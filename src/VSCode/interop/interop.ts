import { ConfigurationController } from '../controllers/configurationController';
import { ProcessArgumentBuilder } from './processArgumentBuilder';
import { ProcessRunner } from './processRunner';
import { Project } from '../models/project';
import { Device } from '../models/device';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveToolContext, normalizeXcodePath, ToolContext } from './toolContext';


export class Interop {
    private static workspaceToolPath: string;

    public static initialize(extensionPath : string) {
        const executableExtension = ConfigurationController.onWindows ? '.exe' : '';
        Interop.workspaceToolPath = path.join(extensionPath, "extension", "bin", "Workspace", "DotNet.Meteor.Workspace" + executableExtension);
        Interop.init();
    }

    private static init() {
        ProcessRunner.runAsync<boolean>(new ProcessArgumentBuilder(Interop.workspaceToolPath)
            .append("--initialize"), { timeout: 15000 }).catch(error => console.error(error));
    }

    private static deviceCache = new Map<string, { expires: number; devices: Device[] }>();
    private static deviceRequests = new Map<string, Promise<Device[]>>();

    public static async getDevices(platform = '', context?: ToolContext): Promise<Device[]> {
        const key = JSON.stringify([platform, context?.env.DEVELOPER_DIR ?? process.env.DEVELOPER_DIR ?? '', context?.env.DOTNET_ROOT ?? '']);
        const cached = Interop.deviceCache.get(key);
        if (cached && cached.expires > Date.now()) {
            return cached.devices;
        }
        const pending = Interop.deviceRequests.get(key);
        if (pending) {
            return pending;
        }
        const discovery = platform
            ? ProcessRunner.runAsync<Device[]>(new ProcessArgumentBuilder(Interop.workspaceToolPath)
                .append("--all-devices", platform), { cwd: context?.cwd, env: context?.env, timeout: 45000 })
            : Promise.allSettled(['android', 'ios', process.platform === 'win32' ? 'windows' : 'maccatalyst']
                .map(source => Interop.getDevices(source, context))).then(results => {
                    const devices: Device[] = [];
                    let successes = 0;
                    for (const result of results) {
                        if (result.status === 'fulfilled') {
                            devices.push(...result.value);
                            successes++;
                        } else {
                            console.error(result.reason);
                        }
                    }
                    if (!successes) {
                        throw new Error('All device discovery sources failed. See the .NET Meteor workspace logs.');
                    }
                    return devices;
                });
        const request = discovery
            .then(devices => {
                Interop.deviceCache.set(key, { devices, expires: Date.now() + 30000 });
                return devices;
            }).finally(() => Interop.deviceRequests.delete(key));
        Interop.deviceRequests.set(key, request);
        return request;
    }
    public static async getProjects(folders: string[]): Promise<Project[]> {
        return await ProcessRunner.runAsync<Project[]>(new ProcessArgumentBuilder(Interop.workspaceToolPath)
            .append("--analyze-workspace")
            .append(...folders));
    }
    public static getAndroidSdk(): string | undefined {
        return ProcessRunner.runSync(new ProcessArgumentBuilder(Interop.workspaceToolPath)
            .append("--android-sdk-path"));
    }
    public static getPropertyValue(propertyName: string, project: Project, configuration: string, device: Device) : string | undefined {
        const targetFramework = ConfigurationController.getTargetFramework();
        const runtimeIdentifier = device?.runtime_id;
        const context = Interop.getToolContext(project);

        return ProcessRunner.runSync(new ProcessArgumentBuilder(context.executable)
            .append("msbuild").append(project.path)
            .append(`-getProperty:${propertyName}`)
            .conditional(`-p:Configuration=${configuration}`, () => configuration)
            .conditional(`-p:TargetFramework=${targetFramework}`, () => targetFramework)
            .conditional(`-p:RuntimeIdentifier=${runtimeIdentifier}`, () => runtimeIdentifier), context);
    }
    public static getToolContext(project: Project): ToolContext {
        const configured = vscode.workspace.getConfiguration('dotnetMeteor', vscode.Uri.file(project.path)).get<string>('dotnetPath');
        return resolveToolContext(project.path, configured);
    }

    public static getProjectToolContext(project: Project, configuration: string, device: Device | undefined): ToolContext {
        const context = Interop.getToolContext(project);
        const framework = ConfigurationController.getTargetFramework();
        const platform = device?.platform ?? framework?.match(/-([a-z]+)/i)?.[1]?.toLowerCase();
        if (process.platform !== 'darwin' || (platform !== 'ios' && platform !== 'maccatalyst')) {
            return context;
        }
        const output = ProcessRunner.runSync(new ProcessArgumentBuilder(context.executable)
            .append('msbuild', project.path, '-getProperty:XcodeLocation,MlaunchPath,_MlaunchPath')
            .conditional(`-p:TargetFramework=${framework}`, () => framework)
            .conditional(`-p:Configuration=${configuration}`, () => configuration)
            .conditional(`-p:RuntimeIdentifier=${device?.runtime_id}`, () => device?.runtime_id), context);
        if (output === undefined) {
            throw new Error('Could not evaluate project Apple tools. See the extension host output for MSBuild diagnostics.');
        }
        const properties = JSON.parse(output).Properties as Record<string, string>;
        if (properties.XcodeLocation) {
            context.env.DEVELOPER_DIR = normalizeXcodePath(properties.XcodeLocation);
        }
        const mlaunch = process.env.MLAUNCH_PATH || properties.MlaunchPath || properties._MlaunchPath;
        if (mlaunch) {
            if (!fs.existsSync(mlaunch)) {
                throw new Error(`Selected mlaunch does not exist: ${mlaunch}`);
            }
            context.env.MLAUNCH_PATH = mlaunch;
        }
        context.env.METEOR_TARGET_FRAMEWORK = framework;
        return context;
    }

}
