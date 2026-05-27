
const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { WebNNRunner, isGpuProcessAlive } = require('./util');

class WptRunner extends WebNNRunner {
    writeFinalResultsCsv(results) {
        const csvEscape = (value) => {
            const text = value == null ? '' : String(value);
            return `"${text.replace(/"/g, '""')}"`;
        };

        const getMessage = (result) => {
            if (result.error) return result.error;
            if (Array.isArray(result.failedSubtests) && result.failedSubtests.length > 0) {
                return result.failedSubtests
                    .map(s => `${s.name || 'subtest'}: ${s.message || s.status || 'FAIL'}`)
                    .join(' | ');
            }
            return '';
        };

        const lines = [];
        lines.push(['Backend', 'Test Suite', 'Test Case', 'Status', 'Message'].map(csvEscape).join(','));

        const backend = (process.env.CURRENT_CONFIG_NAME || '').trim() || 'UNKNOWN';

        for (const r of results) {
            lines.push([
                backend,
                'WPT',
                r.testName || r.fileName || '',
                r.result || 'UNKNOWN',
                getMessage(r)
            ].map(csvEscape).join(','));
        }

        const runDir = process.env.PROJECT_RUN_DIR || path.join(__dirname, '..', 'results');
        const timestamp = process.env.PROJECT_TIMESTAMP;
        const configFileName = (process.env.CURRENT_CONFIG_FILE_NAME || '').trim() || 'config';
        const configBaseName = configFileName.replace(/\.[^/.\\]+$/, '');
        const safeConfigName = configBaseName
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .trim();
        const configNamePart = safeConfigName || 'wpt-ort-cpu-gpu';
        const fileName = timestamp
            ? `${timestamp}-${configNamePart}-results.csv`
            : `${configNamePart}-results.csv`;
        const filePath = path.join(runDir, fileName);

        fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
        console.log(`[Report] WPT CSV generated: ${filePath}`);
    }

