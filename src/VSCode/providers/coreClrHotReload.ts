import * as vscode from 'vscode';
import { ConfigurationController } from '../controllers/configurationController';
import { RuntimeBuildContext } from '../interop/interop';
import { ToolContext } from '../interop/toolContext';
import { Project } from '../models/project';
import { Device } from '../models/device';
import { getHotReloadArguments, validateHotReload } from '../models/hotReload';
import * as res from '../resources/constants';

export const hotReloadTaskDefinitionId = 'dotnet-meteor.hotReload';
export const hotReloadTaskName = 'Hot Reload (CoreCLR)';

// Opt-in Run Without Debugging mode: dotnet watch builds, deploys and applies C# edits.
// It runs without a debugger; F5 keeps using the CoreCLR debugger.
export class CoreClrHotReload {
    public static isEnabled(): boolean {
        return vscode.workspace.getConfiguration(res.configId).get<boolean>('coreClrHotReload') === true;
    }

    public static async start(project: Project, configuration: string, device: Device, framework: string,
        build: RuntimeBuildContext, tools: ToolContext, sdkVersion: string | undefined): Promise<void> {
        validateHotReload({ runtime: build.runtime, device, configuration, sdkVersion, onMac: ConfigurationController.onMac });
        if (vscode.tasks.taskExecutions.some(execution => execution.task.definition.type === hotReloadTaskDefinitionId)) {
            vscode.window.showInformationMessage('.NET Meteor: A Hot Reload session is already running. Stop it (Terminate Task) before starting another.');
            return;
        }
        const args = getHotReloadArguments({
            projectPath: project.path,
            framework,
            configuration,
            device,
            buildProperties: build.properties,
            partialStaticRegistrar: vscode.workspace.getConfiguration(res.configId).get<boolean>('coreClrHotReloadPartialStaticRegistrar') === true
        });
        const task = new vscode.Task({ type: hotReloadTaskDefinitionId }, vscode.TaskScope.Workspace, hotReloadTaskName, res.extensionId,
            new vscode.ShellExecution(tools.executable, args, { cwd: tools.cwd, env: tools.env as Record<string, string> }));
        task.isBackground = true;
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: true, panel: vscode.TaskPanelKind.Dedicated, clear: true };
        await vscode.tasks.executeTask(task);
    }
}
