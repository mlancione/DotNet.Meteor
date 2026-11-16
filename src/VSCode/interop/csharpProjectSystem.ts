import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProcessArgumentBuilder } from './processArgumentBuilder';
import { ProcessRunner } from './processRunner';
import { ReadOnlyBrokerClient } from './readOnlyBrokerClient';
import { resolveToolContext } from './toolContext';

interface EnvironmentState {
    version: number;
    configuration?: string;
    projects?: { projectId?: { fullPath?: string } }[];
    solutions?: string[];
}

interface DisposableProxy { dispose(): void; }
interface ProjectSnapshot {
    targetFramework?: string;
    targetFrameworks?: string[];
    assetsFilePath?: string;
    keyOutputs?: Record<string, string>;
}
interface DesignTimeSlice {
    properties?: { TargetFramework?: string; TargetPath?: string; ProjectAssetsFile?: string; };
    lastDesignTimeBuildSucceeded?: boolean;
}
interface ProjectData {
    workspace?: { configuration?: string; solutionPath?: string; };
    projects?: { projectPath: string; slices?: DesignTimeSlice[]; }[];
}
const projectDataQuery = {
    includeWorkspaceState: true,
    properties: ['TargetFramework', 'TargetPath', 'ProjectAssetsFile']
};
interface DevKitV2 {
    dataModel: {
        queryProjects(query: typeof projectDataQuery): Promise<ProjectData>;
        onDidChangeProjects(query: typeof projectDataQuery, listener: (data: ProjectData) => void): vscode.Disposable;
    };
    workspaceDotnet: {
        getState(): { kind?: string; host?: { executablePath?: string; }; sdk?: { version?: string; }; };
    };
}
interface BaselineSlice {
    framework?: string;
    target?: string;
    assets?: string;
}
export interface CSharpConfiguration { name: string; platform: string; }

export function debuggerHotReloadEnabled(): boolean {
    return vscode.workspace.getConfiguration('csharp').get<boolean>('experimental.debug.hotReload', false);
}

function canonicalPath(value: string): string {
    let resolved = path.resolve(value);
    try {
        resolved = fs.realpathSync(resolved);
    } catch {
        // A design-time output may not have been built yet.
    }
    return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

function platformName(value: string): string { return value.replace(/\s/g, '').toLowerCase(); }

function parseConfiguration(value: string | undefined): CSharpConfiguration | undefined {
    const [name, platform] = (value ?? '').split('|').map(part => part.trim());
    return name && platform ? { name, platform } : undefined;
}

function matchesConfiguration(left: CSharpConfiguration | undefined, right: CSharpConfiguration): boolean {
    return !!left && left.name === right.name && platformName(left.platform) === platformName(right.platform);
}

function isDevKitV2(api: any): api is DevKitV2 {
    return typeof api?.dataModel?.queryProjects === 'function'
        && typeof api.dataModel.onDidChangeProjects === 'function'
        && typeof api.workspaceDotnet?.getState === 'function';
}

async function deadline<T>(promise: PromiseLike<T>, operation: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([promise, new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`C# Dev Kit ${operation} timed out. Check its output and reload VS Code.`)), 30000);
        })]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

// NuGet may omit the platform qualifier in the resolved project entry. Compare
// its runtime framework and version, then keep the declared platform check too.
function referenceFrameworkVersion(framework: string): string | undefined {
    const long = /^\.(NETCoreApp|NETStandard),Version=v(\d+\.\d+)(?:,|$)/i.exec(framework);
    if (long) {
        return (long[1].toLowerCase() === 'netcoreapp' ? 'net' : 'netstandard') + long[2];
    }
    const short = /^(net|netcoreapp|netstandard)(\d+\.\d+)(?:-|$)/i.exec(framework);
    return short ? (short[1].toLowerCase() === 'netcoreapp' ? 'net' : short[1].toLowerCase()) + short[2] : undefined;
}

function resolvedReferenceFrameworks(projectPath: string, assetsFilePath: string, framework: string): Map<string, string> {
    const assets = JSON.parse(fs.readFileSync(assetsFilePath, 'utf8')) as {
        targets?: Record<string, Record<string, { type?: string; framework?: string; }>>;
        libraries?: Record<string, { msbuildProject?: string; }>;
        project?: { frameworks?: Record<string, { targetAlias?: string; }>; };
    };
    const aliases = new Set([framework, ...Object.entries(assets.project?.frameworks ?? {})
        .filter(([, value]) => value.targetAlias === framework).map(([key]) => key)]);
    const versions = new Map<string, Set<string>>();
    for (const [target, dependencies] of Object.entries(assets.targets ?? {})) {
        if (!aliases.has(target.split('/')[0])) {
            continue;
        }
        for (const [key, dependency] of Object.entries(dependencies)) {
            const relative = assets.libraries?.[key]?.msbuildProject;
            const version = dependency.type === 'project' && referenceFrameworkVersion(dependency.framework ?? '');
            if (relative && version) {
                const reference = canonicalPath(path.resolve(path.dirname(projectPath), relative));
                const seen = versions.get(reference) ?? new Set<string>();
                seen.add(version);
                versions.set(reference, seen);
            }
        }
    }
    return new Map([...versions].filter(([, seen]) => seen.size === 1).map(([reference, seen]) => [reference, [...seen][0]]));
}

