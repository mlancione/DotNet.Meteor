import * as vscode from 'vscode';

// Bound attachment independently of the experimental engine's remote listener.
export class CoreClrLaunchTracker implements vscode.DebugAdapterTrackerFactory {
    public createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
        if (session.configuration.meteorRuntime !== 'coreclr') {
            return undefined;
        }
        let deadline: NodeJS.Timeout | undefined;
        const cancel = () => {
            if (deadline) {
                clearTimeout(deadline);
                deadline = undefined;
            }
        };
        return {
            onWillReceiveMessage(message: any) {
                if (message.type === 'request' && message.command === 'configurationDone') {
                    cancel();
                    deadline = setTimeout(() => {
                        deadline = undefined;
                        vscode.window.showErrorMessage('CoreCLR did not attach within 120 seconds. Check the Debug Console, app crash report, selected workload and simulator.');
                        void vscode.debug.stopDebugging(session);
                    }, 120000);
                    deadline.unref();
                }
                if (message.command === 'disconnect' || message.command === 'terminate') {
                    cancel();
                }
            },
            onDidSendMessage(message: any) {
                if ((message.type === 'event' && ['process', 'stopped', 'terminated', 'exited'].includes(message.event))
                    || (message.type === 'response' && message.success === false)) {
                    cancel();
                }
            },
            onWillStopSession: cancel,
            onError: cancel,
            onExit: cancel
        };
    }
}
