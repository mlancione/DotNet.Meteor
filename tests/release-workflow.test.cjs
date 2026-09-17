const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve('scripts/publish-release.sh');
function runRelease({ tagCommit = '', exists = false, version = '6.2.11', failUpload = false, failHttp2 = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-release-test-'));
    try {
        fs.mkdirSync(path.join(root, 'artifacts'));
        fs.writeFileSync(path.join(root, 'artifacts', 'test.vsix'), 'fixture');
        fs.writeFileSync(path.join(root, 'git'), '#!/bin/sh\nif [ "$1" = "show-ref" ]; then [ -n "$TEST_TAG_COMMIT" ]; else echo "$TEST_TAG_COMMIT"; fi\n', { mode: 0o755 });
        fs.writeFileSync(path.join(root, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_LOG"\nif [ "$2" = "view" ]; then [ "$TEST_EXISTS" = "yes" ]; elif [ "$2" = "upload" ] && [ "$TEST_UPLOAD_FAIL" = "yes" ]; then exit 1; elif [ "$2" = "upload" ] && [ "$TEST_HTTP2_FAIL" = "yes" ] && [ "$GODEBUG" != "http2client=0" ]; then exit 1; else exit 0; fi\n', { mode: 0o755 });
        fs.writeFileSync(path.join(root, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
        const log = path.join(root, 'calls');
        const result = spawnSync('bash', [script], { cwd: root, encoding: 'utf8', env: {
            ...process.env, PATH: `${root}:${process.env.PATH}`, RELEASE_VERSION: version,
            GITHUB_SHA: 'built-commit', TEST_TAG_COMMIT: tagCommit, TEST_EXISTS: exists ? 'yes' : 'no', TEST_LOG: log, TEST_UPLOAD_FAIL: failUpload ? 'yes' : 'no', TEST_HTTP2_FAIL: failHttp2 ? 'yes' : 'no'
        }});
        return { ...result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('release targets the built commit and includes VSIX assets', () => {
    const result = runRelease();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /release create local-v6\.2\.11 --target built-commit/);
    assert.match(result.calls, /release upload local-v6\.2\.11 artifacts\/test\.vsix --clobber/);
    assert.match(result.calls, /release edit local-v6\.2\.11 --draft=false --latest/);
});
test('existing version from another commit is never overwritten', () => {
    const result = runRelease({ tagCommit: 'different-commit', exists: true });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, '');
});
test('rerunning the same source can refresh its release assets', () => {
    const result = runRelease({ tagCommit: 'built-commit', exists: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /release upload local-v6\.2\.11 artifacts\/test\.vsix --clobber/);
    assert.doesNotMatch(result.calls, /release create/);
    assert.match(result.calls, /release edit local-v6\.2\.11 --draft=false --latest/);
});
test('invalid version is rejected before any release action', () => {
    const result = runRelease({ version: '6.2.11;echo unsafe' });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, '');
});

test('failed asset upload is retried and never publishes an incomplete draft', () => {
    const result = runRelease({ failUpload: true });
    assert.notEqual(result.status, 0);
    assert.equal((result.calls.match(/release upload/g) || []).length, 2);
    assert.doesNotMatch(result.calls, /release edit/);
});

test('uploads use HTTP/1.1 to avoid stalled HTTP/2 connections', () => {
    const result = runRelease({ failHttp2: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.calls.match(/release upload/g) || []).length, 1);
    assert.match(result.calls, /release edit/);
});
