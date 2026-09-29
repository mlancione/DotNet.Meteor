using DotNet.Meteor.Common.Android;
using NUnit.Framework;

namespace DotNet.Meteor.Common.Tests;

[NonParallelizable]
public class AndroidDiscoveryTests {
    [Test]
    public void OfflineAndUnauthorizedADBDevicesAreExcludedBeforePropertyQueries() {
        if (RuntimeSystem.IsWindows) {
            Assert.Ignore("The fake adb executable is a POSIX shell script.");
        }
        var directory = Path.Combine(Path.GetTempPath(), $"meteor-adb-test-{Guid.NewGuid():N}");
        var previous = Environment.GetEnvironmentVariable("ANDROID_SDK_ROOT");
        try {
            Directory.CreateDirectory(Path.Combine(directory, "platform-tools"));
            var executable = Path.Combine(directory, "platform-tools", "adb");
            File.WriteAllText(executable, "#!/bin/sh\nprintf 'List of devices attached\\nready\\tdevice product:test\\noffline\\toffline\\nlocked\\tunauthorized\\n'\n");
            System.Diagnostics.Process.Start("/bin/chmod", $"+x {executable}")!.WaitForExit();
            Environment.SetEnvironmentVariable("ANDROID_SDK_ROOT", directory);
            Assert.That(AndroidDebugBridge.Devices(), Is.EqualTo(new[] { "ready" }));
        } finally {
            Environment.SetEnvironmentVariable("ANDROID_SDK_ROOT", previous);
            Directory.Delete(directory, true);
        }
    }
}