  async runWptTests(context, browser, onFirstCaseComplete) {
    // Configuration
    const wptCase = process.env.WPT_CASE;
    const specifiedJobs = process.env.JOBS;
    const jobs = specifiedJobs ? parseInt(specifiedJobs, 10) : 1;
    let testCases = [];
    let selectedIndices = new Set();
    const rangeFilter = process.env.WPT_RANGE;

    // Parse range filter if provided (e.g., "1,3-5,10")
    if (rangeFilter) {
      const parts = rangeFilter.split(',');
      parts.forEach(part => {
        if (part.includes('-')) {
          const [start, end] = part.split('-').map(Number);
          for (let i = start; i <= end; i++) selectedIndices.add(i);
        } else {
          selectedIndices.add(Number(part));
        }
      });
      console.log(`Debug: Parsed range filter. Selected indices count: ${selectedIndices.size}`);
    }

    if (wptCase) {
      testCases = wptCase.split(',').map(c => c.trim()).filter(Boolean);
    }

    console.log(`Running WPT tests. Case: ${wptCase || 'ALL'}, Range: ${rangeFilter || 'ALL'}, Jobs: ${jobs}`);

    const baseWptUrl = 'https://wpt.live/webnn/conformance_tests/';

    // 1. Discover Tests
    if (!this.page) {
        throw new Error("WptRunner requires a page in constructor for discovery");
    }

    await this.page.goto(baseWptUrl);
    await this.page.waitForSelector('.file');

    let testFiles = await this.page.$$eval('.file', elements => {
      return elements
        .map(el => {
          const link = el.querySelector('a');
          return link ? link.textContent.trim() : null;
        })
        .filter(name => name && name.endsWith('.js'));
    });

    console.log(`[Success] Test discovery complete. Found ${testFiles.length} files.`);
    await this.page.close();

    // 2. Filter Tests
    if (testCases.length > 0) {
      const orderedTestFiles = [];
      testCases.forEach(testCase => {
        const caseFiles = testFiles.filter(testFile => {
          const baseName = testFile.replace('.https.any.js', '').replace('.js', '');
          return baseName.toLowerCase() === testCase.toLowerCase();
        });
        orderedTestFiles.push(...caseFiles);
      });
      testFiles = [...new Set(orderedTestFiles)];
    }

    if (selectedIndices.size > 0) {
      testFiles = testFiles.filter((_, index) => selectedIndices.has(index));
    }

    console.log(`[Info] Starting test run with ${testFiles.length} tests. Parallel jobs: ${jobs}`);

    // 3. Execution Loop (First Pass)
    let results = [];
    let currentContext = context;
    let currentBrowser = browser;
    let isRestarting = false;
    const enableGpuCrashLogHandler = jobs === 1;
    let lastGpuCrashCount = 0;

    if (enableGpuCrashLogHandler) {
        try {
            if (currentContext) {
                const baselineLog = await this.getGpuCrashLogInfo(currentContext);
                lastGpuCrashCount = baselineLog.crashCount;
            }
        } catch (e) {
            console.log(`[Warning] Failed to initialize GPU crash log baseline: ${e.message}`);
        }
    } else {
        console.log('[Info] GPU crash log handler disabled because jobs > 1.');
    }

    const chunkedExec = async (files) => {
        let index = 0;
        const executeNext = async () => {
            while (index < files.length) {
                // Wait for restart to complete if another worker is restarting
                while (isRestarting) await new Promise(r => setTimeout(r, 100));

                const i = index++;
                if (i >= files.length) break;

                const testFile = files[i];

                await test.step(`Test: ${testFile}`, async () => {
                     let page = null;
                     try {
                         // For isolation: kill/relaunch browser for every conformance test.
                         while (isRestarting) await new Promise(r => setTimeout(r, 100));
                         isRestarting = true;
                         try {
                             const instance = await Promise.race([
                                 this.restartBrowserAndContext(currentBrowser),
                                 new Promise((_, reject) => setTimeout(() => reject(new Error('restartBrowserAndContext timeout 45000ms exceeded')), 45000))
                             ]);
                             currentBrowser = instance.browser || instance.context;
                             currentContext = instance.context;
                             this.page = instance.page;
                         } catch (restartErr) {
                             // Relaunch hung — force kill anything left over so the next iteration can succeed.
                             console.log(`[Fail] Browser relaunch hung: ${restartErr.message}. Force-killing stray processes...`);
                             try { this.forceKillBrowserProcessTree('relaunch hang'); } catch (e) { console.log(`[Debug] relaunch-hang forceKill failed: ${e && e.message ? e.message : e}`); }
                             throw restartErr;
                         } finally {
                             isRestarting = false;
                         }

                         if (!currentContext) {
                             throw new Error('No browser context available after relaunch');
                         }

                         page = await Promise.race([
                             currentContext.newPage(),
                             new Promise((_, reject) => setTimeout(() => reject(new Error('newPage timeout 15000ms exceeded')), 15000))
                         ]);
                         // Run test (Attempt 0). Hard cap 2 minutes — on exceed, finally-block
                         // closes the page (raced) and the catch branch force-kills the browser.
                         const start = Date.now();
                         const res = await Promise.race([
                             this.runSingleWptTest(page, testFile, i, files.length, 0),
                             new Promise((_, reject) => {
                                 const timeoutError = new Error('Test timeout 120000ms exceeded');
                                 timeoutError.name = 'ChunkedExecTimeoutError';
                                 setTimeout(() => reject(timeoutError), 120000);
                             })
                         ]);
                         res.executionTime = ((Date.now() - start) / 1000).toFixed(2);
                         res.fileName = testFile; // Store filename for retry

                         if (enableGpuCrashLogHandler) {
                             // Check chrome://gpu log messages and mark this test as crash if a new crash log appeared.
                             // Race against a hard timeout — a wedged browser can hang chrome://gpu indefinitely.
                             let gpuLog;
                             try {
                                 gpuLog = await Promise.race([
                                     this.getGpuCrashLogInfo(currentContext),
                                     new Promise((_, reject) => setTimeout(() => reject(new Error('getGpuCrashLogInfo timeout 15000ms exceeded')), 15000))
                                 ]);
                             } catch (gpuErr) {
                                 console.log(`[Warning] getGpuCrashLogInfo hung (${gpuErr.message}). Treating as GPU crash and force-killing browser.`);
                                 try { this.forceKillBrowserProcessTree('getGpuCrashLogInfo hang'); } catch (e) { console.log(`[Debug] getGpuCrashLogInfo-hang forceKill failed: ${e && e.message ? e.message : e}`); }
                                 res.crashed = true;
                                 res.result = 'CRASH';
                                 res.error = `[CRASH] getGpuCrashLogInfo hung — browser unresponsive (${gpuErr.message})`;
                                 gpuLog = { crashCount: lastGpuCrashCount, crashLines: [], crashDetails: [] };
                                 // Trigger restart on next iteration via the relaunch path.
                                 currentBrowser = null;
                                 currentContext = null;
                             }
                             if (gpuLog.crashCount > lastGpuCrashCount) {
                                 const crashLabel = '[CRASH]';
                                 const crashDetails = Array.isArray(gpuLog.crashDetails) && gpuLog.crashDetails.length > 0
                                     ? ` Details: ${gpuLog.crashDetails.join(' || ')}`
                                     : '';
                                 res.crashed = true;
                                 res.result = 'CRASH';
                                 res.error = res.error
                                     ? `${crashLabel} ${res.error}${crashDetails}`
                                     : `${crashLabel} GPU process crash detected from chrome://gpu logs${crashDetails}`;
                                 console.log(`[Fail] ${crashLabel} ${testFile}: GpuProcessHost crash detected in chrome://gpu logs.`);
                             }
                             lastGpuCrashCount = Math.max(lastGpuCrashCount, gpuLog.crashCount);
                         }

                         results.push(res);
                         if (results.length === 1 && onFirstCaseComplete) {
                             await onFirstCaseComplete();
                         }
                     } catch (e) {
                         const isTimeoutError = e.name === 'ChunkedExecTimeoutError' ||
                                              (e.message && (e.message.includes('120000ms') || e.message.includes('60000ms') || e.message.includes('Timeout')));
                         const isCriticalError = e.message === 'GPUContextCreationError' ||
                                               e.message === 'HarnessError' ||
                                               e.message.includes('Protocol error') ||
                                               e.message.includes('Target.createTarget') ||
                                               e.message.includes('Target.close') ||
                                               e.message.includes('browserContext.newPage') ||
                                               e.message.includes('Target closed') ||
                                               e.message.includes('WhiteScreen') ||
                                               e.message.includes('GPUProcessCrash') ||
                                               e.message.includes('Timeout') ||
                                               e.name === 'TimeoutError';

                        if (isCriticalError) {
                            // Handle Critical Context Errors (GPU, Protocol, Harness, WhiteScreen, etc.)
                            let errorType = 'Browser/Protocol Error';
                            if (e.message === 'GPUContextCreationError') errorType = 'GPU Context Creation Failed';
                            else if (e.message === 'HarnessError') errorType = 'Harness Error (Restarting)';
                            else if (e.message.includes('WhiteScreen')) errorType = 'White Screen (browser crash)';
                            else if (e.message.includes('GPUProcessCrash')) errorType = 'GPU Process Crash';
                            const crashLabel = '[CRASH]';

                            console.log(`[Fail] ${errorType} for ${testFile} (${e.message}). Force-killing browser and restarting...`);

                            // Force kill browser process tree on crash
                            this.forceKillBrowserProcessTree('WPT web page crash');

                            results.push({
                                testName: testFile,
                                fileName: testFile,
                                suite: 'WPT',
                                result: 'CRASH',
                                subcases: { total: 1, passed: 0, failed: 1 },
                                error: `${crashLabel} ${errorType}`,
                                crashed: true
                            });

                            // Acquire lock to restart
                            if (!isRestarting) {
                                isRestarting = true;
                                try {
                                    const instance = await Promise.race([
                                        this.restartBrowserAndContext(currentBrowser),
                                        new Promise((_, reject) => setTimeout(() => reject(new Error('restartBrowserAndContext timeout 45000ms exceeded (after critical error)')), 45000))
                                    ]);
                                    currentBrowser = instance.browser || instance.context;
                                    currentContext = instance.context;
                                    this.page = instance.page;
                                } catch (restartError) {
                                    console.error(`[Fail] Fatal error restarting browser: ${restartError.message}. Force-killing stray processes...`);
                                    try { this.forceKillBrowserProcessTree('post-critical restart hang'); } catch (e) { console.log(`[Debug] post-critical restart hang forceKill failed: ${e && e.message ? e.message : e}`); }
                                } finally {
                                    isRestarting = false;
                                }
                            }
                        } else if (isTimeoutError) {
                            const crashLabel = '[CRASH]';
                            console.log(`[Fail] ${crashLabel} Timeout for ${testFile} (${e.message}). Force-killing browser and restarting...`);

                            // Timeout + white-screen hangs are treated as browser crashes.
                            this.forceKillBrowserProcessTree('WPT test timeout');

                            results.push({
                                testName: testFile,
                                fileName: testFile,
                                suite: 'WPT',
                                result: 'CRASH',
                                subcases: { total: 1, passed: 0, failed: 1 },
                                error: `${crashLabel} ${e.message}`,
                                crashed: true
                            });

                            if (!isRestarting) {
                                isRestarting = true;
                                try {
                                    const instance = await Promise.race([
                                        this.restartBrowserAndContext(currentBrowser),
                                        new Promise((_, reject) => setTimeout(() => reject(new Error('restartBrowserAndContext timeout 45000ms exceeded (after WPT timeout)')), 45000))
                                    ]);
                                    currentBrowser = instance.browser || instance.context;
                                    currentContext = instance.context;
                                    this.page = instance.page;
                                } catch (restartError) {
                                    console.error(`[Fail] Fatal error restarting browser after timeout: ${restartError.message}. Force-killing stray processes...`);
                                    try { this.forceKillBrowserProcessTree('post-timeout restart hang'); } catch (e) { console.log(`[Debug] post-timeout-restart-hang(catch) forceKill failed: ${e && e.message ? e.message : e}`); }
                                } finally {
                                    isRestarting = false;
                                    try { this.forceKillBrowserProcessTree('post-timeout restart hang'); } catch (e) { console.log(`[Debug] post-timeout-restart-hang(finally) forceKill failed: ${e && e.message ? e.message : e}`); }
                                }
                            }
                        } else {
                            console.error(`Error executing ${testFile}: ${e}`);
                            results.push({
                                testName: testFile,
                                fileName: testFile,
                                suite: 'WPT',
                                result: 'ERROR',
                                subcases: { total: 1, passed: 0, failed: 1 },
                                error: e.message
                            });
                        }
                     } finally {
                         if (page && !page.isClosed()) {
                             try {
                                 await Promise.race([
                                     page.close({ runBeforeUnload: false }),
                                     new Promise(resolve => setTimeout(resolve, 5000))
                                 ]);
                             } catch(e) { console.log(`[Debug] chunkedExec finally page.close failed: ${e && e.message ? e.message : e}`); }
                         }
                     }
                });
            }
        };

        const workers = [];
        for(let j=0; j<Math.min(jobs, files.length); j++) {
            workers.push(executeNext());
        }
        await Promise.all(workers);
    };

    await chunkedExec(testFiles);

    // 4. Retry Logic
    // "all the retries should happen after all the cases run once"
    const failures = results.filter(r => r.result !== 'PASS');

    if (failures.length > 0) {
        if (process.env.SKIP_RETRY === 'true') {
            console.log(`\n[Info]  Found ${failures.length} failures. Skipping retries (SKIP_RETRY is set).`);
        } else {
            console.log(`\n[Warning]  First pass complete. Found ${failures.length} failures. Starting retries...`);
            console.log(`[Info] Closing main browser context to ensure fresh environments for retries.`);

            // Close Phase 1 browser/context to release resources/locks (important for PersistentContext)
            // Use currentContext/currentBrowser in case restarts happened during execution
            try {
               if (currentContext) await currentContext.close();
               if (currentBrowser && currentBrowser !== currentContext) await currentBrowser.close();

               // Also try closing original context if different, just in case
               if (context && context !== currentContext) await context.close();
            } catch(e) {
               console.log(`Ignorable error closing main browser: ${e.message}`);
            }

            for (let i = 0; i < failures.length; i++) {
                const result = failures[i];
                const testFile = result.fileName;
                const maxRetries = 3;
                let attempt = 1;
                // Initialize history with the failure from the first pass
                let retryHistory = [{
                    attempt: 0,
                    status: result.result,
                    passed: result.subcases ? result.subcases.passed : 0,
                    failed: result.subcases ? result.subcases.failed : 1,
                    total: result.subcases ? result.subcases.total : 1
                }];

                console.log(`\n[Retry] [${i+1}/${failures.length}] Retrying: ${result.testName}`);

                while (attempt <= maxRetries) {
                    let retryInstance = null;
                    try {
                        // "for each retry, we should launch a new browser context"
                        retryInstance = await this.launchNewBrowser();
                        const retryPage = retryInstance.page;

                        const res = await this.runSingleWptTest(retryPage, testFile, -1, -1, attempt);

                        // Retry crash detection: mark explicit crash when chrome://gpu reports a GPU crash.
                        try {
                            const retryGpuLog = await this.getGpuCrashLogInfo(retryInstance.context);
                            if (retryGpuLog.crashCount > 0) {
                                const crashLabel = '[CRASH]';
                                const crashDetails = Array.isArray(retryGpuLog.crashDetails) && retryGpuLog.crashDetails.length > 0
                                    ? ` Details: ${retryGpuLog.crashDetails.join(' || ')}`
                                    : '';
                                res.result = 'CRASH';
                                res.crashed = true;
                                res.error = res.error
                                    ? `${crashLabel} ${res.error}${crashDetails}`
                                    : `${crashLabel} GPU process crash detected from chrome://gpu logs during retry${crashDetails}`;
                            }
                        } catch (e) {
                            console.log(`[Debug] retry GPU crash check failed (best effort): ${e && e.message ? e.message : e}`);
                        }

                        retryHistory.push({
                            attempt,
                            status: res.result,
                            passed: res.subcases.passed,
                            failed: res.subcases.failed,
                            total: res.subcases.total
                        });

                        // Update result if passed or stabilized
                        if (res.result === 'PASS') {
                             console.log(`[Success] Retry ${attempt} PASSED!`);
                             result.result = 'PASS';
                             result.subcases = res.subcases;
                             result.retryHistory = retryHistory;
                             break; // Stop retrying this case
                        } else {
                             // Check if result is same as previous (using helper from base class)
                             if (this.compareTestResults(result, res)) {
                                 console.log(`[Warning]  Retry ${attempt} result matches previous failure. Stopping retries for this case.`);
                                 result.retryHistory = retryHistory;
                                 break;
                             }
                             // Update result to latest failure
                             result.result = res.result;
                             result.subcases = res.subcases;
                             result.error = res.error;
                             result.crashed = !!res.crashed;
                        }

                    } catch (e) {
                        const isCriticalError = e.message === 'GPUContextCreationError' ||
                                              e.message === 'HarnessError' ||
                                              e.message.includes('Protocol error') ||
                                              e.message.includes('Target.createTarget') ||
                                              e.message.includes('Target.close') ||
                                              e.message.includes('browserContext.newPage') ||
                                              e.message.includes('Target closed') ||
                                              e.message.includes('Timeout') ||
                                              e.name === 'TimeoutError';

                        if (isCriticalError) {
                            const crashLabel = '[CRASH]';
                            console.error(`[Fail] ${crashLabel} Error during retry ${attempt}: ${e.message}`);
                            result.result = 'CRASH';
                            result.error = `${crashLabel} ${e.message}`;
                            result.crashed = true;
                            retryHistory.push({ attempt, status: 'CRASH', error: e.message });
                        } else {
                            console.error(`[Fail] Error during retry ${attempt}: ${e.message}`);
                            retryHistory.push({ attempt, status: 'ERROR', error: e.message });
                        }
                    } finally {
                        if (retryInstance) {
                            try {
                               if (retryInstance.page && !retryInstance.page.isClosed()) await retryInstance.page.close();
                               if (retryInstance.context) await retryInstance.context.close();
                               if (retryInstance.browser && retryInstance.browser !== retryInstance.context) await retryInstance.browser.close();
                            } catch(e) { console.log(`[Debug] retry-phase retryInstance close failed: ${e && e.message ? e.message : e}`); }
                        }
                    }
                    attempt++;
                }
                if (!result.retryHistory) result.retryHistory = retryHistory;
            }
        }
    }

        this.writeFinalResultsCsv(results);
        return results;
  }

