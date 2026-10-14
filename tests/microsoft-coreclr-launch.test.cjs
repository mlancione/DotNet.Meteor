const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { promisify } = require('node:util');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-ms-launch-'));
const app = path.join(root, 'app with spaces.app'), host = path.join(root, 'host.dylib');
fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'libvsdbgremotecoreclrtarget.dylib'), 'agent'); fs.writeFileSync(host, 'host');
const launcher = path.join(root, 'mlaunch'); fs.writeFileSync(launcher, 'fixture');
let uuidMismatch;
const rawAgent = path.join(root, 'source-agent.dylib'); fs.writeFileSync(rawAgent, 'agent');
let spawns, execs, stopped, errors, messages, factory, trackers, deferred;
const childProcess = {
    execFile: Object.assign(() => {}, { [promisify.custom]: async (file, args, options) => {
        execs.push({ file, args, options });
        if (file.endsWith('dwarfdump')) { return { stdout: `UUID: ${uuidMismatch && args.at(-1).startsWith(app) ? 'BBBB' : 'AAAA'} (arm64) fixture`, stderr: '' }; }
        if (file.endsWith('PlistBuddy')) { return deferred ?? { stdout: 'org.example.debuggerprobe\n', stderr: '' }; }
        return { stdout: '', stderr: '' };
    } }),
    spawn: (file, args, options) => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.pid = 1234; child.exitCode = child.signalCode = null; child.kills = [];
        child.kill = signal => { child.kills.push(signal); child.signalCode = signal; queueMicrotask(() => child.emit('close')); };
        spawns.push({ file, args, options, child }); queueMicrotask(() => child.emit('spawn')); return child;
    }
};
const vscode = {
    window: { createOutputChannel: () => ({ append: value => messages.push(value), dispose() {} }), showErrorMessage: value => errors.push(value) },
    debug: { stopDebugging: async session => stopped.push(session) }
};
const load = Module._load;
Module._load = function(id, ...args) {
    if (id === 'vscode') { return vscode; }
    if (id === 'child_process') { return childProcess; }
    return load.call(this, id, ...args);
};
const { MicrosoftCoreClrLaunchTracker } = require('../src/VSCode/providers/microsoftCoreClrLaunchTracker.ts');
const { debuggerComponentHash } = require('../src/VSCode/interop/microsoftDebugger.ts');
const flush = async () => { for (let i = 0; i < 5; i++) { await new Promise(setImmediate); } };
function session(id = 'session1') {
    return { id, type: 'coreclr_mobile', configuration: { meteorCoreClrDebugger: 'microsoft', meteorMicrosoftLaunch: {
        app, device: '11111111-2222-3333-4444-555555555555', mlaunch: launcher, hostLibrary: host,
        hostHash: debuggerComponentHash(host), targetHash: debuggerComponentHash(rawAgent), targetLibrary: rawAgent,
        cwd: root, env: { DOTNET_ROOT: '/selected sdk', DEVELOPER_DIR: '/selected Xcode' },
        applicationEnvironment: { CUSTOM: 'value with spaces' }, args: ['one two'], port: 51234, uninstall: false
    } } };
}
function tracker(s = session()) { const t = factory.createDebugAdapterTracker(s); trackers.push(t); return t; }
const ready = t => t.onDidSendMessage({ type: 'response', command: 'configurationDone', success: true });
beforeEach(() => { spawns = []; execs = []; stopped = []; errors = []; messages = []; trackers = []; deferred = undefined; uuidMismatch = false; factory = new MicrosoftCoreClrLaunchTracker(); });
afterEach(async () => { for (const t of trackers) { t?.onWillStopSession(); } await flush(); factory.dispose(); });
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('Microsoft simulator launch waits for successful configurationDone and owns exactly one launcher', async () => {
    const t = tracker();
    t.onWillReceiveMessage({ type: 'request', command: 'launch' }); await flush(); assert.equal(spawns.length, 0);
    ready(t); ready(t); await flush(); assert.equal(spawns.length, 1);
    const launch = spawns[0]; assert.equal(launch.file, launcher); assert.equal(launch.options.cwd, root);
    assert.equal(launch.options.env.DOTNET_ROOT, '/selected sdk');
    assert.ok(launch.args.includes('--setenv=CUSTOM=value with spaces')); assert.ok(launch.args.includes('--argument=one two'));
    assert.ok(launch.args.includes('--setenv=CORECLR_PROFILER_PATH=libvsdbgremotecoreclrtarget.dylib'));
    assert.ok(launch.args.includes('--setenv=CORECLR_REMOTE_DEBUGGER_ISSERVER=false'));
    assert.ok(!launch.args.some(value => value.includes('libremotecoreclrtarget')));
});
test('disconnect before app startup never launches or terminates an existing simulator app', async () => {
    const t = tracker(); t.onWillReceiveMessage({ command: 'disconnect' }); ready(t); await flush();
    assert.equal(spawns.length, 0); assert.equal(execs.length, 0);
});
test('disconnect during asynchronous bundle inspection prevents a late app launch', async () => {
    let resolve; deferred = new Promise(r => { resolve = r; });
    const t = tracker(); ready(t); await flush(); t.onWillReceiveMessage({ command: 'disconnect' });
    resolve({ stdout: 'org.example.debuggerprobe', stderr: '' }); await flush();
    assert.equal(spawns.length, 0); assert.ok(!execs.some(call => call.args.includes('terminate')));
});
test('stopping cleans up only the owned launcher and selected simulator bundle', async () => {
    const t = tracker(); ready(t); await flush(); t.onWillStopSession(); t.onExit(); await flush();
    assert.deepEqual(spawns[0].child.kills, ['SIGTERM']);
    const termination = execs.filter(call => call.args.includes('terminate'));
    assert.equal(termination.length, 1); assert.deepEqual(termination[0].args, ['simctl', 'terminate', session().configuration.meteorMicrosoftLaunch.device, 'org.example.debuggerprobe']);
});
test('adapter launch failure and component mismatch prevent simulator startup', async () => {
    const t = tracker(); t.onDidSendMessage({ type: 'response', command: 'launch', success: false }); ready(t); await flush();
    assert.equal(spawns.length, 0);
    const s = session('mismatch'); s.configuration.meteorMicrosoftLaunch.targetHash = 'old component'; ready(tracker(s)); await flush();
    assert.equal(spawns.length, 0); assert.match(errors[0], /no longer match/); assert.equal(stopped.length, 1);
});
test('launcher failure stops the owning debugger session and reports diagnostics', async () => {
    const s = session(); const t = tracker(s); ready(t); await flush(); spawns[0].child.emit('error', new Error('spawn failed')); await flush();
    assert.deepEqual(stopped, [s]); assert.match(errors[0], /spawn failed/);
});
test('same simulator cannot be owned by simultaneous Microsoft sessions', async () => {
    ready(tracker()); await flush(); ready(tracker(session('other'))); await flush();
    assert.equal(spawns.length, 1); assert.match(errors[0], /already owns this simulator/);
});
test('attachment deadline stops an unresponsive session and clears on runtime thread event', async () => {
    const oldSet = global.setTimeout, oldClear = global.clearTimeout; let pending;
    global.setTimeout = (cb, ms) => { assert.equal(ms, 120000); pending = cb; return { unref() {} }; };
    global.clearTimeout = () => { pending = undefined; };
    try {
        const t = tracker(); t.onWillReceiveMessage({ command: 'configurationDone' }); assert.ok(pending);
        t.onDidSendMessage({ type: 'event', event: 'process' }); assert.ok(pending); // Microsoft emits this before the app connects.
        t.onDidSendMessage({ type: 'event', event: 'thread' }); assert.equal(pending, undefined);
        const second = tracker(session('deadline')); second.onWillReceiveMessage({ command: 'configurationDone' }); pending(); await flush();
        assert.match(errors[0], /120 seconds/); assert.equal(stopped.length, 1);
    } finally { global.setTimeout = oldSet; global.clearTimeout = oldClear; }
});
test('unrelated Mono, clrdbg and Microsoft-owned sessions have no Meteor launch side effects', () => {
    for (const s of [{ type: 'dotnet-meteor.debugger', configuration: {} }, { type: 'coreclr_mobile', configuration: {} }]) {
        assert.equal(factory.createDebugAdapterTracker(s), undefined);
    }
});

test('agent re-signing is accepted when source snapshot and Mach-O UUID match', async () => {
    const bundled = path.join(app, 'libvsdbgremotecoreclrtarget.dylib'); fs.writeFileSync(bundled, 're-signed bytes');
    try { ready(tracker()); await flush(); assert.equal(spawns.length, 1); } finally { fs.writeFileSync(bundled, 'agent'); }
});
test('different target Mach-O UUID prevents app launch even when source hash matches', async () => {
    uuidMismatch = true; ready(tracker()); await flush(); assert.equal(spawns.length, 0); assert.match(errors[0], /different Microsoft target library/);
});
