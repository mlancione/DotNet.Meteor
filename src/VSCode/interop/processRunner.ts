import { spawnSync, spawn } from 'child_process';
import { ProcessArgumentBuilder } from './processArgumentBuilder';

export interface ProcessOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    signal?: AbortSignal;
}

export class ProcessRunner {
    public static runSync(builder: ProcessArgumentBuilder, options: ProcessOptions = {}): string | undefined {
        const result = spawnSync(builder.getCommand(), builder.getArguments(), {
            cwd: options.cwd, env: options.env, timeout: options.timeout ?? 30000,
            encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
        });
        if (result.error || result.status !== 0) {
            console.error(`${builder.getCommand()} failed: ${result.error?.message ?? `exit ${result.status}`}\n${result.stderr ?? ''}`);
            return undefined;
        }
        if (result.stderr) {
            console.error(result.stderr);
        }
        return result.stdout.trimEnd();
    }

    public static runAsync<TModel>(builder: ProcessArgumentBuilder, options: ProcessOptions = {}): Promise<TModel> {
        return new Promise<TModel>((resolve, reject) => {
            if (options.signal?.aborted) {
                reject(new Error('Process cancelled'));
                return;
            }
            const child = spawn(builder.getCommand(), builder.getArguments(), {
                stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd, env: options.env
            });
            let output = '';
            let diagnostics = '';
            let settled = false;
            let killTimer: NodeJS.Timeout | undefined;
            const cleanup = () => {
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', cancel);
            };
            const fail = (error: Error) => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(error);
                }
            };
            const stop = (reason: string) => {
                fail(new Error(`${builder.getCommand()}: ${reason}`));
                child.kill('SIGTERM');
                killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
                killTimer.unref();
            };
            const cancel = () => stop('Process cancelled');
            const timer = setTimeout(() => stop('Process timed out'), options.timeout ?? 60000);
            options.signal?.addEventListener('abort', cancel, { once: true });
            child.stdout?.setEncoding('utf8');
            child.stderr?.setEncoding('utf8');
            child.stdout?.on('data', data => { output += data; });
            child.stderr?.on('data', data => { diagnostics += data; });
            child.on('error', fail);
            child.on('close', (code, signal) => {
                clearTimeout(killTimer);
                if (settled) {
                    return;
                }
                if (code !== 0) {
                    fail(new Error(`${builder.getCommand()} exited with ${code ?? signal}: ${diagnostics.trim()}`));
                    return;
                }
                try {
                    const model = JSON.parse(output);
                    settled = true;
                    cleanup();
                    if (diagnostics) {
                        console.error(diagnostics.trimEnd());
                    }
                    resolve(model);
                } catch (error) {
                    fail(new Error(`${builder.getCommand()} returned invalid JSON: ${String(error)}\n${diagnostics.trim()}`));
                }
            });
        });
    }
}
