using System.Net;
using System.Diagnostics;
using DotNet.Meteor.Debugger.Extensions;
using DotNet.Meteor.Debugger.Sdb;
using DotNet.Meteor.Common;
using Mono.Debugging.Soft;
using DotNet.Meteor.Common.Processes;
using DotNet.Meteor.Common.Apple;
using DotNet.Meteor.Common.Android;

namespace DotNet.Meteor.Debugger;

public class DebugLaunchAgent : BaseLaunchAgent {
    private readonly SoftDebuggerStartArgs startArguments;
    private readonly SoftDebuggerStartInfo startInformation;
    private readonly ExternalTypeResolver typeResolver;
    private Process? simulatorLauncher;
    private SimulatorLaunchWatchdog? simulatorWatchdog;
    private DebugSession? debugSession;
    private int launchCompleted;

    public DebugLaunchAgent(LaunchConfiguration configuration) : base(configuration) {
        if (configuration.Device.IsAndroid || (configuration.Device.IsIPhone && !configuration.Device.IsEmulator))
            startArguments = new ClientConnectionProvider(IPAddress.Loopback, configuration.DebugPort, configuration.Project.Name);
        else if (configuration.Device.IsIPhone || configuration.Device.IsMacCatalyst)
            startArguments = new ServerConnectionProvider(IPAddress.Loopback, configuration.DebugPort, configuration.Project.Name);

        ArgumentNullException.ThrowIfNull(startArguments, "Debugger connection arguments not implemented.");
        if (startArguments is ServerConnectionProvider serverConnection) {
            // The listener is opened in the provider constructor, before Run.
            // Also close it if deployment fails before Mono begins connecting.
            Disposables.Add(() => serverConnection.CancelConnect(null!));
        }

        typeResolver = new ExternalTypeResolver(configuration.TransportId);
        startInformation = new SoftDebuggerStartInfo(startArguments);
        startInformation.SetAssemblies(configuration.GetAssembliesPath(), configuration.DebuggerSessionOptions);
    }
    public override void Launch(DebugSession debugSession) {
        this.debugSession = debugSession;
        if (Configuration.Device.IsAndroid)
            LaunchAndroid(debugSession);
        if (Configuration.Device.IsIPhone)
            LaunchAppleMobile(debugSession);
        if (Configuration.Device.IsMacCatalyst)
            LaunchMacCatalyst(debugSession);
        if (Configuration.Device.IsWindows)
            throw new NotSupportedException();
    }
    public override void Connect(SoftDebuggerSession session) {
        session.Run(startInformation, Configuration.DebuggerSessionOptions);
        Disposables.Add(() => typeResolver.Dispose());
        if (typeResolver.TryConnect()) {
            session.TypeResolverHandler = typeResolver.Resolve;
        }

        if (simulatorLauncher != null && Volatile.Read(ref launchCompleted) == 0) {
            simulatorWatchdog = new SimulatorLaunchWatchdog(simulatorLauncher, TimeSpan.FromSeconds(120), message => {
                debugSession!.FailLaunch($"{message} Simulator: {Configuration.Device.Name} ({Configuration.Device.Serial}). Launcher: {simulatorLauncher.StartInfo.FileName}. Check the selected Xcode, iOS workload and simulator, then retry.");
            });
            Disposables.Add(() => simulatorWatchdog.Dispose());
            if (Volatile.Read(ref launchCompleted) != 0) {
                simulatorWatchdog.Dispose();
            } else {
                debugSession!.OnDebugDataReceived($"Waiting up to 120 seconds for simulator debugger attachment: {Configuration.Device.Serial}");
                simulatorWatchdog.Start();
            }
        }
    }

    public void CompleteLaunch() {
        Interlocked.Exchange(ref launchCompleted, 1);
        simulatorWatchdog?.Dispose();
    }

