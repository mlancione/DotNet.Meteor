import * as fs from 'fs';
import * as path from 'path';
import { ProcessArgumentBuilder } from './processArgumentBuilder';
import { ProcessRunner } from './processRunner';

export interface ToolContext {
    executable: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
}

export function resolveToolContext(projectPath: string, configuredDotnet?: string): ToolContext {
    const executableName = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
    const candidates = configuredDotnet ? [configuredDotnet] : (process.env.PATH ?? process.env.Path ?? '')
        .split(path.delimiter).map(directory => path.join(directory, executableName));
    const executable = candidates.find(candidate => {
        try {
            fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
            return fs.statSync(candidate).isFile();
        } catch {
            return false;
        }
    });
    if (!executable) {
        throw new Error(`Cannot find dotnet. Check dotnetMeteor.dotnetPath or VS Code's PATH.`);
    }
    const realExecutable = fs.realpathSync(executable);
    const context: ToolContext = {
        executable: realExecutable, cwd: path.dirname(projectPath),
        env: { ...process.env, DOTNET_ROOT: path.dirname(realExecutable), DOTNET_MULTILEVEL_LOOKUP: '0' }
    };
    if (process.platform === 'darwin') {
        const developer = process.env.DEVELOPER_DIR ?? process.env.MD_APPLE_SDK_ROOT
            ?? ProcessRunner.runSync(new ProcessArgumentBuilder('/usr/bin/xcode-select').append('-p'), { timeout: 10000 });
        if (developer) {
            context.env.DEVELOPER_DIR = normalizeXcodePath(developer);
        }
    }
    return context;
}

export function normalizeXcodePath(value: string): string {
    const developer = value.endsWith('.app') ? path.join(value, 'Contents', 'Developer') : value;
    if (!fs.existsSync(developer) || !fs.statSync(developer).isDirectory()) {
        throw new Error(`Xcode developer directory does not exist: ${developer}`);
    }
    return developer;
}
