using DotNet.Meteor.Common.Apple;
using NUnit.Framework;

namespace DotNet.Meteor.Common.Tests;

[TestFixture, NonParallelizable]
public class AppleSdkSelectionTests {
    private string root = null!;
    private string? oldRoot;
    private string? oldLauncher;
    private string? oldFramework;
    [SetUp]
    public void SetUp() {
        root = Path.Combine(Path.GetTempPath(), "meteor-packs-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        oldRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        oldLauncher = Environment.GetEnvironmentVariable("MLAUNCH_PATH");
        oldFramework = Environment.GetEnvironmentVariable("METEOR_TARGET_FRAMEWORK");
        Environment.SetEnvironmentVariable("DOTNET_ROOT", root);
        Environment.SetEnvironmentVariable("MLAUNCH_PATH", null);
        Environment.SetEnvironmentVariable("METEOR_TARGET_FRAMEWORK", null);
    }
    [TearDown]
    public void TearDown() {
        Environment.SetEnvironmentVariable("DOTNET_ROOT", oldRoot);
        Environment.SetEnvironmentVariable("MLAUNCH_PATH", oldLauncher);
        Environment.SetEnvironmentVariable("METEOR_TARGET_FRAMEWORK", oldFramework);
        Directory.Delete(root, true);
    }
    private string AddLauncher(string band, string version) {
        var tool = Path.Combine(root, "packs", band, version, "tools", "bin", "mlaunch");
        Directory.CreateDirectory(Path.GetDirectoryName(tool)!);
        File.WriteAllText(tool, string.Empty);
        return tool;
    }
    [Test]
    public void NumericOrderingSelectsNet10AheadOfNet9AndLatestPatch() {
        AddLauncher("Microsoft.iOS.Sdk.net9.0_26.5", "26.5.9004");
        AddLauncher("Microsoft.iOS.Sdk.net10.0_27.0", "27.0.9999");
        var expected = AddLauncher("Microsoft.iOS.Sdk.net10.0_27.0", "27.0.10722");
        Assert.That(AppleSdkLocator.MLaunchTool().FullName, Is.EqualTo(expected));
    }
    [Test]
    public void ProjectFrameworkCannotFallBackToOtherFramework() {
        var expected = AddLauncher("Microsoft.iOS.Sdk.net9.0_26.5", "26.5.9004");
        AddLauncher("Microsoft.iOS.Sdk.net10.0_27.0", "27.0.10722");
        Assert.That(AppleSdkLocator.MLaunchTool("net9.0-ios26.5").FullName, Is.EqualTo(expected));
        Assert.Throws<FileNotFoundException>(() => AppleSdkLocator.MLaunchTool("net8.0-ios"));
    }
    [Test]
    public void SkipIncompletePacksAndPreferStableOverPrerelease() {
        var expected = AddLauncher("Microsoft.iOS.Sdk.net10.0_27.0", "27.0.10722");
        AddLauncher("Microsoft.iOS.Sdk.net10.0_27.0", "27.0.10722-preview.1");
        Directory.CreateDirectory(Path.Combine(root, "packs", "Microsoft.iOS.Sdk.net10.0_28.0", "28.0.100"));
        Assert.That(AppleSdkLocator.MLaunchTool("net10.0-ios").FullName, Is.EqualTo(expected));
    }
    [Test]
    public void ExplicitOverrideWinsAndInvalidOverrideIsActionable() {
        var expected = AddLauncher("Microsoft.iOS.Sdk.net9.0_26.5", "26.5.9004");
        AddLauncher("Microsoft.iOS.Sdk.net10.0_27.0", "27.0.10722");
        Environment.SetEnvironmentVariable("MLAUNCH_PATH", expected);
        Assert.That(AppleSdkLocator.MLaunchTool("net10.0-ios").FullName, Is.EqualTo(expected));
        Environment.SetEnvironmentVariable("MLAUNCH_PATH", Path.Combine(root, "missing"));
        Assert.Throws<FileNotFoundException>(() => AppleSdkLocator.MLaunchTool());
    }
    [Test]
    public void LegacyPackRemainsSupported() {
        var expected = AddLauncher("Microsoft.iOS.Sdk", "18.0.10");
        Assert.That(AppleSdkLocator.MLaunchTool("net8.0-ios").FullName, Is.EqualTo(expected));
    }
    [Test]
    public void SimulatorLaunchPassesSelectedXcodeAndUdidWithoutUsbArguments() {
        if (OperatingSystem.IsWindows()) {
            Assert.Ignore("Unix executable fixture");
        }
        var developer = Path.Combine(root, "Xcode Fixture.app", "Contents", "Developer");
        Directory.CreateDirectory(developer);
        var oldDeveloper = Environment.GetEnvironmentVariable("DEVELOPER_DIR");
        try {
            Environment.SetEnvironmentVariable("DEVELOPER_DIR", developer);
            var tool = AddLauncher("Microsoft.iOS.Sdk.net10.0_27.0", "27.0.10722");
            var output = Path.Combine(root, "arguments.txt");
            File.WriteAllText(tool, "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + output + "'\n");
            using (var chmod = System.Diagnostics.Process.Start("/bin/chmod", $"+x {tool}")) {
                chmod!.WaitForExit();
            }
            using var launcher = MonoLauncher.DebugSim("selected-udid", "/fake/App Bundle.app", 12345);
            Assert.That(launcher.WaitForExit(5000), Is.True);
            var args = File.ReadAllLines(output);
            Assert.That(args, Does.Contain("--sdkroot").And.Contain(developer));
            Assert.That(args, Does.Contain("--device=:v2:udid=selected-udid"));
            Assert.That(args.Any(arg => arg.StartsWith("--devname") || arg.StartsWith("--tcp-tunnel")), Is.False);
        } finally {
            Environment.SetEnvironmentVariable("DEVELOPER_DIR", oldDeveloper);
        }
    }

}
