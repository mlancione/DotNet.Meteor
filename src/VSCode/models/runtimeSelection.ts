import * as path from 'path';

export type RuntimePreference = 'auto' | 'mono' | 'coreclr';
export type MobileRuntime = 'mono' | 'coreclr';
export type CoreClrDebugger = 'meteor' | 'microsoft';
export type CoreClrReadyToRunPreference = 'default' | 'disabled' | 'enabled';

export const runtimeChoices = [
    { label: 'Project Default', preference: 'auto' as RuntimePreference,
        description: 'Follow the runtime selected by the project and SDK' },
    { label: 'Mono', preference: 'mono' as RuntimePreference,
        description: 'Use the existing Meteor Mono debugger' },
    { label: 'CoreCLR (Experimental)', preference: 'coreclr' as RuntimePreference,
        description: 'Use the CoreCLR runtime and debugger; iOS requires .NET 11+' }
];

export function getRuntimePreference(value: unknown): RuntimePreference {
    if (value === undefined || value === 'auto' || value === 'mono' || value === 'coreclr') {
        return value ?? 'auto';
    }
    throw new Error('dotnetMeteor.runtime must be auto, mono or coreclr.');
}

export function getCoreClrDebugger(value: unknown): CoreClrDebugger {
    if (value === undefined || value === 'meteor' || value === 'microsoft') {
        return value ?? 'meteor';
    }
    throw new Error('dotnetMeteor.coreClrDebugger must be meteor or microsoft.');
}

export function getCoreClrReadyToRunPreference(value: unknown): CoreClrReadyToRunPreference {
    if (value === undefined || value === 'default' || value === 'disabled' || value === 'enabled') {
        return value ?? 'disabled';
    }
    throw new Error('dotnetMeteor.coreClrReadyToRun must be default, disabled or enabled.');
}

export function selectMobileRuntime(preference: RuntimePreference, framework: string,
    properties: Record<string, string>): MobileRuntime {
    const match = /^net(\d+)\.\d+-(ios|maccatalyst|android)(?:[\d.]+)?$/i.exec(framework);
    if (!match) {
        throw new Error(`Runtime selection is not supported for ${framework}.`);
    }
    const major = Number(match[1]);
    const platform = match[2].toLowerCase();
    if (properties.PublishAot?.toLowerCase() === 'true') {
        throw new Error('NativeAOT apps cannot use the Mono or CoreCLR debugger. Select a non-NativeAOT configuration to debug.');
    }
    const runtime = preference === 'auto'
        ? (properties.UseMonoRuntime?.toLowerCase() === 'false' || (!properties.UseMonoRuntime && major >= 11) ? 'coreclr' : 'mono')
        : preference;
    if (runtime === 'mono' && major >= 11) {
        throw new Error(`${framework} does not support Mono. Select Project Default or CoreCLR, or choose a .NET 10 target to use Mono.`);
    }
    if (runtime === 'coreclr' && (major < 10 || (platform !== 'android' && major < 11))) {
        const required = platform === 'android' ? '.NET 10+' : '.NET 11+';
        throw new Error(`CoreCLR on ${platform} requires ${required}. The selected target is ${framework}. Install a compatible SDK/workload and select a compatible target in the configuration picker. Meteor does not retarget your project automatically.`);
    }
    return runtime;
}

export function getRuntimeBuildProperties(runtime: MobileRuntime, preference: RuntimePreference,
    targetsPath: string, remoteTargetPath: string, originalAfterTargets?: string, originalBeforeProps?: string,
    readyToRun: CoreClrReadyToRunPreference = 'disabled', csharpHotReload = false, debuggerBackend: CoreClrDebugger = 'meteor'): string[] {
    if (runtime === 'mono') {
        return preference === 'mono' ? ['-p:UseMonoRuntime=true'] : [];
    }
    const microsoft = debuggerBackend === 'microsoft' && !csharpHotReload;
    const output = csharpHotReload ? 'meteor-coreclr-hotreload' : microsoft ? 'meteor-coreclr-microsoft' : 'meteor-coreclr';
    const properties = [
        '-p:UseMonoRuntime=false',
        '-p:EnableDiagnostics=true',
        `-p:BaseIntermediateOutputPath=obj/${output}/`,
        `-p:BaseOutputPath=bin/${output}/`,
        `-p:CustomBeforeMicrosoftCommonProps=${path.join(path.dirname(targetsPath), 'CoreClr.props')}`,
        `-p:CustomAfterMicrosoftCommonTargets=${targetsPath}`,
        // The SDK watcher launches directly; no debugger agent is needed.
        `-p:RemoteCoreclrTargetDir=${csharpHotReload ? '' : remoteTargetPath}`
    ];
    if (microsoft) {
        properties.push('-p:MeteorCoreClrAgentName=libvsdbgremotecoreclrtarget.dylib');
    }
    if (csharpHotReload || readyToRun !== 'default') {
        properties.push(`-p:PublishReadyToRun=${!csharpHotReload && readyToRun === 'enabled'}`);
    }
    if (csharpHotReload || microsoft) {
        properties.push('-p:TrimMode=copy', '-p:MtouchLink=None', '-p:Registrar=partial-static',
            '-p:HotReloadCompatibleBuild=true', '-p:MtouchDebug=true', '-p:DebuggerSupport=true',
            '-p:Optimize=false', '-p:DebugSymbols=true', '-p:DebugType=portable');
    }
    if (originalAfterTargets) {
        properties.push(`-p:MeteorOriginalAfterTargets=${originalAfterTargets}`);
    }
    if (originalBeforeProps) {
        properties.push(`-p:MeteorOriginalBeforeProps=${originalBeforeProps}`);
    }
    return properties;
}
