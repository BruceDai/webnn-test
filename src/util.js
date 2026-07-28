
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const nodemailer = require('nodemailer');
const { chromium } = require('@playwright/test');
const { getRuntimeInfo, runtimeInfoRows } = require('./runtime-info');

// Kill only browser processes that belong to our automation.
// Uses the browser root PID (captured at launch) to kill the entire process tree,
// without affecting the user's personal browser windows.
function killOwnBrowserProcesses(browserRootPid) {
    if (!browserRootPid) {
        console.log('[Warning] No browser PID tracked, skipping targeted cleanup');
        return 0;
    }
    try {
        execSync(`taskkill /F /T /PID ${browserRootPid}`, { stdio: 'ignore', timeout: 10000 });
        console.log(`[Info] Killed browser process tree (root PID: ${browserRootPid})`);
        return 1;
    } catch (e) {
        // Process may already be dead
        return 0;
    }
}

// Find the browser root PID by looking for an msedge/chrome process whose parent
// is the current Node process (i.e., Playwright spawned it).
function findBrowserRootPid(processName = 'msedge.exe') {
    try {
        const tempScript = path.join(os.tmpdir(), `find-browser-${Date.now()}.ps1`);
        fs.writeFileSync(tempScript,
            `Get-CimInstance Win32_Process -Filter "Name='${processName}'" | ` +
            `Where-Object { $_.ParentProcessId -eq ${process.pid} } | ` +
            `Select-Object -ExpandProperty ProcessId`, 'utf8');
        const output = execSync(`powershell -ExecutionPolicy Bypass -File "${tempScript}"`, {
            encoding: 'utf8', timeout: 10000
        }).trim();
        try { fs.unlinkSync(tempScript); } catch (e) {}
        if (output) {
            const pid = parseInt(output.split('\n')[0].trim(), 10);
            if (!isNaN(pid)) return pid;
        }
    } catch (e) { /* best effort */ }
    return null;
}

