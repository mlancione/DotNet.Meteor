import * as vscode from 'vscode';

// Scope SDK/Xcode/launcher environment to this adapter process, not the application.
export class MonoDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    public createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.DebugAdapterDescriptor {
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