/** Read-only broker integration. Configuration changes belong to Dev Kit's picker. */
export class CSharpProjectSystem implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.changed.event;
    private state?: EnvironmentState;
    private error?: Error;
    private connection?: Promise<void>;
    private environment?: ReadOnlyBrokerClient;
    private subscription?: DisposableProxy;
    private cache?: ReadOnlyBrokerClient;
    private v2?: DevKitV2;
    private v2Delivery = 0;
    private disposed = false;
    public get failure(): string | undefined { return this.error?.message; }

    public configuration(projectPath: string): CSharpConfiguration | undefined {
        if (this.error || !this.state?.projects?.some(project => project.projectId?.fullPath
            && canonicalPath(project.projectId.fullPath) === canonicalPath(projectPath))) {
            return undefined;
        }
        return parseConfiguration(this.state.configuration);
    }

    public async ready(projectPath: string): Promise<CSharpConfiguration> {
        if (this.disposed) {
            throw new Error('C# project-system connection has been disposed. Reload VS Code.');
        }
        this.connection ??= this.connect();
        await this.connection;
        if (this.error) {
            throw this.error;
        }
        if (this.v2) {
            // A subscription can stop delivering after a Dev Kit service restart.
            // Refresh the selection for builds, even when Hot Reload is disabled.
            const delivery = this.v2Delivery;
            const data = await deadline(this.v2.dataModel.queryProjects(projectDataQuery), 'project data query');
            if (this.disposed) {
                throw new Error('C# project-system connection has been disposed. Reload VS Code.');
            }
            if (this.v2Delivery === delivery) {
                this.publishProjectData(data);
            }
        }
        const current = this.configuration(projectPath);
        if (current) {
            return current;
        }
        let listener: vscode.Disposable | undefined;
        try {
            return await deadline(new Promise<CSharpConfiguration>((resolve, reject) => {
                listener = this.onDidChange(() => {
                    const value = this.configuration(projectPath);
                    if (this.error) {
                        reject(this.error);
                    } else if (value) {
                        resolve(value);
                    } else if (!this.v2 && this.state?.configuration && this.state.projects?.length) {
                        reject(new Error('The selected Meteor project is not loaded in C# Dev Kit. Open its solution in C# Dev Kit before Microsoft debugging.'));
                    }
                });
                if (!this.v2 && this.state?.configuration && this.state.projects?.length) {
                    reject(new Error('The selected Meteor project is not loaded in C# Dev Kit. Open its solution before Microsoft debugging.'));
                }
            }), `configuration loading for ${path.basename(projectPath)}`);
        } finally {
            listener?.dispose();
        }
    }

    private async connect(): Promise<void> {
        let environment: ReadOnlyBrokerClient | undefined;
        let subscription: DisposableProxy | undefined;
        let cache: ReadOnlyBrokerClient | undefined;
        try {
            if (!vscode.workspace.isTrusted) {
                throw new Error('Microsoft CoreCLR debugging requires a trusted workspace.');
            }
            const extension = vscode.extensions.getExtension('ms-dotnettools.csdevkit');
            const api = await deadline(extension?.activate() ?? Promise.resolve(undefined), 'activation');
            if (!api?.isLimitedActivation && isDevKitV2(api)) {
                this.v2 = api;
                subscription = api.dataModel.onDidChangeProjects(projectDataQuery, data => {
                    if (!this.disposed && !this.error) {
                        this.v2Delivery++;
                        this.publishProjectData(data);
                    }
                });
                this.subscription = subscription;
                return;
            }
            if (!api?.serviceBroker?.getPipe || !api.getBrokeredServiceServerPipeName || api.isLimitedActivation) {
                throw new Error('C# Dev Kit does not expose its project-system broker. Enable compatible Microsoft C#/Dev Kit extensions or use the Meteor backend.');
            }
            await deadline(api.getBrokeredServiceServerPipeName(), 'initialization');
            environment = await deadline(ReadOnlyBrokerClient.open(api.serviceBroker, 'Microsoft.VisualStudio.NoDelay.EnvironmentService').then(client => {
                if (this.disposed || this.error) {
                    client.dispose();
                }
                return client;
            }), 'environment service');
            if (!environment || this.disposed) {
                throw new Error('C# Dev Kit active configuration is unavailable. Reload VS Code or use the Meteor backend.');
            }
            subscription = await deadline(environment.observe<EnvironmentState>(state => {
                if (!this.disposed && !this.error && typeof state?.version === 'number' && (!this.state || state.version > this.state.version)) {
                    this.state = state;
                    this.changed.fire();
                }
            }, () => {
                if (!this.disposed) {
                    this.error = new Error('The C# Dev Kit configuration connection closed. Reload VS Code before Microsoft debugging.');
                    this.state = undefined;
                    this.changed.fire();
                }
            }).then(subscription => {
                if (this.disposed || this.error) {
                    subscription.dispose();
                }
                return subscription;
            }), 'configuration subscription');
            cache = await deadline(ReadOnlyBrokerClient.open(api.serviceBroker, 'Microsoft.VisualStudio.ProjectCacheStateService').then(client => {
                if (this.disposed || this.error) {
                    client.dispose();
                }
                return client;
            }), 'project baseline service');
            if (!cache || this.disposed) {
                throw new Error('C# Dev Kit project baseline is unavailable. Reload VS Code or use the Meteor backend.');
            }
            this.environment = environment;
            this.subscription = subscription;
            this.cache = cache;
        } catch (error) {
            subscription?.dispose();
            cache?.dispose();
            environment?.dispose();
            this.error = error instanceof Error ? error : new Error(String(error));
            this.changed.fire();
            throw this.error;
        }
    }

    private publishProjectData(data: ProjectData): void {
        const configuration = data.workspace?.configuration;
        const solution = data.workspace?.solutionPath;
        const paths = [...new Set((data.projects ?? []).map(project => project.projectPath))].sort();
        if (this.state && configuration === this.state.configuration && solution === this.state.solutions?.[0]
            && paths.length === this.state.projects?.length
            && paths.every((value, index) => value === this.state!.projects![index].projectId?.fullPath)) {
            return;
        }
        this.state = {
            version: (this.state?.version ?? 0) + 1,
            configuration,
            solutions: solution ? [solution] : [],
            projects: paths.map(fullPath => ({ projectId: { fullPath } }))
        };
        this.changed.fire();
    }

    private async readBaseline(active: CSharpConfiguration, projectPath: string): Promise<{
        projects: Map<string, BaselineSlice[]>;
        executable?: string;
        sdkVersion?: string;
    }> {
        if (this.v2) {
            const data = await deadline(this.v2.dataModel.queryProjects(projectDataQuery), 'project baseline query');
            if (!matchesConfiguration(parseConfiguration(data.workspace?.configuration), active)) {
                throw new Error('C# Dev Kit changed its project configuration during launch setup. Retry F5 after project loading finishes.');
            }
            const projects = new Map((data.projects ?? []).map(project => [
                canonicalPath(project.projectPath),
                (project.slices ?? []).filter(slice => slice.lastDesignTimeBuildSucceeded === true).map(slice => ({
                    framework: slice.properties?.TargetFramework,
                    target: slice.properties?.TargetPath,
                    assets: slice.properties?.ProjectAssetsFile
                }))
            ]));
            const sdk = this.v2.workspaceDotnet.getState();
            return {
                projects,
                executable: sdk?.kind === 'ready' ? sdk.host?.executablePath : undefined,
                sdkVersion: sdk?.kind === 'ready' ? sdk.sdk?.version : undefined
            };
        }

        const snapshots = await deadline(this.cache!.getAll<Record<string, ProjectSnapshot>>(), 'project baseline query');
        const projects = new Map(Object.entries(snapshots).map(([name, project]) => {
            const target = Object.entries(project.keyOutputs ?? {}).find(([key]) =>
                matchesConfiguration(parseConfiguration(key), active))?.[1];
            const frameworks = project.targetFramework ? [project.targetFramework] : project.targetFrameworks ?? [];
            return [canonicalPath(name), frameworks.map(framework => ({ framework, target, assets: project.assetsFilePath }))];
        }));
        // Legacy Dev Kit exposes its executable on process tasks. Its custom build terminal
        // does not, so use the editor process SDK environment in that case.
        const tasks = await deadline(vscode.tasks.fetchTasks({ type: 'dotnet' }), 'SDK query');
        const solution = this.state?.solutions?.[0];
        const task = tasks.find(task => task.source === 'dotnet' && task.execution instanceof vscode.ProcessExecution
            && (!solution || !task.definition.file || (typeof task.definition.file === 'string' && canonicalPath(task.definition.file) === canonicalPath(solution))));
        const executable = (task?.execution as vscode.ProcessExecution | undefined)?.process ?? resolveToolContext(projectPath).executable;
        return { projects, executable };
    }

    public async validateBaseline(projectPath: string, framework: string, targetPath: string,
        assetsFilePath: string, dotnetExecutable: string): Promise<void> {
        const active = await this.ready(projectPath);
        const version = this.state?.version;
        const { projects, executable, sdkVersion } = await this.readBaseline(active, projectPath);
        const project = projects.get(canonicalPath(projectPath));
        if (!project?.length) {
            throw new Error('C# Dev Kit has not loaded the project baseline yet. Wait for the design-time build to succeed, then retry F5.');
        }
        const matching = project.filter(slice => slice.framework === framework);
        if (!matching.length) {
            const frameworks = project.map(slice => slice.framework).filter(Boolean);
            throw new Error(`C# Dev Kit uses ${frameworks.join(', ') || 'an unknown framework'}, but Meteor selected ${framework}. Select the matching C# configuration and Meteor target framework.`);
        }
        if (!path.isAbsolute(targetPath) || !path.isAbsolute(assetsFilePath) || !matching.some(slice =>
            slice.target && canonicalPath(slice.target) === canonicalPath(targetPath)
            && slice.assets && canonicalPath(slice.assets) === canonicalPath(assetsFilePath))) {
            throw new Error('C# Dev Kit and Meteor use different assembly or intermediate output paths. Align the selected project configuration with Meteor\'s Microsoft build paths (see README), then reload VS Code. Hot Reload would otherwise update a different assembly.');
        }
        if (!executable || !path.isAbsolute(executable) || canonicalPath(executable) !== canonicalPath(dotnetExecutable)) {
            throw new Error(`VS Code's project SDK (${executable ?? 'unavailable'}) differs from Meteor's SDK (${dotnetExecutable}). Fully quit and restart VS Code with the selected SDK in PATH and DOTNET_ROOT. Changing Meteor's SDK path alone does not restart the C# project system.`);
        }
        if (this.v2) {
            const version = ProcessRunner.runSync(new ProcessArgumentBuilder(dotnetExecutable).append('--version'), {
                cwd: path.dirname(projectPath),
                timeout: 10000,
                env: { ...process.env, DOTNET_ROOT: path.dirname(dotnetExecutable), DOTNET_MULTILEVEL_LOOKUP: '0' }
            });
            if (!sdkVersion || version !== sdkVersion) {
                throw new Error(`C# Dev Kit selected SDK ${sdkVersion ?? 'unavailable'}, but Meteor selected ${version ?? 'unavailable'}. Check the solution and project global.json files, then restart VS Code.`);
            }
        }
        // The restore spec lists declared frameworks and intermediate paths. Where
        // available, the resolved assets also identify the reference runtime version.
        const graphPath = path.join(path.dirname(assetsFilePath), `${path.basename(projectPath)}.nuget.dgspec.json`);
        if (fs.existsSync(graphPath)) {
            const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
            const resolved = this.v2 && fs.existsSync(assetsFilePath)
                ? resolvedReferenceFrameworks(projectPath, assetsFilePath, framework) : new Map<string, string>();
            for (const [referencePath, specification] of Object.entries(graph.projects ?? {}) as [string, any][]) {
                if (canonicalPath(referencePath) === canonicalPath(projectPath)) {
                    continue;
                }
                const reference = projects.get(canonicalPath(referencePath));
                const restorePath = specification.restore?.outputPath;
                const frameworkSet = Object.keys(specification.frameworks ?? {});
                const resolvedFramework = resolved.get(canonicalPath(referencePath));
                if (typeof restorePath !== 'string' || !reference?.some(slice =>
                    slice.assets && canonicalPath(slice.assets) === canonicalPath(path.join(restorePath, 'project.assets.json'))
                    && slice.framework && frameworkSet.includes(slice.framework)
                    && (!resolvedFramework || referenceFrameworkVersion(slice.framework) === resolvedFramework))) {
                    throw new Error(`C# Dev Kit's baseline for referenced project ${path.basename(referencePath)} differs from Meteor's restore graph. Select the matching C# configuration and reload VS Code before Hot Reload.`);
                }
            }
        }
        if (this.error || this.state?.version !== version) {
            throw new Error('C# Dev Kit changed its project configuration during launch setup. Retry F5 after project loading finishes.');
        }
    }

    public dispose(): void {
        this.disposed = true;
        this.state = undefined;
        this.subscription?.dispose();
        this.cache?.dispose();
        this.environment?.dispose();
        this.changed.dispose();
    }
}

export const csharpProjectSystem = new CSharpProjectSystem();
