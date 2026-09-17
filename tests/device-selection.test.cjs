const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');

// Load the actual controllers, replacing only the VS Code host API.
require.extensions['.ts'] = (module, filename) => {
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
    module._compile(source, filename);
};
let selected;
const vscode = {
    ThemeIcon: class {}, QuickPickItemKind: { Separator: -1 },
    window: { showQuickPick: async items => items.find(item => item.label === selected) }
};
const load = Module._load;
Module._load = function(id, ...args) {
    return id === 'vscode' ? vscode : load.call(this, id, ...args);
};
const { ConfigurationController: config } = require('../src/VSCode/controllers/configurationController.ts');
const { StatusBarController: status } = require('../src/VSCode/controllers/statusbarController.ts');
const { StateController: state } = require('../src/VSCode/controllers/stateController.ts');
const { deviceId, supportsFramework } = require('../src/VSCode/models/deviceSelection.ts');
const android = { name: 'Pixel', platform: 'android', serial: 'phone-1', is_emulator: false };
const android2 = { ...android, serial: 'phone-2' };
const ios = { name: 'iPhone', platform: 'ios', serial: 'iphone-1', is_emulator: false };
const project = { name: 'App', path: '/app/App.csproj', frameworks: ['net9.0-android', 'net9.0-ios'], configurations: ['Debug', 'Release'] };
let storage;
let context;
beforeEach(() => {
    storage = new Map();
    context = { workspaceState: {
        get: key => storage.get(key),
        update: (key, value) => { storage.set(key, value); return Promise.resolve(); }
    }};
    state.activate(context);
    status.projects = [project];
    status.devices = [android, android2, ios];
    config.project = config.device = config.configuration = config.targetFramework = undefined;
    status.performSelectProject(project);
});

test('switching frameworks restores each explicitly selected device', () => {
    status.performSelectDevice(android2);
    status.performSelectFramework('net9.0-ios');
    status.performSelectDevice(ios);
    status.performSelectFramework('net9.0-android');
    assert.equal(config.device, android2);
    status.performSelectFramework('net9.0-ios');
    assert.equal(config.device, ios);
});
test('workspace reload restores the framework and device', () => {
    status.performSelectFramework('net9.0-ios');
    status.performSelectDevice(ios);
    state.deactivate();
    config.project = config.device = config.targetFramework = undefined;
    state.activate(context);
    status.performSelectProject(project);
    assert.equal(config.getTargetFramework(), 'net9.0-ios');
    assert.equal(config.device, ios);
});
test('disconnected preference survives fallback and returns on reconnect', () => {
    status.performSelectDevice(android2);
    status.devices = [android, ios];
    status.performSelectFramework('net9.0-ios');
    status.performSelectFramework('net9.0-android');
    assert.equal(config.device, android);
    status.devices = [android, android2, ios];
    status.performSelectFramework('net9.0-android');
    assert.equal(config.device, android2);
});
test('unavailable platform clears device instead of reusing an incompatible one', () => {
    status.devices = [android];
    status.performSelectFramework('net9.0-ios');
    assert.equal(config.device, undefined);
    assert.equal(config.getTargetFramework(), 'net9.0-ios');
});
test('legacy device preference migrates only for a compatible framework', () => {
    storage.set('device', `${ios.name}_${ios.platform}_${ios.os_version}`);
    assert.equal(state.getDevice(), undefined);
    status.performSelectFramework('net9.0-ios');
    assert.equal(config.device, ios);
    status.performSelectDevice(ios);
    assert.equal(storage.get('device_net9.0-ios'), deviceId(ios));
});
test('device identity separates identical phones and survives OS/name changes', () => {
    assert.notEqual(deviceId(android), deviceId(android2));
    assert.equal(deviceId(android), deviceId({ ...android, name: 'Renamed', os_version: 'New OS' }));
});
test('Android emulator identity survives shutdown and adb port changes', () => {
    const avd = { ...android, name: 'Pixel_AVD', is_emulator: true, serial: '' };
    assert.equal(deviceId(avd), deviceId({ ...avd, serial: 'emulator-5556', is_running: true }));
});
test('framework compatibility handles platform versions and generic desktop targets', () => {
    assert.equal(supportsFramework(ios, 'net9.0-ios18.0'), true);
    assert.equal(supportsFramework(android, 'net9.0-ios'), false);
    assert.equal(supportsFramework({ platform: 'windows' }, 'net9.0-windows10.0.19041.0'), true);
    assert.equal(supportsFramework({ platform: 'maccatalyst' }, 'net9.0'), true);
    assert.equal(supportsFramework(ios, 'net9.0'), false);
});
test('configuration picker switches framework without losing Release selection', async () => {
    selected = 'Release | net9.0-ios';
    await status.showQuickPickConfiguration();
    assert.equal(config.configuration, 'Release');
    assert.equal(config.getTargetFramework(), 'net9.0-ios');
    assert.equal(config.device, ios);
});
test('framework choice is retained separately for each project', () => {
    status.performSelectFramework('net9.0-ios');
    const second = { ...project, path: '/app/Second.csproj' };
    status.projects.push(second);
    status.performSelectProject(second);
    status.performSelectFramework('net9.0-android');
    status.performSelectProject(project);
    assert.equal(config.getTargetFramework(), 'net9.0-ios');
});
test('each TFM gets its own preference even when both are Android', () => {
    const multi = { ...project, frameworks: ['net8.0-android', 'net9.0-android'] };
    status.performSelectProject(multi);
    status.performSelectFramework('net8.0-android');
    status.performSelectDevice(android);
    status.performSelectFramework('net9.0-android');
    status.performSelectDevice(android2);
    status.performSelectFramework('net8.0-android');
    assert.equal(config.device, android);
});
test('invalid or removed framework cannot become active', () => {
    status.performSelectFramework('net99.0-ios');
    assert.equal(config.getTargetFramework(), 'net9.0-android');
    storage.set(`framework_${project.path}`, 'net99.0-ios');
    status.performSelectProject(project);
    assert.equal(config.getTargetFramework(), 'net9.0-android');
});
