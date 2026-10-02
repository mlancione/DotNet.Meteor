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
let configuredDotnet = '';
const vscode = {
    ThemeIcon: class {}, QuickPickItemKind: { Separator: -1 },
    Uri: { file: value => value }, workspace: { getConfiguration: () => ({ get: key => key === 'dotnetPath' ? configuredDotnet : undefined }) },
    TaskScope: { Workspace: 1 },
    ShellExecution: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
    Task: class { constructor(definition, scope, name, source, execution) { this.execution = execution; } },
    DebugAdapterExecutable: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } }
};
const load = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : load.call(this, id, ...args); };
const { resolveToolContext } = require('../src/VSCode/interop/toolContext.ts');
const { ProcessRunner } = require('../src/VSCode/interop/processRunner.ts');
const { Interop } = require('../src/VSCode/interop/interop.ts');
const { ConfigurationController: config } = require('../src/VSCode/controllers/configurationController.ts');
const { DotNetTaskProvider } = require('../src/VSCode/providers/dotnetTaskProvider.ts');
const { MonoDebugAdapterFactory } = require('../src/VSCode/providers/monoDebugAdapterFactory.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-context-'));
const executable = path.join(root, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const developer = path.join(root, 'Xcode.app', 'Contents', 'Developer');
fs.mkdirSync(developer, { recursive: true });
fs.writeFileSync(executable, 'fixture');
fs.chmodSync(executable, 0o755);
const oldPlatform = process.platform;
const oldPath = process.env.PATH;
const oldLauncher = process.env.MLAUNCH_PATH;
const originalSync = ProcessRunner.runSync;
const originalAsync = ProcessRunner.runAsync;
let calls;
beforeEach(() => {
    configuredDotnet = executable;
    delete process.env.MLAUNCH_PATH;
    calls = [];
    config.project = { path: path.join(root, 'App.csproj'), frameworks: ['net10.0-ios'], configurations: ['Debug'] };
    config.targetFramework = 'net10.0-ios';
    config.configuration = 'Debug';
    config.device = { platform: 'ios', serial: 'selected-udid', runtime_id: 'iossimulator-arm64', is_emulator: true };
    ProcessRunner.runSync = (builder, options) => {
        calls.push({ command: builder.getCommand(), args: builder.getArguments(), options });
        if (builder.getCommand() === '/usr/bin/xcode-select') { return developer; }
        const names = builder.getArguments().find(arg => arg.startsWith('-getProperty:'));
        if (names?.includes(',')) {
            return JSON.stringify({ Properties: { XcodeLocation: path.join(root, 'Xcode.app'), MlaunchPath: executable } });
        }
        return 'value';
    };
});
after(() => {
    ProcessRunner.runSync = originalSync;
    ProcessRunner.runAsync = originalAsync;
    Object.defineProperty(process, 'platform', { value: oldPlatform });
    process.env.PATH = oldPath;
    if (oldLauncher === undefined) { delete process.env.MLAUNCH_PATH; } else { process.env.MLAUNCH_PATH = oldLauncher; }
    fs.rmSync(root, { recursive: true, force: true });
});
test('explicit host and PATH resolution use absolute executable, cwd and authoritative root', () => {
    const explicit = resolveToolContext(config.project.path, executable);
    assert.equal(explicit.executable, fs.realpathSync(executable));
    assert.equal(explicit.env.DOTNET_ROOT, fs.realpathSync(root));
    assert.equal(explicit.cwd, root);
    process.env.PATH = root;
    assert.equal(resolveToolContext(config.project.path).executable, explicit.executable);
    assert.throws(() => resolveToolContext(config.project.path, path.join(root, 'missing')), /Cannot find dotnet/);
});
test('build and property queries share SDK host, project cwd, TFM and RID', () => {
    // Exercise Apple launch properties on every CI host without invoking real Apple tools.
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const task = new DotNetTaskProvider().getTask({ type: 'dotnet-meteor.task' });
    Interop.getPropertyValue('TargetPath', config.project, 'Debug', config.device);
    assert.equal(task.execution.command, fs.realpathSync(executable));
    assert.equal(task.execution.options.cwd, root);
    const query = calls.find(call => call.args.includes('-getProperty:TargetPath'));
    assert.equal(query.command, task.execution.command);
    assert.equal(query.options.cwd, task.execution.options.cwd);
    assert.equal(query.options.env.DOTNET_ROOT, task.execution.options.env.DOTNET_ROOT);
    assert.ok(query.args.includes('-p:TargetFramework=net10.0-ios'));
    assert.ok(query.args.includes('-p:RuntimeIdentifier=iossimulator-arm64'));
    assert.equal(task.execution.options.env.DEVELOPER_DIR, developer);
    assert.equal(task.execution.options.env.MLAUNCH_PATH, executable);
});
test('project-evaluated launcher is scoped to the adapter and explicit override wins', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const tools = Interop.getProjectToolContext(config.project, 'Debug', config.device);
    assert.equal(process.env.MLAUNCH_PATH, undefined);
    const descriptor = new MonoDebugAdapterFactory().createDebugAdapterDescriptor({ configuration: {
        toolEnvironment: tools.env, toolWorkingDirectory: tools.cwd
    } }, new vscode.DebugAdapterExecutable('adapter', [], {}));
    assert.equal(descriptor.options.env.MLAUNCH_PATH, executable);
    assert.equal(descriptor.options.env.METEOR_TARGET_FRAMEWORK, 'net10.0-ios');
    process.env.MLAUNCH_PATH = path.join(root, 'override');
    fs.writeFileSync(process.env.MLAUNCH_PATH, 'tool');
    assert.equal(Interop.getProjectToolContext(config.project, 'Debug', config.device).env.MLAUNCH_PATH, process.env.MLAUNCH_PATH);
});
test('simultaneous platform refreshes coalesce, cache, and preserve Apple success when Android fails', async () => {
    Interop.deviceCache.clear(); Interop.deviceRequests.clear();
    let count = 0;
    const ios = [{ platform: 'ios', serial: 'udid' }];
    ProcessRunner.runAsync = async builder => {
        count++;
        const platform = builder.getArguments()[1];
        if (platform === 'android') { throw new Error('adb unavailable'); }
        return platform === 'ios' ? ios : [];
    };
    const [first, second] = await Promise.all([Interop.getDevices('ios'), Interop.getDevices('ios')]);
    assert.equal(count, 1); assert.equal(first, second);
    await Interop.getDevices('ios'); assert.equal(count, 1);
    const all = await Interop.getDevices();
    assert.deepEqual(all, ios);
    assert.equal(count, 3);
    assert.equal(Interop.deviceRequests.size, 0);
});
