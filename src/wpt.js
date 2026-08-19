
const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { WebNNRunner, killOwnBrowserProcesses, armHangKillWatchdog, withHangKill } = require('./util');

class WptRunner extends WebNNRunner {
    writeFinalResultsCsv(results) {
        const csvEscape = (value) => {
            const text = value == null ? '' : String(value);
            return `"${text.replace(/"/g, '""')}"`;
        };

        const testCaseName = (r) => r.testName || r.fileName || '';

        const lines = [];
        lines.push(['Backend', 'Test Suite', 'Test Case', 'Status', 'Message'].map(csvEscape).join(','));

        for (const r of results) {
            const backend = r.backend;
            const caseName = testCaseName(r);
            const hasFailedSubtests = Array.isArray(r.failedSubtests) && r.failedSubtests.length > 0;

            if (hasFailedSubtests) {
                // Emit one row per failed subtest so each failure is on its own line.
                for (const s of r.failedSubtests) {
                    const subName = s.name || 'subtest';
                    const status = (s.status || r.result || 'FAIL').toString().toUpperCase();
                    const message = s.message || '';
                    lines.push([
                        backend,
                        'WPT',
                        `${caseName} - ${subName}`,
                        status,
                        message
                    ].map(csvEscape).join(','));
                }
            } else {
                lines.push([
                    backend,
                    'WPT',
                    caseName,
                    r.result || 'UNKNOWN',
                    r.error || ''
                ].map(csvEscape).join(','));
            }
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
    // Per-case timeouts (configurable via env). Some WPT conformance tests
    // (e.g. reshape on NPU/OV) can take well over a minute to complete, and
    // 60s was too aggressive for slower backends. Defaults were raised and
    // the outer chunked-exec timeout is kept comfortably larger than the
    // inner per-case timeout so the inner Promise.race always wins first.
    const caseTimeoutMs = parseInt(process.env.WPT_CASE_TIMEOUT_MS, 10) || 180000; // 3 min per test case (inner)
    const chunkTimeoutMs = parseInt(process.env.WPT_CHUNK_TIMEOUT_MS, 10) || (caseTimeoutMs + 60000); // outer wrapper
    // Hang-kill watchdog: when a test step (including its cleanup) exceeds
    // this budget, force-kill our Chrome processes to unblock any Playwright
    // IPC calls that are stuck at the browser side. This is the last-resort
    // safety net when the inner Promise.race timeout also can't recover
    // because the follow-up page.close()/context.close() awaits are hung.
    const hangKillTimeoutMs = parseInt(process.env.WPT_HANG_KILL_TIMEOUT_MS, 10) || (chunkTimeoutMs + 30000);
    // Short per-op timeout used inside the finally block so a wedged
    // page.close()/context.close()/browser.close() can't hang the run.
    const closeOpTimeoutMs = parseInt(process.env.WPT_CLOSE_OP_TIMEOUT_MS, 10) || 15000;
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
                     // Arm hang-kill watchdog for this whole step (execution +
                     // cleanup). If anything below hangs longer than
                     // hangKillTimeoutMs — including the finally-block awaits —
                     // we force-kill our Chrome processes so pending Playwright
                     // IPC calls fail fast and the run makes forward progress.
                     const hangWatchdog = armHangKillWatchdog(
                         hangKillTimeoutMs,
                         `WPT test step ${testFile}`,
                         this.browserRootPid
                     );
                     try {
                         // For isolation: kill/relaunch browser for every conformance test.
                         while (isRestarting) await new Promise(r => setTimeout(r, 100));
                         isRestarting = true;
                         try {
                             const instance = await this.restartBrowserAndContext(currentBrowser);
                             currentBrowser = instance.browser || instance.context;
                             currentContext = instance.context;
                             this.page = instance.page;
                         } finally {
                             isRestarting = false;
                         }

                         if (!currentContext) {
                             throw new Error('No browser context available after relaunch');
                         }

                         page = await currentContext.newPage();
                         // Run test (Attempt 0)
                         const start = Date.now();
                         const res = await Promise.race([
                             this.runSingleWptTest(page, testFile, i, files.length, 0),
                             new Promise((_, reject) => {
                                 const timeoutError = new Error(`Test timeout ${chunkTimeoutMs}ms exceeded`);
                                 timeoutError.name = 'ChunkedExecTimeoutError';
                                 setTimeout(() => reject(timeoutError), chunkTimeoutMs);
                             })
                         ]);
                         res.executionTime = ((Date.now() - start) / 1000).toFixed(2);
                         res.fileName = testFile; // Store filename for retry

                         if (enableGpuCrashLogHandler) {
                             // Check chrome://gpu log messages and mark this test as crash if a new crash log appeared.
                             const gpuLog = await this.getGpuCrashLogInfo(currentContext);
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
                         // Classify timeouts before critical/crash errors so a slow/hung
                         // test is reported as TIMEOUT rather than CRASH. Any error whose
                         // name is a timeout name, or whose message contains "Timeout" /
                         // "ms exceeded" (both our inner Promise.race and the outer
                         // chunked-exec wrapper produce such messages), is a timeout.
                         const isTimeoutError = e.name === 'ChunkedExecTimeoutError' ||
                                              e.name === 'TimeoutError' ||
                                              (e.message && (/ms exceeded/i.test(e.message) || /timeout/i.test(e.message)));
                         const isCriticalError = !isTimeoutError && (
                                               e.message === 'GPUContextCreationError' ||
                                               e.message === 'HarnessError' ||
                                               e.message.includes('Protocol error') ||
                                               e.message.includes('Target.createTarget') ||
                                               e.message.includes('Target.close') ||
                                               e.message.includes('browserContext.newPage') ||
                                               e.message.includes('Target closed'));

                         if (isTimeoutError) {
                             console.log(`[Fail] Timeout for ${testFile} (${e.message}). Marking as TIMEOUT and restarting browser...`);

                             // Best-effort: scrape whatever the WPT harness produced
                             // before our per-case cap fired. This preserves the
                             // subtests that already completed (pass/fail/timeout)
                             // so the report reflects real progress instead of a
                             // synthetic {total:1, passed:0, failed:1}. The overall
                             // case status stays TIMEOUT.
                             let partialSubcases = { total: 1, passed: 0, failed: 1 };
                             let partialFailedSubtests;
                             let partialSummary = '';
                             try {
                                 if (page && !page.isClosed()) {
                                     const partial = await Promise.race([
                                         this.parseWptPageResults(page, true),
                                         new Promise((resolve) => setTimeout(() => resolve(null), 5000))
                                     ]);
                                     if (partial && partial.subcases && partial.subcases.total > 0) {
                                         partialSubcases = partial.subcases;
                                         if (partial.failedSubtests && partial.failedSubtests.length > 0) {
                                             partialFailedSubtests = partial.failedSubtests;
                                         }
                                         partialSummary = ` Partial: ${partial.subcases.passed}P/${partial.subcases.failed}F/${partial.subcases.total}T.`;
                                     }
                                 }
                             } catch (_) { /* best-effort */ }

                             if (partialSummary) {
                                 console.log(`[Info] Preserved partial WPT results for ${testFile}:${partialSummary}`);
                             }

                             results.push({
                                 testName: testFile,
                                 fileName: testFile,
                                 suite: 'WPT',
                                 result: 'TIMEOUT',
                                 subcases: partialSubcases,
                                 failedSubtests: partialFailedSubtests,
                                 error: `${e.message}.${partialSummary}`
                             });

                             if (!isRestarting) {
                                 isRestarting = true;
                                 try {
                                     const instance = await this.restartBrowserAndContext(currentBrowser);
                                     currentBrowser = instance.browser || instance.context;
                                     currentContext = instance.context;
                                     this.page = instance.page;
                                 } catch (restartError) {
                                     console.error(`[Fail] Fatal error restarting browser after timeout: ${restartError.message}`);
                                 } finally {
                                     isRestarting = false;
                                 }
                             }
                         }

                         // Handle Critical Context Errors (GPU, Protocol, Harness, etc.)
                         else if (isCriticalError) {
                             let errorType = 'Browser/Protocol Error';
                             if (e.message === 'GPUContextCreationError') errorType = 'GPU Context Creation Failed';
                             else if (e.message === 'HarnessError') errorType = 'Harness Error (Restarting)';
                             const crashLabel = '[CRASH]';

                             console.log(`[Fail] ${errorType} for ${testFile} (${e.message}). Triggering browser restart...`);

                             results.push({
                                 testName: `${crashLabel} ${testFile}`,
                                 fileName: testFile,
                                 suite: 'WPT',
                                 result: 'CRASH',
                                 subcases: {total:1, passed:0, failed:1},
                                 error: `${crashLabel} ${errorType}`,
                                 crashed: true
                             });

                             // Acquire lock to restart
                             if (!isRestarting) {
                                 isRestarting = true;
                                 try {
                                     const instance = await this.restartBrowserAndContext(currentBrowser);
                                     currentBrowser = instance.browser || instance.context;
                                     currentContext = instance.context;
                                     this.page = instance.page;
                                     // Update global context reference if possible or just use currentContext in loop
                                     // Note: context passed to runWptTests is local, so we rely on currentContext
                                 } catch (restartError) {
                                     console.error(`[Fail] Fatal error restarting browser: ${restartError.message}`);
                                 } finally {
                                     isRestarting = false;
                                 }
                             }
                         } else {
                             console.error(`Error executing ${testFile}: ${e}`);
                             results.push({
                                 testName: testFile, // Fallback name
                                 fileName: testFile,
                                 suite: 'WPT',
                                 result: 'ERROR',
                                 subcases: {total:1, passed:0, failed:1},
                                 error: e.message
                             });
                         }
                     } finally {
                         // Guard each close with a short timeout so a wedged
                         // Playwright IPC can't hang the run. The final
                         // killOwnBrowserProcesses call is synchronous
                         // (taskkill) and will unblock anything still pending.
                         const guardedClose = async (closable, label) => {
                             if (!closable) return;
                             try {
                                 await Promise.race([
                                     closable.close(),
                                     new Promise((_, reject) => setTimeout(
                                         () => reject(new Error(`${label}.close() timeout ${closeOpTimeoutMs}ms`)),
                                         closeOpTimeoutMs
                                     ))
                                 ]);
                             } catch (err) {
                                 console.log(`[Warning] ${label}.close() failed/timed out: ${err.message}`);
                             }
                         };
                         if (page && !page.isClosed()) {
                             await guardedClose(page, 'page');
                         }
                         // Explicitly close the current browser/context and sweep any
                         // leftover chrome/msedge processes matching our user-data-dir.
                         // Playwright's close() alone leaves renderer/GPU/utility
                         // processes behind; without this sweep dozens of stale processes
                         // accumulate over a full WPT run.
                         try {
                             if (currentContext) await guardedClose(currentContext, 'context');
                             if (currentBrowser && currentBrowser !== currentContext) {
                                 await guardedClose(currentBrowser, 'browser');
                             }
                             currentContext = null;
                             currentBrowser = null;
                             this.page = null;
                         } catch (_) {}
                         try { killOwnBrowserProcesses(null); } catch(e) {}
                         // Disarm the per-step hang-kill watchdog. If it
                         // already fired we log; the sweep above has already
                         // killed the browser so the next test will relaunch.
                         if (hangWatchdog.fired()) {
                             console.error(`[HangKill] Test step ${testFile} was force-killed after ${hangKillTimeoutMs}ms hang.`);
                         }
                         hangWatchdog.disarm();
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
                // Track whether any retry attempt has completed the test harness
                // (returned a real result, not thrown a critical exception). Once we
                // have such a result, subsequent critical exceptions must NOT overwrite
                // it with CRASH — the "last completed retry" outcome wins over
                // exception-path crashes so a first-pass CRASH is correctly replaced
                // by FAIL/PASS observed in retries.
                let hasCompletedRetry = false;
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
                    // Same hang-kill safety net for the retry pass. Without
                    // this, a retry that wedges on Playwright IPC would keep
                    // the run stuck indefinitely (Promise.race can't recover
                    // if the finally-block close() awaits also hang).
                    const retryHangWatchdog = armHangKillWatchdog(
                        hangKillTimeoutMs,
                        `WPT retry ${attempt} for ${testFile}`,
                        this.browserRootPid
                    );
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
                        } catch (_) {
                            // Best effort only; retry result parsing should continue.
                        }

                        retryHistory.push({
                            attempt,
                            status: res.result,
                            passed: res.subcases.passed,
                            failed: res.subcases.failed,
                            total: res.subcases.total
                        });

                        // Mark that this retry completed the harness. We use this to
                        // prevent later exception-path handlers from downgrading the
                        // final status back to CRASH.
                        hasCompletedRetry = true;

                        // Always replace the first-pass status with the latest retry
                        // outcome — the retry results are authoritative over the
                        // initial CRASH/FAIL. A PASS additionally stops retries.
                        if (res.result === 'PASS') {
                             console.log(`[Success] Retry ${attempt} PASSED!`);
                             result.result = 'PASS';
                             result.subcases = res.subcases;
                             result.error = undefined;
                             result.crashed = false;
                             // Strip any leading [CRASH] label added on the first pass so
                             // the reported case name reflects the retry outcome.
                             if (typeof result.testName === 'string') {
                                 result.testName = result.testName.replace(/^\s*\[CRASH\]\s*/, '');
                             }
                             result.retryHistory = retryHistory;
                             break; // Stop retrying this case
                        }

                        // Non-PASS: update result to reflect the latest retry outcome,
                        // replacing the initial CRASH/FAIL. This ensures a FAIL from a
                        // retry replaces a CRASH from the first pass.
                        result.result = res.result;
                        // If the retry produced an UNKNOWN with no parseable subcase
                        // counts (e.g. the page was a 504/timeout/error page), keep
                        // the initial run's subcase totals so the summary doesn't
                        // report "0/0/0" (or worse, a stale garbage number) for a
                        // test that actually has a known subcase count.
                        const retryUnparseable =
                            res.result === 'UNKNOWN' &&
                            (!res.subcases || (res.subcases.total === 0 && res.subcases.passed === 0 && res.subcases.failed === 0));
                        if (!retryUnparseable) {
                            result.subcases = res.subcases;
                        }
                        result.error = res.error;
                        result.crashed = !!res.crashed;
                        if (typeof result.testName === 'string') {
                            const hadCrashLabel = /^\s*\[CRASH\]\s*/.test(result.testName);
                            if (hadCrashLabel && res.result !== 'CRASH') {
                                // No longer a crash — drop the stale [CRASH] label.
                                result.testName = result.testName.replace(/^\s*\[CRASH\]\s*/, '');
                            }
                        }

                        // Stop retrying if this retry stabilized on the same failure.
                        if (this.compareTestResults(result, res)) {
                            console.log(`[Warning]  Retry ${attempt} result matches previous failure. Stopping retries for this case.`);
                            result.retryHistory = retryHistory;
                            break;
                        }

                    } catch (e) {
                        // Detect timeouts separately from other critical errors: a
                        // timeout is a slow/hung test, not a browser/GPU crash, so it
                        // must not be labeled [CRASH].
                        const isTimeoutError = e.name === 'ChunkedExecTimeoutError' ||
                                               e.name === 'TimeoutError' ||
                                               (e.message && (/ms exceeded/i.test(e.message) || /timeout/i.test(e.message)));
                        const isCriticalError = !isTimeoutError && (
                                              e.message === 'GPUContextCreationError' ||
                                              e.message === 'HarnessError' ||
                                              e.message.includes('Protocol error') ||
                                              e.message.includes('Target.createTarget') ||
                                              e.message.includes('Target.close') ||
                                              e.message.includes('browserContext.newPage') ||
                                              e.message.includes('Target closed'));

                        if (isTimeoutError) {
                            console.error(`[Fail] Timeout during retry ${attempt}: ${e.message}`);

                            // Best-effort: scrape any partial WPT results the
                            // retry page produced before our per-case cap fired.
                            let partialSubcases = null;
                            let partialFailedSubtests;
                            let partialSummary = '';
                            try {
                                const retryPage = retryInstance && retryInstance.page;
                                if (retryPage && !retryPage.isClosed()) {
                                    const partial = await Promise.race([
                                        this.parseWptPageResults(retryPage, true),
                                        new Promise((resolve) => setTimeout(() => resolve(null), 5000))
                                    ]);
                                    if (partial && partial.subcases && partial.subcases.total > 0) {
                                        partialSubcases = partial.subcases;
                                        if (partial.failedSubtests && partial.failedSubtests.length > 0) {
                                            partialFailedSubtests = partial.failedSubtests;
                                        }
                                        partialSummary = ` Partial: ${partial.subcases.passed}P/${partial.subcases.failed}F/${partial.subcases.total}T.`;
                                    }
                                }
                            } catch (_) { /* best-effort */ }

                            if (partialSummary) {
                                console.log(`[Info] Preserved partial WPT results for retry ${attempt}:${partialSummary}`);
                            }

                            // Only overwrite the final status if we have not yet
                            // observed a completed retry. Timeouts are recorded as
                            // TIMEOUT (never CRASH) and never get a [CRASH] prefix.
                            if (!hasCompletedRetry) {
                                result.result = 'TIMEOUT';
                                result.error = `${e.message}.${partialSummary}`;
                                result.crashed = false;
                                if (partialSubcases) {
                                    result.subcases = partialSubcases;
                                }
                                if (partialFailedSubtests) {
                                    result.failedSubtests = partialFailedSubtests;
                                }
                                if (typeof result.testName === 'string') {
                                    result.testName = result.testName.replace(/^\s*\[CRASH\]\s*/, '');
                                }
                            }
                            retryHistory.push({
                                attempt,
                                status: 'TIMEOUT',
                                passed: partialSubcases ? partialSubcases.passed : 0,
                                failed: partialSubcases ? partialSubcases.failed : 1,
                                total: partialSubcases ? partialSubcases.total : 1,
                                error: `${e.message}${partialSummary}`
                            });
                        } else if (isCriticalError) {
                            const crashLabel = '[CRASH]';
                            console.error(`[Fail] ${crashLabel} Error during retry ${attempt}: ${e.message}`);
                            // Only downgrade the final status to CRASH if we have not
                            // yet observed a completed retry. Otherwise, preserve the
                            // "last completed retry" outcome (PASS/FAIL) — a subsequent
                            // browser/protocol crash should not wipe out a real result.
                            if (!hasCompletedRetry) {
                                result.result = 'CRASH';
                                result.error = `${crashLabel} ${e.message}`;
                                result.crashed = true;
                            }
                            retryHistory.push({
                                attempt,
                                status: 'CRASH',
                                passed: 0,
                                failed: 1,
                                total: 1,
                                error: e.message
                            });
                        } else {
                            console.error(`[Fail] Error during retry ${attempt}: ${e.message}`);
                            retryHistory.push({
                                attempt,
                                status: 'ERROR',
                                passed: 0,
                                failed: 1,
                                total: 1,
                                error: e.message
                            });
                        }
                    } finally {
                        if (retryInstance) {
                            const guardedRetryClose = async (closable, label) => {
                                if (!closable) return;
                                try {
                                    await Promise.race([
                                        closable.close(),
                                        new Promise((_, reject) => setTimeout(
                                            () => reject(new Error(`retry ${label}.close() timeout ${closeOpTimeoutMs}ms`)),
                                            closeOpTimeoutMs
                                        ))
                                    ]);
                                } catch (err) {
                                    console.log(`[Warning] retry ${label}.close() failed/timed out: ${err.message}`);
                                }
                            };
                            try {
                                if (retryInstance.page && !retryInstance.page.isClosed()) {
                                    await guardedRetryClose(retryInstance.page, 'page');
                                }
                                if (retryInstance.context) await guardedRetryClose(retryInstance.context, 'context');
                                if (retryInstance.browser && retryInstance.browser !== retryInstance.context) {
                                    await guardedRetryClose(retryInstance.browser, 'browser');
                                }
                            } catch(e) {}
                        }
                        // Playwright's soft close() often leaves orphan renderer/GPU/utility
                        // processes behind. Sweep any chrome/msedge processes still using our
                        // user-data-dir so we don't accumulate dozens of processes over a run.
                        try { killOwnBrowserProcesses(null); } catch(e) {}
                        if (retryHangWatchdog.fired()) {
                            console.error(`[HangKill] Retry ${attempt} for ${testFile} was force-killed after ${hangKillTimeoutMs}ms hang.`);
                        }
                        retryHangWatchdog.disarm();
                    }
                    attempt++;
                }
                if (!result.retryHistory) result.retryHistory = retryHistory;
            }
        }
    }

        // Final cleanup: make sure no chrome/msedge processes from this run
        // are left behind when runWptTests returns.
        try { killOwnBrowserProcesses(null); } catch(e) {}

        return results;
  }

  async getGpuCrashLogInfo(context) {
    let gpuPage = null;
    const crashPattern = 'GpuProcessHost: The GPU process crashed!';

    try {
        gpuPage = await context.newPage();
        await gpuPage.goto('chrome://gpu', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await gpuPage.waitForTimeout(1000);

        const crashInfo = await gpuPage.evaluate((pattern) => {
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
        }, crashPattern);

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
            try { await gpuPage.close(); } catch (e) {}
        }
    }
  }

  // Removed runTestWithRetry as it's replaced by the retry logic above

  /**
   * Scrape WPT harness results from the current page. Extracted from
   * runSingleWptTest so it can also be called from the chunkedExec timeout
   * handler to preserve partial subcase results when our per-case cap fires
   * mid-run. Best-effort: returns { result, subcases, failedSubtests } and
   * never throws (returns null on failure).
   *
   * @param {import('@playwright/test').Page} page
   * @param {boolean} scrapeDetails - When true, populate failedSubtests[].
   */
  async parseWptPageResults(page, scrapeDetails = true) {
    if (!page || page.isClosed()) return null;
    try {
        return await page.evaluate((scrapeDetails) => {
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

            // NOTE: Do NOT attempt to "guess" the subcase total by grabbing arbitrary
            // numbers from the page body. Error pages (e.g. "504 Gateway Timeout",
            // stack traces, timestamps) contain numbers that have no relation to the
            // subcase count and produced misleading totals like "504" for tests that
            // actually have 25 subcases. If no explicit "N Pass / N Fail / N tests"
            // pattern was matched above, leave subcases at 0 and let resultStatus
            // fall through to UNKNOWN so the report reflects reality.

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
        }, scrapeDetails);
    } catch (e) {
        return null;
    }
  }

  async runSingleWptTest(page, testFile, index, totalFiles, retryCount = 0) {
    const testFileName = testFile.replace('.js', '.html');
    const device = process.env.DEVICE || 'cpu';
    const testUrl = `https://wpt.live/webnn/conformance_tests/${testFileName}?device=${device}`;
    const testName = testFile.replace('.https.any.js', '').replace('.js', '');

    // Per-case timeout (configurable). Previously hard-coded to 60000ms which
    // was too short for slower backends (e.g. NPU/OV reshape/abs). Bumped to
    // 180s by default and made env-configurable.
    const caseTimeoutMs = parseInt(process.env.WPT_CASE_TIMEOUT_MS, 10) || 180000;
    // Navigation / selector waits scale with case timeout but capped separately
    // so a single slow page load can't burn the whole per-case budget.
    const navTimeoutMs = parseInt(process.env.WPT_NAV_TIMEOUT_MS, 10) || Math.min(caseTimeoutMs, 90000);

    let logPrefix = `Running test`;
    if (index >= 0 && totalFiles > 0) {
        logPrefix += ` ${index+1}/${totalFiles}`;
    }
    if (retryCount > 0) {
        logPrefix += ` [Retry ${retryCount}]`;
    }
    console.log(`${logPrefix}: ${testName}`);

    const runTest = async () => {
        await page.goto(testUrl, { waitUntil: 'networkidle', timeout: navTimeoutMs });

        // check if encounter gpu context error or harness error
        const crashError = await page.evaluate(() => {
            const pre = document.evaluate('//*[@id="summary"]/section/pre[1]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (pre && pre.textContent.includes('Error: Unable to create context for gpu variant')) {
                return 'GPUContextCreationError';
            }

            const summarySpan = document.evaluate('//*[@id="summary"]/section/p/span', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (summarySpan && (summarySpan.textContent.includes('Error'))) {
                 return 'HarnessError';
            }
            return null;
       });

       if (crashError) {
            throw new Error(crashError);
       }

        await page.waitForTimeout(3000);

        // Wait for results indicator
        try {
             // Check if .status selector exists first
            const hasStatusSelector = await page.evaluate(() => document.querySelector('.status') !== null);
            if (hasStatusSelector) {
                await page.waitForSelector('.status', { timeout: navTimeoutMs });
            } else {
                await page.waitForFunction(() =>
                    document.body.textContent.includes('Pass') ||
                    document.body.textContent.includes('Fail') ||
                    document.body.textContent.includes('Found') ||
                    document.body.textContent.includes('test'),
                    { timeout: navTimeoutMs }
                );
            }
        } catch(e) { /* proceed */ }

        await page.waitForTimeout(2000);

        // Parse results with robust logic from original file
        // Also scrape detailed failure info if verbose mode is enabled
        const verboseEnabled = true;

        const resData = await this.parseWptPageResults(page, verboseEnabled);

        // If verbose mode is enabled and there are failures but no details captured, try scraping separately
        let failedSubtests = resData.failedSubtests || [];
        if (verboseEnabled && resData.subcases.failed > 0 && failedSubtests.length === 0) {
            // Wait a bit more for the table to populate
            await page.waitForTimeout(1000);

            try {
                failedSubtests = await page.evaluate(() => {
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
                });
            } catch (e) {
                // Scraping failed, continue without details
            }
        }

        // Log captured failures
        if (failedSubtests && failedSubtests.length > 0) {
            console.log(`[${testName}] Captured ${failedSubtests.length} failed subtest(s) details`);
        }

        console.log(`[${testName}] ${resData.result}: ${resData.subcases.passed} PASS, ${resData.subcases.failed} FAIL`);

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
        // Enforce a global per-case timeout (configurable via WPT_CASE_TIMEOUT_MS,
        // default 180000ms). The error message includes the configured value so
        // the chunkedExec catch (and retry logic) can identify it as a TIMEOUT.
        return await Promise.race([
            runTest(),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error(`Timeout ${caseTimeoutMs}ms exceeded`)),
                caseTimeoutMs
            ))
        ]);
    } catch (e) {
        // Rethrow critical errors to trigger browser restart in chunkedExec
        if (e.message.includes('Timeout') ||
            e.message.includes('Target closed') ||
            e.message.includes('Protocol error') ||
            e.message.includes('GPUContextCreationError') ||
            e.message.includes('HarnessError') ||
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
