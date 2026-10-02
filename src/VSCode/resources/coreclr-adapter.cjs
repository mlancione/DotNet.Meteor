// Adapt optional DAP fields expected by the pinned clrdbg release.
// Keep stdout exclusively for debugger protocol messages.
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');

class RequestCompatibility extends Transform {
    constructor() {
        super();
        this.pending = Buffer.alloc(0);
    }
    _transform(chunk, encoding, callback) {
        try {
            this.pending = Buffer.concat([this.pending, chunk]);
            while (true) {
                const headerEnd = this.pending.indexOf('\r\n\r\n');
                if (headerEnd < 0) {
                    break;
                }
                const header = this.pending.subarray(0, headerEnd).toString('ascii');
                const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
                if (!match) {
                    throw new Error('Missing debugger protocol Content-Length');
                }
                const length = Number(match[1]);
                const start = headerEnd + 4;
                if (this.pending.length < start + length) {
                    break;
                }
                const message = JSON.parse(this.pending.subarray(start, start + length).toString('utf8'));
                if (message.type === 'request' && message.command === 'setExceptionBreakpoints') {
                    message.arguments = message.arguments ?? {};
                    message.arguments.filterOptions = message.arguments.filterOptions ?? [];
                }
                const payload = Buffer.from(JSON.stringify(message));
                this.push(Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload]));
                this.pending = this.pending.subarray(start + length);
            }
            callback();
        } catch (error) {
            callback(error);
        }
    }
    _flush(callback) {
        callback(this.pending.length ? new Error('Incomplete debugger protocol message') : undefined);
    }
}

function run(adapter) {
    const child = spawn(adapter, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const requests = new RequestCompatibility();
    const fail = error => {
        console.error(`Meteor CoreCLR adapter: ${error.message}`);
        process.exitCode = 1;
        process.stdin.destroy();
        child.kill();
    };
    child.on('error', fail);
    child.stdin.on('error', error => {
        if (error.code !== 'EPIPE') {
            fail(error);
        }
    });
    requests.on('error', fail);
    process.stdin.pipe(requests).pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on('exit', (code, signal) => {
        process.stdin.destroy();
        process.exitCode = code ?? (signal ? 1 : 0);
    });
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => {
            child.kill(signal);
            process.stdin.destroy();
        });
    }
    process.on('exit', () => {
        child.kill();
    });
}

module.exports = { RequestCompatibility };
if (require.main === module) {
    run(process.argv[2]);
}
