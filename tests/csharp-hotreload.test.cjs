const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { HotReloadSession, frame } = require('../src/VSCode/resources/coreclr-hotreload.cjs');

const device = '1E4E0613-390D-4705-84FC-BDA51B93BCC5';
const bundle = 'org.example.hotreloadprobe';
function fixture(options = {}) {
    const messages = [], launches = [], kills = [], commands = [];
    const child = new EventEmitter();
    child.pid = 43210;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const configuration = {
        executable: '/SDK path/dotnet', cwd: '/Workspace path', appPath: '/Workspace path/Probe.app',
        device, args: ['watch', '--project', '/Workspace path/Probe.csproj', 'run', '-e', 'CUSTOM_VALUE=hello world']
    };
    const session = new HotReloadSession(message => messages.push(message), {
        platform: 'darwin', environment: { DEVELOPER_DIR: '/Xcode path/Contents/Developer', CUSTOM: 'value with spaces' },
        spawn: (...args) => { launches.push(args); return child; },
        kill: (...args) => { kills.push(args); queueMicrotask(() => child.emit('close', 0)); },
        execFile: async (...args) => {
            commands.push(args);
            if (args[0] === '/usr/bin/plutil') { return { stdout: `${bundle}\n` }; }
            if (args[1].includes('launchctl')) { return { stdout: `PID\tStatus\tLabel\n56789\t0\tUIKitApplication:${bundle}[1234][UUID]\n` }; }
            return { stdout: '' };
        },
        ...options
    });
    let sequence = 0;
    const request = async (command, args) => {
        const seq = ++sequence;
        await session.request({ type: 'request', seq, command, arguments: args });
        return messages.find(message => message.type === 'response' && message.request_seq === seq);
    };
    const launch = () => request('launch', { noDebug: true, meteorCSharpHotReload: configuration });
    const start = async () => {
        assert.equal((await launch()).success, true);
        assert.equal((await request('configurationDone')).success, true);
    };
    return { session, child, configuration, messages, launches, kills, commands, request, launch, start };
}

test('Hot Reload launch requires explicit no-debug simulator configuration', async () => {
    for (const changes of [{ noDebug: false }, { meteorCSharpHotReload: undefined }]) {
        const f = fixture();
        const response = await f.request('launch', { noDebug: true, meteorCSharpHotReload: f.configuration, ...changes });
        assert.equal(response.success, false);
        assert.match(response.message, /Run Without Debugging.*local iOS simulator/);
        assert.equal(f.launches.length, 0);
    }
    const windows = fixture({ platform: 'win32' });
    assert.equal((await windows.launch()).success, false);
});

test('launch initializes DAP before configurationDone starts the watcher', async () => {
    const f = fixture();
    const initialized = await f.request('initialize');
    assert.equal(initialized.body.supportsConfigurationDoneRequest, true);
    assert.equal((await f.launch()).success, true);
    assert.equal(f.launches.length, 0);
    assert.equal(f.messages.at(-1).event, 'initialized');
    assert.equal((await f.request('configurationDone')).success, true);
    assert.equal(f.launches.length, 1);
    await f.session.stop();
});

test('watcher spawn preserves argument boundaries and ordinary environment values', async () => {
    const f = fixture();
    await f.start();
    const [executable, args, options] = f.launches[0];
    assert.equal(executable, f.configuration.executable);
    assert.deepEqual(args, f.configuration.args);
    assert.equal(options.cwd, '/Workspace path');
    assert.equal(options.env.CUSTOM, 'value with spaces');
    assert.equal(options.env.DEVELOPER_DIR, '/Xcode path/Contents/Developer');
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    await f.session.stop();
});

test('watcher strips inherited application-only Hot Reload environment', async () => {
    const environment = {
        DOTNET_WATCH: '1', DOTNET_WATCH_ITERATION: '7', DOTNET_WATCH_HOTRELOAD_WEBSOCKET_ENDPOINT: 'ws://stale:123',
        DOTNET_STARTUP_HOOKS: '/stale hook.dll', DOTNET_MODIFIABLE_ASSEMBLIES: 'debug', DOTNET_ROOT: '/SDK path'
    };
    const f = fixture({ environment });
    await f.start();
    const env = f.launches[0][2].env;
    for (const key of Object.keys(environment).filter(key => key !== 'DOTNET_ROOT')) {
        assert.equal(env[key], undefined, key);
    }
    assert.equal(env.DOTNET_ROOT, '/SDK path');
    assert.equal(env.DOTNET_WATCH_SUPPRESS_EMOJIS, '1');
    assert.equal(environment.DOTNET_STARTUP_HOOKS, '/stale hook.dll');
    await f.session.stop();
});

