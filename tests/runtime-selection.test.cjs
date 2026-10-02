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

let settings, selected, calls, properties, errors, activeSession;
const vscode = {
    ThemeIcon: class {}, ThemeColor: class {}, QuickPickItemKind: { Separator: -1 },
    Uri: { file: value => value }, ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => ({
        get: key => settings[key],
        update: async (key, value, target) => { calls.push({ key, value, target }); settings[key] = value; }
    }) },
    window: {
        showQuickPick: async items => items.find(item => item.preference === selected),
        showErrorMessage: value => errors.push(value), showInformationMessage: value => errors.push(value)
    },
    debug: { get activeDebugSession() { return activeSession; } },
    TaskScope: { Workspace: 1 },
    ShellExecution: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
    CustomExecution: class { constructor(callback) { this.callback = callback; } },
    EventEmitter: class {
        constructor() { this.listeners = []; this.event = callback => this.listeners.push(callback); }
        fire(value) { this.listeners.forEach(callback => callback(value)); }
        dispose() { this.listeners = []; }
    },
    Task: class { constructor(definition, scope, name, source, execution) { this.execution = execution; } },
    DebugAdapterExecutable: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } }
};
const load = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : load.call(this, id, ...args); };
const { selectMobileRuntime, getRuntimePreference, getCoreClrReadyToRunPreference } = require('../src/VSCode/models/runtimeSelection.ts');
const { Interop } = require('../src/VSCode/interop/interop.ts');
const { getCoreClrPaths } = require('../src/VSCode/interop/coreClr.ts');
const { ProcessRunner } = require('../src/VSCode/interop/processRunner.ts');
const { ConfigurationController: config } = require('../src/VSCode/controllers/configurationController.ts');
const { StatusBarController: status } = require('../src/VSCode/controllers/statusbarController.ts');
const { DotNetTaskProvider } = require('../src/VSCode/providers/dotnetTaskProvider.ts');
const { MonoDebugConfigurationProvider } = require('../src/VSCode/providers/monoDebugConfigurationProvider.ts');
const { MonoDebugAdapterFactory } = require('../src/VSCode/providers/monoDebugAdapterFactory.ts');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-runtime-')));
const original = { platform: process.platform, sync: ProcessRunner.runSync, onMac: config.onMac, onWindows: config.onWindows };
const executable = path.join(root, 'stable dotnet');
const experimental = path.join(root, 'preview dotnet');
const developer = path.join(root, 'Xcode.app', 'Contents', 'Developer');
fs.mkdirSync(developer, { recursive: true });
for (const p of [executable, experimental]) { fs.writeFileSync(p, 'fixture', { mode: 0o755 }); }
const app = path.join(root, 'bin', 'meteor-coreclr', 'Debug', 'App.app');
const adapter = path.join(root, 'extension', 'bin', 'CoreClr', 'clrdbg');
const host = path.join(root, 'extension', 'bin', 'Remote', 'remote-host', `osx-${process.arch}`, 'libremotecoreclrhost.dylib');
const agent = path.join(root, 'extension', 'bin', 'Remote', 'remote-target', 'ios', 'iossimulator-arm64', 'libremotecoreclrtarget.dylib');
const wrapper = path.join(root, 'extension', 'coreclr-adapter.cjs');
for (const p of [adapter, host, agent, wrapper]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'fixture'); }
beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    config.onMac = true; config.onWindows = false;
    settings = { dotnetPath: executable, runtime: 'auto' };
    calls = []; properties = {}; errors = []; activeSession = undefined; selected = undefined;
    config.project = { path: path.join(root, 'App.csproj'), frameworks: ['net10.0-ios', 'net11.0-ios27.0'], configurations: ['Debug'] };
    config.targetFramework = 'net10.0-ios'; config.configuration = 'Debug';
    config.noDebug = false; config.profiler = undefined;
    config.device = { name: 'iPad', platform: 'ios', serial: 'selected-udid', runtime_id: 'iossimulator-arm64', is_emulator: true };
    status.devices = [config.device]; Interop.extensionPath = root;
    ProcessRunner.runSync = (builder, context) => {
        const args = builder.getArguments(); calls.push({ command: builder.getCommand(), args, context });
        if (builder.getCommand() === '/usr/bin/xcode-select') { return developer; }
        if (args.includes('--version')) { return '11.0.100-rc.2'; }
        const query = args.find(arg => arg.startsWith('-getProperty:')) ?? '';
        if (query.includes('UseMonoRuntime')) { return JSON.stringify({ Properties: properties }); }
        if (query.includes('XcodeLocation')) {
            return JSON.stringify({ Properties: { XcodeLocation: path.join(root, 'Xcode.app'), MlaunchPath: experimental } });
        }
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

test('defaults follow evaluated runtime instead of a framework-name debugger ban', () => {
    assert.equal(selectMobileRuntime('auto', 'net10.0-ios', { UseMonoRuntime: 'true' }), 'mono');
    assert.equal(selectMobileRuntime('auto', 'net10.0-android', { UseMonoRuntime: 'false' }), 'coreclr');
    assert.equal(selectMobileRuntime('auto', 'net11.0-ios27.0', { UseMonoRuntime: 'false' }), 'coreclr');
    assert.equal(selectMobileRuntime('auto', 'net11.0-maccatalyst27.0', {}), 'coreclr');
});
test('unsupported runtime choices explain the actual SDK/TFM prerequisite', () => {
    for (const framework of ['net10.0-ios', 'net10.0-ios27.0', 'net10.0-maccatalyst26.5']) {
        assert.throws(() => selectMobileRuntime('coreclr', framework, {}), /requires .NET 11\+/);
    }
    assert.throws(() => selectMobileRuntime('coreclr', 'net9.0-android35.0', {}), /requires .NET 10\+/);
    assert.throws(() => selectMobileRuntime('mono', 'net11.0-ios27.0', {}), /does not support Mono/);
    assert.throws(() => selectMobileRuntime('auto', 'net11.0-ios', { PublishAot: 'true' }), /NativeAOT/);
    assert.throws(() => getRuntimePreference('bad'), /must be/);
});
test('status-bar runtime picker writes one global extension setting', async () => {
    selected = 'coreclr'; await status.showQuickPickRuntime();
    assert.deepEqual(calls, [{ key: 'runtime', value: 'coreclr', target: vscode.ConfigurationTarget.Global }]);
    assert.equal(settings.runtime, 'coreclr');
});
test('picker cancellation and an active debug session leave the setting untouched', async () => {
    await status.showQuickPickRuntime(); assert.equal(calls.length, 0);
    activeSession = { type: 'dotnet-meteor.debugger' }; selected = 'coreclr';
    await status.showQuickPickRuntime(); assert.equal(calls.length, 0); assert.match(errors[0], /Stop the active/);
});
test('Mono default preserves existing output paths and build switches', () => {
    properties.UseMonoRuntime = 'true';
    const task = new DotNetTaskProvider().getTask({ type: 'dotnet-meteor.task' });
    assert.ok(task.execution.args.includes('-p:MtouchDebug=true'));
    assert.ok(!task.execution.args.some(arg => /meteor-coreclr|EnableDiagnostics|UseMonoRuntime/.test(arg)));
});
test('CoreCLR build and path evaluation share runtime, output paths, SDK host and cwd', () => {
    settings.runtime = 'coreclr'; settings.coreClrDotnetPath = experimental;
    config.targetFramework = 'net11.0-ios27.0'; properties.UseMonoRuntime = 'false';
    const task = new DotNetTaskProvider().getTask({ type: 'dotnet-meteor.task' });
    const build = Interop.getBuildContext(config.project, 'Debug', config.device);
    config.getProgramPath(config.project, 'Debug', config.device, build);
    const query = calls.find(call => call.args?.includes('-getProperty:TargetPath'));
    assert.equal(task.execution.command, experimental); assert.equal(query.command, experimental);
    assert.equal(task.execution.options.cwd, root); assert.equal(query.context.cwd, root);
    for (const property of ['-p:UseMonoRuntime=false', '-p:EnableDiagnostics=true', '-p:BaseIntermediateOutputPath=obj/meteor-coreclr/', '-p:BaseOutputPath=bin/meteor-coreclr/']) {
        assert.ok(task.execution.args.includes(property), property); assert.ok(query.args.includes(property), property);
    }
    assert.ok(!task.execution.args.includes('-p:MtouchDebug=true'));
    assert.ok(!task.execution.args.some(arg => arg.includes('ValidateXcodeVersion')));
});
test('build preflight rejects incompatible targets and conflicting runtime arguments', () => {
    settings.runtime = 'coreclr';
    assert.throws(() => new DotNetTaskProvider().getBuildTask({ type: 'dotnet-meteor.task' }), /requires .NET 11/);
    config.targetFramework = 'net11.0-ios'; config.project.frameworks.push('net11.0-ios');
    assert.throws(() => new DotNetTaskProvider().getBuildTask({ type: 'dotnet-meteor.task', args: ['-p:UseMonoRuntime=true'] }), /conflicting task argument/);
    assert.throws(() => new DotNetTaskProvider().getBuildTask({ type: 'dotnet-meteor.task', args: ['/property:Other=1;UseMonoRuntime=true'] }), /conflicting task argument/);
    assert.throws(() => new DotNetTaskProvider().getBuildTask({ type: 'dotnet-meteor.task', args: ['-p:OutputPath=other'] }), /conflicting task argument/);
    assert.throws(() => new DotNetTaskProvider().getBuildTask({ type: 'dotnet-meteor.task', args: ['--framework', 'net10.0-ios'] }), /conflicting task argument/);
});
test('unavailable runtime stays a registered task and fails with its prerequisite', async () => {
    settings.runtime = 'coreclr';
    const task = new DotNetTaskProvider().getTask({ type: 'dotnet-meteor.task' });
    assert.ok(task.execution instanceof vscode.CustomExecution);
    const terminal = await task.execution.callback();
    const output = [], exits = [];
    terminal.onDidWrite(value => output.push(value)); terminal.onDidClose(value => exits.push(value));
    terminal.open(); terminal.close();
    assert.deepEqual(exits, [1]); assert.match(output[0], /requires .NET 11/);
});
test('CoreCLR resolver preserves launch.json identity and uses the selected device and project tools', async () => {
    settings.runtime = 'coreclr'; settings.coreClrDotnetPath = experimental;
    config.targetFramework = 'net11.0-ios27.0'; properties.UseMonoRuntime = 'false';
    const launch = await new MonoDebugConfigurationProvider().resolveDebugConfiguration(undefined, {
        type: 'dotnet-meteor.debugger', name: 'Existing launch', request: 'launch', preLaunchTask: 'dotnet-meteor: Build'
    });
    assert.ok(launch, errors.join('\n')); assert.equal(launch.type, 'dotnet-meteor.debugger');
    assert.equal(launch.meteorRuntime, 'coreclr'); assert.equal(launch.program, app);
    assert.equal(launch.coreClrMobileDebuggerOptions.device, 'selected-udid');
    assert.equal(launch.coreClrMobileDebuggerOptions.assetsPath, app);
    assert.equal(launch.toolEnvironment.MLAUNCH_PATH, experimental);
    assert.equal(launch.toolEnvironment.DEVELOPER_DIR, developer);
    assert.equal(launch.dotnetExecutable, experimental);
    assert.equal(launch.targetFramework, 'net11.0-ios27.0');
    // The descriptor uses the resolved session, even if the global setting changes later.
    settings.runtime = 'mono';
    const descriptor = new MonoDebugAdapterFactory().createDebugAdapterDescriptor({ configuration: launch }, undefined);
    assert.equal(descriptor.command, process.execPath); assert.deepEqual(descriptor.args, [wrapper, adapter]); assert.equal(descriptor.options.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(descriptor.options.env.MLAUNCH_PATH, experimental);
});
test('SDK defaults automatically route a .NET 11 project through CoreCLR', async () => {
    config.targetFramework = 'net11.0-ios27.0'; properties.UseMonoRuntime = 'false';
    const launch = await new MonoDebugConfigurationProvider().resolveDebugConfiguration(undefined, { type: 'dotnet-meteor.debugger', name: 'Auto', request: 'launch' });
    assert.equal(launch.meteorRuntime, 'coreclr');
});
test('unsupported experimental modes stop before starting the wrong adapter', async () => {
    settings.runtime = 'coreclr'; config.targetFramework = 'net11.0-ios27.0';
    const launch = await new MonoDebugConfigurationProvider().resolveDebugConfiguration(undefined, { type: 'dotnet-meteor.debugger', name: 'Run', request: 'launch', noDebug: true });
    assert.equal(launch, undefined); assert.match(errors[0], /F5 debugging/);
});
test('missing CoreCLR agents are reported before an app build or launch', () => {
    config.device.runtime_id = 'iossimulator-unsupported';
    assert.throws(() => getCoreClrPaths(root, config.device), /component is missing/);
});
test('runtime selection preserves existing custom MSBuild imports', () => {
    settings.runtime = 'coreclr'; config.targetFramework = 'net11.0-ios27.0';
    properties.CustomAfterMicrosoftCommonTargets = '/custom/After.targets';
    properties.CustomBeforeMicrosoftCommonProps = '/custom/Before.props';
    const build = Interop.getBuildContext(config.project, 'Debug', config.device);
    assert.ok(build.properties.includes('-p:MeteorOriginalAfterTargets=/custom/After.targets'));
    assert.ok(build.properties.includes('-p:MeteorOriginalBeforeProps=/custom/Before.props'));
    assert.ok(build.properties.includes(`-p:CustomBeforeMicrosoftCommonProps=${path.join(root, 'extension/CoreClr.props')}`));
});

test('reserved profiler environment values fail clearly instead of crashing mobile initialization', async () => {
    settings.runtime = 'coreclr'; config.targetFramework = 'net11.0-ios27.0';
    const launch = await new MonoDebugConfigurationProvider().resolveDebugConfiguration(undefined, {
        type: 'dotnet-meteor.debugger', name: 'Conflict', request: 'launch', env: { CORECLR_PROFILER: 'other-profiler' }
    });
    assert.equal(launch, undefined); assert.match(errors[0], /controls these launch environment variables: CORECLR_PROFILER/);
});
test('Mono descriptor retains the existing hardened executable and merged tool environment', () => {
    const original = { command: '/mono-adapter', args: ['--existing'], options: { env: { EXISTING: 'yes' }, cwd: '/original' } };
    const descriptor = new MonoDebugAdapterFactory().createDebugAdapterDescriptor({ configuration: {
        meteorRuntime: 'mono', toolWorkingDirectory: root, toolEnvironment: { MLAUNCH_PATH: experimental }
    } }, original);
    assert.equal(descriptor.command, original.command); assert.deepEqual(descriptor.args, original.args);
    assert.equal(descriptor.options.cwd, root); assert.equal(descriptor.options.env.EXISTING, 'yes');
    assert.equal(descriptor.options.env.MLAUNCH_PATH, experimental);
});

test('ReadyToRun is global, defaults to disabled and rejects an invalid preference', () => {
    const setting = require('../package.json').contributes.configuration.flatMap(section => Object.entries(section.properties))
        .find(([name]) => name === 'dotnetMeteor.coreClrReadyToRun')[1];
    assert.equal(setting.scope, 'application'); assert.equal(setting.default, 'disabled');
    assert.deepEqual(setting.enum, ['default', 'disabled', 'enabled']);
    assert.equal(getCoreClrReadyToRunPreference(undefined), 'disabled');
    assert.throws(() => getCoreClrReadyToRunPreference('bad'), /must be default, disabled or enabled/);
});
for (const [preference, expected] of [[undefined, false], ['disabled', false], ['enabled', true], ['default', undefined]]) {
    test(`CoreCLR ReadyToRun ${preference ?? 'initial default'} reaches the build and every scoped query`, () => {
        settings.runtime = 'coreclr'; settings.coreClrReadyToRun = preference;
        config.targetFramework = 'net11.0-ios27.0'; properties.UseMonoRuntime = 'false';
        const task = new DotNetTaskProvider().getBuildTask({ type: 'dotnet-meteor.task' });
        const build = Interop.getBuildContext(config.project, 'Debug', config.device);
        config.getProgramPath(config.project, 'Debug', config.device, build);
        const argument = `-p:PublishReadyToRun=${expected}`;
        const matches = args => args.filter(arg => arg.startsWith('-p:PublishReadyToRun='));
        assert.deepEqual(matches(task.execution.args), expected === undefined ? [] : [argument]);
        const queries = calls.filter(call => call.args?.some(arg => /^-getProperty:(TargetPath|_AppBundleName|XcodeLocation)/.test(arg)));
        assert.ok(queries.length >= 3);
        for (const query of queries) {
            assert.deepEqual(matches(query.args), expected === undefined ? [] : [argument]);
        }
        // Capture once for a build: later setting changes must not alter its queries.
        settings.coreClrReadyToRun = preference === 'enabled' ? 'disabled' : 'enabled';
        Interop.getPropertyValue('TargetPath', config.project, 'Debug', config.device, build);
        assert.deepEqual(matches(calls.at(-1).args), expected === undefined ? [] : [argument]);
    });
}
test('ReadyToRun does not change Mono or desktop build properties, including an invalid unused setting', () => {
    settings.coreClrReadyToRun = 'bad'; properties.UseMonoRuntime = 'true';
    const mono = new DotNetTaskProvider().getBuildTask({ type: 'dotnet-meteor.task' });
    assert.ok(!mono.execution.args.some(arg => /PublishReadyToRun/.test(arg)));
    config.targetFramework = 'net10.0';
    const desktop = Interop.getBuildContext(config.project, 'Debug', undefined);
    assert.deepEqual(desktop.properties, []);
});
test('ReadyToRun applies consistently to a local CoreCLR Release debugging configuration', () => {
    settings.runtime = 'coreclr'; config.targetFramework = 'net11.0-ios27.0'; config.configuration = 'Release';
    assert.ok(new DotNetTaskProvider().getBuildTask({ type: 'dotnet-meteor.task' }).execution.args.includes('-p:PublishReadyToRun=false'));
});
test('ReadyToRun cannot be changed by task-only overrides that bypass path and debugger queries', () => {
    settings.runtime = 'coreclr'; config.targetFramework = 'net11.0-ios27.0';
    for (const arg of ['-p:PublishReadyToRun=true', '/property:Other=1;PublishReadyToRun=false']) {
        assert.throws(() => new DotNetTaskProvider().getBuildTask({ type: 'dotnet-meteor.task', args: [arg] }), /conflicting task argument/);
    }
});
