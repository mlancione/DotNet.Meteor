using System.Diagnostics;
using System.Text.RegularExpressions;
using DotNet.Meteor.Common.Processes;

namespace DotNet.Meteor.Common.Apple;

public static class AppleSdkLocator {
    public static string XCodePath() {
        var configured = Environment.GetEnvironmentVariable("DEVELOPER_DIR")
            ?? Environment.GetEnvironmentVariable("MD_APPLE_SDK_ROOT");
        if (!string.IsNullOrEmpty(configured)) {
            var developer = configured.EndsWith(".app", StringComparison.OrdinalIgnoreCase)
                ? Path.Combine(configured, "Contents", "Developer") : configured;
            if (!Directory.Exists(developer)) {
                throw new DirectoryNotFoundException($"Configured Xcode directory does not exist: {developer}");
            }
            return developer;
        }
        var selector = new FileInfo(Path.Combine("/usr", "bin", "xcode-select"));
        var result = new ProcessRunner(selector, new ProcessArgumentBuilder()
            .Append("-p"))
            .WaitForExit(10000);

        var path = string.Join(Environment.NewLine, result.StandardOutput)?.Trim();

        if (string.IsNullOrEmpty(path))
            throw new InvalidOperationException("Could not find XCode path");

        return path;
    }
    public static string SimulatorsLocation() {
        var home = Environment.GetEnvironmentVariable("HOME")!;
        var path = Path.Combine(home, "Library", "Developer", "CoreSimulator", "Devices");

        if (string.IsNullOrEmpty(path))
            throw new InvalidOperationException("Could not find simulator path");

        return path;
    }
    public static string DotNetRootLocation() {
        var dotnet = Environment.GetEnvironmentVariable("DOTNET_ROOT");

        if (!string.IsNullOrEmpty(dotnet) && Directory.Exists(dotnet))
            return dotnet;

        if (RuntimeSystem.IsWindows)
            dotnet = Path.Combine("C:", "Program Files", "dotnet");
        else if (RuntimeSystem.IsMacOS)
            dotnet = Path.Combine("/usr", "local", "share", "dotnet");
        else
            dotnet = Path.Combine("/usr", "share", "dotnet");

        if (Directory.Exists(dotnet))
            return dotnet;

        var result = new ProcessRunner("dotnet" + RuntimeSystem.ExecExtension, new ProcessArgumentBuilder()
            .Append("--list-sdks"))
            .WaitForExit(10000);

        if (!result.Success)
            throw new FileNotFoundException("Could not find dotnet tool");

        var matches = Regex.Matches(result.StandardOutput.Last(), @"\[(.*?)\]");
        var sdkLocation = matches.Count != 0 ? matches[0].Groups[1].Value : null;

        if (string.IsNullOrEmpty(sdkLocation) || !Directory.Exists(sdkLocation))
            throw new DirectoryNotFoundException("Could not find dotnet sdk");

        return Directory.GetParent(sdkLocation)?.FullName ?? string.Empty;
    }
    public static string IDeviceLocation() {
        var ideviceDirectory = Environment.GetEnvironmentVariable("IDEVICE_DIR");
        if (Directory.Exists(ideviceDirectory))
            return ideviceDirectory;

        if (RuntimeSystem.IsLinux)
            return Path.Combine("/usr", "bin"); // There is no 'Microsoft.iOS.Linux.Sdk' workload

        return FindInstalledTool("Microsoft.iOS.Windows.Sdk", "tools/msbuild/iOS/imobiledevice-x64", null, true);

    }
    public static bool IsAppleDriverRunning() {
        if (RuntimeSystem.IsMacOS)
            throw new PlatformNotSupportedException();

        if (!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("USBMUXD_CHECK_BYPASS")))
            return true;
        
