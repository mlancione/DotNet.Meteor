import { Interop } from '../interop/interop';
import { ProcessArgumentBuilder } from '../interop/processArgumentBuilder';
import { ConfigurationController } from '../controllers/configurationController';
import { RemoteHostProvider } from '../features/removeHostProvider';
import { getCoreClrPaths } from '../interop/coreClr';
import * as res from '../resources/constants';
import * as vscode from 'vscode';


export class DotNetTaskProvider implements vscode.TaskProvider {
    resolveTask(task: vscode.Task, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Task> { 
        return ConfigurationController.isActive() ? this.getTask(task.definition) : task;
    }
    provideTasks(token: vscode.CancellationToken): vscode.ProviderResult<vscode.Task[]> {
        return ConfigurationController.isActive() ? [this.getTask({ type: res.taskDefinitionId })] : undefined;
    }

    private getTask(definition: vscode.TaskDefinition): vscode.Task {
        try {
            return this.getBuildTask(definition);
        } catch (error) {
            // Keep the task registered even when its runtime/toolchain is not ready.
            // A failed terminal explains the prerequisite instead of VS Code reporting
            // that the task command/provider could not be found.
            return new vscode.Task(definition, vscode.TaskScope.Workspace,
                res.taskDefinitionDefaultTargetCapitalized, res.extensionId,
                new vscode.CustomExecution(async () => {
                    const output = new vscode.EventEmitter<string>();
                    const closed = new vscode.EventEmitter<number>();
                    return {
                        onDidWrite: output.event,
                        onDidClose: closed.event,
                        open() {
                            output.fire(`.NET Meteor: ${String(error)}\r\n`);
                            closed.fire(1);
                        },
                        close() {
                            output.dispose();
                            closed.dispose();
                        }
                    };
                }));
        }
    }

    private getBuildTask(definition: vscode.TaskDefinition): vscode.Task {
        const build = Interop.getBuildContext(ConfigurationController.project!, ConfigurationController.configuration!, ConfigurationController.device!);
        const context = Interop.getProjectToolContext(ConfigurationController.project!, ConfigurationController.configuration!, ConfigurationController.device!, build);
        if (build.runtime === 'coreclr') {
            getCoreClrPaths(Interop.extensionPath, ConfigurationController.device!);
        }
        const builder = new ProcessArgumentBuilder(context.executable)
            .append('build')
            .append(ConfigurationController.project!.path)
            .append(`-p:Configuration=${ConfigurationController.configuration}`)
            .append(`-p:TargetFramework=${ConfigurationController.getTargetFramework()}`)
            .conditional(`-p:RuntimeIdentifier=${ConfigurationController.device?.runtime_id}`, () => ConfigurationController.device?.runtime_id)

        if (ConfigurationController.isAndroid()) {
            builder.append(`-p:AndroidSdkDirectory=${ConfigurationController.androidSdkDirectory}`);
            builder.conditional('-p:EmbedAssembliesIntoApk=true', () => ConfigurationController.profiler);
            builder.conditional('-p:AndroidEnableProfiler=true', () => ConfigurationController.profiler);
            // TODO: https://github.com/dotnet/android/issues/9567
            builder.conditional(`-p:AdbTarget=-s%20${ConfigurationController.device?.serial}`, () => ConfigurationController.device?.serial);
            builder.conditional('-p:AndroidAttachDebugger=true', () => build.runtime === 'coreclr');
        }
        if (ConfigurationController.isAppleMobile()) {
            // TODO: https://github.com/xamarin/xamarin-macios/issues/21530
            builder.conditional('-p:MtouchDebug=true', () => build.runtime !== 'coreclr');
            builder.conditional('-p:BuildIpa=true', () => !ConfigurationController.onMac);
        }
        if (ConfigurationController.isMacCatalyst()) {
            builder.conditional('-p:_BundlerDebug=true', () => build.runtime !== 'coreclr' && !ConfigurationController.profiler);
            builder.conditional('-p:Profiling=true', () => ConfigurationController.profiler);
        }
        if (ConfigurationController.isWindows()) {
            builder.append('-p:WindowsPackageType=None');
            builder.append('-p:WinUISDKReferences=false');
        }

        if (ConfigurationController.isAppleMobile() && ConfigurationController.onWindows)
            RemoteHostProvider.feature.connect(builder);

        definition.args?.forEach((arg: string) => {
            if ((build.runtime === 'coreclr' && /^[-/](?:p|property):/i.test(arg) && /(?:^[-/](?:p|property):|[;,])(UseMonoRuntime|PublishReadyToRun|EnableDiagnostics|BaseIntermediateOutputPath|BaseOutputPath|CustomAfterMicrosoftCommonTargets|CustomBeforeMicrosoftCommonProps|RemoteCoreclrTargetDir|MeteorOriginalAfterTargets|MeteorOriginalBeforeProps|TargetFramework|TargetFrameworks|RuntimeIdentifier|Configuration|OutputPath|IntermediateOutputPath|MSBuildProjectExtensionsPath|MtouchDebug|_BundlerDebug)\s*=/i.test(arg))
                || (build.properties.includes('-p:UseMonoRuntime=true') && /^[-/](?:p|property):/i.test(arg) && /(?:^[-/](?:p|property):|[;,])UseMonoRuntime\s*=/i.test(arg))) {
                throw new Error(`The runtime selection controls ${arg}. Remove the conflicting task argument so builds and debugging use the same runtime and output paths.`);
            }
            if (build.runtime === 'coreclr' && /^(-f|--framework|-o|--output|-c|--configuration|-r|--runtime)(?:$|=|:)/i.test(arg)) {
                throw new Error(`CoreCLR builds use the framework, configuration, device and output paths selected by Meteor. Remove the conflicting task argument: ${arg}`);
            }
            builder.override(arg);
        });
        builder.append(...build.properties);
        
        const task = new vscode.Task(
            definition, vscode.TaskScope.Workspace,
            res.taskDefinitionDefaultTargetCapitalized, res.extensionId,
            new vscode.ShellExecution(builder.getCommand(), builder.getArguments(), { cwd: context.cwd, env: context.env as Record<string, string> }), `$${res.taskProblemMatcherId}`
        );
        
        if (ConfigurationController.isAppleMobile() && ConfigurationController.onWindows)
            task.presentationOptions = { echo: false } /* Hide pair to mac commandline arguments */;

        return task;
    }
}
