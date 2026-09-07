#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, expect, chromium } = require('@playwright/test');

const { WptRunner } = require('./wpt');
const { ModelRunner } = require('./model');
const { launchBrowser, killOwnBrowserProcesses, findBrowserRootPid, get_gpu_info, get_cpu_info, get_npu_info } = require('./util');
const { getRuntimeInfo, runtimeInfoRows, resolveWindowsAppSdk, verifyWindowsAppSdk } = require('./runtime-info');

// Helper to parse comma-separated lists
const parseList = (str) => (str || '').split(',').map(s => s.trim()).filter(s => s.length > 0);

// Helper to identify framework and backend
const getFramework = (browserArgs) => (browserArgs || '').includes('WebNNOnnxRuntime') ? 'ort' : 'litert';
const getBackend = (framework, browserArgs, dllResults, device) => {
    // If device is cpu, backend has to be cpu
    if (device === 'cpu') return 'cpu';

    // If DLL check explicitly failed or found nothing, and we are expecting acceleration, fallback to cpu
    if (dllResults && dllResults.found === false && framework === 'ort') {
        return 'cpu';
    }

    // Checking DLL naming for backend detection
    if (framework === 'ort' && dllResults && dllResults.modules && dllResults.modules.length > 0) {
         const modules = dllResults.modules.map(m => (m.ModuleName || m).toLowerCase());
         const rawModules = JSON.stringify(modules);

         if (rawModules.includes('openvino')) return 'openvino';
         if (rawModules.includes('tensorrt')) return 'tensorrt';
         if (rawModules.includes('migraphx')) return 'migraphx';
         if (rawModules.includes('qnn')) return 'qnn';
         if (rawModules.includes('directml')) return 'dml';
    }

    const args = browserArgs || '';
    if (framework === 'litert') return 'cpu'; // Default for litert
    if (args.includes('WebGpuExecutionProvider')) return 'webgpu';
    if (args.includes('OpenVINO')) return 'openvino';
    if (args.includes('Qnn')) return 'qnn';
    if (args.includes('Dml')) return 'dml';
    if (args.includes('MigraphX')) return 'migraphx';
    if (args.includes('Tensorrt')) return 'tensorrt';
    return 'cpu'; // Default fallback
};

const getBrowserProcessName = () => {
    const browserPath = (process.env.BROWSER_PATH || '').toLowerCase();
    const browserName = (process.env.BROWSER_NAME || '').toLowerCase();
    const browserChannel = (process.env.BROWSER_CHANNEL || process.env.CHROME_CHANNEL || '').toLowerCase();
    return browserPath.includes('msedge') || browserName === 'edge' || browserChannel.startsWith('msedge')
        ? 'msedge.exe'
        : 'chrome.exe';
};

