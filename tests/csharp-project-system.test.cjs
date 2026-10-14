const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { PassThrough } = require('node:stream');
const ts = require('typescript');
const { encode } = require('msgpack-lite');
const { FullDuplexStream, MultiplexingStream } = require('nerdbank-streams');
const { createMessageConnection, ParameterStructures } = require('vscode-jsonrpc/node');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, f);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-csharp-')));
const project = path.join(root, 'App.csproj'), library = path.join(root, 'Library.csproj');
const dll = path.join(root, 'bin/meteor-coreclr-microsoft/DebugCoreCLR/net11.0-ios/App.dll');
const assets = path.join(root, 'obj/meteor-coreclr-microsoft/project.assets.json');
const sdk = path.join(root, 'dotnet'), solution = path.join(root, 'App.slnx');
for (const file of [project, library, sdk, solution, dll, assets]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
}
let state, snapshots, active, requests, peers, model, tasks, errors, selection;
const vscode = {
    EventEmitter: class {
        listeners = new Set();
        event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
        fire(value) { for (const f of this.listeners) { f(value); } }
        dispose() { this.listeners.clear(); }
    },
    ProcessExecution: class { constructor(process) { this.process = process; } },
    extensions: { getExtension: () => ({ activate: async () => active }) },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: key => ({ runtime: 'coreclr', coreClrDebugger: 'microsoft' })[key] }) },
    tasks: { fetchTasks: async () => tasks },
    window: { showInformationMessage: async value => errors.push(value), showQuickPick: async () => selection },
    commands: { executeCommand: async (...args) => requests.push(args) },
    debug: {}
};
const load = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : load.call(this, id, ...args); };
const { CSharpProjectSystem, csharpProjectSystem } = require('../src/VSCode/interop/csharpProjectSystem.ts');
const { ReadOnlyBrokerClient, BrokerMessageReader, BrokerMessageWriter } = require('../src/VSCode/interop/readOnlyBrokerClient.ts');
function broker() {
    return { getPipe: async moniker => {
        requests.push(moniker.name);
        const pair = FullDuplexStream.CreatePair();
        const mux = MultiplexingStream.Create(pair.second, { protocolMajorVersion: 3, seededChannels: [{}] });
        const channel = mux.acceptChannel(0);
        const writer = new BrokerMessageWriter(channel.stream);
        const rpc = createMessageConnection(new BrokerMessageReader(channel.stream), writer);
        mux.completion.catch(() => {}); channel.completion.catch(() => {});
        rpc.onRequest('getAll', () => snapshots);
        rpc.onRequest('subscribe', observer => {
            assert.equal(observer.__jsonrpc_marshaled, 1); assert.equal(observer.lifetime, 'explicit');
            void rpc.sendNotification(`$/invokeProxy/${observer.handle}/onNext`, state);
            return { __jsonrpc_marshaled: 1, handle: 27 };
        });
        rpc.onNotification('$/releaseMarshaledObject', value => requests.push(['release', value]));
        // Any attempt to mutate the project system fails the test.
        for (const name of ['set', 'setSolutionWorkspace', 'clear', 'openNoSolutionWorkspace']) {
            rpc.onRequest(name, () => { throw new Error('Unexpected mutation: ' + name); });
        }
        rpc.listen(); peers.push({ rpc, mux, writer }); return pair.first;
    } };
}
const flush = async () => { for (let i = 0; i < 10; i++) { await new Promise(setImmediate); } };
beforeEach(() => {
    requests = []; peers = []; errors = []; selection = undefined;
    state = { version: 1, configuration: 'DebugCoreCLR|Any CPU', solutions: [solution], projects: [{ projectId: { fullPath: project } }] };
    snapshots = { [project]: { targetFramework: 'net11.0-ios', assetsFilePath: assets, keyOutputs: { 'DebugCoreCLR|AnyCPU': dll } } };
    active = { getBrokeredServiceServerPipeName: async () => 'pipe', serviceBroker: broker() };
    tasks = [{ source: 'dotnet', definition: { type: 'dotnet', file: solution }, execution: new vscode.ProcessExecution(sdk) }];
    model = new CSharpProjectSystem();
    fs.rmSync(path.join(path.dirname(assets), 'App.csproj.nuget.dgspec.json'), { force: true });
});
afterEach(async () => {
    model.dispose();
    await flush();
    for (const p of peers) { await p.writer.settled(); p.rpc.dispose(); p.mux.dispose(); }
    await flush();
});
after(() => { csharpProjectSystem.dispose(); fs.rmSync(root, { recursive: true, force: true }); });

