import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
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
    private disposed = false;
    public get failure(): string | undefined { return this.error?.message; }

    public configuration(projectPath: string): CSharpConfiguration | undefined {
        if (this.error || !this.state?.projects?.some(project => project.projectId?.fullPath
            && canonicalPath(project.projectId.fullPath) === canonicalPath(projectPath))) {
            return undefined;
        }
        const [name, platform] = (this.state.configuration ?? '').split('|');
        return name?.trim() && platform?.trim() ? { name: name.trim(), platform: platform.trim() } : undefined;
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
                    } else if (this.state?.configuration && this.state.projects?.length) {
                        reject(new Error('The selected Meteor project is not loaded in C# Dev Kit. Open its solution in C# Dev Kit before Microsoft debugging.'));
                    }
                });
                if (this.state?.configuration && this.state.projects?.length) {
                    reject(new Error('The selected Meteor project is not loaded in C# Dev Kit. Open its solution before Microsoft debugging.'));
                }
            }), 'configuration loading');
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

    public async validateBaseline(projectPath: string, framework: string, targetPath: string,
        assetsFilePath: string, dotnetExecutable: string): Promise<void> {
        const active = await this.ready(projectPath);
        const version = this.state?.version;
        const projects = await deadline(this.cache!.getAll<Record<string, ProjectSnapshot>>(), 'project baseline query');
        const project = Object.entries(projects).find(([name]) => canonicalPath(name) === canonicalPath(projectPath))?.[1];
        if (!project) {
            throw new Error('C# Dev Kit has not loaded the project baseline yet. Wait for project loading to finish, then retry F5.');
        }
        const frameworks = project.targetFramework ? [project.targetFramework] : project.targetFrameworks ?? [];
        if (!frameworks.includes(framework)) {
            throw new Error(`C# Dev Kit uses ${frameworks.join(', ') || 'an unknown framework'}, but Meteor selected ${framework}. Select the matching C# configuration and Meteor target framework, then reload VS Code.`);
        }
        const output = Object.entries(project.keyOutputs ?? {}).find(([key]) => {
            const [name, platform] = key.split('|');
            return name === active.name && platformName(platform ?? '') === platformName(active.platform);
        })?.[1];
        if (!path.isAbsolute(targetPath) || !path.isAbsolute(assetsFilePath) || !output || canonicalPath(output) !== canonicalPath(targetPath)
            || !project.assetsFilePath || canonicalPath(project.assetsFilePath) !== canonicalPath(assetsFilePath)) {
            throw new Error('C# Dev Kit and Meteor use different assembly or intermediate output paths. Align the selected project configuration with Meteor\'s Microsoft build paths (see README), then reload VS Code. Hot Reload would otherwise update a different assembly.');
        }
        // Dev Kit exposes its executable on process tasks. Its custom build terminal
        // does not, so also enforce the editor process SDK environment in that case.
        const tasks = await deadline(vscode.tasks.fetchTasks({ type: 'dotnet' }), 'SDK query');
        const solution = this.state?.solutions?.[0];
        const task = tasks.find(task => task.source === 'dotnet' && task.execution instanceof vscode.ProcessExecution
            && (!solution || !task.definition.file || (typeof task.definition.file === 'string' && canonicalPath(task.definition.file) === canonicalPath(solution))));
        const executable = (task?.execution as vscode.ProcessExecution | undefined)?.process ?? resolveToolContext(projectPath).executable;
        if (!executable || !path.isAbsolute(executable) || canonicalPath(executable) !== canonicalPath(dotnetExecutable)) {
            throw new Error(`VS Code's project SDK (${executable}) differs from Meteor's SDK (${dotnetExecutable}). Fully quit and restart VS Code with the selected SDK in PATH and DOTNET_ROOT. Changing Meteor's SDK path alone does not restart the C# project system.`);
        }
        // Restore's graph includes project-reference intermediate paths and negotiated frameworks.
        const graphPath = path.join(path.dirname(assetsFilePath), `${path.basename(projectPath)}.nuget.dgspec.json`);
        if (fs.existsSync(graphPath)) {
            const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
            for (const [referencePath, specification] of Object.entries(graph.projects ?? {}) as [string, any][]) {
                if (canonicalPath(referencePath) === canonicalPath(projectPath)) {
                    continue;
                }
                const reference = Object.entries(projects).find(([name]) => canonicalPath(name) === canonicalPath(referencePath))?.[1];
                const restorePath = specification.restore?.outputPath;
                const referenceFrameworks = reference?.targetFramework ? [reference.targetFramework] : reference?.targetFrameworks ?? [];
                if (!reference?.assetsFilePath || typeof restorePath !== 'string'
                    || canonicalPath(reference.assetsFilePath) !== canonicalPath(path.join(restorePath, 'project.assets.json'))
                    || !referenceFrameworks.some(value => Object.keys(specification.frameworks ?? {}).includes(value))) {
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
