using NLog;
using NUnit.Framework;

namespace DotNet.Meteor.Common.Tests;

[NonParallelizable]
public class SessionLoggingTests {
    [Test]
    public void ReinitializingLoggingPreservesExistingEvidenceAndExceptionDetails() {
        var previous = LogManager.Configuration;
        try {
            Directory.CreateDirectory(LogConfig.SessionLogDirectory);
            File.WriteAllText(LogConfig.DebugLogFile, "previous diagnostic evidence\n");
            LogConfig.InitializeLog();
            LogManager.GetCurrentClassLogger().Error(new InvalidOperationException("diagnostic-test-exception"));
            LogManager.Flush();
            Assert.That(Path.GetDirectoryName(LogConfig.DebugLogFile), Is.EqualTo(LogConfig.SessionLogDirectory));
            Assert.That(LogConfig.SessionLogDirectory, Does.EndWith($"-{Environment.ProcessId}"));
            Assert.That(ReadActiveLog(LogConfig.DebugLogFile), Does.Contain("previous diagnostic evidence"));
            Assert.That(ReadActiveLog(LogConfig.ErrorLogFile), Does.Contain("InvalidOperationException").And.Contain("diagnostic-test-exception"));
        } finally {
            LogManager.Configuration = previous;
        }
    }

    private static string ReadActiveLog(string path) {
        // NLog keeps its writer open; Windows readers must explicitly share it.
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
