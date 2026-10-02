using System.Runtime.InteropServices;
using _Path = System.IO.Path;

public string RootDirectory => MakeAbsolute(Directory("./")).ToString();
public string ArtifactsDirectory => _Path.Combine(RootDirectory, "artifacts");
public string ExtensionStagingDirectory => _Path.Combine(RootDirectory, "extension");

var target = Argument("target", "vsix");
var version = Argument("release-version", "6.3.0");
var configuration = Argument("configuration", "debug");
var runtime = Argument("arch", RuntimeInformation.RuntimeIdentifier);


Task("clean").Does(() => {
	EnsureDirectoryExists(ArtifactsDirectory);
	CleanDirectory(ExtensionStagingDirectory);
	CleanDirectories(_Path.Combine(RootDirectory, "src", "**", "bin"));
	CleanDirectories(_Path.Combine(RootDirectory, "src", "**", "obj"));
});


Task("workspace").Does(() => DotNetPublish(_Path.Combine(RootDirectory, "src", "DotNet.Meteor.Workspace", "DotNet.Meteor.Workspace.csproj"), new DotNetPublishSettings {
	MSBuildSettings = new DotNetMSBuildSettings { AssemblyVersion = version },
	OutputDirectory = _Path.Combine(ExtensionStagingDirectory, "bin", "Workspace"),
	Configuration = configuration,
	Runtime = runtime,
}));
Task("xaml").Does(() => DotNetPublish(_Path.Combine(RootDirectory, "src", "DotNet.Meteor.Xaml", "DotNet.Meteor.Xaml.LanguageServer", "DotNet.Meteor.Xaml.LanguageServer.csproj"), new DotNetPublishSettings {
	MSBuildSettings = new DotNetMSBuildSettings { AssemblyVersion = version },
	OutputDirectory = _Path.Combine(ExtensionStagingDirectory, "bin", "Xaml"),
	Configuration = configuration,
	Runtime = runtime,
}));
Task("hotreload").Does(() => DotNetPublish(_Path.Combine(RootDirectory, "src", "DotNet.Meteor.HotReload", "DotNet.Meteor.HotReload.csproj"), new DotNetPublishSettings {
	MSBuildSettings = new DotNetMSBuildSettings { AssemblyVersion = version },
	OutputDirectory = _Path.Combine(ExtensionStagingDirectory, "bin", "HotReload"),
	Configuration = configuration,
	Runtime = runtime,
}));
Task("plugin").Does(() => DotNetPack(_Path.Combine(RootDirectory, "src", "DotNet.Meteor.HotReload.Plugin", "DotNet.Meteor.HotReload.Plugin.csproj"), new DotNetPackSettings {
	Configuration = configuration,
	MSBuildSettings = new DotNetMSBuildSettings { 
		AssemblyVersion = version, 
		Version = version
	},
}));


Task("debugger")
	.Does(() => DotNetPublish(_Path.Combine(RootDirectory, "src", "DotNet.Diagnostics", "src", "Tools", "dotnet-dsrouter", "dotnet-dsrouter.csproj"), new DotNetPublishSettings {
		OutputDirectory = _Path.Combine(ExtensionStagingDirectory, "bin", "Debugger"),
		Configuration = configuration,
		Runtime = runtime,
	})).Does(() => DotNetPublish(_Path.Combine(RootDirectory, "src", "DotNet.Diagnostics", "src", "Tools", "dotnet-gcdump", "dotnet-gcdump.csproj"), new DotNetPublishSettings {
		OutputDirectory = _Path.Combine(ExtensionStagingDirectory, "bin", "Debugger"),
		Configuration = configuration,
		Runtime = runtime,
	}))
	.Does(() => DotNetPublish(_Path.Combine(RootDirectory, "src", "DotNet.Meteor.Debugger", "DotNet.Meteor.Debugger.csproj"), new DotNetPublishSettings {
		MSBuildSettings = new DotNetMSBuildSettings { 
			ArgumentCustomization = args => args.Append("/p:NuGetVersionRoslyn=4.5.0"),
			AssemblyVersion = version
		},
		OutputDirectory = _Path.Combine(ExtensionStagingDirectory, "bin", "Debugger"),
		Configuration = configuration,
		Runtime = runtime,
	}));

