# Install WinAppRuntime
https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/downloads

Use **2.4 Experimental (2.4.1-experimental)** for the experimental SDK:
https://aka.ms/windowsappsdk/2.4/2.4.1-experimental/windowsappruntimeinstall-x64.exe

The installer registers `Microsoft.WindowsAppRuntime.2-experimentalB` version
`2.4.1.0`. Run normally to install for the current user, or as an Administrator
to provision for all users. Existing stable runtimes can remain installed.

On Windows, `src/main.js` selects the latest installed preview or experimental
runtime automatically and verifies the loaded ONNX Runtime DLL path. The runner
does not download SDK updates automatically.

# Install EPs
ExecutionProviderCatalog.exe

WindowsAppSDK\dev\DynamicDependency\Powershell
EnsureWinMLExecutionProviders.ps1

# Install Chrome

# Check ORT
DumpPackages.ps1 and search for WindowsAppRuntime

# Check ORT at runtime
Listdlls64.exe -v chrome.exe | findstr /i "onnxruntime.*.dll"

* Delete ORT
\\edgefs\users\rcintron\scripts\Remove-PackagesByWildcard.ps1
Remove-AppxPackage -Package '<package_full_name>'


* Resources
https://webai.run/tests
https://microsoft.github.io/webnn-developer-preview/
https://webmachinelearning.github.io/webnn-samples-intro/
https://huggingface.co/webnn/spaces

https://source.chromium.org/chromium/chromium/src/+/main:services/webnn/public/cpp/win_app_runtime_package_info.h
https://source.chromium.org/chromium/chromium/src/+/main:services/webnn/public/cpp/execution_providers_info.h

https://webnn.io/en/api-reference/browser-compatibility/chrome-flags

https://github.com/webmachinelearning/webnn-samples-test-framework
