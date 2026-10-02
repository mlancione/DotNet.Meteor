"""Verify release identity, version and architecture before uploading packages."""
import argparse
import json
import zipfile
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument("version")
parser.add_argument("--all-targets", action="store_true")
parser.add_argument("files", nargs="+")
args = parser.parse_args()
targets = set()
for path in args.files:
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("extension/package.json"))
        assert manifest["name"] == "dotnet-meteor-local", path
        assert manifest["publisher"] == "localdev", path
        assert manifest["version"] == args.version, path
        assert "nromanov.dotrush" not in manifest.get("extensionDependencies", []), path
        root = ET.fromstring(archive.read("extension.vsixmanifest"))
        identity = root.find(".//{*}Identity")
        assert identity is not None, path
        assert identity.attrib["Id"] == manifest["name"], path
        assert identity.attrib["Publisher"] == manifest["publisher"], path
        assert identity.attrib["Version"] == args.version, path
        target = identity.attrib["TargetPlatform"]
        assert target not in targets, f"Duplicate target: {target}"
        targets.add(target)
        debugger = manifest["contributes"]["debuggers"][0]
        program = debugger["windows"]["program"] if target.startswith("win32-") else debugger["program"]
        archive.getinfo("extension/" + program.removeprefix("./"))
        coreclr_dir = "extension/extension/bin/CoreClr/"
        archive.getinfo(coreclr_dir + ("clrdbg.exe" if target.startswith("win32-") else "clrdbg"))
        archive.getinfo(coreclr_dir + "clrdbg.dll")
        archive.getinfo(coreclr_dir + "LICENSE.txt")
        backend = json.loads(archive.read(coreclr_dir + "upstream.json"))
        assert backend["version"] == "18.0.0", path
        archive.getinfo("extension/extension/CoreClr.targets")
        archive.getinfo("extension/extension/CoreClr.props")
        archive.getinfo("extension/extension/coreclr-adapter.cjs")
        host_os, arch = target.split("-", 1)
        host_os = {"darwin": "osx", "win32": "win"}.get(host_os, host_os)
        host_lib = "remotecoreclrhost.dll" if host_os == "win" else "libremotecoreclrhost." + ("dylib" if host_os == "osx" else "so")
        archive.getinfo(f"extension/extension/bin/Remote/remote-host/{host_os}-{arch}/{host_lib}")
        for rid in ("ios-arm64", "iossimulator-arm64", "iossimulator-x64"):
            archive.getinfo(f"extension/extension/bin/Remote/remote-target/ios/{rid}/libremotecoreclrtarget.dylib")
        archive.getinfo("extension/extension/extension.js")
        print(f"Verified {path}: {manifest['publisher']}.{manifest['name']} {args.version} ({target})")
if args.all_targets:
    expected = {f"{platform}-{arch}" for platform in ("linux", "darwin", "win32") for arch in ("x64", "arm64")}
    assert targets == expected, f"Expected {expected}; found {targets}"