test('watcher stdout and stderr travel through DAP output events', async () => {
    const f = fixture();
    await f.start();
    f.child.stdout.write('C# changes applied in 123ms.\n');
    f.child.stderr.write('Compilation failed: example.cs(12)\n');
    const output = f.messages.filter(message => message.event === 'output').map(message => message.body.output).join('');
    assert.match(output, /C# changes applied in 123ms/);
    assert.match(output, /Compilation failed: example.cs\(12\)/);
    await f.session.stop();
});

test('stopping a watcher that never launched an app preserves existing simulator apps', async () => {
    const f = fixture();
    await f.start();
    await f.request('disconnect');
    assert.deepEqual(f.kills, [[-43210, 'SIGTERM'], [-43210, 'SIGKILL']]);
    assert.equal(f.commands.length, 0);
    assert.equal(f.messages.filter(message => message.event === 'terminated').length, 1);
});

test('disconnect before watcher startup performs no app or process cleanup', async () => {
    const f = fixture();
    await f.launch();
    await f.request('disconnect');
    assert.equal(f.launches.length, 0);
    assert.equal(f.kills.length, 0);
    assert.equal(f.commands.length, 0);
});

test('stop terminates only its process group and matching launched simulator app', async () => {
    const f = fixture();
    await f.start();
    f.child.stdout.write(`${bundle}: 56789\n`);
    await f.session.stop();
    await f.session.stop();
    assert.deepEqual(f.kills, [[-43210, 'SIGTERM'], [-43210, 'SIGKILL']]);
    assert.equal(f.commands.filter(command => command[1].includes('terminate')).length, 1);
    assert.deepEqual(f.commands.find(command => command[1].includes('terminate'))[1], ['simctl', 'terminate', device, bundle]);
    assert.equal(f.messages.filter(message => message.event === 'terminated').length, 1);
});

test('fragmented simulator launch output still proves ownership', async () => {
    const f = fixture();
    await f.start();
    f.child.stdout.write('SDK launch output\norg.example.');
    f.child.stdout.write('hotreloadprobe: 56');
    f.child.stdout.write('789\r\n');
    await f.session.stop();
    assert.equal(f.commands.filter(command => command[1].includes('terminate')).length, 1);
});

test('a replacement process with the same bundle is never terminated', async () => {
    const commands = [];
    const f = fixture({ execFile: async (...args) => {
        commands.push(args);
        return { stdout: args[0] === '/usr/bin/plutil'
            ? `${bundle}\n` : `98765\t0\tUIKitApplication:${bundle}[UUID]\n` };
    } });
    await f.start();
    f.child.stdout.write(`${bundle}: 56789\n`);
    await f.session.stop();
    assert.equal(commands.filter(command => command[1].includes('launchctl')).length, 1);
    assert.equal(commands.filter(command => command[1].includes('terminate')).length, 0);
});

test('PID matches without the expected bundle label do not prove ownership', async () => {
    const commands = [];
    const f = fixture({ execFile: async (...args) => {
        commands.push(args);
        return { stdout: args[0] === '/usr/bin/plutil'
            ? `${bundle}\n` : '56789\t0\tUIKitApplication:another.app[UUID]\n' };
    } });
    await f.start();
    f.child.stdout.write(`${bundle}: 56789\n`);
    await f.session.stop();
    assert.equal(commands.filter(command => command[1].includes('terminate')).length, 0);
});

test('another bundle in SDK output cannot grant cleanup ownership', async () => {
    const f = fixture();
    await f.start();
    f.child.stdout.write('another.app: 56789\n');
    await f.session.stop();
    assert.equal(f.commands.length, 1);
    assert.equal(f.commands[0][0], '/usr/bin/plutil');
});

test('application diagnostics on stderr do not grant cleanup ownership', async () => {
    const f = fixture();
    await f.start();
    f.child.stderr.write(`${bundle}: 56789\n`);
    await f.session.stop();
    assert.equal(f.commands.length, 0);
});

test('watcher startup failure reports the cause and never terminates an existing app', async () => {
    const f = fixture();
    await f.start();
    f.child.emit('error', new Error('SDK executable unavailable'));
    await f.session.stop();
    const output = f.messages.filter(message => message.event === 'output').map(message => message.body.output).join('');
    assert.match(output, /could not start: SDK executable unavailable/);
    assert.deepEqual(f.kills, [[-43210, 'SIGTERM'], [-43210, 'SIGKILL']]);
    assert.equal(f.commands.length, 0);
    assert.equal(f.messages.filter(message => message.event === 'terminated').length, 1);
});

test('watcher exit reports failure and cleans up the owned process group', async () => {
    const f = fixture();
    await f.start();
    f.child.emit('exit', 1, null);
    await f.session.stop();
    const output = f.messages.filter(message => message.event === 'output').map(message => message.body.output).join('');
    assert.match(output, /watcher stopped \(1\).*Restart Run Without Debugging/);
    assert.deepEqual(f.kills, [[-43210, 'SIGTERM'], [-43210, 'SIGKILL']]);
    assert.equal(f.commands.length, 0);
    assert.equal(f.messages.filter(message => message.event === 'terminated').length, 1);
});

test('debugger-only requests explain F5 and breakpoints remain unverified', async () => {
    const f = fixture();
    const breakpoints = await f.request('setBreakpoints', { breakpoints: [{ line: 10 }, { line: 20 }] });
    assert.equal(breakpoints.body.breakpoints.length, 2);
    for (const breakpoint of breakpoints.body.breakpoints) {
        assert.equal(breakpoint.verified, false);
        assert.match(breakpoint.message, /Use F5/);
    }
    const evaluation = await f.request('evaluate', { expression: '1 + 1' });
    assert.equal(evaluation.success, false);
    assert.match(evaluation.message, /unavailable.*Use F5/);
    assert.deepEqual((await f.request('threads')).body, { threads: [] });
});

test('protocol frames count UTF-8 bytes rather than characters', () => {
    const message = { type: 'event', event: 'output', body: { output: 'Résumé 🎉' } };
    const bytes = frame(message);
    const headerEnd = bytes.indexOf('\r\n\r\n');
    const payload = bytes.subarray(headerEnd + 4);
    assert.equal(Number(/Content-Length: (\d+)/.exec(bytes.subarray(0, headerEnd).toString())[1]), payload.length);
    assert.deepEqual(JSON.parse(payload), message);
});


test('closing DAP stdout still cleans up the watcher process group', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    if (process.platform === 'win32') { return; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-hr-epipe-'));
    const preload = path.join(root, 'platform.cjs');
    const sdk = path.join(root, 'sdk.cjs');
    const pidFile = path.join(root, 'pids.json');
    fs.writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' });");
    fs.writeFileSync(sdk, `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore','inherit','inherit'] });
require('node:fs').writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
setInterval(() => console.log('SDK watcher heartbeat'), 10);`);
    const adapter = spawn(process.execPath, ['--require', preload, require.resolve('../src/VSCode/resources/coreclr-hotreload.cjs')], { stdio: ['pipe','pipe','pipe'] });
    adapter.stdout.resume(); adapter.stderr.resume();
    let pids = [];
    const until = async predicate => {
        const deadline = Date.now() + 10000;
        while (!predicate()) {
            if (Date.now() > deadline) { throw new Error('Timed out waiting for adapter cleanup'); }
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };
    const alive = pid => {
        try { process.kill(pid, 0); return true; } catch (error) {
            if (error.code === 'ESRCH') { return false; }
            throw error;
        }
    };
    try {
        adapter.stdin.write(frame({ type:'request', seq:1, command:'launch', arguments:{ noDebug:true,
            meteorCSharpHotReload:{ executable:process.execPath, cwd:root, appPath:path.join(root,'Probe.app'), device,
                args:[sdk,pidFile] } } }));
        adapter.stdin.write(frame({ type:'request', seq:2, command:'configurationDone', arguments:{} }));
        await until(() => fs.existsSync(pidFile));
        pids = JSON.parse(fs.readFileSync(pidFile));
        adapter.stdout.destroy();
        await until(() => adapter.exitCode !== null);
        await until(() => pids.every(pid => !alive(pid)));
        assert.equal(adapter.exitCode, 0);
    } finally {
        if (pids[0]) { try { process.kill(-pids[0], 'SIGKILL'); } catch (_) { } }
        adapter.kill('SIGKILL');
        fs.rmSync(root, { recursive:true, force:true });
    }
});
