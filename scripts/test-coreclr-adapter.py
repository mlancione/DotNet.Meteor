"""Exercise the packaged CoreCLR adapter and agent build targets without mobile workloads."""
import argparse
import json
import shutil
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
import xml.etree.ElementTree as ET


class Protocol:
    def __init__(self, process):
        self.process = process
        self.messages = queue.Queue()
        self.pending = []
        self.sequence = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        try:
            while True:
                length = None
                while True:
                    line = self.process.stdout.readline()
                    if not line:
                        raise EOFError("CoreCLR adapter closed its output")
                    if line in (b"\r\n", b"\n"):
                        break
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":", 1)[1])
                if length is None:
                    raise ValueError("Missing DAP Content-Length")
                payload = bytearray()
                while len(payload) < length:
                    chunk = self.process.stdout.read(length - len(payload))
                    if not chunk:
                        raise EOFError("Incomplete DAP message")
                    payload.extend(chunk)
                self.messages.put(json.loads(payload))
        except Exception as error:
            self.messages.put(error)

    def send(self, command, arguments=None):
        self.sequence += 1
        payload = json.dumps({"seq": self.sequence, "type": "request", "command": command,
                              "arguments": arguments or {}}).encode()
        self.process.stdin.write(f"Content-Length: {len(payload)}\r\n\r\n".encode() + payload)
        self.process.stdin.flush()
        return self.sequence

    def wait(self, predicate, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            for index, message in enumerate(self.pending):
                if predicate(message):
                    return self.pending.pop(index)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"Timed out waiting for DAP response/event. Pending: {self.pending}")
            message = self.messages.get(timeout=remaining)
            if isinstance(message, Exception):
                raise message
            self.pending.append(message)

    def request(self, command, arguments=None):
        sequence = self.send(command, arguments)
        result = self.wait(lambda message: message.get("type") == "response" and message.get("request_seq") == sequence)
        assert result.get("success"), result
        return result.get("body", {})

    def event(self, name):
        return self.wait(lambda message: message.get("type") == "event" and message.get("event") == name).get("body", {})


def check_agent_targets(root, temporary, dotnet):
    targets = root / "src/VSCode/resources/CoreClr.targets"
    remote = root / "extension/bin/Remote/remote-target"
    for family, rid in [("ios", "iossimulator-arm64"), ("ios", "iossimulator-x64"), ("ios", "ios-arm64"),
                        ("maccatalyst", "maccatalyst-arm64"), ("maccatalyst", "maccatalyst-x64"), ("android", "android-arm64"), ("android", "android-x64")]:
        project = ET.Element("Project")
        properties = ET.SubElement(project, "PropertyGroup")
        for key, value in {"TargetPlatformIdentifier": family, "RuntimeIdentifier": rid,
                           "RemoteCoreclrTargetDir": str(remote), "AndroidAttachDebugger": "true"}.items():
            ET.SubElement(properties, key).text = value
        ET.SubElement(project, "Import", Project=str(targets))
        ET.SubElement(project, "Target", Name="PrepareForBuild")
        target = ET.SubElement(project, "Target", Name="_ComputePublishLocation")
        items = "AndroidNativeLibrary" if family == "android" else "ResolvedFileToPublish"
        ET.SubElement(target, "Error", Condition=f"'@({items}->Count())' != '1'", Text="Expected exactly one CoreCLR agent")
        ET.SubElement(target, "Error", Condition=f"!Exists('%({items}.Identity)')", Text="Agent must exist")
        if family != "android":
            ET.SubElement(target, "Error", Condition="'%(ResolvedFileToPublish.PublishFolderType)' != 'DynamicLibrary'",
                          Text="Apple agent must be packaged as a dynamic library")
        filename = temporary / f"{rid}.proj"
        ET.ElementTree(project).write(filename, encoding="unicode")
        subprocess.run([dotnet, "msbuild", str(filename), "-t:PrepareForBuild;_ComputePublishLocation", "-nologo", "-verbosity:quiet"], check=True, timeout=30)
    print("Passed seven mobile agent packaging checks (MSBuild only).", flush=True)


