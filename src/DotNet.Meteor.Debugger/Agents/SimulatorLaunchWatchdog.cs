using System.Diagnostics;

namespace DotNet.Meteor.Debugger;

// The launcher can finish successfully before Mono attaches. Only an unsuccessful
// exit fails immediately; the attachment deadline remains active after exit zero.
public sealed class SimulatorLaunchWatchdog : IDisposable {
    private readonly Process launcher;
    private readonly TimeSpan timeout;
    private readonly Action<string> onFailure;
    private readonly Timer timer;
    private readonly object gate = new object();
    private bool completed;
    private bool started;

    public SimulatorLaunchWatchdog(Process launcher, TimeSpan timeout, Action<string> onFailure) {
        this.launcher = launcher;
        this.timeout = timeout;
        this.onFailure = onFailure;
        timer = new Timer(_ => Fail($"Simulator debugger did not attach within {timeout.TotalSeconds:0} seconds."), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    public void Start() {
        lock (gate) {
            if (completed || started) {
                return;
            }
            started = true;
            launcher.Exited += LauncherExited;
            timer.Change(timeout, Timeout.InfiniteTimeSpan);
            launcher.EnableRaisingEvents = true;
        }
        bool exited;
        lock (gate) {
            if (completed) {
                return;
            }
            exited = launcher.HasExited;
        }
        if (exited) {
            LauncherExited(launcher, EventArgs.Empty);
        }
    }

    private void LauncherExited(object? sender, EventArgs e) {
        int exitCode;
        lock (gate) {
            if (completed) {
                return;
            }
            exitCode = launcher.ExitCode;
        }
        if (exitCode != 0) {
            Fail($"Simulator launcher exited with code {exitCode} before the debugger attached.");
        }
    }

    private void Fail(string message) {
        lock (gate) {
            if (completed) {
                return;
            }
            completed = true;
            Stop();
        }
        try {
            onFailure(message);
        } catch (Exception ex) {
            // Exit events and timers run outside the protocol dispatcher. A
            // disconnected client must not crash the adapter during cleanup.
            Mono.Debugging.Client.DebuggerLoggingService.CustomLogger?.LogError("Simulator launch failure cleanup failed", ex);
        }
    }

    public void Dispose() {
        lock (gate) {
            if (completed) {
                return;
            }
            completed = true;
            Stop();
        }
    }

    private void Stop() {
        launcher.Exited -= LauncherExited;
        timer.Dispose();
    }
}
