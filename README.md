# .NET Meteor (Local)

This fork installs as **`localdev.dotnet-meteor-local`**, separately from official .NET Meteor. Keep Microsoft C# and C# Dev Kit enabled; DotRush is not required. Disable official Meteor in the VS Code profile where you enable this fork, because the debugger, command, task and setting identifiers are intentionally preserved for existing projects.

Download packages from [GitHub Releases](https://github.com/mlancione/DotNet.Meteor/releases) and run **Extensions: Install from VSIX**. Release assets are retained independently of expiring Actions artifacts. Saved workspace selections start fresh when moving from the official extension ID.

Click the configuration item in the status bar to choose a configuration and target framework (for example, `Debug | net9.0-ios`). The device picker lists compatible devices and remembers your choice separately for each framework. The framework is also remembered per project. A disconnected preferred device retains its preference until you explicitly choose another device.

To build and publish all six packages:

```sh
gh workflow run ci.yml --repo mlancione/DotNet.Meteor \
  --ref main \
  -f release_version=6.3.1 -f publish_release=true
```

Use a new numeric version for changed source. Set `publish_release=false` for artifact-only builds. Successful release builds create `local-v<VERSION>` at the exact built commit and attach Linux, macOS and Windows x64/ARM64 VSIX files. Tag pushes matching `local-v*` also publish releases. The GitHub workflow does not publish to the VS Code Marketplace.

Build tooling uses the Node version in `.nvmrc`, locked npm dependencies, and project-local `@vscode/vsce` (no global packaging tools needed). Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run package` for extension checks.

Click the runtime item beside the configuration and device selectors to choose **Project Default**, **Mono**, or **CoreCLR (Experimental)**. This saves one global `dotnetMeteor.runtime` setting. It applies to mobile builds and debugging; desktop projects retain the existing C# debugger route. Stop an active Meteor session before switching.

Project Default follows the project's evaluated `UseMonoRuntime`. Mono retains our hardened debugger and existing build outputs. CoreCLR sets `UseMonoRuntime=false`, enables diagnostics and packages a matching native debugging agent. Its builds use `obj/meteor-coreclr/` and `bin/meteor-coreclr/`, and path queries receive the same properties as the build. Existing launch and task identifiers remain unchanged. CoreCLR rejects task arguments that override the selected framework, configuration, device or managed runtime/output properties, so build and debugger paths remain consistent. SDK source globs retain their exclusions for normal `obj` and `bin` files when the output roots change.

CoreCLR on iOS and Mac Catalyst requires a .NET 11 target and a workload compatible with your Xcode installation. Android requires .NET 10 or later. The runtime picker does not install SDKs, change target frameworks or bypass Xcode validation. To experiment alongside your stable SDK, set the global `dotnetMeteor.coreClrDotnetPath` to a separate installation's executable and explicitly select CoreCLR. It still respects the project's `global.json`; choose a compatible target with the target framework selector. Switching back to Mono on iOS also requires selecting a .NET 10 target because .NET 11 no longer supports Mono.

Set the global **CoreCLR ReadyToRun** setting (`dotnetMeteor.coreClrReadyToRun`) in VS Code Settings to **Default**, **Disabled**, or **Enabled**. Its initial value is Disabled: Meteor passes `PublishReadyToRun=false` to CoreCLR builds and the matching path/tool queries. Enabled passes `true`; Default leaves the project/SDK value alone. This applies to local Meteor CoreCLR sessions, including a Release configuration used for debugging; it does not change Mono or publishing outside Meteor. CoreCLR task arguments must not override this property; use the global setting or, with Default selected, the project's build configuration.

The [.NET 11 RC1 release notes](https://github.com/dotnet/macios/releases/tag/dotnet-11.0.1xx-rc1-12193#known-issues) report a debugger crash with ReadyToRun enabled. Keep it disabled for initial .NET 11/Xcode 27 debugging until the exact compatible workload has been qualified. Xcode support alone does not establish ReadyToRun debugger compatibility.

Application release compilation settings belong in shared project/build configuration consumed by CI. NativeAOT remains a separate publish experiment: after CoreCLR qualification, use an isolated Jenkins publishing lane with explicit SDK/workload pins, AOT/trimming warning review, startup/capture/layout tests and package size/performance measurements before promotion. Do not enable NativeAOT through this debugger's runtime selector; these adapters do not support NativeAOT debugging.

The experimental backend supports F5 debugging, with Apple sessions currently limited to a local Mac. Meteor profiling, Pair to Mac and the existing XAML Hot Reload agent are not supported by this backend. Run Without Debugging is available only through the opt-in C# Hot Reload workflow below. Mono retains these features. NativeAOT is rejected for both debugger modes. .NET 11 RC2/Xcode 27 iOS ARM64 simulator debugging has passed startup, breakpoints, stack inspection, evaluation and stepping; broader app/device qualification remains separate.

### Optional Microsoft CoreCLR debugger

In Meteor 6.3.3+, choose **Microsoft (vsdbg)** using **.NET Meteor: Select CoreCLR debugger (Meteor / Microsoft)** in the Command Palette, or set the global `dotnetMeteor.coreClrDebugger` to `microsoft`. The default remains `meteor` (our bundled `clrdbg` backend). The status bar identifies Microsoft when CoreCLR is explicitly selected. Stop the active session before switching.

The first Microsoft lane supports F5 on a local Mac with a managed .NET 11+ iOS ARM64 or x64 simulator target. Install/enable Microsoft's **C#**, **C# Dev Kit** and **.NET MAUI** extensions in Microsoft-distributed VS Code. Their normal [Microsoft debugger licensing](https://github.com/dotnet/vscode-csharp/blob/main/docs/debugger/Microsoft-.NET-Core-Debugger-licensing-and-Microsoft-Visual-Studio-Code.md) and activation checks apply; [C# Dev Kit/MAUI entitlement requirements](https://code.visualstudio.com/docs/csharp/cs-dev-kit-faq#licensing-and-contributing) are separate from the debugger's editor restriction. Meteor delegates to C#'s `coreclr_mobile` adapter and uses the matching native transport libraries from the installed MAUI extension. It does not download, patch or distribute Microsoft debugger binaries. Extension paths are discovered dynamically; missing components fail with a prerequisite message. This depends on Microsoft's mobile integration contract, which may change in later extension versions.

Select `CoreCLR` and a compatible simulator, then use your normal Meteor **Build & Debug / F5** launch. In 6.3.4+, Microsoft debugging follows **C# Dev Kit's active solution configuration and platform**. The configuration status item displays `(C#)` and opens Dev Kit's configuration picker; accept its window reload after changing the selection. Meteor keeps a separate target framework selector. Mono and SDK-watch retain Meteor's independent configuration picker and saved choice. Meteor reads the installed Dev Kit's broker without changing its private storage. If that service is unavailable, launch reports an actionable error instead of using a stale configuration. Microsoft builds and property queries use `obj/meteor-coreclr-microsoft/` and `bin/meteor-coreclr-microsoft/`, untrimmed assemblies, portable symbols and the partial static registrar. ReadyToRun follows the global CoreCLR setting (Disabled is recommended). Mono, the bundled CoreCLR backend, SDK-watch outputs and publishing outside Meteor retain their existing behavior. NativeAOT cannot use this backend. Physical devices, Android, Mac Catalyst, Pair to Mac and Meteor profiling are not qualified for this Microsoft lane and are rejected rather than silently switching engines.

The Debug Console displays Microsoft debugger output. Simulator launch diagnostics appear in **Output → .NET Meteor Microsoft Debugger**. Meteor launches the app after the Microsoft adapter completes breakpoint configuration, using the selected SDK/workload/Xcode tools and an available loopback port. It verifies the installed components still match the build, tolerating iOS code signing, and stops its owned launcher/app when the session ends. Rebuild after updating the Microsoft extensions.

Debugger-attached C# Hot Reload has been qualified for a native UIKit app using .NET 11 RC2, iOS 27.0 ARM64, **C# 2.160.4**, **C# Dev Kit 3.40.210** and **MAUI 1.17.266**. Earlier extension combinations failed to activate the service. Enable `csharp.experimental.debug.hotReload` and use Microsoft's Apply Hot Reload command (or `csharp.debug.hotReloadOnSave`). Supported edits take effect when the changed method runs again; UIKit view creation is not automatically repeated. Intel/x64 still needs live qualification.

Hot Reload requires the C# project system to compile the same assemblies as Meteor. Put matching properties in the selected project's configuration and shared `Directory.Build.props`, including referenced projects: `BaseIntermediateOutputPath=obj/meteor-coreclr-microsoft/`, `BaseOutputPath=bin/meteor-coreclr-microsoft/`, portable symbols, `Optimize=false`, `MetadataUpdaterSupport=true`, and `DefaultItemExcludes=$(DefaultItemExcludes);**/bin/**;**/obj/**`. The iOS app also needs `UseMonoRuntime=false`, `PublishAot=false`, `PublishReadyToRun=false`, `TrimMode=copy`, `MtouchLink=None`, `MtouchDebug=true`, `DebuggerSupport=true`, `Registrar=partial-static` and `HotReloadCompatibleBuild=true`. Scope these settings to your opt-in managed debug configuration; keep production publishing separate.

Start VS Code with the selected CoreCLR SDK in `PATH` and `DOTNET_ROOT`; Meteor's separate SDK setting does not restart the C# project system. When Microsoft's Hot Reload setting is enabled, Meteor checks the loaded framework, configuration output, restore paths and referenced-project baselines before building and again before launching. Its SDK check uses Dev Kit's process task executable when exposed, otherwise VS Code's process environment; private SDK overrides are not exposed by the custom build terminal. A mismatch blocks launch with repair guidance. SDK-watch Ctrl+F5 remains a separate option and does not depend on Microsoft extensions.

### Opt-in C# Hot Reload

In Meteor 6.3.2+, enable the global **Dotnet Meteor: Core CLR Hot Reload** setting (`dotnetMeteor.coreClrHotReload`). Select a C# .NET 11+ iOS target, a managed CoreCLR configuration and a local iOS simulator, then use **Run Without Debugging (Ctrl+F5)**. The default is off. Ordinary **F5** retains the normal CoreCLR debugger and breakpoints; the C# watcher is not started for F5.

The SDK's `dotnet watch` compiles and applies supported C# edits on save. Its output appears in the Debug Console, and stopping the session stops its owned watcher/build processes and simulator app. No MAUI plugin or extra extension is required. Meteor's **Apply Hot Reload Changes On Save** preference controls the separate XAML agent; it does not control this C# watcher. Edits requiring a restart are reported by the SDK. Updated methods take effect when executed again; existing UIKit view construction is not automatically rerun.

Hot Reload builds and their property queries use untrimmed assemblies, the partial static registrar, portable symbols and ReadyToRun disabled. They use `obj/meteor-coreclr-hotreload/` and `bin/meteor-coreclr-hotreload/`, preserving normal Mono/CoreCLR outputs. These overrides apply only to the opted-in Run Without Debugging lane, including its prelaunch build; they do not change project files or production publishing. Select a configuration that already targets the appropriate framework; Meteor does not retarget project references automatically.

Custom task `args` and non-empty `launch.json` app `args` are rejected in this initial lane so the watcher cannot silently rebuild or launch with different options. Put shared build settings in the project or `Directory.Build.props`.

This first lane supports local iOS simulators only, not physical devices, Pair to Mac, Android or Mac Catalyst. NativeAOT and profiling are excluded. SDK-based Hot Reload cannot apply updates while a managed CoreCLR debugger is attached, and the pinned `clrdbg` has no Edit and Continue integration; the optional Microsoft backend provides the qualified debugger-attached route described above. Keep normal F5 for debugging sessions.

CoreCLR packages include the self-contained [clrdbg 18.0.0 adapter](https://github.com/JaneySprings/clrdbg/releases/tag/18.0.0) and matching remote libraries, with release checksums pinned in `scripts/coreclr-assets.json`. Their MIT license and provenance accompany the binaries. No DotRush extension or source dependency is required. Our protocol wrapper supplies a missing optional exception-filter array required by that adapter release. CI exercises the actual adapter's breakpoints, stack inspection, evaluation and disconnect, plus native-agent MSBuild packaging, on macOS, Linux and Windows. These checks do not replace an iOS simulator run.

To run the backend checks locally, stage the native package with `dotnet cake --target=coreclr`, then run `python scripts/test-coreclr-adapter.py`. The smoke fixture uses .NET 9 and Node; the self-contained adapter carries its own runtime.

The original documentation follows; its profiling, Pair to Mac and Hot Reload instructions apply to the Mono backend.

<img src="https://github.com/JaneySprings/DotNet.Meteor/raw/main/assets/header.jpg" width="1180px" alt=".NET Meteor" align="center" />

## Overview

&emsp;The .NET Meteor extension allows you to build, debug and deploy **.NET apps** to devices or emulators.

- **Cross-Platform** </br>
You can use this extension in the `Windows`, `MacOS`, and `Linux` operation systems.

- **No additional dependencies** </br>
The extension doesn't require any additional extensions to work. You can use it out of the box.

- **Performance and Memory Profiling** </br>
You can profile your application to find performance bottlenecks and undisposed objects that persist in the memory. See the instruction below to enable profiling in your project.

- **Debug iOS Devices on Windows with Pair to Mac** </br>
Build your project on a remote Mac and deploy it to an iOS device connected to your Windows machine using the Pair to Mac feature. Check these [instructions](https://github.com/JaneySprings/DotNet.Meteor/wiki/Build-and-debug-iOS-application-on-Windows-with-Pair-to-Mac) for more details. Please note that only physical devices (not simulators) are currently supported.

- **Enhanced MAUI support** </br>
The extension provides you with a `XAML intellisense` and `XAML Hot Reload` for any platform. See the instruction below to enable Hot Reload in your project.

- **Multi-root Workspaces support** </br>
You can use muliple folders in your workspace and change the current running project.

- **F# support** </br>
Your can build and debug projects, written in the `F#` language.


## Run the Application

1. Open the project folder.
2. Open the `Run and Debug` VSCode tab and click the `create a launch.json file`.
3. In the opened panel, select the `.NET Meteor Debugger`.
4. In the status bar, select a project (if your opened folder contains several projects) and a configuration (the debug is the default).
5. In the status bar, click the device name and select a target device/emulator from the opened panel.
6. Press `F5` to debug the application or `ctrl + F5` to launch the application without debugging.
7. Enjoy!

![image](https://github.com/JaneySprings/DotNet.Meteor/raw/main/assets/demo_dbg.gif)


## Enable XAML Hot Reload

1. Open the `.csproj` file of your project and add the following package reference:

```xml
<ItemGroup>
	<PackageReference Include="DotNetMeteor.HotReload.Plugin" Version="3.*"/>
</ItemGroup>
```

2. Enable Hot Reload Server in your `MauiProgram.cs`:
```cs
using DotNet.Meteor.HotReload.Plugin;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
#if DEBUG
            .EnableHotReload()
#endif
        ...
        return builder.Build();
    }
}
```
3. Now you can run your project, update XAML and see updates in real-time!

![image](https://github.com/JaneySprings/DotNet.Meteor/raw/main/assets/demo_hr.gif)


## Profile the Application

1. Open the project folder.
2. Open the `Run and Debug` VSCode tab and click the `create a launch.json file`.
3. In the opened panel, select the `.NET Meteor Debugger`.
4. Specify a profiler mode option (`trace` or `gcdump`) in the generated configuration. For example:
```json
{
	"name": ".NET Meteor Profiler",
	"type": "dotnet-meteor.debugger",
	"request": "launch",
	"profilerMode": "trace",
	"preLaunchTask": "dotnet-meteor: Build"
}
```
5. In the status bar, select a project (if your opened folder contains several projects) and a configuration (the debug is the default). Click the device name and select a target device/emulator from the opened panel.
6. Press `ctrl + F5` to launch the application without debugging.
* If you use the `gcdump` mode, type a `/dump` command in the `Debug Console` to capture the report. You will see the message:
```
Writing gcdump to '/Users/You/.../Project/MauiProf.gcdump'...
command handled by DotNet.Meteor.Debugger.GCDumpLaunchAgent
Finished writing 2759872 bytes.
```

* If you use the `trace` mode, click `Stop Debugging` in the VSCode to stop the profiling. **Don't close the application manually, because this may damage the report.** After completion, you will see the message:
```
Trace completed.
Writing:	/Users/You/.../Project/MauiProf.speedscope.json
Conversion complete
```
7. You can see the `speedscope.json` report in the root folder of your project. You can use the [Speedscope in VSCode](https://marketplace.visualstudio.com/items?itemName=sransara.speedscope-in-vscode) extension to view it. Alternatively, you can upload it directly to the [speedscope](https://www.speedscope.app) site. For the `gcdump` report, you can use the [dotnet-heapview](https://github.com/1hub/dotnet-heapview) or _Visual Studio for Windows_.

![image](https://github.com/JaneySprings/DotNet.Meteor/raw/main/assets/demo_trace.gif)

&emsp;*The profiler can capture and analyze functions executed within the Mono runtime. To profile native code, you can leverage platform-specific tools, such as Android Studio and Xcode.*


## Troubleshooting

Meteor's workspace, debugger and Hot Reload logs are under the installed extension's `extension/bin/<component>/logs/<UTC timestamp>-<process id>/` directory. Each process writes `Debug.log` and `Error.log`, preserving earlier runs. Older inactive directories are pruned after seven days or when more than thirty are retained; runs from the last 24 hours and live processes are kept. XAML server logs remain under `extension/bin/Xaml/Logs`.

Debugger logs record the selected dotnet executable and SDK version, target framework, working directory, Xcode developer directory, mlaunch path, and device identifier. Include the relevant process directory when reporting a launch failure.

### Apple SDK and simulator selection

Build tasks and MSBuild property queries use the dotnet executable found on VS Code's `PATH`, with the project directory as their working directory so `global.json` applies. Set `dotnetMeteor.dotnetPath` to an absolute executable path to select another installation. The debugger inherits that installation's `DOTNET_ROOT` for Apple tool resolution.

Meteor evaluates the selected project's `MlaunchPath` / `_MlaunchPath` and `XcodeLocation` using its active configuration, target framework and runtime identifier. A `MLAUNCH_PATH` environment override takes precedence; an invalid override produces an error. If the project provides no launcher path, Meteor searches matching framework packs by numeric SDK and workload version, skipping incomplete installations and retaining support for legacy packs. For example, `net10.0-ios` selects a .NET 10 launcher rather than a lexically higher `net9.0` pack.

Xcode selection uses the project's `XcodeLocation`, then `DEVELOPER_DIR` / `MD_APPLE_SDK_ROOT`, then `xcode-select -p`. Launch tools receive the same developer directory used by the build. Use the iOS workload compatible with the selected Xcode; Xcode 27 requires a launcher that understands DeviceHub.

Simulator discovery uses `simctl` JSON and preserves device UDIDs, excluding unavailable runtimes. Device queries are scoped to the selected platform, share concurrent requests and cache successful results for 30 seconds. Reopen the device picker after that interval to see newly connected devices. Android, Apple physical and Apple simulator queries have independent failure handling and bounded subprocesses.

A simulator debug launch fails immediately if mlaunch exits unsuccessfully before attachment, or after 120 seconds without Mono `TargetReady`. Stopping or disconnecting cancels the deadline and cleans up Meteor's listener, launcher and tunnels.

If checking the logs didn’t solve the issue, please open an issue in this fork with a description and the relevant logs.

&emsp;**.NET Meteor** uses the `.NET Diagnostics` tools to profile applications. If you encounter any issues, please check the following:

- VSCode **Debug Console** tab should display a message about the successful connection. If you see the `Router stopped` message or something similar, the connection is not established. You can try to change the **profiler port** in the **.NET Meteor** settings.

- When profiling is started, the **Debug Console** tab should display the `Output File:` message. If you don't see this message after running the app and displaying the first view (after the splash screen), try deleting the `bin` and `obj` folders and rerunning the project. *Sometimes the issue occurs when you frequently switch between the profiling and debugging modes.*
