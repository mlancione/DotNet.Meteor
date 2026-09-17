import { Device } from './device';

export function supportsFramework(device: Device | undefined, framework: string | undefined): boolean {
    if (!device?.platform || !framework)
        return false;
    const platform = framework.match(/-([a-z]+)/i)?.[1]?.toLowerCase();
    return platform ? platform === device.platform.toLowerCase()
        : device.platform === 'windows' || device.platform === 'maccatalyst';
}

export function deviceId(device: Device): string {
    // AVD adb serials change when emulators restart; their configured names do not.
    const identity = device.platform === 'android' && device.is_emulator
        ? device.name : device.serial || device.name;
    return JSON.stringify([device.platform, !!device.is_emulator, identity, device.runtime_id || '']);
}
