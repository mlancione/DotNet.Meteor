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
        archive.getinfo("extension/extension/extension.js")
        print(f"Verified {path}: {manifest['publisher']}.{manifest['name']} {args.version} ({target})")
if args.all_targets:
    expected = {f"{platform}-{arch}" for platform in ("linux", "darwin", "win32") for arch in ("x64", "arm64")}
    assert targets == expected, f"Expected {expected}; found {targets}"
