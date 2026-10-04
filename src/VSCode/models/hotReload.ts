import { MobileRuntime } from './runtimeSelection';

export interface HotReloadDevice {
    serial: string | undefined;
    platform: string | undefined;
    runtime_id: string | undefined;
    is_emulator: boolean | undefined;
}

export interface HotReloadRequest {
    runtime: MobileRuntime | undefined;
    device: HotReloadDevice | undefined;
    configuration: string | undefined;
    sdkVersion: string | undefined;
    onMac: boolean;
}

export interface HotReloadArguments {
    projectPath: string;
    framework: string;
    configuration: string;
    device: HotReloadDevice;
    buildProperties: string[];
    partialStaticRegistrar: boolean;
}

// Hot Reload builds keep their own outputs so switching with F5 debugging stays incremental.
export const hotReloadIntermediateOutputPath = 'obj/meteor-coreclr-hotreload/';
export const hotReloadOutputPath = 'bin/meteor-coreclr-hotreload/';

// Properties that the Hot Reload build owns; values from the debugging build are replaced.
const ownedProperties = ['BaseIntermediateOutputPath', 'BaseOutputPath', 'PublishReadyToRun', 'RemoteCoreclrTargetDir',
    'MtouchLink', 'Registrar', 'RuntimeIdentifier'];

export function validateHotReload(request: HotReloadRequest): void {
    if (request.runtime !== 'coreclr') {
        throw new Error('CoreCLR Hot Reload requires the CoreCLR runtime. Select CoreCLR in the status bar runtime picker.');
    }
    if (!request.onMac) {
        throw new Error('CoreCLR Hot Reload requires a local Mac. Pair to Mac is not supported by dotnet watch.');
    }
    if (request.device?.platform !== 'ios') {
        throw new Error('CoreCLR Hot Reload currently supports iOS simulators and devices only.');
    }
    if (!request.device.serial) {
        throw new Error('CoreCLR Hot Reload needs the selected device identifier. Select the device again.');
    }
    if (!request.configuration || !/debug/i.test(request.configuration)) {
        throw new Error(`CoreCLR Hot Reload requires a Debug configuration. The selected configuration is ${request.configuration ?? 'not set'}.`);
    }
    const major = Number(/^(\d+)\./.exec(request.sdkVersion ?? '')?.[1]);
    if (!(major >= 11)) {
        throw new Error(`CoreCLR Hot Reload on iOS requires the .NET 11 SDK (RC2 or later). The selected SDK is ${request.sdkVersion ?? 'unknown'}.`);
    }
}

export function getHotReloadArguments(options: HotReloadArguments): string[] {
    const inherited = options.buildProperties.filter(property => !ownedProperties.some(name =>
        new RegExp(`^-p:${name}=`, 'i').test(property)));
    const properties = [
        ...inherited,
        `-p:BaseIntermediateOutputPath=${hotReloadIntermediateOutputPath}`,
        `-p:BaseOutputPath=${hotReloadOutputPath}`,
        // The SDK refuses Hot Reload for trimmed apps, and updates replace ReadyToRun code.
        '-p:MtouchLink=None',
        '-p:PublishReadyToRun=false'
    ];
    if (options.device.runtime_id) {
        properties.push(`-p:RuntimeIdentifier=${options.device.runtime_id}`);
    }
    if (options.partialStaticRegistrar && !options.device.is_emulator) {
        // Workaround for SDKs whose default device registrar still modifies user assemblies (dotnet/macios#26069).
        properties.push('-p:Registrar=partial-static');
    }
    return [
        'watch',
        '--project', options.projectPath,
        '--device', options.device.serial!,
        '-f', options.framework,
        '-c', options.configuration,
        ...properties
    ];
}