  async getGpuCrashLogInfo(context) {
    let gpuPage = null;
    const crashPattern = 'GpuProcessHost: The GPU process crashed!';

    try {
        gpuPage = await context.newPage();
        await Promise.race([
            gpuPage.goto('chrome://gpu', { waitUntil: 'domcontentloaded', timeout: 10000 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('chrome://gpu goto timeout')), 12000))
        ]);
        // Plain setTimeout — gpuPage.waitForTimeout hangs on a dead renderer.
        await new Promise(r => setTimeout(r, 1000));

        const crashInfo = await Promise.race([
            gpuPage.evaluate((pattern) => {
            const infoViewHost = document.querySelector('info-view');
            if (!infoViewHost || !infoViewHost.shadowRoot) {
                return { crashLines: [], crashDetails: [] };
            }

            const gpuLogMessages = Array.from(
                infoViewHost.shadowRoot.querySelectorAll('#content > div:last-child > ul > li')
            ).map((el) => (el.innerText || '').trim());

            const crashLines = [];
            const crashDetails = [];
            const contextDepth = 3;

            for (let i = 0; i < gpuLogMessages.length; i++) {
                const line = gpuLogMessages[i];
                if (!line || !line.includes(pattern)) continue;

                crashLines.push(line);

                const start = Math.max(0, i - contextDepth);
                const preLines = gpuLogMessages.slice(start, i).filter(Boolean);
                const detail = preLines.length > 0 ? `${preLines.join(' | ')} -> ${line}` : line;
                crashDetails.push(detail);
            }

            return { crashLines, crashDetails };
        }, crashPattern),
            new Promise((_, reject) => setTimeout(() => reject(new Error('chrome://gpu evaluate timeout')), 8000))
        ]);

        const crashLines = crashInfo.crashLines || [];
        const crashDetails = crashInfo.crashDetails || [];

        console.log(`[Info] Checked chrome://gpu logs. Crash count: ${crashLines.length} ${crashDetails}`);
        return {
            crashCount: crashLines.length,
            crashLines,
            crashDetails
        };
    } catch (e) {
        return {
            crashCount: 0,
            crashLines: [],
            crashDetails: [],
            error: e.message
        };
    } finally {
        if (gpuPage && !gpuPage.isClosed()) {
            try {
                await Promise.race([
                    gpuPage.close({ runBeforeUnload: false }),
                    new Promise(r => setTimeout(r, 3000))
                ]);
            } catch (e) { console.log(`[Debug] getGpuCrashLogInfo finally gpuPage.close failed: ${e && e.message ? e.message : e}`); }
        }
    }
  }

  // Removed runTestWithRetry as it's replaced by the retry logic above

  async runSingleWptTest(page, testFile, index, totalFiles, retryCount = 0) {
    const testFileName = testFile.replace('.js', '.html');
    const device = process.env.DEVICE || 'cpu';
    const testUrl = `https://wpt.live/webnn/conformance_tests/${testFileName}?device=${device}`;
    const testName = testFile.replace('.https.any.js', '').replace('.js', '');

    const backend = (process.env.CURRENT_CONFIG_NAME || '').trim() || 'UNKNOWN';
    let logPrefix = `Running test`;
    if (index >= 0 && totalFiles > 0) {
        logPrefix += ` ${index+1}/${totalFiles}`;
    }
    if (retryCount > 0) {
        logPrefix += ` [Retry ${retryCount}]`;
    }
    console.log(`[${backend}] ${logPrefix}: ${testName} ${testUrl}`);

    const runTest = async () => {
        // Helper: race any page operation against a hard timeout so dead renderers can't suspend the test.
        const withTimeout = (promise, ms, label) =>
            Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms (likely WhiteScreen crash)`)), ms))
            ]);

        // Helper: kill browser tree + best-effort close page when a crash is detected.
        const emergencyCleanup = async (reason) => {
            try { this.forceKillBrowserProcessTree(reason); } catch (e) { console.log(`[Debug] emergencyCleanup(${reason}) forceKill failed: ${e && e.message ? e.message : e}`); }
            if (page && !page.isClosed()) {
                try {
                    await Promise.race([
                        page.close({ runBeforeUnload: false }),
                        new Promise(resolve => setTimeout(resolve, 3000))
                    ]);
                } catch (e) { console.log(`[Debug] emergencyCleanup(${reason}) page.close failed: ${e && e.message ? e.message : e}`); }
            }
        };

        try {
            await withTimeout(
                page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
                35000,
                'page.goto'
            );
        } catch (gotoErr) {
            console.log(`[Fail] page.goto failed for ${testName}: ${gotoErr.message}. Force-killing browser...`);
            await emergencyCleanup('page.goto hang / white screen');
            throw new Error(`WhiteScreen: ${gotoErr.message}`);
        }

        // Check for white screen (browser crash renders blank page)
        let isWhiteScreen = true;
        try {
            isWhiteScreen = await withTimeout(
                page.evaluate(() => {
                    const body = document.body;
                    return !body || body.innerHTML.trim() === '' || body.textContent.trim() === '';
                }),
                5000,
                'whitescreen check'
            );
        } catch (e) {
            console.log(`[Debug] whitescreen check threw — assuming whitescreen: ${e && e.message ? e.message : e}`);
            isWhiteScreen = true;
        }

        if (isWhiteScreen) {
            await emergencyCleanup('white screen detected after goto');
            throw new Error('WhiteScreen: page rendered blank after navigation');
        }

        // GPU-process liveness check: if the dedicated `--type=gpu-process` child
        // has died (driver hang / GPU reset / OOM), the renderer survives as a
        // white screen but WebNN/WebGPU is unusable. Treat as a crash.
        try {
            if (!isGpuProcessAlive()) {
                await emergencyCleanup('gpu process crashed after goto');
                throw new Error('GPUProcessCrash: gpu-process child no longer running');
            }
        } catch (gpuErr) {
            if (gpuErr.message && gpuErr.message.startsWith('GPUProcessCrash')) throw gpuErr;
            // detection itself failed — ignore, don't false-positive
        }

        // check if encounter gpu context error or harness error
        let crashError = null;
        try {
            crashError = await withTimeout(page.evaluate(() => {
                const pre = document.evaluate('//*[@id="summary"]/section/pre[1]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (pre && pre.textContent.includes('Error: Unable to create context for gpu variant')) {
                    return 'GPUContextCreationError';
                }
                const summarySpan = document.evaluate('//*[@id="summary"]/section/p/span', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (summarySpan && (summarySpan.textContent.includes('Error'))) {
                     return 'HarnessError';
                }
                return null;
            }), 5000, 'crashError check');
        } catch (e) {
            console.log(`[Debug] crashError check hung/failed — treating as whitescreen: ${e && e.message ? e.message : e}`);
            await emergencyCleanup('crashError check hang / white screen');
            throw new Error('WhiteScreen: crashError check stalled');
        }

       if (crashError) {
            throw new Error(crashError);
       }

        // Use plain setTimeout instead of page.waitForTimeout — the latter hangs on a dead renderer.
        await new Promise(r => setTimeout(r, 3000));

        // Poll for results or detect white screen during test execution (up to 57s)
        const pollStart = Date.now();
        let pollIter = 0;
        while (Date.now() - pollStart < 57000) {
            let state = 'whitescreen';
            try {
                state = await withTimeout(
                    page.evaluate(() => {
                        const body = document.body;
                        if (!body || body.innerHTML.trim() === '' || body.textContent.trim() === '') return 'whitescreen';
                        if (document.querySelector('.status')) return 'done';
                        const text = body.textContent;
                        if (text.includes('Pass') || text.includes('Fail') || text.includes('Found') || text.includes('test')) return 'done';
                        return 'pending';
                    }),
                    5000,
                    'poll evaluate'
                );
            } catch (e) {
                console.log(`[Debug] poll evaluate threw — assuming whitescreen: ${e && e.message ? e.message : e}`);
                state = 'whitescreen';
            }

            if (state === 'whitescreen') {
                await emergencyCleanup('white screen during test execution');
                throw new Error('WhiteScreen: page went blank during test execution');
            }
            if (state === 'done') break;

            // Throttled GPU-process liveness probe (~every 5s) — catches GPU crashes
            // where the renderer keeps polling but never produces a result.
            if (++pollIter % 5 === 0) {
                try {
                    if (!isGpuProcessAlive()) {
                        await emergencyCleanup('gpu process crashed during test execution');
                        throw new Error('GPUProcessCrash: gpu-process child died mid-test');
                    }
                } catch (gpuErr) {
                    if (gpuErr.message && gpuErr.message.startsWith('GPUProcessCrash')) throw gpuErr;
                }
            }

            // Plain setTimeout — page.waitForTimeout hangs on a dead renderer.
            await new Promise(r => setTimeout(r, 1000));
        }


        // Parse results with robust logic from original file
        // Also scrape detailed failure info if verbose mode is enabled
        const verboseEnabled = true;

        const resData = await withTimeout(page.evaluate((scrapeDetails) => {
            const body = document.body.textContent;
            let subcases = { total: 0, passed: 0, failed: 0 };

            const pattern1 = body.match(/Found\s+(\d+)\s+tests?\s*(\d+)\s+Pass\s*(\d+)\s+Fail/i);
            const pattern1AllPass = body.match(/Found\s+(\d+)\s+tests?\s*(\d+)\s+Pass(?!\s*\d+\s+Fail)/i);
            const pattern2 = body.match(/(\d+)\/(\d+)\s+tests?\s+passed/i);
            const pattern3Passed = body.match(/(\d+)\s+passed/i);
            const pattern3Failed = body.match(/(\d+)\s+failed/i);
            const patternSimpleFail = body.match(/(\d+)\s+FAIL/i);
            const patternSimplePass = body.match(/(\d+)\s+PASS/i);

            if (pattern1) {
                subcases.total = parseInt(pattern1[1]);
                subcases.passed = parseInt(pattern1[2]);
                subcases.failed = parseInt(pattern1[3]);
            } else if (pattern1AllPass) {
                 subcases.total = parseInt(pattern1AllPass[1]);
                 subcases.passed = parseInt(pattern1AllPass[2]);
                 subcases.failed = 0;
            } else if (pattern2) {
                subcases.passed = parseInt(pattern2[1]);
                subcases.total = parseInt(pattern2[2]);
                subcases.failed = subcases.total - subcases.passed;
            } else if (pattern3Passed && pattern3Failed) {
                subcases.passed = parseInt(pattern3Passed[1]);
                subcases.failed = parseInt(pattern3Failed[1]);
                subcases.total = subcases.passed + subcases.failed;
            } else if (patternSimpleFail || patternSimplePass) {
                if (patternSimpleFail) subcases.failed = parseInt(patternSimpleFail[1]);
                if (patternSimplePass) subcases.passed = parseInt(patternSimplePass[1]);
                subcases.total = subcases.passed + subcases.failed;
            } else {
                const passCount = (body.match(/\bPASS\b/g) || []).length;
                const failCount = (body.match(/\bFAIL\b/g) || []).length;
                if (passCount + failCount > 0) {
                    subcases.passed = passCount;
                    subcases.failed = failCount;
                    subcases.total = passCount + failCount;
                }
            }

            // If still 0, try fallback guess
            if (subcases.total === 0) {
                const allNumbers = body.match(/\d+/g) || [];
                if (body.toLowerCase().includes('test') && allNumbers.length >= 2) {
                     subcases.total = Math.max(...allNumbers.map(n => parseInt(n)));
                     if (body.toLowerCase().includes('pass')) subcases.passed = subcases.total;
                }
            }

            // Fallback for completion
            if (subcases.total === 0) {
                 const lowerBody = body.toLowerCase();
                 if (lowerBody.includes('complete') || lowerBody.includes('finished')) {
                      subcases.total = 1;
                      if (lowerBody.includes('fail') || lowerBody.includes('error')) subcases.failed = 1;
                      else subcases.passed = 1;
                 }
            }

            let resultStatus = 'UNKNOWN';
            if (subcases.failed > 0) resultStatus = 'FAIL';
            else if (subcases.passed > 0) resultStatus = 'PASS';
            else if (subcases.total > 0 && subcases.passed === subcases.total) resultStatus = 'PASS';
            else if (body.includes('PASS')) { subcases.total=1; subcases.passed=1; resultStatus = 'PASS'; }
            else if (body.includes('FAIL')) { subcases.total=1; subcases.failed=1; resultStatus = 'FAIL'; }

            // Scrape detailed failure info if requested and there are failures
            let failedSubtests = [];
            if (scrapeDetails && subcases.failed > 0) {
                // WPT results structure: #results IS the table element (contains thead/tbody directly)
                // Don't use '#results table' as that matches nested empty tables in <details>
                const resultsTable = document.querySelector('#results');

                if (resultsTable) {
                    // Query direct child rows from tbody using :scope
                    const tbody = resultsTable.querySelector('tbody');
                    const allRows = tbody ? tbody.querySelectorAll(':scope > tr') : resultsTable.querySelectorAll(':scope > tr');

                    allRows.forEach(row => {
                        // Skip header rows
                        if (row.querySelector('th')) return;

                        const cells = row.querySelectorAll('td');
                        if (cells.length >= 2) {
                            const statusCell = cells[0];
                            const nameCell = cells[1];
                            const messageCell = cells[2];

                            const status = statusCell ? statusCell.textContent.trim().toUpperCase() : '';

                            if (status === 'FAIL' || status === 'TIMEOUT' || status === 'ERROR' || status === 'NOTRUN') {
                                // Test name is in the second column
                                const testName = nameCell ? nameCell.textContent.trim().split('\n')[0].substring(0, 300) : 'Unknown';

                                // Message is in the third column
                                let message = '';
                                if (messageCell) {
                                    const clone = messageCell.cloneNode(true);
                                    const details = clone.querySelector('details');
                                    if (details) details.remove();
                                    message = clone.textContent.trim().substring(0, 800);
                                }

                                failedSubtests.push({
                                    name: testName || 'Unknown subtest',
                                    status: status,
                                    message: message
                                });
                            }
                        }
                    });
                }
            }

            return { result: resultStatus, subcases, failedSubtests };
        }, verboseEnabled), 10000, 'result parsing');

        // If verbose mode is enabled and there are failures but no details captured, try scraping separately
        let failedSubtests = resData.failedSubtests || [];
        if (verboseEnabled && resData.subcases.failed > 0 && failedSubtests.length === 0) {
            // Wait a bit more for the table to populate (plain setTimeout so a dead renderer can't hang us)
            await new Promise(r => setTimeout(r, 1000));

            try {
                failedSubtests = await withTimeout(page.evaluate(() => {
                    const failures = [];

                    // #results IS the table element (contains thead/tbody directly)
                    // Don't look for a nested table - that matches the empty table in <details>
                    const resultsTable = document.querySelector('#results');

                    if (resultsTable) {
                        // Query rows from tbody using :scope to get direct children only
                        const tbody = resultsTable.querySelector('tbody');
                        const allRows = tbody ? tbody.querySelectorAll(':scope > tr') : resultsTable.querySelectorAll(':scope > tr');

                        allRows.forEach((row) => {
                            // Skip header rows
                            if (row.querySelector('th')) return;

                            const cells = row.querySelectorAll('td');

                            if (cells.length >= 2) {
                                const statusCell = cells[0];
                                const nameCell = cells[1];
                                const messageCell = cells[2];

                                const status = statusCell ? statusCell.textContent.trim().toUpperCase() : '';

                                if (status === 'FAIL' || status === 'TIMEOUT' || status === 'ERROR' || status === 'NOTRUN') {
                                    // Test name is in the second column
                                    const testName = nameCell ? nameCell.textContent.trim().split('\n')[0].substring(0, 300) : 'Unknown';

                                    // Message is in the third column, often starts with assertion text
                                    let message = '';
                                    if (messageCell) {
                                        // Get text before <details> and clean it up
                                        const clone = messageCell.cloneNode(true);
                                        const details = clone.querySelector('details');
                                        if (details) details.remove();
                                        message = clone.textContent.trim().substring(0, 800);
                                    }

                                    failures.push({
                                        name: testName,
                                        status: status,
                                        message: message
                                    });
                                }
                            }
                        });
                    }
                    return failures;
                }), 10000, 'failure scrape');
            } catch (e) {
                // Scraping failed, continue without details
            }
        }

        // Log captured failures
        if (failedSubtests && failedSubtests.length > 0) {
            console.log(`[${testName}] Captured ${failedSubtests.length} failed subtest(s) details`);
        }

        console.log(`[${backend}] [${testName}] ${resData.result}: ${resData.subcases.passed} PASS, ${resData.subcases.failed} FAIL`);

        return {
            testName,
            testUrl,
            suite: 'WPT',
            result: resData.result,
            subcases: resData.subcases,
            failedSubtests: failedSubtests && failedSubtests.length > 0 ? failedSubtests : undefined,
            executionTime: '0.00'
        };
    };

    try {
        // Enforce 2 minute global timeout for the test case
        return await Promise.race([
            runTest(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 120000ms exceeded')), 120000))
        ]);
    } catch (e) {
        // Rethrow critical errors to trigger browser restart in chunkedExec
        if (e.message.includes('Timeout') ||
            e.message.includes('Target closed') ||
            e.message.includes('Protocol error') ||
            e.message.includes('GPUContextCreationError') ||
            e.message.includes('HarnessError') ||
            e.message.includes('WhiteScreen') ||
            e.name === 'TimeoutError') {
            throw e;
        }

        return {
            testName,
            suite: 'WPT',
            result: 'ERROR',
            subcases: { total: 0, passed: 0, failed: 0 },
            error: e.message
        };
    }
  }
}

module.exports = { WptRunner };
