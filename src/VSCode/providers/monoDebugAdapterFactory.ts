import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Interop } from '../interop/interop';

// Scope SDK/Xcode/launcher environment to this adapter process, not the application.
export class MonoDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    public createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.DebugAdapterDescriptor {
        if (session.configuration.meteorRuntime === 'coreclr') {
            const adapter = path.join(Interop.extensionPath, 'extension', 'bin', 'CoreClr', process.platform === 'win32' ? 'clrdbg.exe' : 'clrdbg');
            if (!fs.existsSync(adapter)) {
                throw new Error(`Cannot locate the CoreCLR adapter: ${adapter}`);
            }
            const wrapper = path.join(Interop.extensionPath, 'extension', 'coreclr-adapter.cjs');
            if (!fs.existsSync(wrapper)) {
                throw new Error(`Cannot locate the Meteor CoreCLR adapter wrapper: ${wrapper}`);
            }
            return new vscode.DebugAdapterExecutable(process.execPath, [wrapper, adapter], {
                cwd: session.configuration.toolWorkingDirectory,
                env: { ...session.configuration.toolEnvironment, ELECTRON_RUN_AS_NODE: '1' }
            });
        }
        if (!executable) {
            throw new Error('Cannot locate the .NET Meteor debug adapter.');
        }
        return new vscode.DebugAdapterExecutable(executable.command, executable.args, {
            ...executable.options,
            cwd: session.configuration.toolWorkingDirectory ?? executable.options?.cwd,
            env: { ...executable.options?.env, ...session.configuration.toolEnvironment }
        });
    }
}
