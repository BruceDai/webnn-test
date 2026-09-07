const { execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

function resolveWindowsAppSdk(packageName) {
    if (os.platform() !== 'win32') throw new Error('--win-app-sdk requires Windows');
    if (!/^Microsoft\.WindowsAppRuntime\.\d[\w.-]*$/.test(packageName)) {
        throw new Error('Expected a Windows App SDK runtime package name, for example Microsoft.WindowsAppRuntime.2-experimentalB');
    }
    const script = `
        $ErrorActionPreference = 'Stop'
        Get-AppxPackage -Name $env:WEBNN_SDK_PACKAGE | Where-Object {
            $_.Architecture.ToString() -eq $env:WEBNN_SDK_ARCH
        } | Sort-Object { [version]$_.Version } -Descending |
            Select-Object -First 1 Name, Version, InstallLocation | ConvertTo-Json -Compress
    `;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 30000,
        env: { ...process.env, WEBNN_SDK_PACKAGE: packageName, WEBNN_SDK_ARCH: process.arch === 'ia32' ? 'x86' : process.arch }
    }).trim();
    const sdk = output ? JSON.parse(output) : null;
    if (!sdk || !fs.existsSync(path.join(sdk.InstallLocation, 'onnxruntime.dll'))) {
        throw new Error(`No ${process.arch} ONNX Runtime installation found for ${packageName}`);
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

module.exports = { getRuntimeInfo, runtimeInfoRows, resolveWindowsAppSdk, verifyWindowsAppSdk };
