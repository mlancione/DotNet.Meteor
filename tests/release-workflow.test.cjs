const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve('scripts/publish-release.sh');
function runRelease({ tagCommit = '', exists = false, version = '6.2.11', failUpload = false, failHttp2 = false, complete = false, releaseCommit = 'built-commit' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-release-test-'));
    try {
        fs.mkdirSync(path.join(root, 'artifacts'));
        fs.writeFileSync(path.join(root, 'artifacts', 'test.vsix'), 'fixture');
        fs.writeFileSync(path.join(root, 'git'), '#!/bin/sh\nif [ "$1" = "show-ref" ]; then [ -n "$TEST_TAG_COMMIT" ]; else echo "$TEST_TAG_COMMIT"; fi\n', { mode: 0o755 });
        fs.writeFileSync(path.join(root, 'gh'), `#!/bin/sh
printf "%s\\n" "$*" >> "$TEST_LOG"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
    case "$*" in
        *databaseId*) echo 314; exit 0;;
        *targetCommitish*) echo "$TEST_RELEASE_COMMIT"; exit 0;;
        *) [ "$TEST_EXISTS" = "yes" ]; exit $?;;
    esac
fi
if [ "$1" = "api" ] && [ "$2" = "--method" ] && [ "$3" = "POST" ]; then
    [ "$TEST_UPLOAD_FAIL" = "yes" ] && exit 1
    [ "$TEST_HTTP2_FAIL" = "yes" ] && [ "$GODEBUG" != "http2client=0" ] && exit 1
fi
if [ "$1" = "api" ] && [ "$TEST_COMPLETE" = "yes" ]; then
    case "$*" in *uploaded*) echo 42;; esac
fi
exit 0
`, { mode: 0o755 });
        fs.writeFileSync(path.join(root, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
        const log = path.join(root, 'calls');
        const result = spawnSync('bash', [script], { cwd: root, encoding: 'utf8', env: {
            ...process.env, PATH: `${root}:${process.env.PATH}`, RELEASE_VERSION: version,
            GH_REPO: 'owner/repo', GITHUB_SHA: 'built-commit', TEST_TAG_COMMIT: tagCommit, TEST_EXISTS: exists ? 'yes' : 'no', TEST_LOG: log, TEST_UPLOAD_FAIL: failUpload ? 'yes' : 'no', TEST_HTTP2_FAIL: failHttp2 ? 'yes' : 'no', TEST_COMPLETE: complete ? 'yes' : 'no', TEST_RELEASE_COMMIT: releaseCommit
        }});
        return { ...result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('release targets the built commit and includes VSIX assets', () => {
    const result = runRelease();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /release create local-v6\.2\.11 --target built-commit/);
    assert.match(result.calls, /api --method POST https:\/\/uploads.github.com\/repos\/owner\/repo\/releases\/314\/assets\?name=test.vsix/);
    assert.match(result.calls, /release edit local-v6\.2\.11 --draft=false --latest/);
});
test('existing version from another commit is never overwritten', () => {
    const result = runRelease({ tagCommit: 'different-commit', exists: true });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, '');
});
test('rerunning the same source can resume its release assets', () => {
    const result = runRelease({ tagCommit: 'built-commit', exists: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /api --method POST https:\/\/uploads.github.com\/repos\/owner\/repo\/releases\/314\/assets\?name=test.vsix/);
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
    assert.equal((result.calls.match(/api --method POST/g) || []).length, 2);
    assert.doesNotMatch(result.calls, /release edit/);
});

test('uploads use HTTP/1.1 to avoid stalled HTTP/2 connections', () => {
    const result = runRelease({ failHttp2: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.calls.match(/api --method POST/g) || []).length, 1);
    assert.match(result.calls, /release edit/);
});

test('completed assets are preserved when resuming a draft', () => {
    const result = runRelease({ exists: true, tagCommit: 'built-commit', complete: true });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.calls, /api --method POST/);
    assert.match(result.calls, /release edit/);
});

test('draft from another commit cannot receive mismatched assets', () => {
    const result = runRelease({ exists: true, releaseCommit: 'other-commit' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.calls, /api --method POST/);
    assert.doesNotMatch(result.calls, /release edit/);
});
