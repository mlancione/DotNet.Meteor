import { ConfigurationController } from './configurationController';
import { StatusBarController } from './statusbarController';
import { ExtensionContext } from 'vscode';
import { Device } from '../models/device';
import { deviceId, supportsFramework } from '../models/deviceSelection';
import { Project } from '../models/project';

export class StateController {
    private static context: ExtensionContext | undefined;

    public static activate(context: ExtensionContext) {
        StateController.context = context;
    }
    public static deactivate() {
        StateController.context = undefined;
    }

    public static saveProject() {
        if (StateController.context !== undefined)
             StateController.context.workspaceState.update('project', ConfigurationController.project?.path);
    }
    public static saveDevice() {
        const framework = ConfigurationController.getTargetFramework();
        const device = ConfigurationController.device;
        if (framework && device && StateController.context)
            StateController.context.workspaceState.update(`device_${framework}`, deviceId(device));
    }
    public static saveFramework() {
        const project = ConfigurationController.project;
        if (project && StateController.context)
            StateController.context.workspaceState.update(`framework_${project.path}`, ConfigurationController.targetFramework);
    }
    public static getFramework(): string | undefined {
        const project = ConfigurationController.project;
        const saved = StateController.context?.workspaceState.get<string>(`framework_${project?.path}`);
        return project?.frameworks.find(framework => framework === saved);
    }
    public static saveConfiguration() {
        if (StateController.context !== undefined)
            StateController.context.workspaceState.update('target', ConfigurationController.configuration);
    }

    public static getProject() : Project | undefined {
        if (StateController.context === undefined)
            return undefined;

        const project = StateController.context.workspaceState.get<string>('project');
        return StatusBarController.projects.find(it => it.path === project);
    }
    public static getConfiguration() : string | undefined {
        if (StateController.context === undefined)
            return undefined;

        const target = StateController.context.workspaceState.get<string>('target');
        const project = StateController.getProject();
        return project?.configurations.find(it => it === target);
    }
    public static getDevice(): Device | undefined {
        const framework = ConfigurationController.getTargetFramework();
        if (!framework || !StateController.context)
            return undefined;
        const saved = StateController.context.workspaceState.get<string>(`device_${framework}`);
        const compatible = StatusBarController.devices.filter(device => supportsFramework(device, framework));
        if (saved !== undefined)
            return compatible.find(device => deviceId(device) === saved);
        // Migrate the old workspace-wide preference only when it matches this framework.
        const legacy = StateController.context.workspaceState.get<string>('device');
        return compatible.find(device => `${device.name}_${device.platform}_${device.os_version}` === legacy);
    }

    public static getGlobal<TValue>(key: string): TValue | undefined {
        return StateController.context?.globalState.get<TValue>(key);
    }
    public static putGlobal(key: string, value: any) {
        StateController.context?.globalState.update(key, value);
    }

}
