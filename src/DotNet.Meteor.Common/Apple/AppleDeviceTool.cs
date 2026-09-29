namespace DotNet.Meteor.Common.Apple;

public static class AppleDeviceTool {
    public static List<DeviceData> VirtualDevices() {
        return XCRun.Simulators();
    }
    public static List<DeviceData> PhysicalDevices() {
        return SystemProfiler.PhysicalDevices();
    }
    public static List<DeviceData> MacintoshDevices() {
        var devices = new List<DeviceData>();
        var tokens = Environment.OSVersion.VersionString.Split(' ');
        var osVersion = $"MacOS {tokens.Last()}";

        if (RuntimeSystem.IsAarch64) {
            devices.Add(new DeviceData {
                IsEmulator = false,
                IsRunning = true,
                IsMobile = false,
                // Use default for other Frameworks like Avalonia
                // RuntimeId = Runtimes.MacArm64,
                OSVersion = osVersion,
                Detail = Details.MacCatalyst,
                Platform = Platforms.MacCatalyst,
                Name = $"{Environment.MachineName} ({Details.MacArm})"
            });
        }

        devices.Add(new DeviceData {
            IsEmulator = false,
            IsRunning = true,
            IsMobile = false,
            // Use default for other Frameworks like Avalonia
            RuntimeId = RuntimeSystem.IsAarch64 ? Runtimes.MacX64 : string.Empty,
            OSVersion = osVersion,
            Detail = Details.MacCatalyst,
            Platform = Platforms.MacCatalyst,
            Name = $"{Environment.MachineName} ({Details.MacX64})"
        });

        return devices;
    }
}