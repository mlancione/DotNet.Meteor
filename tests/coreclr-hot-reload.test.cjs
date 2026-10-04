const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename);

let settings, properties, errors, infos, executed, executions, sdkVersion;
const vscode = {
    ThemeIcon: class {}, ThemeColor: class {}, QuickPickItemKind: { Separator: -1 },
    Uri: { file: value => value }, ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => ({ get: key => settings[key], update: async () => {} }) },
    window: { showErrorMessage: value => errors.push(value), showInformationMessage: value => infos.push(value) },
    debug: { activeDebugSession: undefined },
    TaskScope: { Workspace: 1 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 2 },
    ShellExecution: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
    CustomExecution: class { constructor(callback) { this.callback = callback; } },
    EventEmitter: class { constructor() { this.event = () => {}; } fire() {} dispose() {} },
    Task: class { constructor(definition, scope, name, source, execution) { Object.assign(this, { definition, scope, name, source, execution }); } },
    tasks: {
        get taskExecutions() { return executions; },
        executeTask: async task => { executed.push(task); return { task }; }
    },
    DebugAdapterExecutable: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } }
};
const load = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : load.call(this, id, ...args); };
const { getHotReloadArguments, validateHotReload, hotReloadIntermediateOutputPath, hotReloadOutputPath } = require('../src/VSCode/models/hotReload.ts');
const { hotReloadTaskDefinitionId } = require('../src/VSCode/providers/coreClrHotReload.ts');
const { ProcessRunner } = require('../src/VSCode/interop/processRunner.ts');
const { Interop } = require('../src/VSCode/interop/interop.ts');
const { ConfigurationController: config } = require('../src/VSCode/controllers/configurationController.ts');
const { StatusBarController: status } = require('../src/VSCode/controllers/statusbarController.ts');
const { MonoDebugConfigurationProvider } = require('../src/VSCode/providers/monoDebugConfigurationProvider.ts');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-hotreload-')));
const original = { platform: process.platform, sync: ProcessRunner.runSync, onMac: config.onMac, onWindows: config.onWindows };
const dotnet = path.join(root, 'preview dotnet');
const mlaunch = path.join(root, 'mlaunch');
const developer = path.join(root, 'Xcode.app', 'Contents', 'Developer');
fs.mkdirSync(developer, { recursive: true });
for (const p of [dotnet, mlaunch]) { fs.writeFileSync(p, 'fixture', { mode: 0o755 }); }
const app = path.join(root, 'bin', 'meteor-coreclr', 'Debug', 'App.app');
for (const p of [path.join(root, 'extension', 'bin', 'CoreClr', 'clrdbg'),
    path.join(root, 'extension', 'bin', 'Remote', 'remote-host', `osx-${process.arch}`, 'libremotecoreclrhost.dylib'),
    path.join(root, 'extension', 'bin', 'Remote', 'remote-target', 'ios', 'iossimulator-arm64', 'libremotecoreclrtarget.dylib')]) {
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'fixture');
}
const simulator = { name: 'iPad', platform: 'ios', serial: 'sim-udid', runtime_id: 'iossimulator-arm64', is_emulator: true };
const ipad = { name: 'iPad Pro', platform: 'ios', serial: 'device-udid', runtime_id: 'ios-arm64', is_emulator: false };
const debuggingBuild = ['-p:UseMonoRuntime=false', '-p:EnableDiagnostics=true', '-p:BaseIntermediateOutputPath=obj/meteor-coreclr/',
    '-p:BaseOutputPath=bin/meteor-coreclr/', '-p:CustomBeforeMicrosoftCommonProps=/ext/CoreClr.props',
    '-p:CustomAfterMicrosoftCommonTargets=/ext/CoreClr.targets', '-p:RemoteCoreclrTargetDir=/ext/remote-target', '-p:PublishReadyToRun=true'];
const run = () => new MonoDebugConfigurationProvider().resolveDebugConfiguration(undefined,
    { type: 'dotnet-meteor.debugger', name: 'Run', request: 'launch', noDebug: true });

beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    config.onMac = true; config.onWindows = false;
    settings = { dotnetPath: dotnet, runtime: 'coreclr', coreClrHotReload: true };
    properties = { UseMonoRuntime: 'false' }; errors = []; infos = []; executed = []; executions = []; sdkVersion = '11.0.100-rc.2';
    config.project = { path: path.join(root, 'App.csproj'), frameworks: ['net10.0-ios', 'net11.0-ios27.0'], configurations: ['Debug', 'Release'] };
    config.targetFramework = 'net11.0-ios27.0'; config.configuration = 'Debug';
    config.noDebug = false; config.profiler = undefined; config.device = { ...simulator };
    status.devices = [config.device]; Interop.extensionPath = root;
    ProcessRunner.runSync = (builder) => {
        const args = builder.getArguments();
        if (builder.getCommand() === '/usr/bin/xcode-select') { return developer; }
        if (args.includes('--version')) { return sdkVersion; }
        const query = args.find(arg => arg.startsWith('-getProperty:')) ?? '';
        if (query.includes('UseMonoRuntime')) { return JSON.stringify({ Properties: properties }); }
        if (query.includes('XcodeLocation')) { return JSON.stringify({ Properties: { XcodeLocation: path.join(root, 'Xcode.app'), MlaunchPath: mlaunch } }); }
        if (query.includes('TargetPath')) { return path.join(path.dirname(app), 'App.dll'); }
        if (query.includes('_AppBundleName')) { return 'App'; }
        return undefined;
    };
});
after(() => {
    ProcessRunner.runSync = original.sync;
    Object.defineProperty(process, 'platform', { value: original.platform });
    config.onMac = original.onMac; config.onWindows = original.onWindows;
    fs.rmSync(root, { recursive: true, force: true });
});

test('dotnet watch targets the selected project, device, framework and configuration', () => {
    const args = getHotReloadArguments({ projectPath: '/src/App.csproj', framework: 'net11.0-ios27.0', configuration: 'Debug',
        device: simulator, buildProperties: debuggingBuild, partialStaticRegistrar: false });
    assert.deepEqual(args.slice(0, 9), ['watch', '--project', '/src/App.csproj', '--device', 'sim-udid', '-f', 'net11.0-ios27.0', '-c', 'Debug']);
});
test('Hot Reload builds keep the CoreCLR runtime but own outputs, trimming, ReadyToRun and the RID', () => {
    const args = getHotReloadArguments({ projectPath: '/src/App.csproj', framework: 'net11.0-ios27.0', configuration: 'Debug',
        device: simulator, buildProperties: debuggingBuild, partialStaticRegistrar: false });
    for (const kept of ['-p:UseMonoRuntime=false', '-p:EnableDiagnostics=true', '-p:CustomBeforeMicrosoftCommonProps=/ext/CoreClr.props',
        '-p:CustomAfterMicrosoftCommonTargets=/ext/CoreClr.targets', '-p:MtouchLink=None', '-p:PublishReadyToRun=false',
        `-p:BaseIntermediateOutputPath=${hotReloadIntermediateOutputPath}`, `-p:BaseOutputPath=${hotReloadOutputPath}`,
        '-p:RuntimeIdentifier=iossimulator-arm64']) {
        assert.equal(args.filter(arg => arg === kept).length, 1, kept);
    }
    // No debugger agent: dotnet watch runs the app without a debugger.
    assert.ok(!args.some(arg => /RemoteCoreclrTargetDir|meteor-coreclr\/$|PublishReadyToRun=true|Registrar/.test(arg)));
});
test('the partial-static registrar workaround applies only to physical devices when enabled', () => {
    const build = options => getHotReloadArguments({ projectPath: '/src/App.csproj', framework: 'net11.0-ios27.0',
        configuration: 'Debug', buildProperties: ['-p:Registrar=managed-static'], ...options });
    assert.ok(build({ device: ipad, partialStaticRegistrar: true }).includes('-p:Registrar=partial-static'));
    assert.ok(!build({ device: ipad, partialStaticRegistrar: false }).some(arg => /Registrar/.test(arg)));
    assert.ok(!build({ device: simulator, partialStaticRegistrar: true }).some(arg => /Registrar/.test(arg)));
    assert.ok(build({ device: ipad, partialStaticRegistrar: false }).includes('-p:RuntimeIdentifier=ios-arm64'));
});
test('validation explains every unsupported Hot Reload prerequisite', () => {
    const valid = { runtime: 'coreclr', device: simulator, configuration: 'Debug', sdkVersion: '11.0.100-rc.2', onMac: true };
    assert.doesNotThrow(() => validateHotReload(valid));
    assert.throws(() => validateHotReload({ ...valid, runtime: 'mono' }), /requires the CoreCLR runtime/);
    assert.throws(() => validateHotReload({ ...valid, onMac: false }), /requires a local Mac/);
    assert.throws(() => validateHotReload({ ...valid, device: { ...simulator, platform: 'android' } }), /iOS simulators and devices only/);
    assert.throws(() => validateHotReload({ ...valid, device: { ...simulator, platform: 'maccatalyst' } }), /iOS simulators and devices only/);
    assert.throws(() => validateHotReload({ ...valid, device: { ...simulator, serial: undefined } }), /device identifier/);
    assert.throws(() => validateHotReload({ ...valid, configuration: 'Release' }), /Debug configuration.*Release/);
    assert.throws(() => validateHotReload({ ...valid, sdkVersion: '10.0.401' }), /\.NET 11 SDK.*10\.0\.401/);
    assert.throws(() => validateHotReload({ ...valid, sdkVersion: undefined }), /\.NET 11 SDK/);
});

