const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectWindowsAppSdk } = require('../src/runtime-info');

const sdk = (release, version, architecture = 'X64') => ({
    Name: `Microsoft.WindowsAppRuntime.${release}`,
    Version: version,
    Architecture: architecture
});

test('new SDK generations outrank legacy 8000.x package versions', () => {
    const latest = sdk('2-experimentalB', '2.4.1.0');
    assert.equal(selectWindowsAppSdk([
        sdk('1.8-preview', '8000.591.1127.0'),
        latest,
        sdk('1.8-experimental4', '8000.548.2012.0')
    ], 'x64'), latest);
});

test('default chooses the latest numeric prerelease version across channels', () => {
    const latest = sdk('2-preview', '2.10.0.0');
    assert.equal(selectWindowsAppSdk([
        sdk('2-experimentalB', '2.9.1.0'),
        sdk('2', '2.11.0.0'),
        latest
    ], 'x64'), latest);
});

test('selection respects architecture, including the Node ia32 alias', () => {
    const x64 = sdk('2-experimentalB', '2.4.1.0');
    const x86 = sdk('2-preview', '2.3.0.0', 'X86');
    const candidates = [sdk('2-preview', '2.5.0.0', 'Arm64'), x64, x86];
    assert.equal(selectWindowsAppSdk(candidates, 'x64'), x64);
    assert.equal(selectWindowsAppSdk(candidates, 'ia32'), x86);
});

test('missing prereleases never fall back to stable or a different architecture', () => {
    assert.equal(selectWindowsAppSdk([], 'x64'), null);
    assert.equal(selectWindowsAppSdk([
        sdk('2', '2.4.0.0'), sdk('2-experimentalB', '2.4.1.0', 'Arm64')
    ], 'x64'), null);
});
