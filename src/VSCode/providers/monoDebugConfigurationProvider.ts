import { ProcessRunner } from '../interop/processRunner';
import { ProcessArgumentBuilder } from '../interop/processArgumentBuilder';
import { Interop } from '../interop/interop';
import { ConfigurationController } from '../controllers/configurationController';
import { ExternalTypeResolver } from '../features/externalTypeResolver';
import { configureCoreClr } from './coreClrConfiguration';
import * as res from '../resources/constants';
import * as vscode from 'vscode';

export class MonoDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {
        ConfigurationController.profiler = config.profilerMode;
        ConfigurationController.noDebug = config.noDebug;
        if (!ConfigurationController.isActive() || !ConfigurationController.isValid()) {
            return undefined;
        }
        try {
            if (!config.type && !config.request && !config.name) {
                config.preLaunchTask = `${res.extensionId}: ${res.taskDefinitionDefaultTargetCapitalized}`;
                config.name = res.debuggerMeteorTitle;
                config.type = res.debuggerMeteorId;
                config.request = 'launch';
            }
            if (config.project === undefined) {
                config.project = ConfigurationController.project;
            }
            if (config.configuration === undefined) {
                config.configuration = ConfigurationController.configuration;
            }
            if (config.device === undefined) {
                config.device = ConfigurationController.device;
            }
            const build = Interop.getBuildContext(config.project, config.configuration, config.device);
            if (config.program === undefined) {
                config.program = ConfigurationController.getProgramPath(config.project, config.configuration, config.device, build);
            }
            if (config.assets === undefined) {
                config.assets = ConfigurationController.getAssetsPath(config.project, config.configuration, config.device, build);
            }
            if (ConfigurationController.isVsdbgRequired()) {
                config.type = res.debuggerVsdbgId;
                config.project = undefined;
                config.configuration = undefined;
                config.device = undefined;
                return ConfigurationController.getVsdbgOptions(config);
            }
            const tools = Interop.getProjectToolContext(config.project, config.configuration, config.device, build);
            config.toolEnvironment = tools.env;
            config.toolWorkingDirectory = tools.cwd;
            config.dotnetExecutable = tools.executable;
            config.dotnetSdkVersion = ProcessRunner.runSync(new ProcessArgumentBuilder(tools.executable).append('--version'), tools);
            config.targetFramework = ConfigurationController.getTargetFramework();
            config.meteorRuntime = build.runtime ?? 'mono';
            if (build.runtime === 'coreclr') {
                return configureCoreClr(config, build);
            }
            config.transportId = ExternalTypeResolver.feature.transportId;
            config.skipDebug = ConfigurationController.noDebug;
            config.debuggingPort = ConfigurationController.getDebuggingPort();
            config.uninstallApp = ConfigurationController.getUninstallAppOption();
            config.reloadHost = ConfigurationController.getReloadHostPort();
            config.profilerPort = ConfigurationController.getProfilerPort();
            config.debuggerOptions = ConfigurationController.getDebuggerOptions();
            return config;
        } catch (error) {
            vscode.window.showErrorMessage(`.NET Meteor: ${String(error)}`);
            return undefined;
        }
    }
}
