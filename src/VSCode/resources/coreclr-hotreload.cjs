// A no-debug DAP session owns the SDK watcher and its simulator application.
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolve, isAbsolute } = require('node:path');
const execFileAsync = promisify(execFile);

function frame(message) {
    const body = Buffer.from(JSON.stringify(message));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

class HotReloadSession {
    constructor(send, options = {}) {
        this.send = send;
        this.spawn = options.spawn ?? spawn;
        this.execFile = options.execFile ?? execFileAsync;
        this.kill = options.kill ?? process.kill.bind(process);
        this.environment = options.environment ?? process.env;
        this.platform = options.platform ?? process.platform;
        this.configuration = undefined;
        this.child = undefined;
        this.stopping = undefined;
        this.closed = false;
        this.appProcess = undefined;
        this.outputLine = '';
    }

    output(text, category = 'console') {
        this.send({ type: 'event', event: 'output', body: { category, output: text } });
    }

    async request(message) {
        const response = { type: 'response', request_seq: message.seq, command: message.command, success: true };
        try {
            switch (message.command) {
                case 'initialize':
                    response.body = { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true };
                    break;
                case 'launch': {
                    const args = message.arguments ?? {};
                    const config = args.meteorCSharpHotReload;
                    if (this.platform !== 'darwin' || !args.noDebug || !config
                        || !isAbsolute(config.executable ?? '') || !isAbsolute(config.cwd ?? '')
                        || !isAbsolute(config.appPath ?? '') || !Array.isArray(config.args)
                        || !config.args.every(value => typeof value === 'string')
                        || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(config.device ?? '')) {
                        throw new Error('C# Hot Reload requires a configured Run Without Debugging session on a local iOS simulator.');
                    }
                    if (this.configuration) {
                        throw new Error('This C# Hot Reload session already has a launch configuration.');
                    }
                    this.configuration = config;
                    break;
                }
                case 'configurationDone':
                    this.start();
                    break;
                case 'setBreakpoints':
                    response.body = { breakpoints: (message.arguments?.breakpoints ?? []).map(() => ({
                        verified: false, message: 'C# Hot Reload runs without a debugger. Use F5 for breakpoints.'
                    })) };
                    break;
                case 'setExceptionBreakpoints':
                    break;
                case 'threads':
                    response.body = { threads: [] };
                    break;
                case 'disconnect':
                case 'terminate':
                    await this.stop();
                    break;
                default:
                    throw new Error(`${message.command} is unavailable during C# Hot Reload. Use F5 for breakpoint debugging.`);
            }
        } catch (error) {
            response.success = false;
            response.message = error.message;
        }
        this.send(response);
        if (response.success && message.command === 'launch') {
            this.send({ type: 'event', event: 'initialized' });
        }
    }

    start() {
        if (!this.configuration || this.child || this.stopping) {
            throw new Error('C# Hot Reload cannot start in the current session state.');
        }
        const config = this.configuration;
        this.output('C# Hot Reload: SDK dotnet watch; running without a managed debugger. Save C# edits to apply supported changes.\n');
        const env = { ...this.environment, NO_COLOR: '1', DOTNET_WATCH_SUPPRESS_EMOJIS: '1' };
        // SDK watch supplies these to its child; inherited hooks can launch the
        // watcher itself with application-only instrumentation or endpoints.
        for (const key of Object.keys(env)) {
            if (/^(DOTNET_WATCH(?:_.*)?|DOTNET_STARTUP_HOOKS|DOTNET_MODIFIABLE_ASSEMBLIES)$/.test(key)) {
                delete env[key];
            }
        }
        env.DOTNET_WATCH_SUPPRESS_EMOJIS = '1';
        this.child = this.spawn(config.executable, config.args, {
            cwd: config.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        for (const stream of [this.child.stdout, this.child.stderr]) {
            stream.setEncoding('utf8');
            stream.on('data', data => {
                this.output(data);
                if (stream === this.child.stdout) {
                    this.outputLine += data;
                    let end;
                    while ((end = this.outputLine.indexOf('\n')) >= 0) {
                        const line = this.outputLine.slice(0, end).trim();
                        this.outputLine = this.outputLine.slice(end + 1);
                        const launched = /^([A-Za-z0-9.-]+):\s+(\d+)$/.exec(line);
                        if (launched) {
                            this.appProcess = { identifier: launched[1], pid: Number(launched[2]) };
                        }
                    }
                    // SDK output is diagnostic text, not an unbounded protocol.
                    this.outputLine = this.outputLine.slice(-16384);
                }
            });
        }
        this.child.once('close', () => { this.closed = true; });
        this.child.on('error', error => {
            this.output(`C# Hot Reload could not start: ${error.message}\n`, 'stderr');
            void this.stop();
        });
        this.child.on('exit', (code, signal) => {
            if (!this.stopping) {
                this.output(`C# Hot Reload watcher stopped (${signal ?? code}). Restart Run Without Debugging to try again.\n`);
                void this.stop();
            }
        });
    }

    stop() {
        if (!this.stopping) {
            this.stopping = this.cleanup();
        }
        return this.stopping;
    }

    async cleanup() {
        const child = this.child;
        if (child?.pid) {
            // Terminate the owned process group, including SDK build/run children.
            try { this.kill(-child.pid, 'SIGTERM'); } catch (error) {
                if (error.code !== 'ESRCH') {
                    this.output(`C# Hot Reload watcher cleanup: ${error.message}\n`, 'stderr');
                }
            }
            if (!this.closed) {
                await new Promise(resolveStop => {
                    const timeout = setTimeout(() => {
                        resolveStop();
                    }, 3000);
                    child.once('close', () => { clearTimeout(timeout); resolveStop(); });
                });
            }
            // The dotnet wrapper may exit before dotnet-watch/MSBuild children.
            // Finish the owned group even when the immediate child has closed.
            try { this.kill(-child.pid, 'SIGKILL'); } catch (error) {
                if (error.code !== 'ESRCH') {
                    this.output(`C# Hot Reload watcher cleanup: ${error.message}\n`, 'stderr');
                }
            }
        }
        const config = this.configuration;
        if (config && this.appProcess) {
            try {
                const { stdout } = await this.execFile('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-',
                    resolve(config.appPath, 'Info.plist')], { timeout: 5000 });
                const identifier = stdout.trim();
                if (!/^[A-Za-z0-9.-]+$/.test(identifier)) {
                    throw new Error('Invalid app bundle identifier.');
                }
                if (identifier === this.appProcess.identifier) {
                    const live = await this.execFile('/usr/bin/xcrun', ['simctl', 'spawn', config.device, 'launchctl', 'list'],
                        { timeout: 10000, env: this.environment });
                    const ownsProcess = live.stdout.split(/\r?\n/).some(line => {
                        const fields = line.trim().split(/\s+/);
                        return Number(fields[0]) === this.appProcess.pid
                            && fields[2]?.startsWith(`UIKitApplication:${identifier}[`);
                    });
                    if (ownsProcess) {
                        await this.execFile('/usr/bin/xcrun', ['simctl', 'terminate', config.device, identifier],
                            { timeout: 10000, env: this.environment });
                    }
                }
            } catch (error) {
                // Not-running/not-installed is expected if launch or build failed.
                // Surface other failures so cleanup is never silently assumed.
                if (!/No such process|not running|not installed|does not exist|Could not extract value/i.test(error.stderr ?? error.message)) {
                    this.output(`C# Hot Reload app cleanup: ${error.stderr ?? error.message}\n`, 'stderr');
                }
            }
        }
        this.send({ type: 'event', event: 'terminated' });
    }
}

function run() {
    let pending = Buffer.alloc(0);
    let sequence = 0;
    let queue = Promise.resolve();
    let outputOpen = true;
    let closing = false;
    const session = new HotReloadSession(message => {
        if (outputOpen) { process.stdout.write(frame({ seq: ++sequence, ...message })); }
    });
    const finish = () => {
        if (closing) { return; }
        closing = true;
        process.stdin.destroy();
        void session.stop().finally(() => { process.exitCode = 0; });
    };
    process.stdout.on('error', () => { outputOpen = false; finish(); });
    process.stdout.on('close', () => { outputOpen = false; finish(); });
    process.on('exit', () => {
        if (session.child?.pid) {
            try { process.kill(-session.child.pid, 'SIGKILL'); } catch (_) { }
        }
    });
    process.stdin.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        try {
            while (true) {
                const end = pending.indexOf('\r\n\r\n');
                if (end < 0) { break; }
                const match = /^Content-Length:\s*(\d+)\s*$/im.exec(pending.subarray(0, end).toString('ascii'));
                if (!match || Number(match[1]) > 16 * 1024 * 1024) {
                    throw new Error('Invalid C# Hot Reload protocol frame.');
                }
                const start = end + 4, length = Number(match[1]);
                if (pending.length < start + length) { break; }
                const message = JSON.parse(pending.subarray(start, start + length).toString('utf8'));
                pending = pending.subarray(start + length);
                if (message.type === 'request') {
                    queue = queue.then(() => session.request(message)).then(() => {
                        if (message.command === 'disconnect' || message.command === 'terminate') { finish(); }
                    });
                }
            }
        } catch (error) {
            session.output(`C# Hot Reload protocol error: ${error.message}\n`, 'stderr');
            finish();
        }
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    for (const signal of ['SIGINT', 'SIGTERM']) { process.on(signal, finish); }
}

module.exports = { HotReloadSession, frame };
if (require.main === module) { run(); }
