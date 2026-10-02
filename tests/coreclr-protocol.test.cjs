const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RequestCompatibility } = require('../src/VSCode/resources/coreclr-adapter.cjs');

function frame(message) {
    const payload = Buffer.from(JSON.stringify(message));
    return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload]);
}
async function adapt(chunks) {
    const stream = new RequestCompatibility();
    const output = [];
    const done = new Promise((resolve, reject) => {
        stream.on('data', data => output.push(data));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    for (const chunk of chunks) { stream.write(chunk); }
    stream.end();
    await done;
    return Buffer.concat(output);
}
test('omitted exception filter options are normalized across split headers and UTF-8 payloads', async () => {
    const input = { type: 'request', seq: 2, command: 'setExceptionBreakpoints', arguments: { filters: ['all'], note: 'é' } };
    const bytes = frame(input);
    const result = await adapt([bytes.subarray(0, 9), bytes.subarray(9, bytes.length - 2), bytes.subarray(bytes.length - 2)]);
    assert.deepEqual(result, frame({ ...input, arguments: { ...input.arguments, filterOptions: [] } }));
});
test('explicit exception conditions and consecutive other requests retain their values', async () => {
    const request = { type: 'request', seq: 5, command: 'setExceptionBreakpoints', arguments: { filters: [], filterOptions: [{ filterId: 'all', condition: 'MyException' }] } };
    const launch = { type: 'request', seq: 6, command: 'launch', arguments: { cwd: '/test path' } };
    const bytes = Buffer.concat([frame(request), frame(launch)]);
    assert.deepEqual(await adapt([bytes]), bytes);
});
test('incomplete protocol input reports an error instead of silently dropping a request', async () => {
    await assert.rejects(adapt([Buffer.from('Content-Length: 20\r\n\r\n{}')]), /Incomplete/);
});