async function send_email(subject, content, sender = '', to = '') {
    const emailService = {
        serverConfig: {
            host: '',
            port: port
        },
        from: '',
        to: ['']
    };

    try {
        const transporter = nodemailer.createTransport({
            host: emailService.serverConfig.host,
            port: emailService.serverConfig.port,
            secure: false,
            tls: { rejectUnauthorized: false }
        });

        const recipients = to
        ? to.split(',').map(item => item.trim()).filter(Boolean)
        : emailService.to;

        const fromAddress = sender || emailService.from;

        await transporter.sendMail({
            from: fromAddress,
            to: recipients.join(', '),
            subject,
            html: content
        });

        return `Email sent successfully to ${recipients.join(', ')}`;
    } catch (error) {
        console.error('Error in send_email:', error);
        throw error;
    }
}

  function _format_driver_date(dateString) {
    if (!dateString) return '';
    let datePart = dateString.toString().trim().split(/\s+/)[0];
    datePart = datePart.replace(/-/g, '/').replace(/\./g, '/');

    if (datePart.includes('/')) {
        const parts = datePart.split('/');
        if (parts.length === 3) {
            if (parts[0].length === 4 && !isNaN(parts[0])) {
                // YYYY/M/D -> YYYYMMDD
                return `${parts[0]}${parts[1].padStart(2, '0')}${parts[2].padStart(2, '0')}`;
            } else {
                // M/D/YYYY -> YYYYMMDD
                return `${parts[2]}${parts[0].padStart(2, '0')}${parts[1].padStart(2, '0')}`;
            }
        }
    }
    return datePart.replace(/\//g, '');
  }

  function _is_hardware_gpu(gpu) {
    const name = gpu.Name || '';
    const pnp = gpu.PNPDeviceID || '';
    const status = gpu.Status || '';
    if (name.includes('Microsoft') && (name.includes('Remote Display') || name.includes('Basic Display') || name.includes('Basic Render'))) return false;
    if (pnp.startsWith('SWD')) return false;
    if (status && !['ok', 'working properly', ''].includes(status.toLowerCase())) return false;
    return true;
  }

  function _is_software_gpu(gpu) {
    const name = gpu.Name || '';
    const status = gpu.Status || '';
    if (name.includes('Microsoft')) {
        if (name.includes('Remote Display')) return false;
        if (name.includes('Basic Display') || name.includes('Basic Render')) {
              if (!status || ['ok', 'working properly', ''].includes(status.toLowerCase())) return true;
        }
    }
    return false;
  }

  function _is_remote_display_gpu(gpu) {
    const name = gpu.Name || '';
    const status = gpu.Status || '';
    if (name.includes('Microsoft') && name.includes('Remote Display')) {
        if (!status || ['ok', 'working properly', ''].includes(status.toLowerCase())) return true;
    }
    return false;
  }

  function get_gpu_info() {
    let name = '';
    let driver_date = '';
    let driver_ver = '';
    let device_id = '';
    let vendor_id = '';

    if (os.platform() === 'win32') {
        try {
            const cmd = 'powershell -c "Get-CimInstance -query \'select * from win32_VideoController\' | Select-Object Name, @{N=\'DriverDate\';E={if($_.DriverDate){([datetime]$_.DriverDate).ToString(\'yyyy/MM/dd\')}}}, DriverVersion, PNPDeviceID, Status | ConvertTo-Json -Compress"';
            const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();

            if (output) {
                let gpus = [];
                try {
                    const parsed = JSON.parse(output);
                    gpus = Array.isArray(parsed) ? parsed : [parsed];
                } catch(e) {
                    // console.error('Failed to parse GPU info JSON', e);
                }

                let selectedGpu = null;

                // 1. Hardware
                for (const gpu of gpus) {
                    if (_is_hardware_gpu(gpu)) {
                        selectedGpu = gpu;
                        break;
                    }
                }

                // 2. Software
                if (!selectedGpu) {
                    for (const gpu of gpus) {
                        if (_is_software_gpu(gpu)) {
                            selectedGpu = gpu;
                            break;
                        }
                    }
                }

                // 3. Remote
                if (!selectedGpu) {
                    for (const gpu of gpus) {
                        if (_is_remote_display_gpu(gpu)) {
                            selectedGpu = gpu;
                            break;
                        }
                    }
                }

                if (selectedGpu) {
                    name = selectedGpu.Name || '';
                    driver_date = _format_driver_date(selectedGpu.DriverDate);
                    driver_ver = selectedGpu.DriverVersion || '';
                    const pnp = selectedGpu.PNPDeviceID || '';

                    if (pnp && !pnp.startsWith('SWD')) {
                        const devMatch = pnp.match(/DEV_(.{4})/);
                        const venMatch = pnp.match(/VEN_(.{4})/);
                        if (devMatch) device_id = devMatch[1];
                        if (venMatch) vendor_id = venMatch[1];
                    } else if (name.includes('Microsoft') && (name.includes('Basic Render') || name.includes('Basic Display') || name.includes('Remote Display'))) {
                          vendor_id = '1414';
                          if (name.includes('Basic Render')) device_id = '008c';
                          else if (name.includes('Basic Display')) device_id = '00ff';
                          else if (name.includes('Remote Display')) device_id = '008c';
                    }

                } else {
                      name = 'Microsoft Basic Render Driver';
                      vendor_id = '1414';
                      device_id = '008c';
                }
            }
        } catch (e) {
            console.error('Failed to get GPU info:', e.message);
        }
    }

    return { name, driver_date, driver_ver, device_id, vendor_id };
  }

  function get_cpu_info() {
    try {
        if (os.platform() === 'win32') {
             const cmd = 'powershell -c "Get-CimInstance -ClassName Win32_Processor | Select-Object -ExpandProperty Name"';
             const cpuName = execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
             return cpuName;
        } else {
             const cpus = os.cpus();
             if (cpus && cpus.length > 0) {
                 return cpus[0].model;
             }
        }
    } catch(e) {
        console.log('Failed to get CPU info:', e.message);
    }
    return 'Unknown CPU';
  }

  function get_npu_info() {
     let name = '';
     let driver_date = '';
     let driver_ver = '';
     let device_id = '';
     try {
        if (os.platform() === 'win32') {
            // Try to find NPU devices from PnP entities.
            // Common potential names: "Intel(R) AI Boost", "Intel(R) NPU", "LNP", "NPU"
            // We use word boundary \bNPU\b to avoid matching "Input" (which contains "npu")
            const cmd = 'powershell -c "Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName -match \'\\\\bNPU\\\\b|Intel.*AI Boost|Intel.*NPU|Hexagon|Movidius\' } | Sort-Object -Property DriverDate -Descending | Select-Object DeviceName, DriverVersion, DeviceID, @{N=\'DriverDate\';E={if($_.DriverDate){([datetime]$_.DriverDate).ToString(\'yyyy/MM/dd\')}}} | ConvertTo-Json -Compress"';
            const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
            if (output) {
                let npu = null;
                try {
                    const parsed = JSON.parse(output);
                    npu = Array.isArray(parsed) ? parsed[0] : parsed;
                } catch(e) { /* ignore */ }

                if (npu) {
                    name = npu.DeviceName || 'Unknown NPU';
                    driver_ver = npu.DriverVersion || '';
                    driver_date = _format_driver_date(npu.DriverDate);

                    if (npu.DeviceID) {
                         const devMatch = npu.DeviceID.match(/DEV_([0-9A-Fa-f]+)/);
                         if (devMatch) device_id = devMatch[1];
                    }
                }
            }
        }
     } catch(e) {
         console.log('Failed to get NPU info:', e.message);
     }

     if (!name) return 'Unknown NPU';
     return { name, driver_ver, driver_date, device_id };
  }

async function launchBrowser() {
    // Ensure stale browser processes do not interfere with a new launch.
    const browserProcessName = (() => {
        const browserPath = (process.env.BROWSER_PATH || '').toLowerCase();
        const channel = (process.env.CHROME_CHANNEL || '').toLowerCase();
        if (browserPath.includes('msedge') || channel.includes('edge')) {
            return 'msedge.exe';
        }
        return 'chrome.exe';
    })();
    try {
        execSync(`taskkill /F /IM ${browserProcessName} /T`, { stdio: 'ignore', timeout: 10000 });
        console.log(`[Info] Killed existing ${browserProcessName} processes before launch`);
    } catch (e) {
        // Best effort: process may not exist
    }

    // Using flags found in current file + persistent context logic
    const args = [];

   if (process.env.EXTRA_BROWSER_ARGS) {
       // Split by whitespace followed by -- to allow spaces in argument values
       const extraArgs = process.env.EXTRA_BROWSER_ARGS.split(/\s+(?=--)/);
       extraArgs.forEach(arg => {
           arg = arg.trim();
           if (arg.startsWith('--enable-features=')) {
               const matchIndex = args.findIndex(a => a.startsWith('--enable-features='));
               if (matchIndex !== -1) {
                   const newValue = arg.split('=')[1];
                   args[matchIndex] = `${args[matchIndex]},${newValue}`;
               } else {
                   args.push(arg);
               }
           } else if (arg !== '') {
               args.push(arg);
           }
       });
   }

   if (process.env.WEBNN_EXPECTED_SDK_PATH) {
       // Chromium requires this opt-in for its development runtime override.
       args.push('--allow-third-party-modules');
       args.push(`--webnn-ort-library-path-for-testing=${process.env.WEBNN_EXPECTED_SDK_PATH}`);
   }

   const launchOptions = {
       headless: false,
       args: args,
       ignoreDefaultArgs: ['--disable-component-extensions-with-background-pages']
   };

   if (process.env.BROWSER_PATH) {
       launchOptions.executablePath = process.env.BROWSER_PATH;
   } else if (process.env.BROWSER_CHANNEL || process.env.CHROME_CHANNEL) {
       // CHROME_CHANNEL is retained as a fallback for older callers.
       launchOptions.channel = process.env.BROWSER_CHANNEL || process.env.CHROME_CHANNEL;
   } else {
        launchOptions.channel = 'chrome-canary'; // Default to chrome-canary
   }

   // We use a local persistent directory in the workspace.
   const userDataDir = path.join(__dirname, '..', 'user-data');
   if (!fs.existsSync(userDataDir)) {
       fs.mkdirSync(userDataDir, { recursive: true });
   }

   const isEdge = (launchOptions.channel || '').startsWith('msedge') ||
       (process.env.BROWSER_PATH || '').toLowerCase().includes('msedge') ||
       process.env.BROWSER_NAME === 'edge';
   const browserName = isEdge ? 'Edge' : 'Chrome';
   console.log(`[Launch] Launch options: ${JSON.stringify(launchOptions)}`);
   console.log(`[Launch] Launching ${browserName} from: ${userDataDir}`);

   let context, page, browser;

   // Use launchPersistentContext to reuse user data dir
   try {
       context = await chromium.launchPersistentContext(userDataDir, launchOptions);
       // Always create a new page for the test to avoid interference with restored tabs
       page = await context.newPage();
       await page.bringToFront();
   } catch (e) {
       console.error(`[Error] Failed to launch persistent context: ${e.message}`);
       console.log('[Warning]  Falling back to standard launch (fresh profile)...');
       browser = await chromium.launch(launchOptions);
       context = await browser.newContext();
       page = await context.newPage();
   }

   if (process.env.DEVICE) {
       const deviceType = process.env.DEVICE;
       await context.addInitScript((type) => {
           if (navigator.ml && !navigator.ml.createContext._instrumented) {
               const originalCreateContext = navigator.ml.createContext;
               navigator.ml.createContext = async function(options) {
                   options = options || {};
                   options.deviceType = type;
                   return originalCreateContext.call(navigator.ml, options);
               };
               navigator.ml.createContext._instrumented = true;
           }
       }, deviceType);
   }

   return { context, page, browser };
}

class WebNNRunner {
  constructor(page) {
    this.page = page;
    this.epFlag = process.env.EP_FLAG === 'true';
    this.launchNewBrowser = null;
    this.browserRootPid = null;
  }

  // Ensure the page is available, recreating it if necessary
  async ensurePage() {
    if (this.page.isClosed()) {
      try {
        console.log('[Info] Page was closed, creating new page...');
        this.page = await this.page.context().newPage();
      } catch (e) {
        console.log('[Warning] Could not create new page from context, restarting browser...');
        const instance = await this.restartBrowserAndContext();
        this.page = instance.page;
      }
    }
  }

  // Wrapper for running a test with session failure monitoring.
  // Includes a hard timeout (default 10 min) that fires even when the GPU process
  // crashes and Playwright calls hang forever at the IPC level.
  async runTestWithSessionCheck(testFn, shouldRestart = true, { timeoutMs = 600000 } = {}) {
    await this.ensurePage();
    const pageInUse = this.page;

    let sessionInitFailed = false;
    let sessionFailureMessage = '';
    let browserCrashed = false;
    let hardTimedOut = false;

    const checkFailure = async (text) => {
      if (text.toLowerCase().includes('failed to create session')) {
        if (!sessionInitFailed) {
          sessionInitFailed = true;
          sessionFailureMessage = text;
          const msg = shouldRestart ? 'Restarting browser...' : 'Browser restart skipped (last case).';
          console.error(`[Fail] [Auto-Fail] "Failed to create session" detected. ${msg}`);
          try { await pageInUse.close(); } catch (e) {}
        }
      }
    };

    const failConsoleListener = async (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') {
        console.log(`[Browser Console] ${type}: ${text}`);
      }
      await checkFailure(text);
    };

    const failErrorListener = (err) => {
      const text = err.message || String(err);
      console.log(`[Browser Page Error] ${text}`);
      checkFailure(text);
    };

    pageInUse.on('console', failConsoleListener);
    pageInUse.on('pageerror', failErrorListener);

    // Hard timeout: when the GPU process crashes, the renderer's IPC channel
    // hangs and ALL Playwright calls (evaluate, isDisabled, goto, etc.) block
    // forever. Promise.race with a timer ensures we abort and recover.
    let hardTimer;
    const hardTimeoutPromise = new Promise((_, reject) => {
      hardTimer = setTimeout(() => {
        hardTimedOut = true;
        reject(new Error(`Test hard timeout (${timeoutMs/1000}s) - GPU process may have crashed`));
      }, timeoutMs);
    });

    try {
      await Promise.race([testFn(), hardTimeoutPromise]);
      clearTimeout(hardTimer);
      // Check if session failed even if testFn swallowed the error (e.g. via internal try/catch)
      if (sessionInitFailed) {
        throw new Error(`Failed to create session: ${sessionFailureMessage}`);
      }
    } catch (error) {
      clearTimeout(hardTimer);
      // Detect GPU process crash: the browser/page dies mid-test, producing
      // errors like "Target page, context or browser has been closed" or
      // "Target closed" or "Protocol error ... Target closed".
      const msg = error.message || '';
      const isCrash = hardTimedOut ||
                      msg.includes('Target page, context or browser has been closed') ||
                      msg.includes('Target closed') ||
                      msg.includes('browser has been closed') ||
                      msg.includes('Protocol error') ||
                      msg.includes('Connection closed');
      if (isCrash && !sessionInitFailed) {
        browserCrashed = true;
        console.error(`[Fail] [Browser Crash] Browser process died during test. Error: ${msg}`);
      }

      if (sessionInitFailed || browserCrashed) {
        console.log('[Info] Handling browser failure recovery...');
        if (shouldRestart) {
          try {
              let objectToClose = null;
              try {
                const currentContext = pageInUse.context();
                objectToClose = currentContext.browser() || currentContext;
              } catch (e) { /* context may already be dead */ }
              const instance = await this.restartBrowserAndContext(objectToClose);
              this.page = instance.page;
          } catch (restartError) {
              console.error(`[Error] Failed to restart browser: ${restartError.message}`);
          }
        }
        if (sessionInitFailed) {
          throw new Error(`Failed to create session: ${sessionFailureMessage}`);
        }
        throw new Error(`Browser crashed: ${msg}`);
      }
      throw error;
    } finally {
      clearTimeout(hardTimer);
      try {
        if (!pageInUse.isClosed()) {
            pageInUse.removeListener('console', failConsoleListener);
            pageInUse.removeListener('pageerror', failErrorListener);
        }
      } catch (e) {}
    }
  }

  // Helper function to check if two results are identical (works for both PASS and FAIL)
  compareTestResults(result1, result2) {
    if (!result1 || !result2) return false;
    if (result1.result !== result2.result) return false;

    // Compare subcase counts
    const sc1 = result1.subcases;
    const sc2 = result2.subcases;
    if (sc1.total !== sc2.total || sc1.passed !== sc2.passed || sc1.failed !== sc2.failed) {
      return false;
    }

    return true;
  }

  async restartBrowserAndContext(browserToClose) {
    if (browserToClose) {
      try {
        console.log('[Info] Closing browser before restart...');
        await browserToClose.close();
        console.log('[Success] Browser closed');
      } catch (e) {
        console.log(`[Warning] Error closing browser: ${e.message}`);
      }
    }

    // Force kill our browser process tree to ensure clean restart
    if (this.browserRootPid) {
        console.log(`[Info] Killing browser process tree (PID: ${this.browserRootPid})...`);
        killOwnBrowserProcesses(this.browserRootPid);
        this.browserRootPid = null;
    }

    // Wait a bit to ensure process is fully gone
    await new Promise(resolve => setTimeout(resolve, 3000));

    if (!this.launchNewBrowser) {
      throw new Error('launchNewBrowser function is not defined');
    }

    console.log('[Info] Launching new browser...');
    const result = await this.launchNewBrowser();

    let newBrowser, newContext, newPage;

    // Handle both { browser } return type (Launch) and { context, page } return type (PersistentContext)
    if (result.context) {
        // Persistent Context case
        newBrowser = null; // No browser object exposed
        newContext = result.context;
        newPage = result.page;
        console.log('[Success] New persistent context launched');
    } else {
        // Standard Launch case
        newBrowser = result;
        console.log('[Success] New browser launched');
        console.log('[Info] Creating new context...');
        newContext = await newBrowser.newContext();
        console.log(`[Success] Created fresh browser context (ID: ${newContext._guid || 'N/A'})`);
        newPage = null; // Will be created by caller or here?
    }

    return { browser: newBrowser, context: newContext, page: newPage };
  }

  async checkOnnxruntimeDlls(processName = 'chrome.exe', retries = 3) {
    const MAX_RETRIES = retries;
    let attempt = 0;

    console.log(`[Info] Checking for ONNX Runtime DLLs in ${processName} (GPU Process)...`);

    while (attempt <= MAX_RETRIES) {
        try {
            // 1. Find GPU Process ID
            // We use Get-CimInstance for better compatibility in pwsh/Modern Windows
            // We filter for the specific flag '--webnn-ort-ignore-ep-blocklist' which we pass to the browser.
            // This ensures we pick the correct process if multiple Chromiums are open.
            const cmdFind = `Get-CimInstance Win32_Process -Filter "Name='${processName}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
            // Increase maxBuffer just in case
            const stdout = execSync(cmdFind, { encoding: 'utf8', maxBuffer: 1024 * 1024, shell: 'powershell.exe' }).trim();

            if (!stdout) throw new Error(`Process ${processName} not found`);

            let processes = [];
            try {
                const parsed = JSON.parse(stdout);
                processes = Array.isArray(parsed) ? parsed : [parsed];
            } catch(e) { /* Single object or parse error */ }

            // Find valid GPU process
            // Priority 1: Has our specific test flag (unambiguous)
            let gpuProcess = processes.find(p => p.CommandLine && p.CommandLine.includes('--type=gpu-process') && p.CommandLine.includes('--webnn-ort-ignore-ep-blocklist'));

            // Priority 2: Just has gpu-process (fallback)
            if (!gpuProcess) {
                console.log('[Warning] Could not find GPU process with specific test flags. Falling back to generic GPU process detection.');
                gpuProcess = processes.find(p => p.CommandLine && p.CommandLine.includes('--type=gpu-process'));
            }

            if (!gpuProcess) {
                 // If no GPU process, maybe it hasn't started yet or running in single process mode?
                 // But for WebNN/WebGL usually there is one.
                 throw new Error('GPU process not found');
            }

            const pid = gpuProcess.ProcessId;

            // 2. Get Modules from that process
            let findings = [];

            // Attempt 2A: PowerShell Get-Process
            const cmdModules = `Get-Process -Id ${pid} | Select-Object -ExpandProperty Modules | Select-Object ModuleName, FileName, @{N='ProductVersion';E={$_.FileVersionInfo.ProductVersion}} | ConvertTo-Json -Compress`;
            const robustCmd = `try { ${cmdModules} } catch { Write-Output "[]" }`;

            try {
                const modulesJson = execSync(robustCmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, shell: 'powershell.exe' }).trim();

                if (modulesJson && modulesJson !== '[]') {
                    let modules = [];
                    try {
                        const parsed = JSON.parse(modulesJson);
                        modules = Array.isArray(parsed) ? parsed : [parsed];
                        findings = modules.filter(m => {
                            const name = (m.ModuleName || '').toLowerCase();
                            const path = (m.FileName || '').toLowerCase();
                            return name.includes('onnxruntime') || name.includes('openvino') || name.includes('directml') || name.includes('tensorrt') || name.includes('migraphx') || name.includes('qnn') || name === 'dxil.dll' || name === 'dxcompiler.dll' ||
                                   path.includes('onnxruntime') || path.includes('openvino') || path.includes('directml') || path.includes('tensorrt') || path.includes('migraphx') || path.includes('qnn') || path.endsWith('\\dxil.dll') || path.endsWith('\\dxcompiler.dll');
                        });
                    } catch(e) {}
                }
            } catch(e) { console.log('[Info] PowerShell module check failed, trying tasklist...'); }

            // Attempt 2B: tasklist /M (Fallback or verification)
            // If PowerShell failed or found nothing, try tasklist which is simpler but less detailed (no version info usually)
            if (findings.length === 0) {
                 try {
                     // Check common DLL names
                     const dllNames = ['onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'openvino.dll', 'DirectML.dll', 'nvinfer.dll', 'migraphx.dll', 'QnnHtp.dll', 'dxil.dll', 'dxcompiler.dll'];

                     // tasklist /M <pattern> lists processes using it. We filter for our PID.
                     // It's faster to run: tasklist /FI "PID eq <PID>" /M
                     const tasklistCmd = `tasklist /FI "PID eq ${pid}" /M`;
                     const tasklistOut = execSync(tasklistCmd, { encoding: 'utf8' }).toLowerCase();

                     // Output format is like:
                     // Image Name                     PID Modules
                     // ========================== ======== =======================================
                     // chrome.exe                    1234 ntdll.dll, kernel32.dll, ...

                     if (tasklistOut) {
                         // Extract the specific DLL names found
                         const foundDlls = [];
                         if (tasklistOut.includes('onnxruntime')) foundDlls.push('onnxruntime.dll');
                         if (tasklistOut.includes('openvino')) foundDlls.push('openvino.dll');
                         if (tasklistOut.includes('directml')) foundDlls.push('DirectML.dll');
                         if (tasklistOut.includes('nvinfer') || tasklistOut.includes('tensorrt')) foundDlls.push('tensorrt.dll');
                         if (tasklistOut.includes('migraphx')) foundDlls.push('migraphx.dll');
                         if (tasklistOut.includes('qnn')) foundDlls.push('QnnHtp.dll');
                         if (/\bdxil\.dll\b/.test(tasklistOut)) foundDlls.push('dxil.dll');
                         if (/\bdxcompiler\.dll\b/.test(tasklistOut)) foundDlls.push('dxcompiler.dll');

                         // Create synthetic finding objects
                         findings = foundDlls.map(name => ({
                             ModuleName: name,
                             FileName: name + ' (Detected via tasklist)',
                             ProductVersion: 'Unknown'
                         }));
                     }
                 } catch(e) { console.log('[Info] tasklist check failed'); }
            }

            if (findings.length > 0) {
                 const dllsOutput = findings.map(m => {
                     return `${m.FileName} (Version: ${m.ProductVersion || 'Unknown'})`;
                 }).join('\n');

                 console.log(`[Success] ONNX Runtime/Backend DLLs found:\n${dllsOutput}`);
                 return { found: true, dlls: dllsOutput, dllCount: findings.length, modules: findings };
            } else {
                 console.log('[Warning] No ONNX Runtime/Backend DLLs found in GPU process modules');
                 return { found: false };
            }

        } catch (e) {
            console.log(`[Warning] DLL Check Attempt ${attempt + 1} failed: ${e.message}`);

            if (attempt < MAX_RETRIES) {
                attempt++;
                await new Promise(r => setTimeout(r, 2000));
            } else {
                return { found: false, error: e.message };
            }
        }
    }
  }

  async checkOnnxruntimeDlls_ListDlls(processName = 'chrome.exe', retries = 3) {
    return new Promise((resolve) => {
      console.log(`[Info] Checking for ONNX Runtime DLLs in ${processName} process... (Attempts remaining: ${retries + 1})`);

      // Construct path to Listdlls64.exe in tools folder
      // We use __dirname to be relative to src/util.js, going up to root then tools
      const toolsPath = path.join(__dirname, '..', 'tools', 'Listdlls64.exe');

      // Run Listdlls64.exe -v <processName> and filter for onnxruntime*.dll files
      // Note: Using findstr on Windows with pattern matching for .dll files
      // Use quotes around executable path to handle spaces
      const command = `"${toolsPath}" -v ${processName} | findstr /i "onnxruntime.*\\.dll"`;

      console.log(`Running command: ${command}`);
      const { exec } = require('child_process');
      exec(command, { encoding: 'utf8', timeout: 60000 }, async (error, stdout, stderr) => {
        if (error) {
           console.log(`[Warning] Error/No output checking ONNX Runtime DLLs: ${error.message}`);

           if (retries > 0) {
               console.log(`[Info] Retrying DLL check...`);
               await new Promise(r => setTimeout(r, 2000));
               resolve(this.checkOnnxruntimeDlls(processName, retries - 1));
           } else {
               resolve({ found: false, error: error.message });
           }
           return;
        }

        const output = stdout;
        if (output && output.trim()) {
           // Verify that we actually found .dll files, not just any text containing "onnxruntime"
           // Filter out "Command line:" lines which Listdlls might print if they match the grep
           const dllLines = output.trim().split('\n')
               .filter(line => line.includes('.dll') && !line.trim().startsWith('Command line:'));

           if (dllLines.length > 0) {
               console.log(`[Success] ONNX Runtime DLL files found in ${processName} process:`);
               const cleanOutput = dllLines.join('\n');
               console.log(cleanOutput);
               resolve({ found: true, dlls: cleanOutput, dllCount: dllLines.length });
           } else {
               if (retries > 0) {
                   console.log(`[Info] No DLLs found in output, retrying...`);
                   await new Promise(r => setTimeout(r, 2000));
                   resolve(this.checkOnnxruntimeDlls(processName, retries - 1));
               } else {
                   resolve({ found: false, error: 'No onnxruntime DLLs found in output' });
               }
           }
        } else {
            console.log(`[Fail] No ONNX Runtime DLL files found in ${processName} process`);
            resolve({ found: false, dlls: '', reason: 'No output from command' });
        }
      });
    });
  }

  generateHtmlReport(testSuites, testCase, results, dllCheckResults = null, wallTime = null, sumOfTestTimes = null, baselineDirName = null, browserInfo = null, runtimeInfo = null) {
    const totalSubcases = results.reduce((sum, r) => sum + r.subcases.total, 0);
    const passedSubcases = results.reduce((sum, r) => sum + r.subcases.passed, 0);
    const failedSubcases = results.reduce((sum, r) => sum + r.subcases.failed, 0);
    const passed = results.filter(r => r.result === 'PASS').length;
    const failed = results.filter(r => r.result === 'FAIL').length;
    const crashed = results.filter(r => r.result === 'CRASH').length;
    const errors = results.filter(r => r.result === 'ERROR').length;
    const skipped = results.filter(r => r.result === 'SKIP').length;

    const toSafeText = (value) => {
        const text = value == null ? '' : value.toString().trim();
        return text;
    };

    const resolveBackendName = (r) => toSafeText(
        r.configName || (r.fullConfig && r.fullConfig.name) || r.backend
    );

    const formatBackendKey = (value) => toSafeText(value)
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    // Calculate overall regressions and improvements (case-level and subcase-level)
    const allRegressions = [];
    const allImprovements = [];
    results.forEach(r => {
        const prev = r.previousResult;
        if (prev) {
            const isPass = r.result === 'PASS';
            const wasPass = prev === 'PASS';
            const backendName = formatBackendKey(resolveBackendName(r));
            const groupKey = backendName;
            if (wasPass && !isPass) {
                // Case-level regression
                allRegressions.push({ name: r.testName, result: r.result, prev, group: groupKey, backendName, type: 'case' });
            } else if (!wasPass && isPass) {
                // Case-level improvement
                allImprovements.push({ name: r.testName, result: r.result, prev, group: groupKey, backendName, type: 'case' });
            } else if (r.previousSubcases && r.subcases && r.subcases.total > 0) {
                // Same case-level result — check subcase-level changes
                const prevSc = r.previousSubcases;
                const curSc = r.subcases;
                if (prevSc.passed !== undefined && prevSc.total !== undefined) {
                    // New format: compare passed/total
                    if (curSc.passed < prevSc.passed || (curSc.passed === prevSc.passed && curSc.total > prevSc.total)) {
                        allRegressions.push({
                            name: r.testName, result: r.result, prev, group: groupKey, backendName, type: 'subcase',
                            subcaseInfo: `${prevSc.passed}/${prevSc.total} \u2192 ${curSc.passed}/${curSc.total}`
                        });
                    } else if (curSc.passed > prevSc.passed || (curSc.passed === prevSc.passed && curSc.total < prevSc.total)) {
                        allImprovements.push({
                            name: r.testName, result: r.result, prev, group: groupKey, backendName, type: 'subcase',
                            subcaseInfo: `${prevSc.passed}/${prevSc.total} \u2192 ${curSc.passed}/${curSc.total}`
                        });
                    }
                } else if (prevSc.failed !== undefined) {
                    // Old format: only failed count available from subtest detail lines
                    const curFailed = curSc.failed || 0;
                    const prevFailed = prevSc.failed || 0;
                    if (curFailed > prevFailed) {
                        allRegressions.push({
                            name: r.testName, result: r.result, prev, group: groupKey, backendName, type: 'subcase',
                            subcaseInfo: `${prevFailed} failed \u2192 ${curFailed} failed`
                        });
                    } else if (curFailed < prevFailed) {
                        allImprovements.push({
                            name: r.testName, result: r.result, prev, group: groupKey, backendName, type: 'subcase',
                            subcaseInfo: `${prevFailed} failed \u2192 ${curFailed} failed`
                        });
                    }
                }
            }
        }
    });
    const totalRegressions = allRegressions.length;
    const totalImprovements = allImprovements.length;

    // Use provided timing data or calculate from individual tests
    const displayWallTime = wallTime || results.reduce((sum, r) => sum + (parseFloat(r.executionTime) || 0), 0).toFixed(2);
    const displaySumOfTimes = sumOfTestTimes || results.reduce((sum, r) => sum + (parseFloat(r.executionTime) || 0), 0).toFixed(2);

    const suiteTitle = testSuites.length > 1 ?
      testSuites.map(s => s.toUpperCase()).join(', ') :
      testSuites[0].toUpperCase();

    const makeAnchorId = (value) => toSafeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    // Per-backend summary table shown at the top of the report.
    const backendGroups = results.reduce((acc, r) => {
        const key = formatBackendKey(resolveBackendName(r));
        if (!acc[key]) acc[key] = [];
        acc[key].push(r);
        return acc;
    }, {});

    const backendSummaryRowsHtml = Object.entries(backendGroups).map(([backendName, group]) => {
        const cases = group.length;
        const passCases = group.filter(r => r.result === 'PASS').length;
        const crashCases = group.filter(r => r.result === 'CRASH').length;
        const failCases = group.filter(r => r.result !== 'PASS' && r.result !== 'SKIP').length;
        const subcases = group.reduce((s, r) => s + (r.subcases ? r.subcases.total : 0), 0);
        const passSubcases = group.reduce((s, r) => s + (r.subcases ? r.subcases.passed : 0), 0);
        const failSubcases = group.reduce((s, r) => s + (r.subcases ? r.subcases.failed : 0), 0);
        const successRate = subcases > 0 ? ((passSubcases / subcases) * 100).toFixed(1) : '0.0';
        const detailAnchorId = `config-${makeAnchorId(backendName)}`;

        return `
        <tr>
            <td style="border: 1px solid #e1e4e8; padding: 8px 10px;"><strong><a href="#${detailAnchorId}" style="color: #0366d6; text-decoration: none;">${backendName}</a></strong></td>
            <td style="border: 1px solid #e1e4e8; padding: 8px 10px;">${cases}</td>
            <td style="border: 1px solid #e1e4e8; padding: 8px 10px; color: #28a745; font-weight: bold;">${passCases}</td>
            <td style="border: 1px solid #e1e4e8; padding: 8px 10px; color: ${failCases > 0 ? '#dc3545' : '#586069'}; font-weight: bold;">${failCases}</td>
            <td style="border: 1px solid #e1e4e8; padding: 8px 10px; color: ${crashCases > 0 ? '#b03060' : '#586069'}; font-weight: bold;">${crashCases}</td>
            <td style="border: 1px solid #e1e4e8; padding: 8px 10px;">${subcases}</td>
            <td style="border: 1px solid #e1e4e8; padding: 8px 10px; color: #28a745; font-weight: bold;">${passSubcases}</td>
            <td style="border: 1px solid #e1e4e8; padding: 8px 10px; color: ${failSubcases > 0 ? '#dc3545' : '#586069'}; font-weight: bold;">${failSubcases}</td>
            <td style="border: 1px solid #e1e4e8; padding: 8px 10px; font-weight: bold; color: ${parseFloat(successRate) >= 100 ? '#28a745' : '#24292e'};">${successRate}%</td>
        </tr>`;
    }).join('');

    const backendSummaryTableHtml = `
        <div style="margin: 0 0 20px 0; padding: 12px; background-color: #f8fbff; border: 1px solid #c8e1ff; border-radius: 8px;">
            <h3 style="margin: 0 0 10px 0; color: #0366d6;">Backend Summary</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr>
                        <th style="border: 1px solid #c8e1ff; padding: 8px 10px; text-align: left; background-color: #eaf5ff;">Backend</th>
                        <th style="border: 1px solid #c8e1ff; padding: 8px 10px; text-align: left; background-color: #eaf5ff;">Cases</th>
                        <th style="border: 1px solid #c8e1ff; padding: 8px 10px; text-align: left; background-color: #eaf5ff;">Pass</th>
                        <th style="border: 1px solid #c8e1ff; padding: 8px 10px; text-align: left; background-color: #eaf5ff;">Fail</th>
                        <th style="border: 1px solid #c8e1ff; padding: 8px 10px; text-align: left; background-color: #eaf5ff;">Crash</th>
                        <th style="border: 1px solid #c8e1ff; padding: 8px 10px; text-align: left; background-color: #eaf5ff;">Subcases</th>
                        <th style="border: 1px solid #c8e1ff; padding: 8px 10px; text-align: left; background-color: #eaf5ff;">Pass</th>
                        <th style="border: 1px solid #c8e1ff; padding: 8px 10px; text-align: left; background-color: #eaf5ff;">Fail</th>
                        <th style="border: 1px solid #c8e1ff; padding: 8px 10px; text-align: left; background-color: #eaf5ff;">Success Rate</th>
                    </tr>
                </thead>
                <tbody>
                    ${backendSummaryRowsHtml}
                </tbody>
            </table>
        </div>`;

    // Build crash details grouped by backend for summary section.
    const crashResults = results.filter(r => r.result === 'CRASH');
    const crashGroups = crashResults.reduce((acc, r) => {
        const configKey = formatBackendKey(resolveBackendName(r));
        if (!acc[configKey]) acc[configKey] = [];
        acc[configKey].push(r);
        return acc;
    }, {});

    const crashTestsByBackendHtml = crashResults.length > 0 ? `
        <div style="margin: 12px 0 20px 0; padding: 12px; background-color: #fff4fb; border: 1px solid #e3b5d5; border-radius: 8px;">
            <h4 style="margin: 0 0 10px 0; color: #b03060;">Crash Tests By Configuration (${crashResults.length})</h4>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr>
                        <th style="border: 1px solid #e3b5d5; padding: 6px 10px; text-align: left; background-color: #ffe6f3;">Configuration</th>
                        <th style="border: 1px solid #e3b5d5; padding: 6px 10px; text-align: left; background-color: #ffe6f3;">Test Case</th>
                        <th style="border: 1px solid #e3b5d5; padding: 6px 10px; text-align: left; background-color: #ffe6f3;">Message</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.entries(crashGroups).map(([configName, items]) => items.map((item, idx) => `
                    <tr>
                        <td style="border: 1px solid #f2cfe3; padding: 6px 10px; vertical-align: top;">${idx === 0 ? `<strong>${configName}</strong> (${items.length})` : ''}</td>
                        <td style="border: 1px solid #f2cfe3; padding: 6px 10px;">${item.testName || item.fileName || 'unknown'}</td>
                        <td style="border: 1px solid #f2cfe3; padding: 6px 10px; color: #5f2120;">${(item.error || '').toString().slice(0, 500) || '-'}</td>
                    </tr>`).join('')).join('')}
                </tbody>
            </table>
        </div>` : '';

    // Device Info (CPU, GPU, NPU)
    let deviceInfoHtml = '';

    // Browser Info
    if (browserInfo) {
        deviceInfoHtml += `
        <div style="background-color: #fff3e0; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ffcc80;">
            <h3 style="margin-top: 0; color: #e65100;">Browser Information</h3>
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center;">
                <div style="font-weight: bold; color: #bf360c;">Name:</div>
                <div>${browserInfo.name}</div>
                <div style="font-weight: bold; color: #bf360c;">Channel:</div>
                <div>${browserInfo.channel}</div>
                <div style="font-weight: bold; color: #bf360c;">Version:</div>
                <div>${browserInfo.version}</div>
            </div>
        </div>`;
    }

    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
    const runtimeRows = runtimeInfoRows(runtimeInfo || getRuntimeInfo(dllCheckResults));
    deviceInfoHtml += `
        <div style="background-color: #e0f7fa; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #80deea;">
            <h3 style="margin-top: 0; color: #006064;">Runtime Information</h3>
            <div style="display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: center;">
                ${runtimeRows.map(([label, value]) => `
                <div style="font-weight: bold; color: #00838f;">${escapeHtml(label)}:</div>
                <div style="white-space: pre-wrap; overflow-wrap: anywhere;">${escapeHtml(value)}</div>
                `).join('')}
            </div>
        </div>`;

    // CPU Info (if any test ran on cpu)
    const hasCpuTest = results.some(r => r.device === 'cpu');
    if (hasCpuTest) {
        const cpuName = get_cpu_info();
        deviceInfoHtml += `
        <div style="background-color: #e8f5e9; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #a5d6a7;">
            <h3 style="margin-top: 0; color: #2e7d32;">CPU Information</h3>
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center;">
                <div style="font-weight: bold; color: #1b5e20;">CPU Name:</div>
                <div>${cpuName}</div>
            </div>
        </div>`;
    }

    // GPU Info (if any test ran on gpu)
    const hasGpuTest = results.some(r => r.device === 'gpu');
    if (hasGpuTest) {
        let gpuName = 'Unknown GPU';
        let gpuDriverDate = '';
        let gpuDriverVer = '';
        try {
            const info = get_gpu_info();
            if (info.name) {
                gpuName = info.name;
                gpuDriverDate = info.driver_date;
                gpuDriverVer = info.driver_ver;
            }
        } catch (e) {
            console.log('[Warning] Could not retrieve GPU info:', e.message);
        }

        deviceInfoHtml += `
        <div style="background-color: #e3f2fd; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #90caf9;">
            <h3 style="margin-top: 0; color: #0d47a1;">GPU Information</h3>
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center;">
                <div style="font-weight: bold; color: #1565c0;">GPU Name:</div>
                <div>${gpuName}</div>
                <div style="font-weight: bold; color: #1565c0;">Driver Date:</div>
                <div>${gpuDriverDate}</div>
                <div style="font-weight: bold; color: #1565c0;">Driver Version:</div>
                <div>${gpuDriverVer}</div>
            </div>
        </div>`;
    }

    // NPU Info
    {
        let npuName = 'Unknown NPU';
        let npuDriverVer = '';
        let npuDriverDate = '';
        try {
             const info = get_npu_info();
             // get_npu_info returns object { name, driver_ver, driver_date } or string (old behavior backup)
             if (typeof info === 'string') {
                 if (info !== 'Unknown NPU') npuName = info;
             } else if (info && info.name) {
                 npuName = info.name;
                 npuDriverVer = info.driver_ver;
                 npuDriverDate = info.driver_date;
             }
        } catch(e) {
             console.log('[Warning] Could not retrieve NPU info:', e.message);
        }

        if (npuName !== 'Unknown NPU') {
            deviceInfoHtml += `
            <div style="background-color: #f3e5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ce93d8;">
                <h3 style="margin-top: 0; color: #7b1fa2;">NPU Information</h3>
                 <div style="display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center;">
                    <div style="font-weight: bold; color: #4a148c;">NPU Name:</div>
                    <div>${npuName}</div>
                    ${npuDriverDate ? `<div style="font-weight: bold; color: #4a148c;">Driver Date:</div><div>${npuDriverDate}</div>` : ''}
                    ${npuDriverVer ? `<div style="font-weight: bold; color: #4a148c;">Driver Version:</div><div>${npuDriverVer}</div>` : ''}
                </div>
            </div>`;
        } else {
            deviceInfoHtml += `
            <div style="background-color: #f3e5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ce93d8;">
                <h3 style="margin-top: 0; color: #7b1fa2;">NPU Information</h3>
                <div>None</div>
            </div>`;
        }
    }

    const reportHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>WebNN Test Report - ${suiteTitle}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; }
        .header { background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .summary { margin-bottom: 20px; }
        .stat-card { background-color: white; border: 1px solid #e1e4e8; border-radius: 6px; padding: 15px; text-align: center; display: inline-block; margin: 5px; min-width: 150px; }
        .stat-number { font-size: 24px; font-weight: bold; margin-bottom: 5px; }
        .stat-label { color: #586069; font-size: 14px; }
        .pass { color: #28a745; } .fail { color: #dc3545; } .error { color: #fd7e14; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; }
        th { background-color: #f6f8fa; font-weight: 600; }
        .status-pass { color: #28a745; font-weight: bold; }
        .status-fail { color: #dc3545; font-weight: bold; }
        .status-error { color: #fd7e14; font-weight: bold; }
        .details { margin-top: 20px; }
        .case-details { margin: 15px 0; padding: 15px; border: 1px solid #e1e4e8; border-radius: 6px; }
        .subcase { margin: 5px 0; padding: 5px; background-color: #f8f9fa; border-radius: 3px; }
    </style>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background-color: #ffffff;">
    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e1e4e8;">
        <h1 style="margin: 0; color: #24292e;">WebNN Test Report</h1>
    </div>

    ${deviceInfoHtml}

    ${backendSummaryTableHtml}

    ${crashTestsByBackendHtml}

    <div style="margin-bottom: 20px;">
        ${baselineDirName && (totalRegressions > 0 || totalImprovements > 0) ? `
        <div style="margin-bottom: 15px; padding: 12px; background-color: #e3f2fd; border-left: 4px solid #2196f3; border-radius: 4px; font-size: 14px;">
            <strong>Baseline Comparison:</strong> Comparing against results from <code>${baselineDirName}</code>
        </div>
        <div style="margin-bottom: 20px;">
            ${totalRegressions > 0 ? `
            <div style="margin-bottom: 12px; padding: 15px; background-color: #fff5f5; border: 1px solid #f5c6cb; border-radius: 8px;">
                <h4 style="margin: 0 0 10px 0; color: #dc3545;">\u25BC Regressions (${totalRegressions})</h4>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead>
                        <tr>
                            <th style="border: 1px solid #f5c6cb; padding: 6px 10px; text-align: left; background-color: #ffe0e0;">Backend</th>
                            <th style="border: 1px solid #f5c6cb; padding: 6px 10px; text-align: left; background-color: #ffe0e0;">Test Case</th>
                            <th style="border: 1px solid #f5c6cb; padding: 6px 10px; text-align: left; background-color: #ffe0e0;">Baseline</th>
                            <th style="border: 1px solid #f5c6cb; padding: 6px 10px; text-align: left; background-color: #ffe0e0;">Current</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${allRegressions.map(t => `
                        <tr>
                            <td style="border: 1px solid #f5c6cb; padding: 6px 10px; color: #586069;">${t.backendName || '-'}</td>
                            <td style="border: 1px solid #f5c6cb; padding: 6px 10px;"><strong>${t.name}</strong>${t.type === 'subcase' ? ' <span style="font-size:11px;color:#856404;">[subcase]</span>' : ''}</td>
                            <td style="border: 1px solid #f5c6cb; padding: 6px 10px; color: #28a745; font-weight: bold;">${t.prev}${t.subcaseInfo ? ` <span style="font-size:12px;font-weight:normal;">(${t.subcaseInfo.split(' \u2192 ')[0]})</span>` : ''}</td>
                            <td style="border: 1px solid #f5c6cb; padding: 6px 10px; color: #dc3545; font-weight: bold;">${t.result}${t.subcaseInfo ? ` <span style="font-size:12px;font-weight:normal;">(${t.subcaseInfo.split(' \u2192 ')[1]})</span>` : ''}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            ` : ''}
            ${totalImprovements > 0 ? `
            <div style="margin-bottom: 12px; padding: 15px; background-color: #f0fff4; border: 1px solid #c3e6cb; border-radius: 8px;">
                <h4 style="margin: 0 0 10px 0; color: #28a745;">\u25B2 Improvements (${totalImprovements})</h4>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead>
                        <tr>
                            <th style="border: 1px solid #c3e6cb; padding: 6px 10px; text-align: left; background-color: #d4edda;">Backend</th>
                            <th style="border: 1px solid #c3e6cb; padding: 6px 10px; text-align: left; background-color: #d4edda;">Test Case</th>
                            <th style="border: 1px solid #c3e6cb; padding: 6px 10px; text-align: left; background-color: #d4edda;">Baseline</th>
                            <th style="border: 1px solid #c3e6cb; padding: 6px 10px; text-align: left; background-color: #d4edda;">Current</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${allImprovements.map(t => `
                        <tr>
                            <td style="border: 1px solid #c3e6cb; padding: 6px 10px; color: #586069;">${t.backendName || '-'}</td>
                            <td style="border: 1px solid #c3e6cb; padding: 6px 10px;"><strong>${t.name}</strong>${t.type === 'subcase' ? ' <span style="font-size:11px;color:#856404;">[subcase]</span>' : ''}</td>
                            <td style="border: 1px solid #c3e6cb; padding: 6px 10px; color: #dc3545; font-weight: bold;">${t.prev}${t.subcaseInfo ? ` <span style="font-size:12px;font-weight:normal;">(${t.subcaseInfo.split(' \u2192 ')[0]})</span>` : ''}</td>
                            <td style="border: 1px solid #c3e6cb; padding: 6px 10px; color: #28a745; font-weight: bold;">${t.result}${t.subcaseInfo ? ` <span style="font-size:12px;font-weight:normal;">(${t.subcaseInfo.split(' \u2192 ')[1]})</span>` : ''}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            ` : ''}
        </div>
        ` : ''}

        <h3>Summary</h3>
        <table style="width: 100%; border-collapse: separate; border-spacing: 12px; margin-bottom: 20px;">
            <tr>
                <td style="text-align: center; padding: 20px; background-color: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); width: 33%;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #24292e;">${results.length}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Total Cases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); width: 33%;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #24292e;">${totalSubcases}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Total Subcases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); width: 33%;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${((passedSubcases/totalSubcases)*100) >= 100 ? '#28a745' : '#24292e'};">${Math.floor(((passedSubcases/totalSubcases)*100)*10)/10}%</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Success Rate</div>
                </td>
            </tr>
            <tr>
                <td style="text-align: center; padding: 20px; background-color: #f0fff4; border: 1px solid #c3e6cb; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #28a745;">${passed}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Passed Cases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: #f0fff4; border: 1px solid #c3e6cb; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #28a745;">${passedSubcases}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Passed Subcases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #586069;">${displayWallTime}s</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Wall Time</div>
                </td>
            </tr>
            <tr>
                <td style="text-align: center; padding: 20px; background-color: ${failed > 0 ? '#fff5f5' : '#ffffff'}; border: 1px solid ${failed > 0 ? '#f5c6cb' : '#e1e4e8'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${failed > 0 ? '#dc3545' : '#586069'};">${failed}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Failed Cases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: ${failedSubcases > 0 ? '#fff5f5' : '#ffffff'}; border: 1px solid ${failedSubcases > 0 ? '#f5c6cb' : '#e1e4e8'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${failedSubcases > 0 ? '#dc3545' : '#586069'};">${failedSubcases}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Failed Subcases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #586069;">${displaySumOfTimes}s</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Sum of Test Times</div>
                </td>
            </tr>
            <tr>
                <td style="text-align: center; padding: 20px; background-color: ${crashed > 0 ? '#fff4fb' : '#ffffff'}; border: 1px solid ${crashed > 0 ? '#e3b5d5' : '#e1e4e8'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${crashed > 0 ? '#b03060' : '#586069'};">${crashed}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Crash Cases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: ${errors > 0 ? '#fff8f0' : '#ffffff'}; border: 1px solid ${errors > 0 ? '#ffd8a8' : '#e1e4e8'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${errors > 0 ? '#fd7e14' : '#586069'};">${errors}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Error Cases</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: ${skipped > 0 ? '#f8f9fa' : '#ffffff'}; border: 1px solid ${skipped > 0 ? '#ced4da' : '#e1e4e8'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${skipped > 0 ? '#6c757d' : '#586069'};">${skipped}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Skipped Cases</div>
                </td>
            </tr>
            ${baselineDirName ? `
            <tr>
                <td style="text-align: center; padding: 20px; background-color: ${totalRegressions > 0 ? '#fff5f5' : '#ffffff'}; border: 1px solid ${totalRegressions > 0 ? '#f5c6cb' : '#e1e4e8'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${totalRegressions > 0 ? '#dc3545' : '#586069'};">${totalRegressions}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">\u25BC Regressions</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: ${totalImprovements > 0 ? '#f0fff4' : '#ffffff'}; border: 1px solid ${totalImprovements > 0 ? '#c3e6cb' : '#e1e4e8'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: ${totalImprovements > 0 ? '#28a745' : '#586069'};">${totalImprovements}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">\u25B2 Improvements</div>
                </td>
                <td style="text-align: center; padding: 20px; background-color: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: #586069;">${results.filter(r => r.previousResult).length}</div>
                    <div style="color: #586069; font-size: 14px; font-weight: 500;">Baseline Matched</div>
                </td>
            </tr>
            ` : ''}
        </table>

    </div>

    <h3>Detailed Test Results</h3>
    ${(() => {
        const resultsByConfig = {};
        results.forEach(r => {
            const cName = r.configName || 'Default';
            // Group by Config + Device (and backend/framework to be safe for unique tables)
            // Using signature parts ensures separation requested
            const device = toSafeText(r.deviceName || r.device).toLowerCase();
            const framework = toSafeText(r.framework).toLowerCase();
            const backend = toSafeText(r.backend).toLowerCase();

            const key = `${cName}::${framework}::${backend}::${device}`;

            if (!resultsByConfig[key]) resultsByConfig[key] = [];
            resultsByConfig[key].push(r);
        });

        // Preserve execution order: sort by the first configIndex seen in each group
        const sortedKeys = Object.keys(resultsByConfig).sort((a, b) => {
            const idxA = resultsByConfig[a][0].configIndex ?? 0;
            const idxB = resultsByConfig[b][0].configIndex ?? 0;
            return idxA - idxB;
        });

        return sortedKeys.map(key => {
            const groupResults = resultsByConfig[key];
            const [configName, framework, backend, device] = key.split('::');

            // Find matching DLL info
            let dllDisplayHtml = '';
            if (Array.isArray(dllCheckResults)) {
                let dllItem = dllCheckResults.find(d =>
                    d.configName === configName &&
                    d.framework === framework &&
                    d.backend === backend &&
                    d.device === device
                );

                // Fallback 1: Ignore device specifier (often varies by naming resolution)
                if (!dllItem) {
                     dllItem = dllCheckResults.find(d =>
                        d.configName === configName &&
                        d.framework === framework &&
                        d.backend === backend
                     );
                }

                // Fallback 2: Match by Config Name only (most robust)
                if (!dllItem) {
                    dllItem = dllCheckResults.find(d => d.configName === configName);
                }

                if (dllItem) {
                    if (dllItem.dllInfo && dllItem.dllInfo.found) {
                         dllDisplayHtml = `
                         <div style="margin: 10px 0 20px 0; padding: 10px; border: 1px solid #c8e1ff; border-radius: 6px; background-color: #f1f8ff; font-size: 14px;">
                            <h4 style="margin: 0 0 10px 0; color: #0366d6;">DLL Detection Details</h4>
                            <div style="background-color: white; padding: 10px; border: 1px solid #e1e4e8; border-radius: 4px;">
                                 <div style="margin-bottom: 5px; font-weight: 500;">DLLs Loaded in GPU Process (${dllItem.dllInfo.dllCount}):</div>
                                 <pre style="background-color: #f6f8fa; padding: 8px; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 11px; margin: 0; border: 1px solid #eaecef;">${dllItem.dllInfo.dlls}</pre>
                            </div>
                         </div>`;
                    } else {
                         dllDisplayHtml = `
                         <div style="margin: 10px 0 20px 0; padding: 10px; border: 1px solid #f5c6cb; border-radius: 6px; background-color: #fff5f5; font-size: 14px;">
                            <h4 style="margin: 0 0 10px 0; color: #d73a49;">DLL Detection Details</h4>
                            <div style="color: #24292e;">No specific backend DLLs detected in GPU process.</div>
                            ${dllItem.dllInfo && (dllItem.dllInfo.reason || dllItem.dllInfo.error) ? `<div style="margin-top: 5px; color: #586069;">Reason: ${dllItem.dllInfo.reason || dllItem.dllInfo.error}</div>` : ''}
                         </div>`;
                    }
                }
            }

            // Extract configuration info for display
            // Since a group might contain results from multiple split configs (e.g. diff devices),
            // we should collect unique values.
            const uniqueConfigValues = (key) => {
                const values = [...new Set(groupResults.map(r => r.fullConfig ? r.fullConfig[key] : null).filter(v => v !== null && v !== ''))];
                return values.length > 0 ? values.join(', ') : 'N/A';
            };

            const suiteStr = uniqueConfigValues('suite');
            const deviceStr = uniqueConfigValues('device');
            const argsStr = uniqueConfigValues('browserArgs');
            const wptCaseStr = uniqueConfigValues('wptCase');
            const modelCaseStr = uniqueConfigValues('modelCase');

            // Calculate Group Summary
            const groupTotal = groupResults.length;
            const groupPassed = groupResults.filter(r => r.result === 'PASS').length;
            const groupFailed = groupResults.filter(r => r.result === 'FAIL').length;
            const groupCrashed = groupResults.filter(r => r.result === 'CRASH').length;
            const groupErrors = groupResults.filter(r => r.result === 'ERROR').length;
            const groupSkipped = groupResults.filter(r => r.result === 'SKIP').length;
            const groupTotalSubcases = groupResults.reduce((s,r)=>s+r.subcases.total,0);
            const groupPassedSubcases = groupResults.reduce((s,r)=>s+r.subcases.passed,0);
            const groupFailedSubcases = groupResults.reduce((s,r)=>s+r.subcases.failed,0);
            const successRate = groupTotalSubcases > 0 ? ((groupPassedSubcases / groupTotalSubcases) * 100).toFixed(1) : '0.0';

            // Calculate Trends (case-level and subcase-level)
            const regressionTests = [];
            const improvementTests = [];
            groupResults.forEach(r => {
                const prev = r.previousResult;
                if (prev) {
                    const isPass = r.result === 'PASS';
                    const wasPass = prev === 'PASS';
                    if (wasPass && !isPass) {
                        regressionTests.push({ name: r.testName, result: r.result, prev, type: 'case' });
                    } else if (!wasPass && isPass) {
                        improvementTests.push({ name: r.testName, result: r.result, prev, type: 'case' });
                    } else if (r.previousSubcases && r.subcases && r.subcases.total > 0) {
                        const prevSc = r.previousSubcases;
                        const curSc = r.subcases;
                        if (prevSc.passed !== undefined && prevSc.total !== undefined) {
                            if (curSc.passed < prevSc.passed || (curSc.passed === prevSc.passed && curSc.total > prevSc.total)) {
                                regressionTests.push({ name: r.testName, result: r.result, prev, type: 'subcase', subcaseInfo: `${prevSc.passed}/${prevSc.total} \u2192 ${curSc.passed}/${curSc.total}` });
                            } else if (curSc.passed > prevSc.passed || (curSc.passed === prevSc.passed && curSc.total < prevSc.total)) {
                                improvementTests.push({ name: r.testName, result: r.result, prev, type: 'subcase', subcaseInfo: `${prevSc.passed}/${prevSc.total} \u2192 ${curSc.passed}/${curSc.total}` });
                            }
                        } else if (prevSc.failed !== undefined) {
                            const curFailed = curSc.failed || 0;
                            const prevFailed = prevSc.failed || 0;
                            if (curFailed > prevFailed) {
                                regressionTests.push({ name: r.testName, result: r.result, prev, type: 'subcase', subcaseInfo: `${prevFailed} failed \u2192 ${curFailed} failed` });
                            } else if (curFailed < prevFailed) {
                                improvementTests.push({ name: r.testName, result: r.result, prev, type: 'subcase', subcaseInfo: `${prevFailed} failed \u2192 ${curFailed} failed` });
                            }
                        }
                    }
                }
            });
            const groupRegressions = regressionTests.length;
            const groupImprovements = improvementTests.length;

            const groupSummaryHtml = `
            <div style="display: flex; gap: 15px; margin-bottom: 15px; font-size: 14px; background-color: #fff; padding: 12px; border: 1px solid #e1e4e8; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                 <div style="font-weight: bold; color: #24292e;">Cases: ${groupTotal}</div>
                 <div style="font-weight: bold; color: #28a745;">Pass: ${groupPassed}</div>
                 <div style="font-weight: bold; color: #dc3545;">Fail: ${groupFailed}</div>
                  ${groupCrashed > 0 ? `<div style="font-weight: bold; color: #b03060;">Crash: ${groupCrashed}</div>` : ''}
                 ${groupErrors > 0 ? `<div style="font-weight: bold; color: #fd7e14;">Error: ${groupErrors}</div>` : ''}
                 ${groupSkipped > 0 ? `<div style="font-weight: bold; color: #6c757d;">Skip: ${groupSkipped}</div>` : ''}
                 <div style="width: 1px; background-color: #e1e4e8; margin: 0 5px;"></div>

                 ${groupRegressions > 0 ? `<div style="font-weight: bold; color: #dc3545;">Regressions: ${groupRegressions}</div>` : ''}
                 ${groupImprovements > 0 ? `<div style="font-weight: bold; color: #28a745;">Improvements: ${groupImprovements}</div>` : ''}
                 ${(groupRegressions > 0 || groupImprovements > 0) ? `<div style="width: 1px; background-color: #e1e4e8; margin: 0 5px;"></div>` : ''}

                 <div style="font-weight: bold; color: #24292e;">Subcases: ${groupTotalSubcases}</div>
                 <div style="font-weight: bold; color: #28a745;">Pass: ${groupPassedSubcases}</div>
                 <div style="font-weight: bold; color: #dc3545;">Fail: ${groupFailedSubcases}</div>
                 <div style="width: 1px; background-color: #e1e4e8; margin: 0 5px;"></div>
                 <div style="font-weight: bold; color: ${successRate >= 100 ? '#28a745' : '#24292e'};">Success Rate: ${successRate}%</div>
            </div>`;

            let changesHtml = '';
            if (groupRegressions > 0 || groupImprovements > 0) {
                changesHtml += '<div style="margin-bottom: 20px;">';
                if (groupRegressions > 0) {
                    changesHtml += `
                    <div style="margin-bottom: 10px; padding: 10px; background-color: #fff5f5; border: 1px solid #f5c6cb; border-radius: 6px;">
                        <strong style="color: #dc3545;">▼ Regressions (${groupRegressions}):</strong>
                        <ul style="margin: 5px 0 0 0; padding-left: 20px; font-size: 13px; color: #24292e; max-height: 150px; overflow-y: auto;">
                            ${regressionTests.map(t => `<li><strong>${t.name}</strong>${t.type === 'subcase' ? ' <span style="font-size:11px;color:#856404;">[subcase]</span>' : ''} <span style="color: #666; font-size: 0.9em;">${t.subcaseInfo ? `(${t.subcaseInfo})` : `(${t.prev} &#8594; ${t.result})`}</span></li>`).join('')}
                        </ul>
                    </div>`;
                }
                if (groupImprovements > 0) {
                     changesHtml += `
                    <div style="margin-bottom: 10px; padding: 10px; background-color: #f0fff4; border: 1px solid #c3e6cb; border-radius: 6px;">
                        <strong style="color: #28a745;">▲ Improvements (${groupImprovements}):</strong>
                        <ul style="margin: 5px 0 0 0; padding-left: 20px; font-size: 13px; color: #24292e; max-height: 150px; overflow-y: auto;">
                            ${improvementTests.map(t => `<li><strong>${t.name}</strong>${t.type === 'subcase' ? ' <span style="font-size:11px;color:#856404;">[subcase]</span>' : ''} <span style="color: #666; font-size: 0.9em;">${t.subcaseInfo ? `(${t.subcaseInfo})` : `(${t.prev} &#8594; ${t.result})`}</span></li>`).join('')}
                        </ul>
                    </div>`;
                }
                changesHtml += '</div>';
            }

            let configDisplay = `
            <div style="background-color: #f1f8ff; border: 1px solid #c8e1ff; padding: 10px; border-radius: 6px; margin: 10px 0 20px 0; font-size: 14px;">
                <h4 style="margin: 0 0 10px 0; color: #0366d6;">Configuration Details</h4>
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px;">
                    <div style="font-weight: bold; color: #24292e;">Suite:</div><div>${suiteStr.toUpperCase()}</div>
                    <div style="font-weight: bold; color: #24292e;">Device:</div><div>${deviceStr}</div>
                    ${argsStr !== 'N/A' ? `<div style="font-weight: bold; color: #24292e;">Browser Args:</div><div style="font-family: monospace; background-color: #fafbfc; padding: 2px 4px; border-radius: 3px;">${argsStr}</div>` : ''}
                    ${wptCaseStr !== 'N/A' ? `<div style="font-weight: bold; color: #24292e;">WPT Case:</div><div>${wptCaseStr}</div>` : ''}
                     ${modelCaseStr !== 'N/A' ? `<div style="font-weight: bold; color: #24292e;">Model Case:</div><div>${modelCaseStr}</div>` : ''}
                </div>
            </div>`;

            const configSectionAnchorId = `config-${makeAnchorId(configName)}`;

            return `
            <div id="${configSectionAnchorId}" style="border: 2px solid #e1e4e8; border-radius: 8px; padding: 20px; margin-bottom: 40px; background-color: #ffffff; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
                <h3 style="margin-top: 0; padding-bottom: 15px; border-bottom: 1px solid #e1e4e8; color: #24292e;">${configName}</h3>
                ${configDisplay}
                ${dllDisplayHtml}
                ${groupSummaryHtml}
                ${changesHtml}
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-family: sans-serif;">
                    <thead>
                        <tr>
                            <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Device</th>
                            <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Suite</th>
                            <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Case</th>
                            <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Status</th>
                            <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Trend</th>
                            <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Passed Subcases</th>
                            <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Failed Subcases</th>
                            <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Total Subcases</th>
                            <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Success Rate</th>
                            <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Retries</th>
                            <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Execution Time</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${groupResults.map(result => {
                          const retryCount = result.retryHistory ? result.retryHistory.length - 1 : 0;
                          const retryInfo = retryCount > 0 ? `${retryCount} retry(ies)` : 'No retries';
                          const statusColor = result.result === 'PASS' ? '#28a745' :
                                              result.result === 'FAIL' ? '#dc3545' :
                                              result.result === 'CRASH' ? '#b03060' :
                                              result.result === 'TIMEOUT' ? '#ff8c00' :
                                              result.result === 'SKIP' ? '#6c757d' : '#fd7e14';
                          const statusStyle = `color: ${statusColor}; font-weight: bold;`;
                          const baseTdStyle = "border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;";

                          const prev = result.previousResult;
                          let trendHtml = '';
                          if (prev) {
                              const isPass = result.result === 'PASS';
                              const wasPass = prev === 'PASS';

                              if (wasPass && !isPass) {
                                  trendHtml = '<span style="color: #dc3545; font-weight: bold;">▼ REGRESSION</span>';
                              } else if (!wasPass && isPass) {
                                  trendHtml = '<span style="color: #28a745; font-weight: bold;">▲ IMPROVEMENT</span>';
                              } else if (result.previousSubcases && result.subcases && result.subcases.total > 0) {
                                  // Check subcase-level changes
                                  const prevSc = result.previousSubcases;
                                  const curSc = result.subcases;
                                  let subcaseChange = null;
                                  if (prevSc.passed !== undefined && prevSc.total !== undefined) {
                                      if (curSc.passed < prevSc.passed || (curSc.passed === prevSc.passed && curSc.total > prevSc.total)) {
                                          subcaseChange = { dir: 'regression', info: `${prevSc.passed}/${prevSc.total} \u2192 ${curSc.passed}/${curSc.total}` };
                                      } else if (curSc.passed > prevSc.passed || (curSc.passed === prevSc.passed && curSc.total < prevSc.total)) {
                                          subcaseChange = { dir: 'improvement', info: `${prevSc.passed}/${prevSc.total} \u2192 ${curSc.passed}/${curSc.total}` };
                                      }
                                  } else if (prevSc.failed !== undefined) {
                                      const curFailed = curSc.failed || 0;
                                      const prevFailed = prevSc.failed || 0;
                                      if (curFailed > prevFailed) {
                                          subcaseChange = { dir: 'regression', info: `${prevFailed} failed \u2192 ${curFailed} failed` };
                                      } else if (curFailed < prevFailed) {
                                          subcaseChange = { dir: 'improvement', info: `${prevFailed} failed \u2192 ${curFailed} failed` };
                                      }
                                  }
                                  if (subcaseChange) {
                                      if (subcaseChange.dir === 'regression') {
                                          trendHtml = `<span style="color: #dc3545; font-weight: bold;">▼ REGRESSION</span><br><span style="font-size:11px;color:#856404;">[subcase: ${subcaseChange.info}]</span>`;
                                      } else {
                                          trendHtml = `<span style="color: #28a745; font-weight: bold;">▲ IMPROVEMENT</span><br><span style="font-size:11px;color:#856404;">[subcase: ${subcaseChange.info}]</span>`;
                                      }
                                  } else if (prev !== result.result) {
                                      trendHtml = `<span style="color: #586069; font-size: 0.9em;">${prev} \u2192 ${result.result}</span>`;
                                  } else {
                                      trendHtml = '<span style="color: #ccc;">-</span>';
                                  }
                              } else if (prev !== result.result) {
                                  trendHtml = `<span style="color: #586069; font-size: 0.9em;">${prev} \u2192 ${result.result}</span>`;
                              } else {
                                  trendHtml = '<span style="color: #ccc;">-</span>';
                              }
                          } else {
                              trendHtml = '<span style="color: #ccc;">-</span>';
                          }

                          // Generate failed subtests HTML if available
                          const failedSubtestsHtml = result.failedSubtests && result.failedSubtests.length > 0 ? `
                                    <br><details style="margin-top: 5px;">
                                        <summary style="cursor: pointer; color: #dc3545; font-size: 12px; font-weight: bold;">View Failed Subtests (${result.failedSubtests.length})</summary>
                                        <div style="margin-top: 5px; padding: 10px; background-color: #fff5f5; border-radius: 4px; border: 1px solid #f5c6cb; max-height: 400px; overflow-y: auto;">
                                            ${result.failedSubtests.map((subtest, idx) => `
                                                <div style="margin: 8px 0; padding: 8px; background-color: #fff; border-left: 3px solid #dc3545; border-radius: 2px;">
                                                    <div style="font-size: 12px; font-weight: bold; color: #24292e; word-break: break-word;">${idx + 1}. ${subtest.name}</div>
                                                    ${subtest.status && subtest.status !== 'FAIL' ? `<div style="font-size: 11px; color: #fd7e14; margin-top: 2px;">Status: ${subtest.status}</div>` : ''}
                                                    ${subtest.message ? `<div style="font-size: 11px; color: #586069; margin-top: 4px; font-family: monospace; white-space: pre-wrap; word-break: break-word; background-color: #f6f8fa; padding: 4px; border-radius: 2px;">${subtest.message}</div>` : ''}
                                                </div>
                                            `).join('')}
                                        </div>
                                    </details>
                                    ` : '';

                          return `
                            <tr>
                                <td style="${baseTdStyle}"><strong>${(result.device || 'N/A').toUpperCase()}</strong></td>
                                <td style="${baseTdStyle}"><strong>${(result.suite || 'N/A').toUpperCase()}</strong></td>
                                <td style="${baseTdStyle}">
                                    <strong>${result.testName}</strong>
                                    ${result.testUrl ? `<br><small><a href="${result.testUrl}" target="_blank" style="color: #0366d6;">${result.testUrl}</a></small>` : ''}
                                    ${result.details && !result.details.includes('Exception') ? `<br><div style="margin-top:4px; font-size: 0.9em; color: #24292e; background-color: #e6ffed; padding: 5px; border-left: 3px solid #28a745; border-radius: 2px;">${result.details}</div>` : ''}
                                    ${result.fullText && result.hasErrors ? `<br><div style="margin-top:4px; font-size: 0.9em; color: #a00; background-color: #fff0f0; padding: 5px; border-left: 3px solid #a00; border-radius: 2px;">${result.fullText}</div>` : ''}
                                    ${failedSubtestsHtml}
                                    ${result.retryHistory && result.retryHistory.length > 1 ? `
                                    <br><details style="margin-top: 5px;">
                                        <summary style="cursor: pointer; color: #0366d6; font-size: 12px;">View Retry History (${retryCount} attempts)</summary>
                                        <div style="margin-top: 5px; padding: 10px; background-color: #f6f8fa; border-radius: 4px;">
                                            ${result.retryHistory.map((attempt, idx) => `
                                                <div style="margin: 3px 0; font-size: 11px;">
                                                    <strong>${idx === 0 ? 'Initial Run' : 'Retry ' + idx}:</strong>
                                                    <span style="color: ${attempt.status === 'PASS' ? '#28a745' : attempt.status === 'FAIL' ? '#dc3545' : '#fd7e14'}; font-weight: bold;">${attempt.status}</span>
                                                    (${attempt.passed}/${attempt.total} passed, ${attempt.failed} failed)
                                                </div>
                                            `).join('')}
                                        </div>
                                    </details>
                                    ` : ''}
                                </td>
                                <td style="${baseTdStyle} ${statusStyle}">${result.result}</td>
                                <td style="${baseTdStyle}">${trendHtml}</td>
                                <td style="${baseTdStyle} color: #28a745;"><strong>${result.subcases.passed}</strong></td>
                                <td style="${baseTdStyle} color: #dc3545;"><strong>${result.subcases.failed}</strong></td>
                                <td style="${baseTdStyle}"><strong>${result.subcases.total}</strong></td>
                                <td style="${baseTdStyle}"><strong>${result.subcases.total > 0 ? ((result.subcases.passed/result.subcases.total)*100).toFixed(1) : 0}%</strong></td>
                                <td style="${baseTdStyle} font-size: 12px; color: #586069;">${retryInfo}</td>
                                <td style="${baseTdStyle}"><strong>${result.executionTime ? result.executionTime + 's' : 'N/A'}</strong></td>
                            </tr>
                            ${result.perfMetrics && Object.keys(result.perfMetrics).length > 0 ? `
                            <tr style="background-color: #f0f7ff;">
                                <td colspan="10" style="border: 1px solid #e1e4e8; padding: 4px 12px 8px 24px; font-size: 12px;">
                                    <details>
                                        <summary style="cursor: pointer; color: #0366d6; font-weight: 600;">WebNN Perf Metrics</summary>
                                        <table style="margin-top: 6px; border-collapse: collapse; font-size: 12px; width: auto;">
                                            <thead><tr>
                                                <th style="border: 1px solid #ddd; padding: 4px 8px; background: #f6f8fa; text-align: left;">Phase</th>
                                                <th style="border: 1px solid #ddd; padding: 4px 8px; background: #f6f8fa; text-align: right;">Duration (ms)</th>
                                                <th style="border: 1px solid #ddd; padding: 4px 8px; background: #f6f8fa; text-align: left;">Notes</th>
                                            </tr></thead>
                                            <tbody>${(() => {
                                                const pm = result.perfMetrics;
                                                let rows = '';
                                                for (const [phase, data] of Object.entries(pm)) {
                                                    if (Array.isArray(data)) {
                                                        const durations = data.map(d => d.durationMs).filter(d => typeof d === 'number');
                                                        const avg = durations.length > 0 ? (durations.reduce((a,b) => a+b, 0) / durations.length).toFixed(1) : 'N/A';
                                                        const models = [...new Set(data.map(d => d.model).filter(Boolean))];
                                                        const notes = durations.length + ' calls, avg ' + avg + 'ms' + (models.length > 0 ? ' (' + models.join(', ') + ')' : '');
                                                        rows += '<tr><td style="border:1px solid #ddd;padding:4px 8px;">' + phase + '</td>';
                                                        rows += '<td style="border:1px solid #ddd;padding:4px 8px;text-align:right;">' + avg + '</td>';
                                                        rows += '<td style="border:1px solid #ddd;padding:4px 8px;color:#586069;">' + notes + '</td></tr>';
                                                    } else {
                                                        const dur = typeof data.durationMs === 'number' ? data.durationMs.toFixed(1) : 'N/A';
                                                        const notes = data.model ? data.model : '';
                                                        rows += '<tr><td style="border:1px solid #ddd;padding:4px 8px;">' + phase + '</td>';
                                                        rows += '<td style="border:1px solid #ddd;padding:4px 8px;text-align:right;">' + dur + '</td>';
                                                        rows += '<td style="border:1px solid #ddd;padding:4px 8px;color:#586069;">' + notes + '</td></tr>';
                                                    }
                                                }
                                                return rows;
                                            })()}</tbody>
                                        </table>
                                    </details>
                                </td>
                            </tr>
                            ` : ''}
                          `;
                        }).join('')}
                        <tr style="background-color: #e8f5e9; font-weight: bold;">
                            <td colspan="4" style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;"><strong>TOTAL (${configName})</strong></td>
                            <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;"></td>
                            <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; color: #28a745;"><strong>${groupResults.reduce((s,r)=>s+r.subcases.passed,0)}</strong></td>
                            <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; color: #dc3545;"><strong>${groupResults.reduce((s,r)=>s+r.subcases.failed,0)}</strong></td>
                            <td style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;"><strong>${groupResults.reduce((s,r)=>s+r.subcases.total,0)}</strong></td>
                            <td colspan="3" style="border: 1px solid #e1e4e8; padding: 8px 12px;"></td>
                        </tr>
                    </tbody>
                </table>
            </div>
            `;
        }).join('');
    })()}

    ${results.filter(r => r.retryHistory && r.retryHistory.length > 1).length > 0 ? `
    <h3>Retry Analysis</h3>
    <div style="background-color: #fff3cd; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <p><strong>${results.filter(r => r.retryHistory && r.retryHistory.length > 1).length}</strong> test(s) required retries</p>
    </div>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-family: sans-serif;">
        <thead>
            <tr>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Backend</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Test Case</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Initial Status</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Final Status</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Retry Attempts</th>
                <th style="border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; background-color: #f6f8fa; font-weight: 600;">Subcase Changes</th>
            </tr>
        </thead>
        <tbody>
            ${results.filter(r => r.retryHistory && r.retryHistory.length > 1).map(result => {
              const initial = result.retryHistory[0];
              const final = result.retryHistory[result.retryHistory.length - 1];
              const retryCount = result.retryHistory.length - 1;
              const subcaseChange = final.passed !== initial.passed || final.failed !== initial.failed;
              const retryBackend = formatBackendKey(resolveBackendName(result));

              const baseTdStyle = "border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left;";
              const getStatusColor = (status) => status === 'PASS' ? '#28a745' : status === 'FAIL' ? '#dc3545' : '#fd7e14';

              return `
                <tr>
                    <td style="${baseTdStyle}"><strong>${retryBackend}</strong></td>
                    <td style="${baseTdStyle}"><strong>${result.testName}</strong></td>
                    <td style="${baseTdStyle} font-weight: bold; color: ${getStatusColor(initial.status)};">${initial.status}<br><small style="font-weight: normal; color: #586069;">(${initial.passed}/${initial.total} passed)</small></td>
                    <td style="${baseTdStyle} font-weight: bold; color: ${getStatusColor(final.status)};">${final.status}<br><small style="font-weight: normal; color: #586069;">(${final.passed}/${final.total} passed)</small></td>
                    <td style="${baseTdStyle}">${retryCount}</td>
                    <td style="${baseTdStyle}">
                        ${subcaseChange ?
                          `<span style="color: #fd7e14;">[Changed]</span><br>
                           <small>Passed: ${initial.passed} -> ${final.passed}<br>
                           Failed: ${initial.failed} -> ${final.failed}</small>` :
                          '<span style="color: #28a745;">[Consistent]</span>'}
                    </td>
                </tr>
                <tr>
                    <td colspan="6" style="padding: 0; border: 1px solid #e1e4e8;">
                        <details style="padding: 10px; background-color: #f6f8fa;">
                            <summary style="cursor: pointer; font-weight: bold;">View All Attempts</summary>
                            <div style="margin-top: 10px;">
                                ${result.retryHistory.map((attempt, idx) => `
                                    <div style="padding: 8px; margin: 5px 0; background-color: white; border-left: 3px solid ${getStatusColor(attempt.status)}; border-radius: 3px;">
                                        <strong>${idx === 0 ? 'Initial Run' : 'Retry Attempt ' + idx}:</strong>
                                        <span style="font-weight: bold; color: ${getStatusColor(attempt.status)};">${attempt.status}</span><br>
                                        <small>Passed: ${attempt.passed} | Failed: ${attempt.failed} | Total: ${attempt.total}</small>
                                    </div>
                                `).join('')}
                            </div>
                        </details>
                    </td>
                </tr>
              `;
            }).join('')}
        </tbody>
    </table>
    ` : ''}



</body>
</html>`;

    // Defensive cleanup: remove legacy signature labels appended to section titles.
    return reportHtml.replace(/\s*<span style="font-weight:\s*normal;\s*font-size:\s*0\.9em;\s*color:\s*#586069;">\[[^<]*\]<\/span>/g, '');
  }

  generateSubcaseTable(testSuites, results) {
    const totalSubcases = results.reduce((sum, r) => sum + r.subcases.total, 0);
    const passedSubcases = results.reduce((sum, r) => sum + r.subcases.passed, 0);
    const failedSubcases = results.reduce((sum, r) => sum + r.subcases.failed, 0);

    const suiteTitle = testSuites.length > 1 ?
      testSuites.map(s => s.toUpperCase()).join(', ') :
      testSuites[0].toUpperCase();

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Subcase Summary - ${suiteTitle}</title>
    <style>
        body { font-family: monospace; background: #f8f9fa; padding: 20px; }
        table { background: white; border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
        th { background: #e9ecef; font-weight: bold; }
        .summary-row { background: #d4edda; font-weight: bold; }
        .pass { color: #28a745; } .fail { color: #dc3545; } .error { color: #fd7e14; }
    </style>
</head>
<body>
    <h2>Subcases Summary Table - ${suiteTitle}</h2>
    <table>
        <thead>
            <tr>
                <th>Case Name</th>
                <th>Total Subcases</th>
                <th>Passed Subcases</th>
                <th>Failed Subcases</th>
                <th>Status</th>
            </tr>
        </thead>
        <tbody>
            ${results.map(result => `
                <tr>
                    <td>${result.testName}</td>
                    <td>${result.subcases.total}</td>
                    <td class="pass">${result.subcases.passed}</td>
                    <td class="fail">${result.subcases.failed}</td>
                    <td class="${result.result.toLowerCase()}">${result.result === 'PASS' ? 'PASS' : result.result === 'FAIL' ? 'FAIL' : 'ERROR'}</td>
                </tr>, launchBrowser
            `).join('')}
            <tr class="summary-row">
                <td><strong>TOTAL (${suiteTitle})</strong></td>
                <td><strong>${totalSubcases}</strong></td>
                <td class="pass"><strong>${passedSubcases}</strong></td>
                <td class="fail"><strong>${failedSubcases}</strong></td>
                <td><strong>${results.filter(r => r.result === 'PASS').length}/${results.length} cases</strong></td>
            </tr>
        </tbody>
    </table>
</body>
</html>`;
  }

  async sendEmailReport(emailAddress, testSuites, results, wallTime, sumOfTestTimes, reportTimestamp = null, htmlReportContent = null) {
    try {
    console.log(`\n[Info] Sending email report${emailAddress ? ` to ${emailAddress}` : ' to default recipients'}...`);

      // Calculate summary statistics
      const totalSubcases = results.reduce((sum, r) => sum + r.subcases.total, 0);
      const passedSubcases = results.reduce((sum, r) => sum + r.subcases.passed, 0);
      const successRate = totalSubcases > 0 ? ((passedSubcases / totalSubcases) * 100).toFixed(1) : '0.0';

      const suiteTitle = testSuites.length > 1 ?
        testSuites.map(s => s.toUpperCase()).join(', ') :
        testSuites[0].toUpperCase();

      // Get machine name
      const os = require('os');
      const machineName = os.hostname();

      // GPU info is no longer needed in the subject, only in the report body if applicable

      // Use provided timestamp (from report filename) or generate new one
      const timestamp = reportTimestamp || (() => {
        const now = new Date();
        return now.getFullYear().toString() +
               (now.getMonth() + 1).toString().padStart(2, '0') +
               now.getDate().toString().padStart(2, '0') +
               now.getHours().toString().padStart(2, '0') +
               now.getMinutes().toString().padStart(2, '0') +
               now.getSeconds().toString().padStart(2, '0');
      })();

      // Create email subject: [WebNN Test Report] timestamp | machine name
      const subject = `[${machineName}] WebNN Test Report - ${timestamp}`;

      // Use provided HTML content or generate new one
      const htmlBody = htmlReportContent || this.generateHtmlReport(testSuites, null, results, null, wallTime, sumOfTestTimes);

      const sendResult = await send_email(subject, htmlBody, '', emailAddress);

      console.log(`[Success] ${sendResult}`);
    } catch (error) {
      console.error(`[Fail] Failed to send email: ${error.message}`);
      console.error(`   This is a non-critical error - test results are still available in the HTML report`);
    }
  }
}

/**
 * Captures structured [WebNN:Perf] console events emitted by the
 * webnn-perf.js instrumentation in the developer-preview demos.
 *
 * Usage:
 *   const collector = new WebNNPerfCollector();
 *   collector.start(page);
 *   // ... run demo ...
 *   const metrics = collector.getSummary();
 *   collector.stop();
 */
class WebNNPerfCollector {
  constructor() {
    this._entries = [];
    this._page = null;
    this._listener = null;
    this._waiters = [];
  }

  start(page) {
    this._page = page;
    this._entries = [];
    this._waiters = [];

    this._listener = (msg) => {
      const text = msg.text();
      if (!text.startsWith('[WebNN:Perf] ')) return;
      try {
        const json = JSON.parse(text.slice('[WebNN:Perf] '.length));
        this._entries.push({ ...json, _timestamp: Date.now() });
        // Resolve any waiters matching this event name
        this._waiters = this._waiters.filter(w => {
          if (w.name === json.name) {
            w.resolve(json);
            return false;
          }
          return true;
        });
      } catch (e) {
        // Malformed payload — ignore
      }
    };

    page.on('console', this._listener);
  }

  stop() {
    if (this._page && this._listener) {
      try {
        if (!this._page.isClosed()) {
          this._page.removeListener('console', this._listener);
        }
      } catch (e) { /* page may already be closed */ }
    }
    // Reject pending waiters
    this._waiters.forEach(w => w.reject(new Error('WebNNPerfCollector stopped')));
    this._waiters = [];
    this._listener = null;
  }

  getEntries() {
    return [...this._entries];
  }

  /**
   * Returns a promise that resolves when an event with the given name arrives.
   * Resolves immediately if such an event was already captured.
   */
  waitForEvent(name, { timeout = 60000 } = {}) {
    const existing = this._entries.find(e => e.name === name);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = { name, resolve, reject };
      this._waiters.push(waiter);

      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter(w => w !== waiter);
        reject(new Error(`WebNNPerfCollector: timeout waiting for "${name}"`));
      }, timeout);

      // Wrap resolve to clear timer
      const origResolve = waiter.resolve;
      waiter.resolve = (val) => { clearTimeout(timer); origResolve(val); };
    });
  }

  /**
   * Returns structured per-phase metrics grouped by event name.
   * Single-occurrence events are stored as objects; repeated events as arrays.
   */
  getSummary() {
    const summary = {};
    for (const entry of this._entries) {
      const key = entry.name;
      if (!key) continue;
      const record = { durationMs: entry.durationMs, sequence: entry.sequence };
      // Preserve useful metadata
      if (entry.model) record.model = entry.model;
      if (entry.iteration !== undefined) record.iteration = entry.iteration;
      if (entry.error) record.error = entry.error;

      if (!summary[key]) {
        summary[key] = record;
      } else if (Array.isArray(summary[key])) {
        summary[key].push(record);
      } else {
        summary[key] = [summary[key], record];
      }
    }
    return summary;
  }

  /**
   * Returns a compact one-line string summarising key phases.
   * e.g. "session=1234ms first_inf=89ms avg_inf=42ms"
   */
  toCompactString() {
    const entries = this._entries;
    if (entries.length === 0) return '';

    const parts = [];

    const sessionEntries = entries.filter(e => e.name === 'webnn.session.create');
    if (sessionEntries.length > 0) {
      const totalSession = sessionEntries.reduce((s, e) => s + (e.durationMs || 0), 0);
      parts.push(`session=${totalSession.toFixed(1)}ms`);
    }

    const fetchEntries = entries.filter(e => e.name === 'webnn.model.fetch');
    if (fetchEntries.length > 0) {
      const totalFetch = fetchEntries.reduce((s, e) => s + (e.durationMs || 0), 0);
      parts.push(`fetch=${totalFetch.toFixed(1)}ms`);
    }

    const firstInf = entries.find(e => e.name === 'webnn.inference.first');
    if (firstInf) {
      parts.push(`first_inf=${firstInf.durationMs.toFixed(1)}ms`);
    }

    const infEntries = entries.filter(e => e.name === 'webnn.inference');
    if (infEntries.length > 0) {
      const avg = infEntries.reduce((s, e) => s + (e.durationMs || 0), 0) / infEntries.length;
      parts.push(`avg_inf=${avg.toFixed(1)}ms`);
    }

    return parts.join(' ');
  }
}

module.exports = { WebNNRunner, WebNNPerfCollector, killOwnBrowserProcesses, findBrowserRootPid, launchBrowser, get_gpu_info, get_cpu_info, get_npu_info };