def smoke(root, temporary, dotnet):
    (temporary / "global.json").write_text(json.dumps({"sdk": {"version": "9.0.100", "rollForward": "latestFeature"}}))
    project = temporary / "Smoke.csproj"
    project.write_text('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>'
                       '<TargetFramework>net9.0</TargetFramework><DebugType>portable</DebugType>'
                       '<UseAppHost>false</UseAppHost><NuGetAudit>false</NuGetAudit><RestoreIgnoreFailedSources>true</RestoreIgnoreFailedSources>'
                       '</PropertyGroup></Project>')
    source = temporary / "Program.cs"
    source.write_text('class Program\n{\n    static void Main()\n    {\n        int value = 7;\n'
                      '        System.Console.WriteLine(value);\n    }\n}\n')
    subprocess.run([dotnet, "build", str(project), "-nologo", "-verbosity:quiet"], cwd=temporary, check=True, timeout=90)
    # A previous Mono-style build must not contaminate the isolated outputs.
    subprocess.run([dotnet, "build", str(project), "-nologo", "-verbosity:quiet",
                    "-p:BaseIntermediateOutputPath=obj/meteor-coreclr/", "-p:BaseOutputPath=bin/meteor-coreclr/",
                    "-p:PublishReadyToRun=false",
                    f"-p:CustomBeforeMicrosoftCommonProps={root / 'extension/CoreClr.props'}",
                    f"-p:CustomAfterMicrosoftCommonTargets={root / 'extension/CoreClr.targets'}"],
                   cwd=temporary, check=True, timeout=90)
    assert (temporary / "bin/Debug/net9.0/Smoke.dll").is_file()
    assert (temporary / "bin/meteor-coreclr/Debug/net9.0/Smoke.dll").is_file()
    print("Passed build-output isolation check after a normal build.", flush=True)
    adapter = root / "extension/bin/CoreClr" / ("clrdbg.exe" if os.name == "nt" else "clrdbg")
    with tempfile.TemporaryFile() as diagnostics:
        process = subprocess.Popen([shutil.which("node"), str(root / "extension/coreclr-adapter.cjs"), str(adapter)], cwd=temporary, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=diagnostics)
        try:
            protocol = Protocol(process)
            protocol.request("initialize", {"adapterID": "dotnet-meteor.debugger", "clientID": "meteor-smoke",
                                           "linesStartAt1": True, "columnsStartAt1": True, "pathFormat": "path"})
            protocol.request("launch", {"program": str(temporary / "bin/meteor-coreclr/Debug/net9.0/Smoke.dll"),
                                        "cwd": str(temporary), "justMyCode": False, "console": "internalConsole"})
            protocol.event("initialized")
            protocol.request("setBreakpoints", {"source": {"path": str(source)}, "breakpoints": [{"line": 6}]})
            protocol.request("setExceptionBreakpoints", {"filters": []})
            protocol.request("configurationDone")
            stopped = protocol.event("stopped")
            assert stopped["reason"] == "breakpoint", stopped
            frames = protocol.request("stackTrace", {"threadId": stopped["threadId"]})["stackFrames"]
            assert frames and frames[0]["line"] == 6, frames
            result = protocol.request("evaluate", {"expression": "value", "frameId": frames[0]["id"], "context": "watch"})
            assert result["result"] == "7", result
            protocol.request("continue", {"threadId": stopped["threadId"]})
            protocol.event("terminated")
            protocol.request("disconnect", {"terminateDebuggee": True})
            print("Passed actual CoreCLR adapter breakpoint, stack, evaluation, continue and disconnect checks.", flush=True)
        except Exception:
            diagnostics.seek(0)
            print(diagnostics.read().decode(errors="replace"), flush=True)
            raise
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dotnet", default="dotnet")
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="meteor-coreclr-smoke-") as directory:
        scratch = Path(directory).resolve()
        check_agent_targets(repository, scratch, args.dotnet)
        smoke(repository, scratch, args.dotnet)
