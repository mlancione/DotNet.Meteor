import * as path from 'path';
import * as net from 'net';
import { debuggerComponentHash } from '../interop/microsoftDebugger';
import * as vscode from 'vscode';
import { ConfigurationController } from '../controllers/configurationController';
import { Interop, RuntimeBuildContext } from '../interop/interop';

async function withDeadline<T>(promise: PromiseLike<T>, operation: string, token?: vscode.CancellationToken): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let cancelled: vscode.Disposable | undefined;
    try {
        return await Promise.race([promise, new Promise<T>((_, reject) => {
            if (token?.isCancellationRequested) {
                reject(new Error('Microsoft debugger setup cancelled.'));
                return;
            }
            cancelled = token?.onCancellationRequested?.(() => reject(new Error('Microsoft debugger setup cancelled.')));
            timer = setTimeout(() => reject(new Error(`Microsoft debugger ${operation} timed out. Check the C# extension output and restart VS Code.`)), 60000);
        })]);
    } finally {
        cancelled?.dispose();
        if (timer) {
            clearTimeout(timer);
        }
    }
}

async function availablePort(preferred: number): Promise<number> {
    if (!Number.isInteger(preferred) || preferred < 0 || preferred > 65535) {
        throw new Error('dotnetMeteor.coreClrDebuggerPort must be an integer from 0 to 65535.');
    }
    const server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(preferred, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

export async function configureMicrosoftCoreClr(config: vscode.DebugConfiguration, build: RuntimeBuildContext,
    token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {
    if (!vscode.workspace.isTrusted) {
        throw new Error('Microsoft CoreCLR debugging requires a trusted workspace.');
    }
    if (!Array.isArray(config.args ?? []) || (config.args ?? []).some((arg: unknown) => typeof arg !== 'string')
        || Object.entries(config.env ?? {}).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string')) {
        throw new Error('Microsoft iOS launch arguments and environment values must be strings, with valid environment names.');
    }
    const components = build.microsoftDebugger!;
    const csharp = await withDeadline(components.csharp.activate(), 'activation', token);
    if (typeof csharp?.initializationFinished !== 'function') {
        throw new Error('The installed C# extension does not expose its initialization API. Update it or use the Meteor backend.');
    }
    await withDeadline(csharp.initializationFinished(), 'initialization', token);
    if (csharp.isLimitedActivation) {
        throw new Error('The Microsoft C# debugger has limited activation. Check workspace trust and the C# extension output.');
    }
    const devkit = await withDeadline(components.devkit.activate(), 'Dev Kit activation', token);
    if (typeof devkit?.getBrokeredServiceServerPipeName !== 'function') {
        throw new Error('The installed C# Dev Kit does not expose the mobile debugger broker. Update it or use the Meteor backend.');
    }
    const broker = await withDeadline(devkit.getBrokeredServiceServerPipeName(), 'broker initialization', token);
    if (token?.isCancellationRequested) {
        return undefined;
    }
    if (typeof broker !== 'string' || !broker.trim()) {
        throw new Error('Microsoft C# Dev Kit returned no mobile debugger broker. Check its initialization output.');
    }
    const mlaunch = build.tools.env.MLAUNCH_PATH;
    const program = Interop.getPropertyValue('TargetPath', config.project, config.configuration, config.device, build);
    if (!program || !path.isAbsolute(program) || !/\.dll$/i.test(program)
        || !path.isAbsolute(config.program ?? '') || !mlaunch || !path.isAbsolute(mlaunch)) {
        throw new Error('Microsoft iOS debugging requires an evaluated managed DLL, app bundle and absolute mlaunch path from the selected workload.');
    }
    const port = await availablePort(ConfigurationController.getSetting<number>('coreClrDebuggerPort', 0));
    if (token?.isCancellationRequested) {
        return undefined;
    }
    const hostLibrary = path.join(components.host, 'libvsdbgremotecoreclrhost.dylib');
    const options = ConfigurationController.getDebuggerOptions();
    const app = config.program;
    // Delegate adapter creation and its normal handshake to Microsoft's C# extension.
    config.type = 'coreclr_mobile';
    config.program = program;
    config.cwd = config.cwd ?? build.tools.cwd;
    config.meteorRuntime = 'coreclr';
    config.meteorCoreClrDebugger = 'microsoft';
    config.justMyCode = config.justMyCode ?? options.projectAssembliesOnly ?? true;
    config.enableStepFiltering = config.enableStepFiltering ?? options.stepOverPropertiesAndOperators ?? false;
    config.sourceFileMap = config.sourceFileMap ?? options.sourceCodeMappings;
    config.symbolOptions = config.symbolOptions ?? { searchPaths: options.symbolSearchPaths,
        searchMicrosoftSymbolServer: options.searchMicrosoftSymbolServer ?? false };
    config.brokeredServicePipeName = broker;
    config.coreClrMobileDebuggerOptions = {
        platform: `ios;${components.architecture}`, ip: '127.0.0.1', port, isServer: true,
        assetsPath: `${app}${path.sep};${components.host}`
    };
    config.meteorMicrosoftLaunch = {
        app, device: config.device.serial, mlaunch, cwd: build.tools.cwd, env: build.tools.env,
        applicationEnvironment: config.env ?? {}, args: config.args ?? [], port,
        uninstall: ConfigurationController.getUninstallAppOption(), hostLibrary,
        hostHash: debuggerComponentHash(hostLibrary), targetHash: debuggerComponentHash(components.targetLibrary), targetLibrary: components.targetLibrary
    };
    // App env/args belong to mlaunch; do not pass them to the desktop host process.
    delete config.env;
    delete config.args;
    delete config.project;
    delete config.device;
    delete config.configuration;
    return config;
}