    private void LaunchAppleMobile(DebugSession debugSession) {
        if (RuntimeSystem.IsMacOS) {
            if (Configuration.Device.IsEmulator) {
                var debugProcess = MonoLauncher.DebugSim(Configuration.Device.Serial, Configuration.ProgramPath, Configuration.DebugPort, Configuration.EnvironmentVariables, debugSession);
                simulatorLauncher = debugProcess;
                Disposables.Add(() => debugProcess.Terminate());
            } else {
                var debugPortForwarding = MonoLauncher.TcpTunnel(Configuration.Device.Serial, Configuration.DebugPort, debugSession);
                Disposables.Add(() => debugPortForwarding.Terminate());
                var hotReloadPortForwarding = MonoLauncher.TcpTunnel(Configuration.Device.Serial, Configuration.ReloadHostPort, debugSession);
                Disposables.Add(() => hotReloadPortForwarding.Terminate());
                MonoLauncher.InstallDev(Configuration.Device.Serial, Configuration.ProgramPath, debugSession);

                var debugProcess = MonoLauncher.DebugDev(Configuration.Device.Serial, Configuration.ProgramPath, Configuration.DebugPort, Configuration.EnvironmentVariables, debugSession);
                Disposables.Add(() => debugProcess.Terminate());
            }
        } else {
            var debugProxyProcess = IDeviceTool.Proxy(Configuration.Device.Serial, Configuration.DebugPort, debugSession);
            Disposables.Add(() => debugProxyProcess.Terminate());
            var reloadProxyProcess = IDeviceTool.Proxy(Configuration.Device.Serial, Configuration.ReloadHostPort, debugSession);
            Disposables.Add(() => reloadProxyProcess.Terminate());

            IDeviceTool.Installer(Configuration.Device.Serial, Configuration.ProgramPath, debugSession);
            debugSession.OnImportantDataReceived("Application installed on device. Tap the application icon on your device to run it.");
        }
    }
    private void LaunchMacCatalyst(IProcessLogger logger) {
        var tool = AppleSdkLocator.OpenTool();
        var processRunner = new ProcessRunner(tool, new ProcessArgumentBuilder().AppendQuoted(Configuration.ProgramPath));
        processRunner.SetEnvironmentVariable("__XAMARIN_DEBUG_HOSTS__", "127.0.0.1");
        processRunner.SetEnvironmentVariable("__XAMARIN_DEBUG_PORT__", Configuration.DebugPort.ToString());
        foreach (var env in Configuration.EnvironmentVariables)
            processRunner.SetEnvironmentVariable(env.Key, env.Value);

        var result = processRunner.WaitForExit();
        if (!result.Success)
            throw ServerExtensions.GetProtocolException(string.Join(Environment.NewLine, result.StandardError));
    }
    private void LaunchAndroid(IProcessLogger logger) {
        var applicationId = Configuration.GetApplicationName();
        if (Configuration.Device.IsEmulator)
            Configuration.Device.Serial = AndroidEmulator.Run(Configuration.Device.Name).Serial;

        AndroidDebugBridge.Forward(Configuration.Device.Serial, Configuration.ReloadHostPort);
        AndroidDebugBridge.Forward(Configuration.Device.Serial, Configuration.DebugPort);

        if (Configuration.UninstallApp)
            AndroidDebugBridge.Uninstall(Configuration.Device.Serial, applicationId, logger);

        AndroidDebugBridge.Install(Configuration.Device.Serial, Configuration.ProgramPath, logger);
        AndroidDebugBridge.Shell(Configuration.Device.Serial, "setprop", "debug.mono.connect", $"port={Configuration.DebugPort}");
        if (Configuration.EnvironmentVariables.Count != 0)
            AndroidDebugBridge.Shell(Configuration.Device.Serial, "setprop", "debug.mono.env", Configuration.EnvironmentVariables.ToAndroidEnvString());

        AndroidDebugBridge.Shell(Configuration.Device.Serial, "am", "set-debug-app", applicationId);

        AndroidFastDev.TryPushAssemblies(Configuration.Device, Configuration.AssetsPath, applicationId, logger);

        AndroidDebugBridge.Launch(Configuration.Device.Serial, applicationId, logger);
        AndroidDebugBridge.Flush(Configuration.Device.Serial);

        var logcatProcess = AndroidDebugBridge.Logcat(Configuration.Device.Serial, applicationId, logger);

        Disposables.Add(() => logcatProcess.Terminate());
        Disposables.Add(() => AndroidDebugBridge.RemoveForward(Configuration.Device.Serial));
    }
}