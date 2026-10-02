import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigurationController } from '../controllers/configurationController';
import { Interop, RuntimeBuildContext } from '../interop/interop';
import { getCoreClrPaths } from '../interop/coreClr';
import * as res from '../resources/constants';

export function configureCoreClr(config: vscode.DebugConfiguration, build: RuntimeBuildContext): vscode.DebugConfiguration {
    if (!ConfigurationController.onMac && (ConfigurationController.isAppleMobile() || ConfigurationController.isMacCatalyst())) {
        throw new Error('Experimental CoreCLR debugging for Apple apps currently requires a local Mac. The existing Mono Pair to Mac support is unchanged.');
    }
    if (config.noDebug || config.profilerMode) {
        throw new Error('The experimental CoreCLR backend currently supports F5 debugging. Run Without Debugging and Meteor profiling are not yet supported by this backend.');
    }
    const reserved = Object.keys(config.env ?? {}).filter(key => key === 'CORECLR_ENABLE_PROFILING' || key === 'CORECLR_PROFILER'
        || key === 'CORECLR_PROFILER_PATH' || key.startsWith('CORECLR_REMOTE_DEBUGGER_'));
    if (reserved.length) {
        throw new Error(`CoreCLR debugging controls these launch environment variables: ${reserved.join(', ')}. Remove them from launch.json to avoid conflicting debugger setup.`);
    }
    const paths = getCoreClrPaths(Interop.extensionPath, config.device);
    let assetsPath = config.assets;
    if (ConfigurationController.isAppleMobile()) {
        assetsPath = config.program;
    } else if (ConfigurationController.isMacCatalyst()) {
        assetsPath = path.join(config.program, 'Contents', 'MonoBundle');
    } else if (assetsPath && !path.isAbsolute(assetsPath)) {
        assetsPath = path.resolve(build.tools.cwd, assetsPath);
    }
    const options = ConfigurationController.getDebuggerOptions();
    config.meteorRuntime = 'coreclr';
    config.cwd = config.cwd ?? build.tools.cwd;
    config.remoteCoreclrHost = paths.host;
    config.remoteCoreclrTarget = paths.target;
    config.justMyCode = options.projectAssembliesOnly ?? true;
    config.enableStepFiltering = options.stepOverPropertiesAndOperators ?? false;
    config.symbolOptions = {
        searchPaths: options.symbolSearchPaths,
        searchMicrosoftSymbolServer: options.searchMicrosoftSymbolServer ?? false,
        searchNuGetOrgSymbolServer: ConfigurationController.getSetting<boolean>(res.configIdDebuggerOptionsSearchNuGetSymbolServer, false)
    };
    config.sourceLinkOptions = { '*': { enabled: options.automaticSourceLinkDownload ?? true } };
    config.sourceFileMap = options.sourceCodeMappings;
    config.coreClrMobileDebuggerOptions = {
        runtimeIdentifier: config.device.runtime_id,
        platform: config.device.platform,
        ip: '127.0.0.1',
        port: ConfigurationController.getSetting<number>('coreClrDebuggerPort', 0),
        assetsPath,
        uninstallApp: ConfigurationController.getUninstallAppOption(),
        device: ConfigurationController.isAndroid() && config.device.is_emulator ? config.device.name : config.device.serial,
        isDevice: !config.device.is_emulator,
        tcpTunnel: []
    };
    return config;
}
