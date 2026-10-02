import * as fs from 'fs';
import * as path from 'path';
import { Device } from '../models/device';

export function getCoreClrPaths(extensionPath: string, device: Device) {
    if (!device.platform || !device.runtime_id) {
        throw new Error('Select a device with a platform and runtime identifier before using CoreCLR.');
    }
    const adapter = path.join(extensionPath, 'extension', 'bin', 'CoreClr', process.platform === 'win32' ? 'clrdbg.exe' : 'clrdbg');
    const remote = path.join(extensionPath, 'extension', 'bin', 'Remote');
    const host = path.join(remote, 'remote-host');
    const target = path.join(remote, 'remote-target');
    const hostOS = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'win' : process.platform;
    const hostLibrary = process.platform === 'win32' ? 'remotecoreclrhost.dll'
        : process.platform === 'darwin' ? 'libremotecoreclrhost.dylib' : 'libremotecoreclrhost.so';
    let targetLibrary: string;
    if (device.platform === 'android') {
        const abi = device.runtime_id === 'android-arm64' ? 'arm64-v8a'
            : device.runtime_id === 'android-x64' ? 'x86_64' : undefined;
        if (!abi) {
            throw new Error(`The experimental CoreCLR debugger does not include an agent for ${device.runtime_id}. Select an arm64 or x64 device.`);
        }
        targetLibrary = path.join(target, 'android', abi, 'libremotecoreclrtarget.so');
    } else {
        targetLibrary = path.join(target, device.platform, device.runtime_id, 'libremotecoreclrtarget.dylib');
    }
    const hostPath = path.join(host, `${hostOS}-${process.arch}`, hostLibrary);
    for (const file of [adapter, hostPath, targetLibrary]) {
        if (!fs.existsSync(file)) {
            throw new Error(`CoreCLR debugger component is missing: ${file}. Install a complete Meteor package for this host architecture.`);
        }
    }
    return { adapter, host, target, hostPath, targetLibrary };
}
