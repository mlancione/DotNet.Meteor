using System.Diagnostics;
using DotNet.Meteor.Common.Processes;
using NUnit.Framework;

namespace DotNet.Meteor.Common.Tests;

[TestFixture]
public class ProcessTimeoutTests {
    [Test]
    public void TimedOutHelperIsTerminated() {
        if (OperatingSystem.IsWindows()) {
            Assert.Ignore("Unix shell fixture");
        }
        var watch = Stopwatch.StartNew();
        var runner = new ProcessRunner(new FileInfo("/bin/sh"), new ProcessArgumentBuilder().Append("-c").AppendQuoted("sleep 30"));
        Assert.Throws<TimeoutException>(() => runner.WaitForExit(100));
        Assert.That(watch.Elapsed, Is.LessThan(TimeSpan.FromSeconds(5)));
    }
    [Test]
    public void TimedWaitFlushesOutputAndReturnsExitCode() {
        if (OperatingSystem.IsWindows()) {
            Assert.Ignore("Unix shell fixture");
        }
        var runner = new ProcessRunner(new FileInfo("/bin/sh"), new ProcessArgumentBuilder().Append("-c").AppendQuoted("echo output; echo warning >&2; exit 7"));
        var result = runner.WaitForExit(5000);
        Assert.That(result.ExitCode, Is.EqualTo(7));
        Assert.That(result.StandardOutput, Does.Contain("output"));
        Assert.That(result.StandardError, Does.Contain("warning"));
    }
}