test('read-only observer follows loaded Dev Kit configuration and ignores older updates', async () => {
    assert.deepEqual(await model.ready(project), { name: 'DebugCoreCLR', platform: 'Any CPU' });
    await peers[0].rpc.sendNotification('$/invokeProxy/1/onNext', { ...state, version: 2, configuration: 'Release|x64' });
    await flush(); assert.deepEqual(model.configuration(project), { name: 'Release', platform: 'x64' });
    await peers[0].rpc.sendNotification('$/invokeProxy/1/onNext', state);
    await flush(); assert.equal(model.configuration(project).name, 'Release');
    assert.equal(requests.filter(x => x === 'Microsoft.VisualStudio.NoDelay.EnvironmentService').length, 1);
});
test('matching framework, outputs and SDK pass with one shared subscription', async () => {
    await Promise.all([model.ready(project), model.ready(project)]);
    await model.validateBaseline(project, 'net11.0-ios', dll, assets, sdk);
    assert.equal(requests.filter(x => x === 'Microsoft.VisualStudio.NoDelay.EnvironmentService').length, 1);
    assert.equal(requests.filter(x => x === 'Microsoft.VisualStudio.ProjectCacheStateService').length, 1);
});
test('project not loaded in the editor is rejected', async () => {
    await assert.rejects(model.ready(library), /not loaded/);
});
test('wrong framework and normal output baseline are rejected before launch', async () => {
    snapshots[project].targetFramework = 'net10.0-ios';
    await assert.rejects(model.validateBaseline(project, 'net11.0-ios', dll, assets, sdk), /uses net10.0-ios/);
    snapshots[project].targetFramework = 'net11.0-ios';
    snapshots[project].keyOutputs['DebugCoreCLR|AnyCPU'] = path.join(root, 'bin/Debug/net10.0-ios/App.dll');
    await assert.rejects(model.validateBaseline(project, 'net11.0-ios', dll, assets, sdk), /different assembly/);
});
test('intermediate baseline and unrelated SDK tasks cannot satisfy the launch guard', async () => {
    snapshots[project].assetsFilePath = path.join(root, 'obj/project.assets.json');
    await assert.rejects(model.validateBaseline(project, 'net11.0-ios', dll, assets, sdk), /different assembly/);
    snapshots[project].assetsFilePath = assets;
    tasks[0].execution = new vscode.ProcessExecution(path.join(root, 'other-sdk'));
    await assert.rejects(model.validateBaseline(project, 'net11.0-ios', dll, assets, sdk), /project SDK.*differs/);
});
test('referenced-library framework and assets must agree with the actual restore graph', async () => {
    const libraryAssets = path.join(root, 'Library/obj/meteor-coreclr-microsoft/project.assets.json');
    const graph = { projects: { [library]: { restore: { outputPath: path.dirname(libraryAssets) }, frameworks: { 'net11.0': {} } } } };
    fs.writeFileSync(path.join(path.dirname(assets), 'App.csproj.nuget.dgspec.json'), JSON.stringify(graph));
    snapshots[library] = { targetFramework: 'net10.0', assetsFilePath: path.join(root, 'Library/obj/project.assets.json') };
    await assert.rejects(model.validateBaseline(project, 'net11.0-ios', dll, assets, sdk), /referenced project Library.csproj/);
    snapshots[library] = { targetFramework: 'net11.0', assetsFilePath: libraryAssets };
    await model.validateBaseline(project, 'net11.0-ios', dll, assets, sdk);
});
test('configuration loss invalidates the cached selection', async () => {
    await model.ready(project);
    await peers[0].rpc.sendNotification('$/invokeProxy/1/onCompleted'); await flush();
    assert.equal(model.configuration(project), undefined);
    await assert.rejects(model.ready(project), /connection closed/);
});
test('missing broker API and limited activation fail without filesystem state access', async () => {
    active = { isLimitedActivation: true };
    await assert.rejects(model.ready(project), /project-system broker/);
    assert.equal(requests.length, 0);
});
test('dispose during connection initialization releases a late pipe', async () => {
    let release;
    const b = broker(); active.serviceBroker.getPipe = async m => { await new Promise(r => { release = r; }); return b.getPipe(m); };
    const pending = model.ready(project); await flush(); model.dispose(); release();
    await assert.rejects(pending, /unavailable/);
});
test('subscription disposal releases the remote observer once', async () => {
    const client = await ReadOnlyBrokerClient.open(broker(), 'Microsoft.VisualStudio.NoDelay.EnvironmentService');
    const sub = await client.observe(() => {}, () => {});
    sub.dispose(); sub.dispose(); await flush();
    assert.equal(requests.filter(x => Array.isArray(x) && x[0] === 'release').length, 1);
    client.dispose();
});
test('MessagePack reader accepts fragmented and combined frames and removes listeners', () => {
    const stream = new PassThrough(), reader = new BrokerMessageReader(stream), received = [];
    reader.listen(value => received.push(value));
    const frame = message => { const payload = encode(message), header = Buffer.alloc(4); header.writeUInt32BE(payload.length); return Buffer.concat([header,payload]); };
    const one = frame({ jsonrpc: '2.0', method: 'first' });
    stream.write(one.subarray(0,2)); stream.write(one.subarray(2,7)); stream.write(Buffer.concat([one.subarray(7),frame({ jsonrpc:'2.0',method:'second' })]));
    assert.deepEqual(received.map(x=>x.method), ['first','second']);
    reader.dispose(); assert.equal(stream.listenerCount('data'),0); stream.destroy();
});
test('MessagePack reader rejects oversized frames without allocating the payload', () => {
    const stream = new PassThrough(), reader = new BrokerMessageReader(stream), received = [], problems = [];
    reader.onError(e=>problems.push(e)); reader.listen(x=>received.push(x));
    const header=Buffer.alloc(4); header.writeUInt32BE(32*1024*1024);stream.write(header);
    assert.equal(received.length,0);assert.match(problems[0].message,/Invalid/);reader.dispose();
});
