import { ConfigurationController } from './configurationController';
import { Interop } from "../interop/interop";
import { StateController } from './stateController';
import { Project } from '../models/project';
import { ProjectItem } from '../models/projectItem';
import { Device } from '../models/device';
import { supportsFramework } from '../models/deviceSelection';
import { DeviceItem } from '../models/deviceItem';
import { SeparatorItem } from '../models/separatorItem';
import { Icons } from '../resources/icons';
import * as res from '../resources/constants';
import * as vscode from 'vscode';

export class StatusBarController {
    private static projectStatusItem: vscode.StatusBarItem | undefined;
    private static targetStatusItem: vscode.StatusBarItem | undefined;
    private static deviceStatusItem: vscode.StatusBarItem | undefined;

    public static projects: Project[] = [];
    public static devices: Device[] = [];

    public static async activate(context: vscode.ExtensionContext): Promise<void> {
        if (vscode.extensions.getExtension(res.dotrushExtensionId) !== undefined)
            return StatusBarController.activateWithDotRush(context);
        
        StatusBarController.createProjectStatusBarItem(context);
        StatusBarController.createConfigurationStatusBarItem(context);
        StatusBarController.createDeviceStatusBarItem(context);

        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(_ => {
            StatusBarController.updateProjectStatusBarItem();
        }));
        context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(ev => {
            if (ev.fileName.endsWith('proj') || ev.fileName.endsWith('.props'))
                StatusBarController.updateProjectStatusBarItem();
        }));

        await StatusBarController.updateDeviceStatusBarItem();
        await StatusBarController.updateProjectStatusBarItem();
    }
    public static async activateWithDotRush(context: vscode.ExtensionContext): Promise<void> {
        const exports = await vscode.extensions.getExtension(res.dotrushExtensionId)?.activate();
        exports?.onActiveProjectChanged?.add((p: Project) => StatusBarController.performSelectProject(p));
        exports?.onActiveConfigurationChanged?.add((c: string) => StatusBarController.performSelectConfiguration(c));
    
        StatusBarController.createDeviceStatusBarItem(context);
        StatusBarController.updateDeviceStatusBarItem();
    }

    private static createProjectStatusBarItem(context: vscode.ExtensionContext) {
        StatusBarController.projectStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        StatusBarController.projectStatusItem.command = res.commandIdSelectActiveProject;
        context.subscriptions.push(StatusBarController.projectStatusItem);
        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdSelectActiveProject, StatusBarController.showQuickPickProject));
    }
    private static createConfigurationStatusBarItem(context: vscode.ExtensionContext) {
        StatusBarController.targetStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        StatusBarController.targetStatusItem.command = res.commandIdSelectActiveConfiguration;
        context.subscriptions.push(StatusBarController.targetStatusItem);
        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdSelectActiveConfiguration, StatusBarController.showQuickPickConfiguration));
    }
    private static createDeviceStatusBarItem(context: vscode.ExtensionContext) {
        StatusBarController.deviceStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 80);
        StatusBarController.deviceStatusItem.command = res.commandIdSelectActiveDevice;
        context.subscriptions.push(StatusBarController.deviceStatusItem);
        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdSelectActiveDevice, StatusBarController.showQuickPickDevice));
    }

    private static async updateProjectStatusBarItem(): Promise<void> {
        if (StatusBarController.projectStatusItem === undefined)
            return;

        const folders = (vscode.workspace.workspaceFolders ?? []).map(it => it.uri.fsPath);
        StatusBarController.projects = await Interop.getProjects(folders);
        if (StatusBarController.projects.length === 0)
            return StatusBarController.projectStatusItem.hide();

        StatusBarController.performSelectProject(StateController.getProject());
        StatusBarController.projects.length === 1
            ? StatusBarController.projectStatusItem.hide()
            : StatusBarController.projectStatusItem.show();

        StatusBarController.updateConfigurationStatusBarItem();
    }
    private static async updateConfigurationStatusBarItem(): Promise<void> {
        if (StatusBarController.targetStatusItem === undefined)
            return;

        if (StatusBarController.projects.length === 0)
            return StatusBarController.targetStatusItem.hide();

        StatusBarController.performSelectConfiguration(StateController.getConfiguration());
        StatusBarController.targetStatusItem.show();
    }
    private static async updateDeviceStatusBarItem(): Promise<void> {
        if (StatusBarController.deviceStatusItem === undefined)
            return;

        StatusBarController.devices = await Interop.getDevices();
        if (StatusBarController.devices.length === 0)
            return StatusBarController.deviceStatusItem.hide();

        StatusBarController.restoreDevice();
    }

    public static performSelectProject(item: Project | undefined = undefined) {
        ConfigurationController.project = item ?? StatusBarController.projects[0];
        const frameworks = ConfigurationController.project?.frameworks ?? [];
        ConfigurationController.targetFramework = StateController.getFramework()
            ?? frameworks.find(framework => StatusBarController.devices.some(device => supportsFramework(device, framework)))
            ?? frameworks[0];
        if (StatusBarController.projectStatusItem !== undefined)
            StatusBarController.projectStatusItem.text = `${Icons.project} ${ConfigurationController.project?.name ?? ''}`;
        StateController.saveProject();
        StatusBarController.performSelectConfiguration(StateController.getConfiguration());
        StateController.saveFramework();
        StatusBarController.restoreDevice();
    }
    public static performSelectConfiguration(item: string | undefined = undefined) {
        const configurations = ConfigurationController.project?.configurations ?? [];
        ConfigurationController.configuration = item ?? configurations.find(value => value === 'Debug') ?? configurations[0];
        if (StatusBarController.targetStatusItem !== undefined)
            StatusBarController.targetStatusItem.text = `${Icons.target} ${ConfigurationController.configuration ?? ''} | ${ConfigurationController.getTargetFramework() ?? ''}`;
        StateController.saveConfiguration();
    }
    public static performSelectFramework(framework: string) {
        if (!ConfigurationController.project?.frameworks.includes(framework))
            return;
        ConfigurationController.targetFramework = framework;
        StateController.saveFramework();
        StatusBarController.performSelectConfiguration(ConfigurationController.configuration);
        StatusBarController.restoreDevice();
    }
    private static restoreDevice() {
        const framework = ConfigurationController.getTargetFramework();
        const device = StateController.getDevice()
            ?? StatusBarController.devices.find(candidate => supportsFramework(candidate, framework));
        // A temporarily disconnected preferred device should not lose its saved selection.
        StatusBarController.performSelectDevice(device, false);
    }
    public static performSelectDevice(item: Device | undefined = undefined, remember = true) {
        ConfigurationController.device = supportsFramework(item, ConfigurationController.getTargetFramework()) ? item : undefined;
        const device = ConfigurationController.device;
        if (StatusBarController.deviceStatusItem !== undefined) {
            StatusBarController.deviceStatusItem.text = device
                ? `${Icons.deviceKind(device)} ${device.name}` : `${Icons.device} Select device`;
            StatusBarController.deviceStatusItem.show();
        }
        if (remember)
            StateController.saveDevice();
    }

    public static async showQuickPickProject() {
        const items = StatusBarController.projects.map(project => new ProjectItem(project));
        const options = { placeHolder: res.commandTitleSelectActiveProject };
        const selectedItem = await vscode.window.showQuickPick(items, options);

        if (selectedItem !== undefined) {
            StatusBarController.performSelectProject(selectedItem.item);
        }
    }
    public static async showQuickPickConfiguration() {
        const project = ConfigurationController.project;
        const items = (project?.configurations ?? []).flatMap(configuration =>
            (project?.frameworks ?? []).map(framework => ({
                label: `${configuration} | ${framework}`, configuration, framework
            })));
        const selected = await vscode.window.showQuickPick(items, { placeHolder: res.commandTitleSelectActiveConfiguration });
        if (selected !== undefined) {
            StatusBarController.performSelectConfiguration(selected.configuration);
            StatusBarController.performSelectFramework(selected.framework);
        }
    }
    public static async showQuickPickDevice() {
        const picker = vscode.window.createQuickPick();
        picker.placeholder = res.messageDeviceLoading;
        picker.matchOnDetail = true;
        picker.busy = true;
        picker.show();
        picker.onDidHide(() => picker.dispose());
        picker.onDidAccept(() => {
            if (picker.selectedItems.length > 0) {
                const selectedItem = (picker.selectedItems[0] as DeviceItem).item;
                StatusBarController.performSelectDevice(selectedItem);
            }
            picker.hide();
        });

        StatusBarController.devices = await Interop.getDevices();

        const devices = StatusBarController.devices.filter(device => supportsFramework(device, ConfigurationController.getTargetFramework()));
        StatusBarController.restoreDevice();
        const items: vscode.QuickPickItem[] = [];
        for (let i of devices.keys()) {
            if (i == 0 || devices[i].detail !== devices[i - 1].detail)
                items.push(new SeparatorItem(devices[i].detail));
            items.push(new DeviceItem(devices[i]));
        }

        picker.items = items;
        picker.placeholder = `${ConfigurationController.getTargetFramework() ?? ""}: ${res.commandTitleSelectActiveDevice}`;
        picker.busy = false;
    }
}