if (require.main === module && process.env.IS_PLAYWRIGHT_CHILD_PROCESS !== 'true') {
  // ===========================================================================
  // CLI / Parent Process Logic
  // ===========================================================================

  const args = process.argv.slice(2);

  // Help Check
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
WebNN Automation Tests

Usage: node src/main.js [options]

Options:
  --config <file>          Path to JSON configuration file
  --suite <name>           Test suite to run (default: wpt). Values: wpt, model
  --list                   List all test cases in the specified suite
  --jobs <number>          Number of parallel jobs (default: 4)
  --repeat <number>        Number of times to repeat the test run (default: 1)
  --device <type>          Device type to use (default: gpu). Values: cpu, gpu, npu
  --browser <name>         Browser to use (default: chrome). Values: chrome, edge
  --browser-channel <name> Browser channel to use (default: canary). Values: stable, canary, dev, beta
  --chrome-channel <name>  Deprecated alias for --browser-channel
  --browser-arg <arg>      Extra arguments for browser launch, split by space
  --email [address]        Send email report
  --pause <case>           Pause execution on failure
  --browser-path <path>    Custom path to browser executable
  --win-app-sdk <package>  Select an installed Windows App SDK runtime package and verify ONNX Runtime uses it (enables WebNNOnnxRuntime)
  --skip-retry             Skip the retry stage for failed tests
  --baseline <folder>      Baseline folder (timestamp) for comparison

Test Selection:
  --wpt-case <filter>      Run specific WPT test cases
  --wpt-range <range>      Run tests by index range
  --model-case <filter>    Run specific Model cases

Examples:
  node src/main.js --config config.json
  node src/main.js --suite wpt --wpt-case abs
  node src/main.js --suite wpt --browser edge --browser-channel canary
`);
    process.exit(0);
  }

  // List Mode Handling
  if (args.includes('--list')) {
    process.env.LIST_MODE = 'true';
  } else {
    process.env.LIST_MODE = 'false';
  }

  // --- Argument Parsing ---

  // Common Args
  const getArg = (name) => {
    const idx = args.findIndex(a => a === name);
    return (idx !== -1 && idx + 1 < args.length) ? args[idx + 1] : null;
  };
  const getArgValue = (prefix) => {
    const arg = args.find(a => a.startsWith(prefix));
    return arg ? arg.split('=')[1] : null;
  };

  const jobsStr = getArg('--jobs') || '4';
  const jobs = parseInt(jobsStr, 10);
  const repeatStr = getArg('--repeat') || '1';
  const repeat = parseInt(repeatStr, 10);

  let emailAddress = null;
  const emailIdx = args.findIndex(a => a === '--email');
  if (emailIdx !== -1) {
      if (emailIdx + 1 < args.length && !args[emailIdx + 1].startsWith('--')) {
          emailAddress = args[emailIdx + 1];
      } else {
          emailAddress = 'ygu@microsoft.com';
      }
  }

  const browserName = (getArg('--browser') || 'chrome').toLowerCase();
  const validBrowsers = ['chrome', 'edge'];
  if (!validBrowsers.includes(browserName)) {
      console.error(`Invalid --browser value: ${browserName}`);
      console.error(`Valid browsers are: ${validBrowsers.join(', ')}`);
      process.exit(1);
  }

  const browserChannel = (getArg('--browser-channel') || getArg('--chrome-channel') || 'canary').toLowerCase();
  const validChannels = ['canary', 'dev', 'beta', 'stable'];
  if (!validChannels.includes(browserChannel)) {
      console.error(`Invalid --browser-channel value: ${browserChannel}`);
      console.error(`Valid channels are: ${validChannels.join(', ')}`);
      process.exit(1);
  }

  const channelPrefix = browserName === 'edge' ? 'msedge' : 'chrome';
  const playwrightChannel = browserChannel === 'stable' ? channelPrefix : `${channelPrefix}-${browserChannel}`;

  let globalExtraArgs = getArg('--browser-arg');
  const sdkPackage = getArg('--win-app-sdk');
  if (sdkPackage) {
      try {
          const sdk = resolveWindowsAppSdk(sdkPackage);
          process.env.WEBNN_EXPECTED_SDK_PATH = sdk.InstallLocation;
          console.log(`[SDK] Selected ${sdk.Name} ${sdk.Version}: ${sdk.InstallLocation}`);
          globalExtraArgs = `${globalExtraArgs || ''} --enable-features=WebNNOnnxRuntime`.trim();
      } catch (error) {
          console.error(`[SDK] ${error.message}`);
          process.exit(1);
      }
  } else {
      delete process.env.WEBNN_EXPECTED_SDK_PATH;
  }
  const browserPath = getArg('--browser-path');
  const skipRetry = args.includes('--skip-retry');
  const baseline = getArg('--baseline');
  const configFile = getArg('--config');
  const pauseCase = getArg('--pause');
  const wptRange = getArg('--wpt-range');

  // --- Config Generation ---
  let runConfigs = [];

  if (configFile) {
      const configPath = path.isAbsolute(configFile) ? configFile : path.resolve(process.cwd(), configFile);
      if (!fs.existsSync(configPath)) {
          console.error(`Config file not found: ${configPath}`);
          process.exit(1);
      }
      try {
          const rawConfigs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          // Normalize configs and expand devices
          runConfigs = rawConfigs.flatMap((item, idx) => {
               const devices = (item.device || 'gpu').split(',').map(d => d.trim()).filter(Boolean);
               return devices.map(device => ({
                  name: item.name || `Config_${idx+1}`,
                  suite: item.suite || 'wpt',
                  device: device,
                  browserArgs: item['browser-arg'] ? `${globalExtraArgs || ''} ${item['browser-arg']}`.trim() : globalExtraArgs,
                  wptCase: item['wpt-case'] || null,
                  modelCase: item['model-case'] || null,
                  wptRange: null,
                  pauseCase: null
               }));
          });
      } catch (e) {
          console.error(`Error reading config file: ${e.message}`);
          process.exit(1);
      }
  } else {
      // CLI Mode -> Generate Cartesian Product
      let suites = parseList(getArg('--suite') || 'wpt');
      let deviceArg = getArg('--device');
      if (!deviceArg) {
          const dVal = getArgValue('--device=');
          deviceArg = dVal || 'gpu';
      }
      let devices = parseList(deviceArg);

      const wptCase = getArg('--wpt-case') || getArg('--model-case');
      const modelCase = getArg('--model-case') || getArg('--wpt-case');

      // Expand "all" suite
      if (suites.includes('all')) suites = ['wpt', 'model'];

      // Generate configs
      // Order: Device outer, Suite inner
      for (const d of devices) {
          for (const s of suites) {
              runConfigs.push({
                  name: 'Default',
                  suite: s,
                  device: d,
                  browserArgs: globalExtraArgs,
                  wptCase: (s === 'wpt') ? (getArg('--wpt-case') || wptCase) : null,
                  modelCase: (s === 'model') ? (getArg('--model-case') || modelCase) : null,
                  wptRange: wptRange,
                  pauseCase: pauseCase
              });
          }
      }
  }

  // --- Environment Setup ---
  process.env.JOBS = jobs.toString();
  process.env.BROWSER_NAME = browserName;
  process.env.BROWSER_CHANNEL = playwrightChannel;
  process.env.TEST_CONFIG_LIST = JSON.stringify(runConfigs);
  process.env.IS_LIST_MODE = process.env.LIST_MODE;
  if (emailAddress) {
      process.env.EMAIL_ADDRESS = emailAddress;
      process.env.EMAIL_TO = emailAddress;
  }
  if (browserPath) process.env.BROWSER_PATH = browserPath;
  if (skipRetry) process.env.SKIP_RETRY = 'true';
  if (baseline) process.env.BASELINE_DIR = baseline;

  delete process.env.TEST_SUITE;
  delete process.env.DEVICE;
  delete process.env.WPT_CASE;
  delete process.env.MODEL_CASE;
  delete process.env.EXTRA_BROWSER_ARGS;

  // --- Execution & Iteration Loop ---

  const runIteration = (iteration, totalIterations) => {
      return new Promise((resolve, reject) => {
          const iterationPrefix = totalIterations > 1 ? `[Iteration ${iteration}/${totalIterations}] ` : '';

          if (totalIterations > 1) {
            console.log(`\n${'='.repeat(80)}`);
            console.log(`[Iteration] ITERATION ${iteration}/${totalIterations}`);
            console.log(`${'='.repeat(80)}\n`);
          }

          process.env.TEST_ITERATION = iteration.toString();
          process.env.TEST_TOTAL_ITERATIONS = totalIterations.toString();

          // Generate timestamp for this iteration
          const now = new Date();
          const timestamp = now.getFullYear().toString() +
            (now.getMonth() + 1).toString().padStart(2, '0') +
            now.getDate().toString().padStart(2, '0') +
            now.getHours().toString().padStart(2, '0') +
            now.getMinutes().toString().padStart(2, '0') +
            now.getSeconds().toString().padStart(2, '0');

          const reportDir = path.join(__dirname, '..', 'results');
          const runDir = path.join(reportDir, timestamp);

          if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, {recursive: true});

          const playwrightArgs = [
            'test',
            '-c', path.join(__dirname, '..', 'runner.config.js'),
            'src/main.js',
            '--reporter=line,html',
            `--output=${path.join('results', timestamp, 'artifacts')}`,
            '--timeout=0'
          ];

          process.env.PLAYWRIGHT_HTML_REPORT = path.join(runDir, 'playwright');
          process.env.PROJECT_TIMESTAMP = timestamp; // Pass timestamp to child process if needed
          process.env.PROJECT_RUN_DIR = runDir;      // Pass full run dir to child process

          if (process.env.CI) playwrightArgs.push('--retries=2');

          const playwrightCli = path.join(__dirname, '..', 'node_modules', '@playwright', 'test', 'cli.js');

          const childProcess = spawn(process.execPath, [playwrightCli, ...playwrightArgs], {
             stdio: 'inherit',
             shell: false,
             env: { ...process.env, IS_PLAYWRIGHT_CHILD_PROCESS: 'true' }
          });

          childProcess.on('close', (code) => {
              if (code === 0) {
                  console.log(`[Success] Results saved to: ${runDir}`);
                  resolve(0);
              } else {
                  console.log(`\n[Fail] ${iterationPrefix}Test iteration failed with code ${code}`);
                  reject(code);
              }
          });
      });
  };

  (async () => {
    if (process.env.LIST_MODE === 'true') {
         // Run Playwright with specific env to triggering Listing
         await runIteration(1, 1);
    } else {
         const results = [];
         for (let i = 1; i <= repeat; i++) {
             try {
                 await runIteration(i, repeat);
                 results.push(0);
             } catch (c) {
                 results.push(c);
             }
             if (i < repeat) await new Promise(r => setTimeout(r, 2000));
         }
         process.exit(results.every(r => r === 0) ? 0 : 1);
    }
  })();

} else {
  // ===========================================================================
  // Child Process / Playwright Test Logic
  // ===========================================================================

  test.describe('WebNN Tests', () => {
      let browser, context, page;
      let browserRootPid = null;
      const launchInstance = async () => launchBrowser();

      test.afterAll(async () => {
          if (browser) {
              try { await browser.close(); } catch (e) {}
          }
          // Kill only our automation's browser process tree (not the user's personal browser).
          if (browserRootPid) {
              killOwnBrowserProcesses(browserRootPid);
          }
      });

      if (process.env.IS_LIST_MODE === 'true') {
          // Listing Logic
          test('List Tests', async () => {
               const configs = JSON.parse(process.env.TEST_CONFIG_LIST || '[]');
               // Collect unique suites
               const uniqueSuites = [...new Set(configs.map(c => c.suite))];

               // Launch minimal browser for discovery
               const instance = await launchInstance();
               page = instance.page;
               browser = instance.browser || instance.context;

               for (const suite of uniqueSuites) {
                    console.log(`\n=== Suite: ${suite.toUpperCase()} ===`);
                    if (suite === 'wpt') {
                        console.log('Discovering WPT tests from https://wpt.live/webnn/conformance_tests/ ...');
                        await page.goto('https://wpt.live/webnn/conformance_tests/');
                        try {
                            await page.waitForSelector('.file', {timeout: 10000});
                            const files = await page.$$eval('.file a', links =>
                                links.map(l => l.textContent.trim()).filter(t => t.endsWith('.js'))
                            );
                            files.forEach((f, i) => console.log(`[${i}] ${f}`));
                        } catch(e) { console.log('Could not load WPT file list'); }
                    } else if (suite === 'model') {
                        const runner = new ModelRunner(page);
                        Object.keys(runner.models).forEach((k, i) => {
                             const m = runner.models[k];
                             console.log(`[${i}] ${k}: ${m.name} (${m.type})`);
                        });
                    }
               }
          });
      } else {
          test('Run Configured Tests', async () => {
              const configs = JSON.parse(process.env.TEST_CONFIG_LIST || '[]');
              let results = [];
              let runner = null;
              const startTime = Date.now();
              // Store DLL results per configuration
              // Structure: { configName: string, framework: string, backend: string, device: string, results: object }
              let allDllResults = [];
              let browserInfo = null; // { name, channel, version }

              for (const [idx, config] of configs.entries()) {
                   // Pre-flight check: Skip if NPU/GPU device requested but not found
                   if (config.device === 'npu') {
                       const npuInfo = get_npu_info();
                       if (npuInfo === 'Unknown NPU') {
                           console.log(`\n[Skip] Skipping config ${config.name} (Platform: NPU) - No NPU detected.`);
                           continue;
                       }
                   }

                   console.log(`\n=== Running Config: ${config.name} (Suite: ${config.suite}, Device: ${config.device}) ===`);
                   let currentDllResults = null;

                   process.env.EXTRA_BROWSER_ARGS = config.browserArgs || '';
                   process.env.DEVICE = config.device;

                   // Always relaunch for isolation between configs
                   if (browser) {
                       await browser.close();
                       browser = null;
                       await new Promise(r => setTimeout(r, 1000));
                   }

                   const instance = await launchInstance();
                   browser = instance.browser || instance.context;
                   context = instance.context;
                   page = instance.page;

                   // Track the browser root PID for targeted cleanup
                   try {
                       browserRootPid = findBrowserRootPid(getBrowserProcessName());
                       if (browserRootPid) console.log(`[Info] Browser root PID: ${browserRootPid}`);
                   } catch (e) { /* best effort */ }

                   // Capture browser info on first launch
                   if (!browserInfo) {
                       try {
                           const channel = process.env.BROWSER_CHANNEL || process.env.CHROME_CHANNEL || 'chrome-canary';
                           const browserPath = (process.env.BROWSER_PATH || '').toLowerCase();
                           const isEdge = channel.startsWith('msedge') || process.env.BROWSER_NAME === 'edge' || browserPath.includes('msedge');
                           const name = isEdge ? 'Edge' : 'Chrome';

                           // Get full version via CDP (Browser.getVersion returns the real version)
                           let version = 'Unknown';
                           try {
                               const cdp = await page.context().newCDPSession(page);
                               const info = await cdp.send('Browser.getVersion');
                               // info.product is like "Chrome/146.0.7680.2"
                               const m = info.product && info.product.match(/\/([\d.]+)/);
                               if (m) version = m[1];
                               await cdp.detach();
                           } catch (_) {}

                           const channelLabel = channel.replace(/^(chrome|msedge)-?/, '') || 'stable';
                           browserInfo = {
                               name: name,
                               channel: channelLabel.charAt(0).toUpperCase() + channelLabel.slice(1),
                               version: version
                           };
                           console.log(`[Browser] ${browserInfo.name} ${browserInfo.channel} v${browserInfo.version}`);
                       } catch (e) {
                           console.log('[Warning] Could not retrieve browser info:', e.message);
                       }
                   }

                   let currentRunner;
                   if (config.suite === 'wpt') {
                       currentRunner = new WptRunner(page);
                       currentRunner.launchNewBrowser = launchInstance;
                   } else {
                       currentRunner = new ModelRunner(page);
                       currentRunner.launchNewBrowser = launchInstance;
                   }
                   if (browserRootPid) currentRunner.browserRootPid = browserRootPid;
                   runner = currentRunner;

                   if (idx === 0) {
                        // Short delay to ensure process is stable
                        // await new Promise(r => setTimeout(r, 2000));
                        // dllResults = await currentRunner.checkOnnxruntimeDlls(processName);
                   }

                   process.env.WPT_CASE = config.wptCase || '';
                   process.env.MODEL_CASE = config.modelCase || '';
                   process.env.WPT_RANGE = config.wptRange || '';
                   process.env.PAUSE_CASE = config.pauseCase || '';

                   // Callback to run DLL check after first case execution
                   const onFirstCaseComplete = async () => {
                       if (!currentDllResults) {
                           console.log('[Info] First case completed. Checking DLLs...');
                           currentDllResults = await currentRunner.checkOnnxruntimeDlls(getBrowserProcessName());
                       }
                   };

                   let runRes = [];
                   if (config.suite === 'wpt') {
                       runRes = await currentRunner.runWptTests(context, browser, onFirstCaseComplete);
                   } else {
                       runRes = await currentRunner.runModelTests(onFirstCaseComplete);
                   }

                   // Ensure check ran if for some reason callback wasn't triggered (e.g. 0 tests)
                   if (!currentDllResults) await onFirstCaseComplete();

                   if (process.env.WEBNN_EXPECTED_SDK_PATH) {
                       verifyWindowsAppSdk(currentDllResults, process.env.WEBNN_EXPECTED_SDK_PATH);
                       console.log(`[SDK] Verified ONNX Runtime loaded from ${process.env.WEBNN_EXPECTED_SDK_PATH}`);
                   }

                   const fw = getFramework(config.browserArgs);
                   const bk = getBackend(fw, config.browserArgs, currentDllResults, config.device);

                   // Store DLL info for this configuration
                   allDllResults.push({
                      configName: config.name,
                      framework: fw,
                      backend: bk,
                      device: config.device,
                      dllInfo: currentDllResults
                   });

                   runRes.forEach(r => {
                       r.configName = config.name;
                       r.device = config.device;
                       r.fullConfig = config;
                       r.configIndex = idx;
                       // Determine identifiers for report matching
                       r.framework = fw;
                       // We use the dllResults (global for now, but usually reflects the first/main run)
                       // If multiple configs are run, this might need refinement to be per-config
                       r.backend = bk;
                   });
                   results = results.concat(runRes);
              }

              if (results.length > 0 && runner) {
                   const wallTime = ((Date.now() - startTime) / 1000).toFixed(2);
                   const sumOfTestTimes = results.reduce((acc, r) => acc + (parseFloat(r.executionTime)||0), 0).toFixed(2);
                   const subtitle = configs.map(c => c.name).join(', ');
                   const suiteNames = [...new Set(configs.map(c => c.suite))];

                   // --- Resolve System Device Names ---
                   // Do this BEFORE report generation so both HTML and Text reports use the same resolved names
                   let sysGpuInfo = null;
                   let sysCpuInfo = null;
                   let sysNpuInfo = null;
                   try { sysGpuInfo = get_gpu_info(); } catch(e) {}
                   try { sysCpuInfo = get_cpu_info(); } catch(e) {}
                   try { sysNpuInfo = get_npu_info(); } catch(e) {}

                   results.forEach(r => {
                       let deviceName = r.device;

                       if (deviceName === 'gpu') {
                           if (sysGpuInfo && sysGpuInfo.device_id) deviceName = sysGpuInfo.device_id;
                       } else if (deviceName === 'cpu') {
                           if (sysCpuInfo) {
                               const rawName = sysCpuInfo.toLowerCase();
                               if (rawName.includes('intel')) deviceName = 'intel';
                               else if (rawName.includes('amd')) deviceName = 'amd';
                               else if (rawName.includes('qualcomm') || rawName.includes('snapdragon')) deviceName = 'qualcomm';
                               else if (rawName.includes('arm')) deviceName = 'arm';
                               else {
                                   deviceName = rawName.replace(/[^a-zA-Z0-9]/g, '');
                                   if (deviceName.length > 20) deviceName = deviceName.substring(0, 20);
                               }
                           }
                       } else if (deviceName === 'npu') {
                           if (sysNpuInfo && sysNpuInfo.device_id) {
                               deviceName = sysNpuInfo.device_id;
                           } else if (sysNpuInfo && sysNpuInfo.name) {
                               deviceName = sysNpuInfo.name.replace(/[^a-zA-Z0-9]/g, '');
                           }
                       }
                       r.deviceName = deviceName.toLowerCase();
                       // Update dllResults with resolved device name
                       const relatedDllResult = allDllResults.find(d => d.configName === r.configName);
                       if (relatedDllResult) {
                           relatedDllResult.device = r.deviceName;
                       }
                   });

                   const resultsRoot = path.join(__dirname, '..', 'results');
                   let baselineDirName = process.env.BASELINE_DIR || null;

                   // -----------------------------------
                   // Baseline Comparison Logic (Moved here to use resolved identifiers)
                   // -----------------------------------
                   try {
                       // Find latest baseline if not specified
                       if (!baselineDirName && fs.existsSync(resultsRoot)) {
                           let dirs = [];
                           const currentTimestamp = process.env.PROJECT_TIMESTAMP;
                             dirs = fs.readdirSync(resultsRoot)
                                .filter(f => {
                                    // Exclude current run directory
                                    if (currentTimestamp && f.includes(currentTimestamp)) return false;
                                    const fullPath = path.join(resultsRoot, f);
                                    if (!fs.statSync(fullPath).isDirectory()) return false;
                                    // Skip non-result directories
                                    if (['temp', 'playwright', 'artifacts'].includes(f)) return false;
                                    // Accept bl- prefixed baseline dirs or pure timestamp dirs
                                    if (!f.startsWith('bl-') && !/^\d+$/.test(f)) return false;
                                    // Must contain at least one .txt report file
                                    const hasTextReport = fs.readdirSync(fullPath).some(c => c.endsWith('.txt'));
                                    if (!hasTextReport) return false;
                                    return true;
                                })
                                .sort((a, b) => {
                                    // Sort by timestamp portion (strip bl- prefix if present)
                                    const tsA = a.replace(/^bl-/, '');
                                    const tsB = b.replace(/^bl-/, '');
                                    return tsB.localeCompare(tsA); // Newest first
                                });

                           // Use the latest directory (already sorted newest first)
                           if (dirs.length > 0) {
                               baselineDirName = dirs[0];
                           }
                       }

                       if (baselineDirName) {
                           const latestDir = path.join(resultsRoot, baselineDirName);
                           // Find the main text report file. Usually has the same name as folder or ends in .txt
                           // The text report writer uses: `${timestamp}.txt` or `index.txt`
                           // We will look for *.txt that are NOT 'artifacts' or 'debug'
                           const files = fs.readdirSync(latestDir).filter(f => f.endsWith('.txt'));
                           // If specific timestamp file exists (matching dir name or its timestamp part), prefer it
                           const baselineTimestamp = baselineDirName.replace(/^bl-/, '');
                           let baselineFile = files.find(f => f.includes(baselineDirName)) ||
                                              files.find(f => f.includes(baselineTimestamp));
                           if (!baselineFile && files.length > 0) baselineFile = files[0];

                           if (baselineFile) {
                               const content = fs.readFileSync(path.join(latestDir, baselineFile), 'utf8');
                               // Parse content:
                               // [ort-gpu-nvidia]
                               // test1: PASS
                               const baselineData = {}; // key -> Map<testName, entry>
                               let currentKey = null;
                               let lastEntryName = null; // track current test for counting subtest lines

                               const lines = content.split('\n');
                               for (const line of lines) {
                                   const trimmed = line.trim();
                                   if (!trimmed) continue;
                                   if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                                       currentKey = trimmed.slice(1, -1);
                                       baselineData[currentKey] = {};
                                       lastEntryName = null;
                                   } else if (currentKey && trimmed.startsWith('- ')) {
                                       // Subtest detail line (e.g., "  - subtestName: FAIL")
                                       // Count as a failed subcase for the current test entry
                                       if (lastEntryName && baselineData[currentKey][lastEntryName]) {
                                           const entry = baselineData[currentKey][lastEntryName];
                                           if (!entry.subcases) entry.subcases = { failed: 0 };
                                           entry.subcases.failed = (entry.subcases.failed || 0) + 1;
                                       }
                                   } else if (currentKey && trimmed.includes(':')) {
                                       // Robust parsing for "TestName: Status" where TestName might contain colons.
                                       const lastColonIndex = trimmed.lastIndexOf(':');
                                       if (lastColonIndex !== -1) {
                                           const name = trimmed.substring(0, lastColonIndex).trim();
                                           const statusPart = trimmed.substring(lastColonIndex + 1).trim();
                                           // Parse status and optional subcase counts: "FAIL [10/15]" or "PASS [15/15]"
                                           const statusMatch = statusPart.match(/^(\S+)(?:\s+\[(\d+)\/(\d+)\])?/);
                                           if (statusMatch) {
                                               const entry = { status: statusMatch[1] };
                                               if (statusMatch[2] !== undefined) {
                                                   entry.subcases = { passed: parseInt(statusMatch[2]), total: parseInt(statusMatch[3]) };
                                               }
                                               baselineData[currentKey][name] = entry;
                                               lastEntryName = name;
                                           }
                                       }
                                   }
                               }

                               // Compare (baseline applies to WPT suite only)
                               let matchCount = 0;
                               results.forEach(r => {
                                   if (r.fullConfig && r.fullConfig.suite !== 'wpt') return;
                                   // Construct key matching how text report generates it
                                   // key = `${r.framework}-${r.backend}-${r.deviceName}`
                                   const key = `${r.framework}-${r.backend}-${r.deviceName}`;
                                   const baseline = baselineData[key] && baselineData[key][r.testName];
                                   if (baseline) {
                                       r.previousResult = baseline.status;
                                       if (baseline.subcases) {
                                           r.previousSubcases = baseline.subcases;
                                       }
                                       matchCount++;
                                   }
                               });
                               console.log(`[Baseline] Loaded from ${baselineDirName} (${baselineFile}). Matched ${matchCount} tests.`);
                           }
                       }
                   } catch (e) {
                       console.error('[Baseline] Error processing:', e.message);
                   }
                   // -----------------------------------

                   const runtimeInfo = getRuntimeInfo(allDllResults);
                   const report = runner.generateHtmlReport(suiteNames, subtitle, results, allDllResults, wallTime, sumOfTestTimes, baselineDirName, browserInfo, runtimeInfo);

                   const runDir = process.env.PROJECT_RUN_DIR || path.join(__dirname, '..', 'results');
                   const timestamp = process.env.PROJECT_TIMESTAMP;
                   const reportFileName = timestamp ? `${timestamp}.html` : 'index.html';

                   // Write HTML report to the specific run directory
                   fs.writeFileSync(path.join(runDir, reportFileName), report);
                   console.log(`[Report] Generated: ${path.join(runDir, reportFileName)}`);

                   // --- Generate Plain Text Results ---
                   try {
                       // Group results by unique framework-backend-device combination
                       const groups = {};
                       // Retrieve system HW Info once (already done above)

                       // Header with System Info
                       let sysInfoText = '=== System Information ===\n';
                       if (browserInfo) {
                           sysInfoText += `Browser: ${browserInfo.name} ${browserInfo.channel} ${browserInfo.version}\n`;
                       }
                       for (const [label, value] of runtimeInfoRows(runtimeInfo)) {
                           sysInfoText += `${label}:\n  ${value.replace(/\n/g, '\n  ')}\n`;
                       }
                       if (sysCpuInfo) sysInfoText += `CPU: ${sysCpuInfo}\n`;
                       if (sysGpuInfo) {
                           sysInfoText += `GPU: ${sysGpuInfo.name || 'Unknown'}\n`;
                           if (sysGpuInfo.driver_ver) sysInfoText += `GPU Driver: ${sysGpuInfo.driver_ver}\n`;
                       }
                       if (sysNpuInfo) {
                           let npuName = typeof sysNpuInfo === 'string' ? sysNpuInfo : sysNpuInfo.name;
                           if (npuName === 'Unknown NPU') npuName = 'None';
                           sysInfoText += `NPU: ${npuName}\n`;
                           if (typeof sysNpuInfo === 'object' && sysNpuInfo.driver_ver) {
                               sysInfoText += `NPU Driver: ${sysNpuInfo.driver_ver}\n`;
                           }
                       }
                       sysInfoText += '==========================\n';

                       results.forEach(r => {
                           const key = `${r.framework}-${r.backend}-${r.deviceName}`;
                           if (!groups[key]) groups[key] = [];
                           groups[key].push(r);
                       });

                       let allTextContent = sysInfoText;
                       for (const [key, groupResults] of Object.entries(groups)) {
                           allTextContent += `\n[${key}]\n`;

                           const content = groupResults.map(r => {
                               let line = `${r.testName}: ${r.result}`;
                               // Append subcase counts if available
                               if (r.subcases && r.subcases.total > 0) {
                                   line += ` [${r.subcases.passed}/${r.subcases.total}]`;
                               }
                               // Append WebNN perf metrics summary if available
                               if (r.perfSummary) {
                                   line += `\n  perf: ${r.perfSummary}`;
                               }
                               // Append detailed failure messages for WPT if available
                               if (r.failedSubtests && r.failedSubtests.length > 0) {
                                   const subtestDetails = r.failedSubtests.map(s => `  - ${s.name}: ${s.status}`).join('\n');
                                   line += `\n${subtestDetails}`;
                               }
                               return line;
                           }).join('\n');

                           allTextContent += content + '\n';
                       }

                       // Determine output output dir
                       const runDir = process.env.PROJECT_RUN_DIR || path.join(__dirname, '..', 'results');
                       const timestamp = process.env.PROJECT_TIMESTAMP;

                       // If timestamp is available, prefix it, otherwise just use key
                       const fileName = timestamp ? `${timestamp}.txt` : `index.txt`;

                       fs.writeFileSync(path.join(runDir, fileName), allTextContent.trim());
                   } catch (e) { console.error('Error saving text report:', e); }
                   // -----------------------------------

                   if (process.env.EMAIL_TO) {
                       await runner.sendEmailReport(process.env.EMAIL_TO, suiteNames, results, wallTime, sumOfTestTimes, null, report);
                   }
              }
          });
      }
  });
}
