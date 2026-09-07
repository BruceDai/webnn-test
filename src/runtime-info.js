const { execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

function selectWindowsAppSdk(packages, architecture = process.arch) {
    const arch = architecture === 'ia32' ? 'x86' : architecture;
    const candidates = packages.filter(sdk =>
        /^Microsoft\.WindowsAppRuntime\.\d[\w.-]*$/i.test(sdk.Name) &&
        sdk.Architecture.toLowerCase() === arch.toLowerCase() &&
        /-(preview|experimental)/i.test(sdk.Name)
    );
    // SDK 1.x used package versions like 8000.x. SDK 2.x uses 2.x.
    // Compare the SDK generation first so an old 1.8 runtime cannot outrank 2.x.
    const versionParts = sdk => [
        Number(sdk.Name.match(/^Microsoft\.WindowsAppRuntime\.(\d+)/i)[1]),
        ...sdk.Version.split('.').map(Number)
    ];
    candidates.sort((a, b) => {
        const left = versionParts(a);
        const right = versionParts(b);
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
            const difference = (right[i] || 0) - (left[i] || 0);
            if (difference) return difference;
        }
        return b.Name.localeCompare(a.Name, undefined, { numeric: true });
    });
    return candidates[0] || null;
}

function resolveWindowsAppSdk() {
    if (os.platform() !== 'win32') throw new Error('Windows App SDK selection requires Windows');
    const script = `
        $ErrorActionPreference = 'Stop'
        $packages = @(Get-AppxPackage -Name 'Microsoft.WindowsAppRuntime.*' |
            Select-Object Name, @{N='Version';E={$_.Version.ToString()}},
                @{N='Architecture';E={$_.Architecture.ToString()}}, InstallLocation)
        ConvertTo-Json -InputObject $packages -Compress
    `;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 30000
    }).trim();
    const sdk = selectWindowsAppSdk(JSON.parse(output || '[]'));
    if (!sdk) {
        throw new Error(`No ${process.arch} preview or experimental Windows App SDK runtime is installed. Install one from https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/downloads.`);
    }
    if (!fs.existsSync(path.join(sdk.InstallLocation, 'onnxruntime.dll'))) {
        throw new Error(`Selected Windows App SDK package ${sdk.Name} ${sdk.Version} does not contain onnxruntime.dll`);
    }
    return sdk;
}

function verifyWindowsAppSdk(dllInfo, sdkPath) {
    const expected = path.resolve(sdkPath, 'onnxruntime.dll').toLowerCase();
    const ortModules = (dllInfo?.modules || []).filter(m => /^onnxruntime\.dll$/i.test(m.ModuleName || ''));
    if (ortModules.length === 0 || ortModules.some(m => path.resolve(m.FileName || '').toLowerCase() !== expected)) {
        throw new Error(`Windows App SDK selection failed: expected ${expected}; loaded ${ortModules.map(m => m.FileName).join(', ') || 'not detected'}`);
    }
}

// Report runtime versions from the modules captured during the test run.
function getRuntimeInfo(dllCheckResults = []) {
    const info = {
        loadedWindowsAppSdk: '',
        loadedOnnxRuntime: '',
        loadedExecutionProviderPackages: '',
        loadedExecutionProviders: ''
    };

    const loadedProviders = new Set();
    const loadedProviderPackages = new Set();
    const loadedSdks = new Set();
    const loadedOrtVersions = new Set();
    const backendModules = {
        tensorrt: /tensorrt|nvinfer/i,
        openvino: /openvino/i,
        dml: /directml|providers_dml/i,
        migraphx: /migraphx/i,
        qnn: /qnn/i
    };
    for (const result of Array.isArray(dllCheckResults) ? dllCheckResults : []) {
        for (const module of result.dllInfo?.modules || []) {
            const name = module.ModuleName || '';
            if (/^onnxruntime\.dll$/i.test(name)) {
                const sdk = (module.FileName || '').match(/[\\/](Microsoft\.WindowsAppRuntime\.[^\\/]+?)_(\d+\.\d+\.\d+\.\d+)_(x64|x86|arm64)__[^\\/]+[\\/]/i);
                if (sdk) loadedSdks.add(`${sdk[1]}: ${sdk[2]} (${sdk[3]})`);
                loadedOrtVersions.add(`${module.ProductVersion || 'Unknown'} (${module.FileName || name})`);
            }
            const matchesBackend = !result.backend || backendModules[result.backend]?.test(name);
            if (matchesBackend && /^(onnxruntime_providers_(?!shared\.)[^\\/]+|DirectML|openvino|nvinfer[^\\/]*|migraphx|QnnHtp|QnnCpu)\.dll$/i.test(name)) {
                loadedProviders.add(`${name}: ${module.ProductVersion || 'Unknown'}`);
                const ep = (module.FileName || '').match(/[\\/]([^\\/]+\.WinML\.[^\\/]+\.EP(?:\.[^\\/]+)?)_(\d+\.\d+\.\d+\.\d+)_(x64|x86|arm64)__[^\\/]+[\\/]/i);
                if (ep) loadedProviderPackages.add(`${ep[1]}: ${ep[2]} (${ep[3]})`);
            }
        }
    }
    info.loadedExecutionProviders = [...loadedProviders].sort().join('\n');
    info.loadedExecutionProviderPackages = [...loadedProviderPackages].sort().join('\n');
    info.loadedWindowsAppSdk = [...loadedSdks].sort().join('\n');
    info.loadedOnnxRuntime = [...loadedOrtVersions].sort().join('\n');

    return info;
}

function runtimeInfoRows(info) {
    return [
        ...(info.loadedOnnxRuntime ? [['ORT', info.loadedOnnxRuntime]] : []),
        ['Windows App SDK', info.loadedWindowsAppSdk || 'Not detected'],
        ...(info.loadedExecutionProviderPackages ? [['EP', info.loadedExecutionProviderPackages]] : []),
        ...(info.loadedExecutionProviders ? [['EP DLLs', info.loadedExecutionProviders]] : [])
    ];
}

module.exports = { getRuntimeInfo, runtimeInfoRows, selectWindowsAppSdk, resolveWindowsAppSdk, verifyWindowsAppSdk };
