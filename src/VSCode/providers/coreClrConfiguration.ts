import { configureMicrosoftCoreClr } from './microsoftCoreClrConfiguration';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigurationController } from '../controllers/configurationController';
import { Interop, RuntimeBuildContext } from '../interop/interop';
import { getCoreClrPaths } from '../interop/coreClr';
import * as res from '../resources/constants';

export async function configureCoreClr(config: vscode.DebugConfiguration, build: RuntimeBuildContext,
    token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {
    if (!ConfigurationController.onMac && (ConfigurationController.isAppleMobile() || ConfigurationController.isMacCatalyst())) {
        throw new Error('Experimental CoreCLR debugging for Apple apps currently requires a local Mac. The existing Mono Pair to Mac support is unchanged.');
    }
    const reserved = Object.keys(config.env ?? {}).filter(key => key === 'CORECLR_ENABLE_PROFILING' || key === 'CORECLR_PROFILER'
        || key === 'CORECLR_PROFILER_PATH' || key.startsWith('CORECLR_REMOTE_DEBUGGER_'));
    if (reserved.length) {
        throw new Error(`CoreCLR debugging controls these launch environment variables: ${reserved.join(', ')}. Remove them from launch.json to avoid conflicting debugger setup.`);
    }
    if (build.csharpHotReload && config.noDebug && !config.profilerMode) {
        if (config.args?.length) {
            throw new Error('This C# Hot Reload lane does not yet support launch.json app arguments. Remove args or use normal F5.');
        }
        if (!/^1[1-9]\.|^[2-9]\d\./.test(config.dotnetSdkVersion ?? '')) {
            throw new Error('C# Hot Reload on iOS requires a .NET 11+ SDK. Check dotnetMeteor.coreClrDotnetPath and global.json.');
        }
        const controlled = /^(DOTNET_WATCH(?:_.*)?|DOTNET_STARTUP_HOOKS|DOTNET_MODIFIABLE_ASSEMBLIES)$/;
        if (Object.keys(config.env ?? {}).some(key => controlled.test(key))) {
            throw new Error('The SDK watcher controls DOTNET_WATCH, DOTNET_STARTUP_HOOKS and DOTNET_MODIFIABLE_ASSEMBLIES. Remove these variables from launch.json for C# Hot Reload.');
        }
        config.meteorRuntime = 'coreclr';
        config.meteorCSharpHotReload = {
            executable: build.tools.executable,
            cwd: build.tools.cwd,
            args: ['watch', '--project', config.project.path, '--non-interactive', '--no-launch-profile',
                '--disable-build-servers', '--configuration', config.configuration,
                '--framework', config.targetFramework, '--runtime', config.device.runtime_id,
                '--device', config.device.serial, ...build.properties.map(value => value.replace(/^-p:/, '--property:')),
                ...Object.entries(config.env ?? {}).flatMap(([key, value]) => {
                    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                        throw new Error('C# Hot Reload launch environment entries must have valid names and string values.');
                    }
                    return ['--environment', `${key}=${value}`];
                })],
            appPath: config.program,
            device: config.device.serial
        };
        return config;
    }
    if (config.noDebug || config.profilerMode) {
        throw new Error('The experimental CoreCLR backend supports F5 debugging. For C# Hot Reload on a local .NET 11+ iOS simulator, enable dotnetMeteor.coreClrHotReload and use Run Without Debugging. Meteor profiling is not supported by this backend.');
    }
    if (build.debuggerBackend === 'microsoft') {
        return configureMicrosoftCoreClr(config, build, token);
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
