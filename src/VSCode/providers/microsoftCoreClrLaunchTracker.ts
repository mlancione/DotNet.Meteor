import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { debuggerComponentHash } from '../interop/microsoftDebugger';

const execFileAsync = promisify(execFile);

// Microsoft owns the adapter. Meteor owns only its selected simulator launcher.
export class MicrosoftCoreClrLaunchTracker implements vscode.DebugAdapterTrackerFactory, vscode.Disposable {
    private sessions = new Map<string, { device: string; stop: () => Promise<void> }>();
    private output = vscode.window.createOutputChannel('.NET Meteor Microsoft Debugger');

    public dispose() {
        for (const entry of this.sessions.values()) {
            void entry.stop();
        }
        this.output.dispose();
    }

    public createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
        if (session.type !== 'coreclr_mobile' || session.configuration.meteorCoreClrDebugger !== 'microsoft') {
            return undefined;
        }
        const config = session.configuration.meteorMicrosoftLaunch;
        let child: ChildProcess | undefined;
        let deadline: NodeJS.Timeout | undefined;
        let started = false;
        let stopping = false;
        let cleanup: Promise<void> | undefined;
        let identifier: string | undefined;
        let launched = false;
        const cancelDeadline = () => {
            if (deadline) {
                clearTimeout(deadline);
                deadline = undefined;
            }
        };
        const log = (value: string) => this.output.append(value);
        const stop = (): Promise<void> => {
            if (cleanup) {
                return cleanup;
            }
            stopping = true;
            cancelDeadline();
            cleanup = (async () => {
                if (child?.pid && child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGTERM');
                    await new Promise<void>(resolve => {
                        const timer = setTimeout(() => {
                            if (child?.exitCode === null && child.signalCode === null) {
                                child.kill('SIGKILL');
                            }
                            resolve();
                        }, 2000);
                        child!.once('close', () => { clearTimeout(timer); resolve(); });
                    });
                }
                if (launched && identifier) {
                    try {
                        await execFileAsync('/usr/bin/xcrun', ['simctl', 'terminate', config.device, identifier], {
                            env: config.env, timeout: 10000
                        });
                    } catch {
                        // The adapter/app may already have exited or the simulator shut down.
                    }
                }
                this.sessions.delete(session.id);
            })();
            return cleanup;
        };
        const fail = (error: unknown) => {
            if (!stopping) {
                const text = `Microsoft CoreCLR launch failed: ${String(error)}`;
                log(`${text}\n`);
                void vscode.window.showErrorMessage(text);
                void stop();
                void vscode.debug.stopDebugging(session);
            }
        };
        const start = async () => {
            if (started || stopping) {
                return;
            }
            started = true;
            try {
                if (!config || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(config.device ?? '')
                    || !path.isAbsolute(config.app ?? '') || !fs.existsSync(config.app)
                    || !path.isAbsolute(config.mlaunch ?? '') || !fs.existsSync(config.mlaunch)) {
                    throw new Error('The selected simulator app or mlaunch is missing. Run the matching Meteor build task first.');
                }
                if ([...this.sessions.entries()].some(([id, entry]) => id !== session.id && entry.device === config.device)) {
                    throw new Error('A Meteor Microsoft debugger session already owns this simulator. Stop it before launching another.');
                }
                this.sessions.set(session.id, { device: config.device, stop });
                const agent = path.join(config.app, 'libvsdbgremotecoreclrtarget.dylib');
                if (debuggerComponentHash(config.targetLibrary) !== config.targetHash
                    || debuggerComponentHash(config.hostLibrary) !== config.hostHash) {
                    throw new Error('The built app and Microsoft debugger components no longer match. Rebuild after the Microsoft extensions update.');
                }
                // Bundling re-signs the target library. Its Mach-O UUID survives signing;
                // whole-file hashes do not. Also check the source snapshot above.
                const uuidArgs = ['--uuid'];
                const [sourceUuid, bundledUuid] = await Promise.all([config.targetLibrary, agent].map(file =>
                    execFileAsync('/usr/bin/dwarfdump', [...uuidArgs, file], { timeout: 10000, env: config.env })));
                const uuids = (text: string) => (text.match(/UUID: [0-9A-F-]+ \([^)]+\)/gi) ?? []).sort().join(';');
                if (!uuids(sourceUuid.stdout) || uuids(sourceUuid.stdout) !== uuids(bundledUuid.stdout)) {
                    throw new Error('The app contains a different Microsoft target library. Run the matching Meteor build before debugging.');
                }
                const bundle = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(config.app, 'Info.plist')], {
                    timeout: 10000, env: config.env
                });
                identifier = bundle.stdout.trim();
                if (!/^[A-Za-z0-9.-]+$/.test(identifier)) {
                    throw new Error('The simulator app has no valid bundle identifier.');
                }
                if (stopping) {
                    return;
                }
                if (config.uninstall) {
                    try {
                        await execFileAsync('/usr/bin/xcrun', ['simctl', 'uninstall', config.device, identifier], { env: config.env, timeout: 15000 });
                    } catch (error) {
                        // Fresh simulators have nothing to uninstall. mlaunch reports installation errors.
                        log(`Simulator uninstall: ${String(error)}\n`);
                    }
                }
                if (stopping) {
                    return;
                }
                const applicationEnvironment = {
                    ...config.applicationEnvironment,
                    CORECLR_REMOTE_DEBUGGER_IP: '127.0.0.1', CORECLR_REMOTE_DEBUGGER_ISSERVER: 'false',
                    CORECLR_REMOTE_DEBUGGER_PORT: String(config.port), CORECLR_ENABLE_PROFILING: '1',
                    CORECLR_PROFILER: '{9DC623E8-C88F-4FD5-AD99-77E67E1D9631}',
                    CORECLR_PROFILER_PATH: 'libvsdbgremotecoreclrtarget.dylib'
                };
                const args = ['--launchsim', config.app, '--device', `:v2:udid=${config.device}`, '--wait-for-exit:true',
                    ...Object.entries(applicationEnvironment).map(([key, value]) => `--setenv=${key}=${value}`),
                    ...config.args.map((arg: string) => `--argument=${arg}`)];
                log(`Microsoft CoreCLR: launching ${identifier} on ${config.device}, port ${config.port}.\n`);
                child = spawn(config.mlaunch, args, { cwd: config.cwd, env: config.env, stdio: ['ignore', 'pipe', 'pipe'] });
                child.once('spawn', () => { launched = true; });
                child.stdout?.on('data', data => log(data.toString()));
                child.stderr?.on('data', data => log(data.toString()));
                child.once('error', fail);
                child.once('exit', (code, signal) => fail(new Error(`Simulator launcher exited (${signal ?? code}). Check the Meteor Microsoft Debugger output and app crash report.`)));
            } catch (error) {
                fail(error);
            }
        };
        return {
            onWillReceiveMessage: (message: any) => {
                if (message.command === 'configurationDone' && !deadline && !started && !stopping) {
                    deadline = setTimeout(() => fail(new Error('The debugger did not attach within 120 seconds.')), 120000);
                    deadline.unref();
                }
                if (message.command === 'disconnect' || message.command === 'terminate') {
                    void stop();
                }
            },
            onDidSendMessage: (message: any) => {
                // Launch only after the Microsoft listener and breakpoint configuration are ready.
                if (message.type === 'response' && message.command === 'configurationDone' && message.success) {
                    void start();
                }
                if (message.type === 'event' && ['thread', 'stopped'].includes(message.event)) {
                    cancelDeadline();
                }
                if ((message.type === 'response' && message.success === false && ['initialize', 'launch', 'configurationDone'].includes(message.command))
                    || (message.type === 'event' && ['terminated', 'exited'].includes(message.event))) {
                    void stop();
                }
            },
            onWillStopSession: () => { void stop(); },
            onError: fail,
            onExit: () => { void stop(); }
        };
    }
}
