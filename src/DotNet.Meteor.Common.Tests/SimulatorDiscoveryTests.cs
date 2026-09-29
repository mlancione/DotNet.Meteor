using System.Text.Json;
using DotNet.Meteor.Common.Apple;
using DotNet.Meteor.Workspace;
using NUnit.Framework;

namespace DotNet.Meteor.Common.Tests;

public class SimulatorDiscoveryTests {
    [Test]
    public void AvailableIOSDevicesKeepDistinctUDIDsAndBootState() {
        const string json = @"{
          ""devices"": {
            ""com.apple.CoreSimulator.SimRuntime.iOS-27-0"": [
              {""name"":""iPad Pro 11-inch (M5)"",""udid"":""first"",""state"":""Booted"",""isAvailable"":true},
              {""name"":""iPad Pro 11-inch (M5)"",""udid"":""second"",""state"":""Shutdown"",""isAvailable"":true},
              {""name"":""Unavailable runtime"",""udid"":""retired"",""state"":""Shutdown"",""isAvailable"":false},
              {""name"":""Duplicate"",""udid"":""first"",""state"":""Booted"",""isAvailable"":true}
            ],
            ""com.apple.CoreSimulator.SimRuntime.tvOS-27-0"": [
              {""name"":""Apple TV"",""udid"":""tv"",""state"":""Booted"",""isAvailable"":true}
            ]
          }
        }";
        var devices = XCRun.ParseSimulators(json);
        Assert.That(devices.Select(x => x.Serial), Is.EqualTo(new[] { "first", "second" }));
        Assert.That(devices.Select(x => x.IsRunning), Is.EqualTo(new[] { true, false }));
        Assert.That(devices.All(x => x.IsEmulator && x.Platform == Platforms.iOS && x.OSVersion == "iOS 27.0"), Is.True);
        Assert.That(devices.All(x => x.RuntimeId == (RuntimeSystem.IsAarch64 ? Runtimes.iOSSimulatorArm64 : Runtimes.iOSSimulatorX64)), Is.True);
    }

    [Test]
    public void InvalidSimulatorOutputIsReportedRatherThanSilentlyReturningNoDevices() {
        Assert.Catch<JsonException>(() => XCRun.ParseSimulators("not JSON"));
    }

    [Test]
    public void UnsupportedPlatformIsRejectedBeforeStartingProviders() {
        Assert.Throws<ArgumentException>(() => DeviceProvider.GetDevices(platform: "unknown"));
    }

    [Test]
    public void DesktopDiscoveryDoesNotInvokeAndroidOrIOSProviders() {
        var messages = new System.Collections.Concurrent.ConcurrentBag<string>();
        var errors = new System.Collections.Concurrent.ConcurrentBag<Exception>();
        var devices = DeviceProvider.GetDevices(errors.Add, messages.Add, Platforms.MacCatalyst);
        Assert.That(errors, Is.Empty);
        Assert.That(messages.Any(x => x.StartsWith("Android") || x.StartsWith("Apple")), Is.False);
        Assert.That(devices.All(x => x.Platform == Platforms.MacCatalyst), Is.True);
    }
}
