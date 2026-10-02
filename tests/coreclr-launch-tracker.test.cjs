const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename);
const stopped = [], errors = [];
const vscode = { debug: { stopDebugging: async session => stopped.push(session) }, window: { showErrorMessage: value => errors.push(value) } };
const load = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : load.call(this, id, ...args); };
const { CoreClrLaunchTracker } = require('../src/VSCode/providers/coreClrLaunchTracker.ts');
const session = { configuration: { meteorRuntime: 'coreclr' } };
function withTimer(run) {
    const oldSet = global.setTimeout, oldClear = global.clearTimeout;
    let pending;
    global.setTimeout = (callback, ms) => { assert.equal(ms, 120000); pending = callback; return { unref() {} }; };
    global.clearTimeout = () => { pending = undefined; };
    stopped.length = errors.length = 0;
    try { run(() => pending); } finally { global.setTimeout = oldSet; global.clearTimeout = oldClear; }
}
test('attachment deadline starts when the engine actually starts the application', () => withTimer(pending => {
    const tracker = new CoreClrLaunchTracker().createDebugAdapterTracker(session);
    tracker.onWillReceiveMessage({ type: 'request', command: 'launch' }); assert.equal(pending(), undefined);
    tracker.onWillReceiveMessage({ type: 'request', command: 'configurationDone' }); pending()();
    assert.deepEqual(stopped, [session]); assert.match(errors[0], /120 seconds/);
}));
test('attachment, errors, termination and cancellation all clear the deadline', () => withTimer(pending => {
    for (const message of [{ type: 'event', event: 'process' }, { type: 'event', event: 'stopped' }, { type: 'event', event: 'terminated' }, { type: 'response', success: false }]) {
        const tracker = new CoreClrLaunchTracker().createDebugAdapterTracker(session);
        tracker.onWillReceiveMessage({ type: 'request', command: 'configurationDone' });
        tracker.onDidSendMessage(message); assert.equal(pending(), undefined);
    }
    for (const method of ['onWillStopSession', 'onError', 'onExit']) {
        const tracker = new CoreClrLaunchTracker().createDebugAdapterTracker(session);
        tracker.onWillReceiveMessage({ type: 'request', command: 'configurationDone' }); tracker[method](); assert.equal(pending(), undefined);
    }
    const tracker = new CoreClrLaunchTracker().createDebugAdapterTracker(session);
    tracker.onWillReceiveMessage({ type: 'request', command: 'configurationDone' });
    tracker.onWillReceiveMessage({ type: 'request', command: 'disconnect' }); assert.equal(pending(), undefined);
    assert.equal(stopped.length, 0);
}));
test('CoreCLR deadline never changes Mono sessions', () => {
    assert.equal(new CoreClrLaunchTracker().createDebugAdapterTracker({ configuration: { meteorRuntime: 'mono' } }), undefined);
});