        var processName = RuntimeSystem.IsWindows ? "AppleMobileDeviceProcess" : "usbmuxd";
        var process = Process.GetProcessesByName(processName);
        return process.Length > 0;
    }

    public static FileInfo SystemProfilerTool() {
        string path = Path.Combine("/usr", "sbin", "system_profiler");
        var tool = new FileInfo(path);

        if (!tool.Exists)
            throw new InvalidOperationException("Could not find system_profiler path");

        return tool;
    }
    public static FileInfo MLaunchTool(string? targetFramework = null) {
        var mlaunchToolPath = Environment.GetEnvironmentVariable("MLAUNCH_PATH");
        if (!string.IsNullOrEmpty(mlaunchToolPath)) {
            if (!File.Exists(mlaunchToolPath)) {
                throw new FileNotFoundException("Configured MLAUNCH_PATH does not exist", mlaunchToolPath);
            }
            return new FileInfo(mlaunchToolPath);
        }

        targetFramework ??= Environment.GetEnvironmentVariable("METEOR_TARGET_FRAMEWORK");
        return new FileInfo(FindInstalledTool("Microsoft.iOS.Sdk", "tools/bin/mlaunch", targetFramework));
    }

    private static string FindInstalledTool(string sdkName, string relativePath, string? targetFramework, bool directory = false) {
        var packs = Path.Combine(DotNetRootLocation(), "packs");
        var frameworkVersion = Regex.Match(targetFramework ?? string.Empty, @"^net(\d+\.\d+)(?:-|$)").Groups[1].Value;
        var prefix = string.IsNullOrEmpty(frameworkVersion) ? $"{sdkName}.net" : $"{sdkName}.net{frameworkVersion}_";
        var bands = Directory.Exists(packs)
            ? Directory.GetDirectories(packs).Where(p => Path.GetFileName(p).StartsWith(prefix, StringComparison.Ordinal))
                .OrderByDescending(p => Path.GetFileName(p), NumericVersionComparer.Instance).ToList()
            : new List<string>();
        // Legacy packs are used only after all matching framework-specific packs.
        var legacy = Path.Combine(packs, sdkName);
        if (Directory.Exists(legacy)) {
            bands.Add(legacy);
        }
        foreach (var band in bands) {
            foreach (var version in Directory.GetDirectories(band)
                .OrderByDescending(p => Path.GetFileName(p), NumericVersionComparer.Instance)) {
                var tool = Path.Combine(version, relativePath);
                if (directory ? Directory.Exists(tool) : File.Exists(tool)) {
                    return tool;
                }
            }
        }
        throw new FileNotFoundException($"Could not find {relativePath} for '{targetFramework ?? "installed SDKs"}' in {packs}");
    }

    private sealed class NumericVersionComparer : IComparer<string> {
        public static readonly NumericVersionComparer Instance = new();
        public int Compare(string? x, string? y) {
            var left = Regex.Matches((x ?? string.Empty).Split('-')[0], @"\d+").Select(m => int.Parse(m.Value)).ToArray();
            var right = Regex.Matches((y ?? string.Empty).Split('-')[0], @"\d+").Select(m => int.Parse(m.Value)).ToArray();
            for (var i = 0; i < Math.Max(left.Length, right.Length); i++) {
                var comparison = (i < left.Length ? left[i] : 0).CompareTo(i < right.Length ? right[i] : 0);
                if (comparison != 0) {
                    return comparison;
                }
            }
            // A stable version sorts after the corresponding prerelease.
            var leftPrerelease = (x ?? string.Empty).Contains('-');
            var rightPrerelease = (y ?? string.Empty).Contains('-');
            return leftPrerelease == rightPrerelease ? StringComparer.Ordinal.Compare(x, y) : leftPrerelease ? -1 : 1;
        }
    }
    public static FileInfo XCRunTool() {
        string path = Path.Combine("/usr", "bin", "xcrun");
        FileInfo tool = new FileInfo(path);

        if (!tool.Exists)
            throw new InvalidOperationException("Could not find xcrun tool");

        return tool;
    }
    public static FileInfo OpenTool() {
        string path = Path.Combine("/usr", "bin", "open");
        FileInfo tool = new FileInfo(path);

        if (!tool.Exists)
            throw new InvalidOperationException("Could not find open tool");

        return tool;
    }
}