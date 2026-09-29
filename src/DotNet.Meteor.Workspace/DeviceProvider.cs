using DotNet.Meteor.Common;
using DotNet.Meteor.Common.Android;
using DotNet.Meteor.Common.Apple;
using DotNet.Meteor.Common.Windows;

namespace DotNet.Meteor.Workspace;

public static class DeviceProvider {
    public static List<DeviceData> GetDevices(Action<Exception>? errorHandler = null, Action<string>? debugHandler = null, string? platform = null) {
        if (platform != null && platform != Platforms.Android && platform != Platforms.iOS
            && platform != Platforms.MacCatalyst && platform != Platforms.Windows) {
            throw new ArgumentException($"Unsupported device platform: {platform}", nameof(platform));
        }

        debugHandler?.Invoke($"Fetching devices for {platform ?? "all platforms"}...");
        var providers = new List<Task<List<DeviceData>>>();

        void AddProvider(string name, Func<IEnumerable<DeviceData>> getDevices) {
            providers.Add(Task.Run(() => {
                try {
                    var result = getDevices().ToList();
                    debugHandler?.Invoke($"{name}: {result.Count} devices added.");
                    return result;
                } catch (Exception e) {
                    debugHandler?.Invoke($"{name} discovery failed: {e.Message}");
                    errorHandler?.Invoke(e);
                    return new List<DeviceData>();
                }
            }));
        }

        if (RuntimeSystem.IsWindows && (platform == null || platform == Platforms.Windows)) {
            AddProvider("Windows", () => new[] { WindowsDeviceTool.WindowsDevice() });
        }
        if (platform == null || platform == Platforms.Android) {
            AddProvider("Android physical", () => AndroidDeviceTool.PhysicalDevices().OrderBy(x => x.Name));
            AddProvider("Android virtual", () => AndroidDeviceTool.VirtualDevices().OrderBy(x => !x.IsRunning).ThenBy(x => x.Name));
        }
        if (RuntimeSystem.IsMacOS) {
            if (platform == null || platform == Platforms.MacCatalyst) {
                AddProvider("MacOS", AppleDeviceTool.MacintoshDevices);
            }
            if (platform == null || platform == Platforms.iOS) {
                AddProvider("Apple physical", () => AppleDeviceTool.PhysicalDevices().OrderBy(x => x.Name));
                AddProvider("Apple virtual", () => AppleDeviceTool.VirtualDevices().OrderBy(x => !x.IsRunning).ThenBy(x => x.Name));
            }
        } else if (platform == null || platform == Platforms.iOS) {
            AddProvider("Apple physical", () => AppleSdkLocator.IsAppleDriverRunning() ? IDeviceTool.Info() : new List<DeviceData>());
        }

        // Each provider owns its failure; Android cannot prevent Apple discovery,
        // and a USB query cannot suppress simulator results.
        var devices = Task.WhenAll(providers).GetAwaiter().GetResult().SelectMany(x => x).ToList();
        debugHandler?.Invoke($"Devices fetched. Total: {devices.Count}.");
        return devices;
    }
}