// Keep the experimental backend beside the hardened Mono adapter. Pin both
// host binaries and mobile agents to one upstream release and verify every download.
Task("coreclr").Does(() => {
	var manifestPath = _Path.Combine(RootDirectory, "scripts", "coreclr-assets.json");
	using var manifest = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(manifestPath));
	var backendVersion = manifest.RootElement.GetProperty("version").GetString();
	var downloadDirectory = _Path.Combine(ArtifactsDirectory, "coreclr-downloads");
	EnsureDirectoryExists(downloadDirectory);
	var adapterDirectory = _Path.Combine(ExtensionStagingDirectory, "bin", "CoreClr");
	var remoteDirectory = _Path.Combine(ExtensionStagingDirectory, "bin", "Remote");
	CleanDirectory(adapterDirectory);
	CleanDirectory(remoteDirectory);
	foreach (var asset in new[] { $"clrdbg_{runtime}.zip", "RemoteCoreClrLibraries.zip" }) {
		var expectedHash = manifest.RootElement.GetProperty("sha256").GetProperty(asset).GetString();
		var archive = _Path.Combine(downloadDirectory, asset);
		if (!System.IO.File.Exists(archive)) {
			DownloadFile($"https://github.com/JaneySprings/clrdbg/releases/download/{backendVersion}/{asset}", archive);
		}
		using (var hash = System.Security.Cryptography.SHA256.Create()) {
			using var input = System.IO.File.OpenRead(archive);
			var actualHash = Convert.ToHexString(hash.ComputeHash(input)).ToLowerInvariant();
			if (actualHash != expectedHash) {
				throw new Exception($"CoreCLR asset checksum mismatch: {asset}. Delete {archive} and retry.");
			}
		}
		Unzip(archive, asset == "RemoteCoreClrLibraries.zip" ? remoteDirectory : adapterDirectory);
	}
	if (!runtime.StartsWith("win-")) {
		ExecuteCommand("chmod", $"+x \"{_Path.Combine(adapterDirectory, "clrdbg")}\"");
	}
	CopyFile(_Path.Combine(RootDirectory, "src", "VSCode", "resources", "CoreClr.targets"), _Path.Combine(ExtensionStagingDirectory, "CoreClr.targets"));
	CopyFile(_Path.Combine(RootDirectory, "src", "VSCode", "resources", "CoreClr.props"), _Path.Combine(ExtensionStagingDirectory, "CoreClr.props"));
	CopyFile(_Path.Combine(RootDirectory, "third-party", "clrdbg-LICENSE.txt"), _Path.Combine(adapterDirectory, "LICENSE.txt"));
	CopyFile(manifestPath, _Path.Combine(adapterDirectory, "upstream.json"));
	CopyFile(_Path.Combine(RootDirectory, "src", "VSCode", "resources", "coreclr-adapter.cjs"), _Path.Combine(ExtensionStagingDirectory, "coreclr-adapter.cjs"));
});


Task("test")
	.Does(() => DotNetTest(_Path.Combine(RootDirectory, "src", "DotNet.Meteor.Common.Tests", "DotNet.Meteor.Common.Tests.csproj"),
		new DotNetTestSettings {  
			Configuration = configuration,
			Verbosity = DotNetVerbosity.Quiet,
			ResultsDirectory = ArtifactsDirectory,
			Loggers = new[] { "trx" }
		}
	)).Does(() => DotNetTest(_Path.Combine(RootDirectory, "src", "DotNet.Meteor.Debugger.Tests", "DotNet.Meteor.Debugger.Tests.csproj"),
		new DotNetTestSettings {  
			Configuration = configuration,
			Verbosity = DotNetVerbosity.Quiet,
			ResultsDirectory = ArtifactsDirectory,
			Loggers = new[] { "trx" }
		}
	));


Task("vsix")
	.IsDependentOn("clean")
	.IsDependentOn("workspace")
	.IsDependentOn("xaml")
	.IsDependentOn("hotreload")
	.IsDependentOn("debugger")
	.IsDependentOn("coreclr")
	.Does(() => {
		var vsruntime = runtime.Replace("win-", "win32-").Replace("osx-", "darwin-");
		var output = _Path.Combine(ArtifactsDirectory, $"DotNet.Meteor.Local.v{version}_{vsruntime}.vsix");
		ExecuteCommand("npm", "ci");
		ExecuteCommand("npm", $"run vsix -- --target {vsruntime} --out {output} --no-git-tag-version {version}");
	});


void ExecuteCommand(string command, string arguments) {
	if (Environment.OSVersion.Platform == PlatformID.Win32NT) {
		arguments = $"/c \"{command} {arguments}\"";
		command = "cmd";
	}
	if (StartProcess(command, arguments) != 0)
		throw new Exception($"{command} exited with non-zero exit code.");
}

RunTarget(target);
