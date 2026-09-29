const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename);
const { ProcessRunner } = require('../src/VSCode/interop/processRunner.ts');
const { ProcessArgumentBuilder } = require('../src/VSCode/interop/processArgumentBuilder.ts');
const command = script => new ProcessArgumentBuilder(process.execPath).append('-e', script);

test('valid JSON with warning stderr succeeds', async () => {
    assert.deepEqual(await ProcessRunner.runAsync(command('process.stderr.write("warning"); process.stdout.write("[1]")')), [1]);
});
test('nonzero exit rejects even with valid JSON', async () => {
    await assert.rejects(ProcessRunner.runAsync(command('process.stdout.write("[]"); process.stderr.write("failure"); process.exitCode=7')), /exited with 7: failure/);
});
test('spawn failure rejects', async () => {
    await assert.rejects(ProcessRunner.runAsync(new ProcessArgumentBuilder('/does-not-exist-meteor')), /ENOENT/);
});
test('invalid JSON rejects instead of escaping process callback', async () => {
    await assert.rejects(ProcessRunner.runAsync(command('process.stdout.write("not-json")')), /invalid JSON/);
});
test('stdout chunks preserve significant trailing whitespace and UTF8', async () => {
    const script = 'process.stdout.write(\'["hello \' ); setTimeout(() => process.stdout.write(\'world ☃"]\'), 10)';
    assert.deepEqual(await ProcessRunner.runAsync(command(script)), ['hello world ☃']);
});
test('timeout kills only the spawned helper and rejects', async () => {
    await assert.rejects(ProcessRunner.runAsync(command('setInterval(() => {}, 1000)'), { timeout: 100 }), /timed out/);
});
test('caller cancellation stops a helper', async () => {
    const controller = new AbortController();
    const pending = ProcessRunner.runAsync(command('setInterval(() => {}, 1000)'), { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /cancelled/);
});
test('sync runner rejects failed exit and bounds stalled helpers', () => {
    assert.equal(ProcessRunner.runSync(command('process.stdout.write("incorrect"); process.exit(5)')), undefined);
    assert.equal(ProcessRunner.runSync(command('setInterval(() => {}, 1000)'), { timeout: 100 }), undefined);
});
