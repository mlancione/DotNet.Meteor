using System.Text.RegularExpressions;
using System.Text.Json;
using DotNet.Meteor.Common.Processes;

namespace DotNet.Meteor.Common.Apple;

public static class XCRun {
    public static List<DeviceData> Simulators() {
        var result = new ProcessRunner(AppleSdkLocator.XCRunTool(), new ProcessArgumentBuilder()
            .Append("simctl")
            .Append("list", "devices", "available", "--json"))
            .WaitForExit(15000);

        if (!result.Success) {
            throw new InvalidOperationException(result.GetError());
        }
        return ParseSimulators(result.GetOutput());
    }

    internal static List<DeviceData> ParseSimulators(string json) {
        using var document = JsonDocument.Parse(json);
        var devices = new List<DeviceData>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var runtimeId = RuntimeSystem.IsAarch64 ? Runtimes.iOSSimulatorArm64 : Runtimes.iOSSimulatorX64;

        foreach (var runtime in document.RootElement.GetProperty("devices").EnumerateObject()) {
            const string prefix = "com.apple.CoreSimulator.SimRuntime.iOS-";
            if (!runtime.Name.StartsWith(prefix, StringComparison.Ordinal)) {
                continue;
            }
            var osVersion = $"iOS {runtime.Name.Substring(prefix.Length).Replace('-', '.')}";
            foreach (var device in runtime.Value.EnumerateArray()) {
                if (!device.TryGetProperty("isAvailable", out var available) || available.ValueKind != JsonValueKind.True) {
                    continue;
                }
                var serial = device.GetProperty("udid").GetString();
                if (string.IsNullOrEmpty(serial) || !seen.Add(serial)) {
                    continue;
                }
                devices.Add(new DeviceData {
                    IsEmulator = true,
                    IsMobile = true,
                    IsRunning = device.GetProperty("state").GetString() == "Booted",
                    Name = device.GetProperty("name").GetString() ?? "Unknown",
                    Detail = Details.iOSSimulator,
                    Platform = Platforms.iOS,
                    RuntimeId = runtimeId,
                    OSVersion = osVersion,
                    Serial = serial
                });
            }
        }
        return devices;
    }
    public static List<DeviceData> PhysicalDevices() {
        FileInfo tool = AppleSdkLocator.XCRunTool();
        ProcessResult result = new ProcessRunner(tool, new ProcessArgumentBuilder()
            .Append("xctrace")
            .Append("list")
            .Append("devices"))
            .WaitForExit();

        if (!result.Success)
            throw new InvalidOperationException(string.Join(Environment.NewLine, result.StandardError));

        var output = string.Join(Environment.NewLine, result.StandardOutput) + Environment.NewLine;
        var contentRegex = new Regex(@"^==\sDevices(\sOffline)*\s==\n(?<content>[^,]+?^\n)", RegexOptions.Multiline);
        var deviceRegex = new Regex(@"^(?<name>.+)\s\((?<os>.+)\)\s\((?<udid>.+)\)", RegexOptions.Multiline);
        var devices = new List<DeviceData>();

        foreach (Match match in contentRegex.Matches(output)) {
            var content = match.Groups["content"].Value;

            foreach (Match deviceMatch in deviceRegex.Matches(content)) {
                devices.Add(new DeviceData {
                    IsEmulator = false,
                    IsRunning = true,
                    IsMobile = true,
                    Name = deviceMatch.Groups["name"].Value,
                    Detail = Details.iOSDevice,
                    Platform = Platforms.iOS,
                    RuntimeId = Runtimes.iOSArm64,
                    OSVersion = $"iOS {deviceMatch.Groups["os"].Value}",
                    Serial = deviceMatch.Groups["udid"].Value
                });
            }
        }

        return devices;
    }
    public static void ShutdownAll(IProcessLogger? logger = null) {
        FileInfo tool = AppleSdkLocator.XCRunTool();
        ProcessResult result = new ProcessRunner(tool, new ProcessArgumentBuilder()
            .Append("simctl")
            .Append("shutdown")
            .Append("all"), logger)
            .WaitForExit();

        var output = string.Join(Environment.NewLine, result.StandardOutput) + Environment.NewLine;

        if (!result.Success)
            throw new InvalidOperationException(string.Join(Environment.NewLine, result.StandardError));
    }
    public static void LaunchSimulator(string serial, IProcessLogger? logger = null) {
        var tool = AppleSdkLocator.OpenTool();
        ProcessResult result = new ProcessRunner(tool, new ProcessArgumentBuilder()
            .Append("-a", "Simulator")
            .Append("--args", "-CurrentDeviceUDID", serial), logger)
            .WaitForExit();

        var output = string.Join(Environment.NewLine, result.StandardOutput) + Environment.NewLine;

        if (!result.Success)
            throw new InvalidOperationException(string.Join(Environment.NewLine, result.StandardError));
    }
}