test('enabled CoreCLR Run Without Debugging starts one dotnet watch task instead of a debug session', async () => {
    const launch = await run();
    assert.equal(launch, undefined); assert.deepEqual(errors, []);
    assert.equal(executed.length, 1);
    const task = executed[0];
    assert.equal(task.definition.type, hotReloadTaskDefinitionId); assert.equal(task.source, 'dotnet-meteor');
    assert.equal(task.isBackground, true);
    assert.equal(task.execution.command, dotnet);
    assert.equal(task.execution.args[0], 'watch');
    assert.ok(task.execution.args.includes('sim-udid'));
    assert.equal(task.execution.options.cwd, root);
    assert.equal(task.execution.options.env.DEVELOPER_DIR, developer);
    assert.equal(task.execution.options.env.MLAUNCH_PATH, mlaunch);
});
test('Hot Reload uses the CoreCLR SDK override and the partial-static setting', async () => {
    settings.coreClrDotnetPath = mlaunch; settings.coreClrHotReloadPartialStaticRegistrar = true;
    config.device = { ...ipad }; status.devices = [config.device];
    await run();
    assert.deepEqual(errors, []);
    assert.equal(executed[0].execution.command, mlaunch);
    assert.ok(executed[0].execution.args.includes('-p:Registrar=partial-static'));
});
test('a running Hot Reload session is reused instead of starting a second dotnet watch', async () => {
    executions = [{ task: { definition: { type: hotReloadTaskDefinitionId } } }];
    assert.equal(await run(), undefined);
    assert.equal(executed.length, 0); assert.match(infos[0], /already running/);
});
test('unmet prerequisites are reported and start nothing', async () => {
    config.configuration = 'Release';
    assert.equal(await run(), undefined);
    assert.equal(executed.length, 0); assert.match(errors[0], /requires a Debug configuration/);
    config.configuration = 'Debug'; sdkVersion = '10.0.401'; errors = [];
    assert.equal(await run(), undefined);
    assert.equal(executed.length, 0); assert.match(errors[0], /\.NET 11 SDK/);
});
test('with the option off, CoreCLR Run Without Debugging keeps failing clearly and points to the option', async () => {
    settings.coreClrHotReload = false;
    assert.equal(await run(), undefined);
    assert.equal(executed.length, 0); assert.match(errors[0], /F5 debugging/); assert.match(errors[0], /coreClrHotReload/);
});
test('F5 debugging is unchanged when Hot Reload is enabled', async () => {
    const launch = await new MonoDebugConfigurationProvider().resolveDebugConfiguration(undefined,
        { type: 'dotnet-meteor.debugger', name: 'Debug', request: 'launch' });
    assert.ok(launch, errors.join('\n'));
    assert.equal(launch.meteorRuntime, 'coreclr'); assert.equal(launch.program, app);
    assert.equal(executed.length, 0);
});
test('Mono Run Without Debugging is unchanged when Hot Reload is enabled', async () => {
    settings.runtime = 'auto'; config.targetFramework = 'net10.0-ios'; properties.UseMonoRuntime = 'true';
    const launch = await run();
    assert.ok(launch, errors.join('\n'));
    assert.equal(launch.meteorRuntime, 'mono'); assert.equal(launch.skipDebug, true);
    assert.equal(executed.length, 0);
});
test('package contributes an opt-in, application-scoped Hot Reload option and task type', () => {
    const contributes = require('../package.json').contributes;
    const settingsByName = Object.fromEntries(contributes.configuration.flatMap(section => Object.entries(section.properties)));
    for (const name of ['dotnetMeteor.coreClrHotReload', 'dotnetMeteor.coreClrHotReloadPartialStaticRegistrar']) {
        assert.equal(settingsByName[name].type, 'boolean', name);
        assert.equal(settingsByName[name].default, false, name);
        assert.equal(settingsByName[name].scope, 'application', name);
    }
    assert.ok(contributes.taskDefinitions.some(definition => definition.type === hotReloadTaskDefinitionId));
});
