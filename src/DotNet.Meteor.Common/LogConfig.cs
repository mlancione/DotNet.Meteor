using System.Diagnostics;
using System.Text.RegularExpressions;
using NLog;
using NLog.Config;
using NLog.Targets;
using NLog.Targets.Wrappers;

namespace DotNet.Meteor.Common;

public static class LogConfig {
    private static readonly string _logDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logs");
    // Workspace, debugger and hot-reload processes must not erase one another's diagnostics.
    public static readonly string SessionLogDirectory = Path.Combine(_logDir, $"{DateTime.UtcNow:yyyyMMdd-HHmmss-fffffff}-{Environment.ProcessId}");
    public static readonly string ErrorLogFile = Path.Combine(SessionLogDirectory, "Error.log");
    public static readonly string DebugLogFile = Path.Combine(SessionLogDirectory, "Debug.log");

    public static void InitializeLog() {
        Directory.CreateDirectory(SessionLogDirectory);
        RemoveExpiredLogs();
        var configuration = new LoggingConfiguration();

        var commonTarget = new FileTarget() {
            FileName = DebugLogFile,
            Layout = "${time}|${message}",
            DeleteOldFileOnStartup = false,
            MaxArchiveFiles = 1,
            ArchiveAboveSize = 1 * 1024 * 1024, //MB
        };
        var commonAsyncTarget = new AsyncTargetWrapper(commonTarget, 500, AsyncTargetWrapperOverflowAction.Discard);
        configuration.AddTarget("log", commonAsyncTarget);

        var errorTarget = new FileTarget() {
            FileName = ErrorLogFile,
            DeleteOldFileOnStartup = false,
            Layout = "${longdate}|${message}${exception:format=tostring}${newline}at ${stacktrace:format=Flat:separator= at :reverse=true}${newline}${callsite-filename}[${callsite-linenumber}]",
            MaxArchiveFiles = 1,
            ArchiveAboveSize = 1 * 1024 * 1024, //MB
        };
        var errorAsyncTarget = new AsyncTargetWrapper(errorTarget, 500, AsyncTargetWrapperOverflowAction.Discard);
        configuration.AddTarget("errorLog", errorAsyncTarget);

        configuration.LoggingRules.Add(new LoggingRule("*", LogLevel.Debug, commonAsyncTarget));
        configuration.LoggingRules.Add(new LoggingRule("*", LogLevel.Error, errorAsyncTarget));

        LogManager.ThrowExceptions = false;
        LogManager.Configuration = configuration;
        LogManager.ReconfigExistingLoggers();
        LogManager.GetCurrentClassLogger().Debug($"Process {Environment.ProcessId} diagnostics: {SessionLogDirectory}");
    }

    private static void RemoveExpiredLogs() {
        // Keep recent processes (which may still be running), and cap older evidence
        // at seven days or thirty process directories. Legacy shared logs are retained.
        try {
            var directories = new DirectoryInfo(_logDir).GetDirectories()
                .Where(x => Regex.IsMatch(x.Name, @"^\d{8}-\d{6}-\d{7}-\d+$"))
                .OrderByDescending(x => x.CreationTimeUtc)
                .ToList();
            var now = DateTime.UtcNow;
            for (var index = 0; index < directories.Count; index++) {
                var directory = directories[index];
                if (directory.FullName == SessionLogDirectory || directory.CreationTimeUtc > now.AddDays(-1)) {
                    continue;
                }
                if (index >= 30 || directory.CreationTimeUtc < now.AddDays(-7)) {
                    if (int.TryParse(directory.Name.Split('-').Last(), out var processId)) {
                        try {
                            using var process = Process.GetProcessById(processId);
                            if (!process.HasExited) {
                                continue;
                            }
                        } catch (ArgumentException) {
                            // No live process owns this directory.
                        }
                    }
                    try {
                        directory.Delete(true);
                    } catch (IOException) {
                        // A concurrent process may own the files or have already removed them.
                    } catch (UnauthorizedAccessException) {
                        // Logging must remain available when old evidence cannot be removed.
                    }
                }
            }
        } catch (IOException) {
        } catch (UnauthorizedAccessException) {
        }
    }
}
