using System.Diagnostics;
using NUnit.Framework;

namespace DotNet.Meteor.Debugger.Tests;

public class SimulatorLaunchWatchdogTests {
    private static Process StartLauncher(string command) {
        var executable = OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh";
        var arguments = OperatingSystem.IsWindows() ? $"/c {command}" : $"-c \"{command}\"";
        return Process.Start(new ProcessStartInfo(executable, arguments) { UseShellExecute = false })!;
    }

    [Test]
    public void UnsuccessfulExitFailsOnceBeforeAttachment() {
        using var launcher = StartLauncher("exit 7");
        // The process may already have exited when monitoring starts.
        launcher.WaitForExit();
        var failures = new List<string>();
        using var failed = new ManualResetEventSlim();
        using var watchdog = new SimulatorLaunchWatchdog(launcher, TimeSpan.FromSeconds(1), message => {
            failures.Add(message);
            failed.Set();
        });
        watchdog.Start();
        Assert.That(failed.Wait(TimeSpan.FromSeconds(5)), Is.True);
        watchdog.Dispose();
        Assert.That(failures, Has.Count.EqualTo(1));
        Assert.That(failures[0], Does.Contain("code 7"));
    }

    [Test]
    public void UnsuccessfulExitWhileMonitoringFailsImmediately() {
        var command = OperatingSystem.IsWindows() ? "ping -n 2 127.0.0.1 > nul & exit /b 7" : "sleep 0.1; exit 7";
        using var launcher = StartLauncher(command);
        string? failure = null;
        using var failed = new ManualResetEventSlim();
        using var watchdog = new SimulatorLaunchWatchdog(launcher, TimeSpan.FromSeconds(5), message => {
            failure = message;
            failed.Set();
        });
        watchdog.Start();
        Assert.That(failed.Wait(TimeSpan.FromSeconds(4)), Is.True);
        Assert.That(failure, Does.Contain("code 7"));
    }

    [Test]
    public void SuccessfulExitStillRequiresDebuggerAttachment() {
        using var launcher = StartLauncher("exit 0");
        launcher.WaitForExit();
        string? failure = null;
        using var failed = new ManualResetEventSlim();
        using var watchdog = new SimulatorLaunchWatchdog(launcher, TimeSpan.FromMilliseconds(100), message => {
            failure = message;
            failed.Set();
        });
        watchdog.Start();
        Assert.That(failed.Wait(TimeSpan.FromSeconds(5)), Is.True);
        Assert.That(failure, Does.Contain("did not attach"));
    }

    [Test]
    public void ReadyOrDisconnectCancelsDeadlineAndExitMonitoring() {
        using var launcher = StartLauncher("exit 7");
        launcher.WaitForExit();
        using var failed = new ManualResetEventSlim();
        using var watchdog = new SimulatorLaunchWatchdog(launcher, TimeSpan.FromMilliseconds(50), _ => failed.Set());
        watchdog.Dispose();
        watchdog.Start();
        Assert.That(failed.Wait(TimeSpan.FromMilliseconds(150)), Is.False);
    }

    [Test]
    public void AttachmentCancelsAnAlreadyStartedDeadline() {
        using var launcher = StartLauncher("exit 0");
        launcher.WaitForExit();
        using var failed = new ManualResetEventSlim();
        using var watchdog = new SimulatorLaunchWatchdog(launcher, TimeSpan.FromMilliseconds(100), _ => failed.Set());
        watchdog.Start();
        watchdog.Dispose();
        Assert.That(failed.Wait(TimeSpan.FromMilliseconds(200)), Is.False);
    }
}
