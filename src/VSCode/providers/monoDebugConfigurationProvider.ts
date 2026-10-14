import { ProcessRunner } from '../interop/processRunner';
import { ProcessArgumentBuilder } from '../interop/processArgumentBuilder';
import { Interop } from '../interop/interop';
import { ConfigurationController } from '../controllers/configurationController';
import { ExternalTypeResolver } from '../features/externalTypeResolver';
import { configureCoreClr } from './coreClrConfiguration';
import * as res from '../resources/constants';
import * as vscode from 'vscode';
import { StateController } from '../controllers/stateController';
import { StatusBarController } from '../controllers/statusbarController';
import { csharpProjectSystem, debuggerHotReloadEnabled } from '../interop/csharpProjectSystem';

export class MonoDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {
        if (token?.isCancellationRequested) {
            return undefined;
        }
        ConfigurationController.profiler = config.profilerMode;
        const previousNoDebug = ConfigurationController.noDebug;
        ConfigurationController.noDebug = config.noDebug;
        if (!ConfigurationController.isActive()) {
            return undefined;
        }
        try {
            if (previousNoDebug !== ConfigurationController.noDebug) {
                StatusBarController.performSelectConfiguration(StateController.getConfiguration());
            }
            await StatusBarController.synchronizeMicrosoftConfiguration();
            if (token?.isCancellationRequested) {
                return undefined;
            }
            if (!ConfigurationController.isValid()) {
                return undefined;
            }
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
            if (ConfigurationController.usesMicrosoftConfiguration() && config.configuration !== ConfigurationController.configuration) {
                throw new Error('The Microsoft backend uses C# Dev Kit\'s active configuration. Remove the conflicting launch.json configuration or select it in C# Dev Kit and reload VS Code.');
            }
            if (config.device === undefined) {
                config.device = ConfigurationController.device;
            }
            const build = Interop.getBuildContext(config.project, config.configuration, config.device);
            if (build.debuggerBackend === 'microsoft' && debuggerHotReloadEnabled()) {
                const baseline = { project: config.project.path, framework: ConfigurationController.getTargetFramework()!,
                    target: Interop.getPropertyValue('TargetPath', config.project, config.configuration, config.device, build) ?? '',
                    assets: Interop.getPropertyValue('ProjectAssetsFile', config.project, config.configuration, config.device, build) ?? '', sdk: build.tools.executable };
                await csharpProjectSystem.validateBaseline(baseline.project, baseline.framework, baseline.target, baseline.assets, baseline.sdk);
                config.meteorCSharpBaseline = baseline;
            }
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
                return await configureCoreClr(config, build, token);
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
            if (token?.isCancellationRequested) {
                return undefined;
            }
            if (ConfigurationController.usesMicrosoftConfiguration()) {
                void Promise.resolve(vscode.window.showErrorMessage(`.NET Meteor: ${String(error)}`,
                    'Select C# configuration', 'Select target framework')).then(choice => {
                    if (choice === 'Select C# configuration') {
                        return StatusBarController.showQuickPickConfiguration();
                    }
                    if (choice === 'Select target framework') {
                        return StatusBarController.showQuickPickFramework();
                    }
                }).catch(error => console.error(error));
            } else {
                vscode.window.showErrorMessage(`.NET Meteor: ${String(error)}`);
            }
            return undefined;
        }
    }
}
