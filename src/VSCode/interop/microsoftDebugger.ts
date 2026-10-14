import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Device } from '../models/device';

export function getMicrosoftDebuggerPaths(device: Device | undefined) {
    if (process.platform !== 'darwin' || device?.platform !== 'ios' || !device.is_emulator
        || !['iossimulator-arm64', 'iossimulator-x64'].includes(device.runtime_id ?? '')) {
        throw new Error('The Microsoft CoreCLR backend currently supports local iOS arm64/x64 simulators only. Select a supported simulator or use the Meteor backend.');
    }
    const csharp = vscode.extensions.getExtension('ms-dotnettools.csharp');
    const devkit = vscode.extensions.getExtension('ms-dotnettools.csdevkit');
    const maui = vscode.extensions.getExtension('ms-dotnettools.dotnet-maui');
    if (!csharp || !devkit || !maui) {
        throw new Error('Microsoft CoreCLR debugging requires the installed Microsoft C#, C# Dev Kit and .NET MAUI extensions in Microsoft VS Code. Install/enable them or select dotnetMeteor.coreClrDebugger=meteor.');
    }
    if (!csharp.packageJSON.contributes?.debuggers?.some((entry: any) => entry.type === 'coreclr_mobile')) {
        throw new Error('The installed Microsoft C# extension does not provide coreclr_mobile. Update the Microsoft extensions or select the Meteor backend.');
    }
    const resources = path.join(maui.extensionPath, 'dist', 'resources');
    const host = path.join(resources, 'VsdbgRemoteCoreclrHost', `osx-${process.arch}`);
    const target = path.join(resources, 'VsdbgRemoteCoreclrTarget');
    const targetLibrary = path.join(target, 'ios', device.runtime_id!, 'libvsdbgremotecoreclrtarget.dylib');
    for (const file of [path.join(host, 'libvsdbgremotecoreclrhost.dylib'), path.join(host, 'libremotemscordbihost.dylib'), targetLibrary]) {
        if (!fs.existsSync(file)) {
            throw new Error(`Microsoft mobile debugger component is missing: ${file}. Update/reinstall the Microsoft .NET MAUI extension; Meteor does not download these binaries.`);
        }
    }
    return { csharp, devkit, host, target, targetLibrary, architecture: device.runtime_id!.endsWith('-arm64') ? 'arm64' : 'x64' };
}

export function debuggerComponentHash(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
