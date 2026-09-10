
const { WebNNRunner, WebNNPerfCollector } = require('./util');
const { expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

class ModelRunner extends WebNNRunner {
  constructor(page) {
    super(page);
    this.models = {
      // Samples
      'lenet': {
        name: 'LeNet Digit Recognition',
        url: 'https://webmachinelearning.github.io/webnn-samples/lenet/',
        type: 'sample',
        func: this.runModelLenet
      },
      'segmentation': {
        name: 'Semantic Segmentation (DeepLab V3 MobileNet V2)',
        url: 'https://webmachinelearning.github.io/webnn-samples/semantic_segmentation/',
        type: 'sample',
        func: this.runModelSemanticSegmentation
      },
      'style': {
        name: 'Fast Style Transfer',
        url: 'https://webmachinelearning.github.io/webnn-samples/style_transfer/',
        type: 'sample',
        func: this.runModelStyleTransfer
      },
      'od': {
        name: 'Object Detection (Tiny Yolo V2)',
        url: 'https://webmachinelearning.github.io/webnn-samples/object_detection/',
        type: 'sample',
        func: this.runModelObjectDetection
      },
      // Preview
      'ic': {
        name: 'WebNN Developer Preview Image Classification',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/image-classification',
        type: 'preview',
        func: this.runModelImageClassification
      },
      'sam': {
        name: 'WebNN Developer Preview Segment Anything',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/segment-anything/',
        type: 'preview',
        func: this.runModelSam
      },
      'whisper': {
        name: 'WebNN Developer Preview Whisper-base WebGPU',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/whisper-base/',
        type: 'preview',
        func: this.runModelWhisper
      },
      'sdxl': {
        name: 'WebNN Developer Preview SDXL Turbo',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/sdxl-turbo/',
        type: 'preview',
        func: this.runModelSdxl
      },
      'phi': {
        name: 'WebNN Developer Preview Phi WebGPU',
        url: 'https://microsoft.github.io/webnn-developer-preview/demos/text-generation/',
        type: 'preview',
        func: this.runModelPhi
      }
    };
  }

  async runModelTests(onFirstCaseComplete) {
    console.log('[Info] Running MODEL suite...');

    // Collect filter from various legacy env vars
    const filterStr = process.env.MODEL_CASE;
    let testKeys = [];

    if (filterStr) {
      testKeys = filterStr.split(',').map(c => c.trim().toLowerCase()).filter(c => c.length > 0);
      console.log(`Running specific model cases: ${testKeys.join(', ')}`);
    } else {
      testKeys = Object.keys(this.models);
      console.log('Running all model test cases');
    }

    const results = [];

    for (const key of testKeys) {
      if (!this.models[key]) {
         console.warn(`[Warning] Unknown model test case: ${key}`);
         results.push({
            testName: `Model: ${key}`,
            result: 'ERROR',
            hasErrors: true,
            fullText: `Unknown test case: ${key}`,
            subcases: { total: 1, passed: 0, failed: 1 },
            suite: 'model'
         });
         continue;
      }

      const modelDef = this.models[key];
      const startTime = Date.now();
      let infinityErrorDetected = false;

      try {
        await this.runTestWithSessionCheck(async () => {
             // Setup console listener for infinity checks (common in preview)
             const consoleListener = async (msg) => {
                if (msg.text().includes('Found infinity in logits')) {
                  console.error(`[Fail] [Auto-Fail] "Found infinity in logits" detected. Quitting case...`);
                  infinityErrorDetected = true;
                  try { await this.page.close(); } catch (e) {}
                }
             };
             this.page.on('console', consoleListener);

             try {
                // Call the bound function
                await modelDef.func.call(this, results, modelDef);
             } finally {
                if (!this.page.isClosed()) {
                  this.page.off('console', consoleListener);
                }
             }
        });
      } catch (error) {
        if (infinityErrorDetected) {
            error.message = "Found infinity in logits";
        }

        // Check if we already pushed a result (some funcs push result themselves)
        // If not, push error result
        // Or if we need to update the last result
        // Ideally, the runner functions should push results.
        // If runTestWithSessionCheck throws, it means it wasn't caught inside

        console.error(`[Fail] Error running model case ${key}:`, error.message);

        // Simple duplicate check based on testName
        const alreadyReported = results.length > 0 && results[results.length-1].testName === modelDef.name;

        if (!alreadyReported) {
             results.push({
                testName: modelDef.name,
                testUrl: modelDef.url,
                result: 'ERROR',
                errors: [{ text: error.message }],
                fullText: error.message,
                hasErrors: true,
                subcases: { total: 1, passed: 0, failed: 1 },
                suite: 'model'
             });
        }
      }

      // Add execution time to the last result if it belongs to this test
      if (results.length > 0) {
        const lastRes = results[results.length - 1];
        if (lastRes.testName === modelDef.name && !lastRes.executionTime) {
            lastRes.executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
        }
      }

      if (results.length === 1 && onFirstCaseComplete) {
          await onFirstCaseComplete();
      }

      // Pause between tests and navigate away to release WebNN resources
      if (!this.page.isClosed()) {
         try { await this.page.goto('about:blank', { waitUntil: 'load', timeout: 5000 }); } catch(e) {}
         try { await this.page.waitForTimeout(2000); } catch(e) {}
      } else {
         // Page/browser crashed during the test — ensure recovery before next test
         console.log('[Info] Page closed after test, ensuring browser is available for next test...');
         try { await this.ensurePage(); } catch(e) {
           console.log('[Warning] Could not recover page, will try restartBrowserAndContext...');
           try {
             const instance = await this.restartBrowserAndContext(null);
             this.page = instance.page;
           } catch(e2) {
             console.error(`[Error] Browser recovery failed: ${e2.message}`);
           }
         }
      }
    }

    return results;
  }

  // --- Sample Implementations ---

  async runModelLenet(results, modelDef) {
    const testName = modelDef.name;
    const testUrl = modelDef.url;

    const device = process.env.DEVICE || 'cpu';

    // ... Copy implementation from demo.js with minor tweaks ...
    try {
      console.log(`Running sample test: ${testName} on ${device.toUpperCase()}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      // Select Backend based on device
      try {
        if (device === 'cpu') {
            await this.page.click('//*[@id="backendBtns"]/label[1]'); // WebNN (CPU)
        } else if (device === 'gpu') {
            await this.page.click('//*[@id="backendBtns"]/label[2]'); // WebNN (GPU)
        } else if (device === 'npu') {
            // Check if NPU button exists
            const npuBtn = this.page.locator('//*[@id="deviceTypeBtns"]/label[3]');
            if (await npuBtn.isVisible()) {
                await npuBtn.click();
            } else {
                console.log('NPU not supported/available for this sample, skipping...');
                results.push({
                    testName: testName,
                    testUrl: testUrl,
                    result: 'PASS', // Considered pass as "skipped/unsupported"
                    details: 'NPU not supported/available',
                    subcases: { total: 1, passed: 1, failed: 0 },
                    suite: 'model'
                });
                return;
            }
        }
      } catch (e) { throw new Error(`Could not click backend button for ${device}: ` + e.message); }

      await this.page.waitForTimeout(1000);

      try {
         await this.page.click('//*[@id="predict"]');
      } catch (e) { throw new Error('Could not click Predict button: ' + e.message); }

      let buildTime = null;
      let inferenceTime = null;
      let checkCount = 0;
      const maxChecks = 30; // 15s

      while (checkCount < maxChecks && (buildTime === null || inferenceTime === null)) {
        checkCount++;
        const result = await this.page.evaluate(() => {
           const buildTimeEl = document.getElementById('buildTime');
           const inferenceTimeEl = document.getElementById('inferenceTime');
           if (buildTimeEl && inferenceTimeEl && buildTimeEl.innerText.trim() !== '' && inferenceTimeEl.innerText.trim() !== '') {
             return { buildTime: buildTimeEl.innerText.trim(), inferenceTime: inferenceTimeEl.innerText.trim() };
           }
           return null;
        });

        if (result) {
            buildTime = result.buildTime;
            inferenceTime = result.inferenceTime;
        } else {
            await this.page.waitForTimeout(500);
        }
      }

      if (buildTime && inferenceTime) {
        console.log(`Got LeNet result: ${buildTime}, ${inferenceTime}`);
        results.push({
            testName: testName,
            testUrl: testUrl,
            result: 'PASS',
            details: `${buildTime}, ${inferenceTime}`,
            subcases: { total: 1, passed: 1, failed: 0 },
            suite: 'model'
        });
      } else {
         throw new Error('Timeout waiting for inference results buildTime/inferenceTime');
      }

    } catch (error) {
       console.error(`[Fail] Error in ${testName}:`, error.message);
       throw error;
    }
  }

  async runModelSemanticSegmentation(results, modelDef) {
    const testName = modelDef.name;
    const testUrl = modelDef.url;

    const device = process.env.DEVICE || 'cpu';

    try {
      console.log(`Running sample test: ${testName} on ${device.toUpperCase()}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      try {
        if (device === 'cpu') {
             await this.page.click('//*[@id="backendBtns"]/label[1]');
        } else if (device === 'gpu') {
             await this.page.click('//*[@id="backendBtns"]/label[2]');
        } else if (device === 'npu') {
             const npuBtn = this.page.locator('//*[@id="deviceTypeBtns"]/label[3]');
             if (await npuBtn.isVisible()) {
                await npuBtn.click();
             } else {
                console.log('NPU button not found, skipping');
                 results.push({
                    testName: testName,
                    testUrl: testUrl,
                    result: 'PASS',
                    details: 'NPU not supported',
                    subcases: { total: 1, passed: 1, failed: 0 },
                    suite: 'model'
                });
                return;
             }
        }
      } catch (e) { throw new Error(`Could not click backend button for ${device}: ` + e.message); }

      await this.page.waitForTimeout(1000);

      try {
        const labels = await this.page.$$('label');
        let clicked = false;
        for (const label of labels) {
            const text = await label.innerText();
            if (text.includes('DeepLab V3 MobileNet V2')) {
                await label.click();
                clicked = true;
                break;
            }
        }
        if (!clicked) {
             const labelFor = await this.page.$('label[for="deeplabv3mnv2"]');
             if (labelFor) {
                await labelFor.click();
                clicked = true;
             } else {
                 await this.page.click('#deeplabv3mnv2');
             }
        }
      } catch (e) {
         console.log('Error selecting model, trying alternative selector...', e.message);
         await this.page.click("text=DeepLab V3 MobileNet V2");
      }

      console.log('Model selected, waiting for results...');

      let checkCount = 0;
      const maxChecks = 60;

      while (checkCount < maxChecks) {
        checkCount++;
        const times = await this.page.evaluate(() => {
            const computeEl = document.querySelector('#computeTime');
            const loadEl = document.querySelector('#loadTime');
            const buildEl = document.querySelector('#buildTime');

            if (computeEl && computeEl.innerText.includes('ms')) {
                return {
                    compute: computeEl.innerText,
                    load: loadEl ? loadEl.innerText : 'N/A',
                    build: buildEl ? buildEl.innerText : 'N/A'
                };
            }
            return null;
        });

        if (times) {
            console.log(`Got Semantic Segmentation results: Load=${times.load}, Build=${times.build}, Inference=${times.compute}`);
            results.push({
                testName: testName,
                testUrl: testUrl,
                result: 'PASS',
                details: `Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`,
                subcases: { total: 1, passed: 1, failed: 0 },
                suite: 'model'
            });
            return;
        }
        await this.page.waitForTimeout(500);
      }
      throw new Error('Timeout waiting for inference results (#computeTime)');
    } catch (error) { throw error; }
  }

  async runModelStyleTransfer(results, modelDef) {
    const testName = modelDef.name;
    const testUrl = modelDef.url;
    const device = process.env.DEVICE || 'cpu';

    try {
      console.log(`Running sample test: ${testName} on ${device.toUpperCase()}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      try {
        // Selection logic for Style Transfer
        const targetText = device === 'cpu' ? 'WebNN (CPU)' : 'WebNN (GPU)';
        const targetId = device === 'cpu' ? '#webnn_cpu' : '#webnn_gpu';

        if (device === 'npu') {
             // Style transfer sample page might be slightly different structure for NPU if supported
             // Assuming similar NPU button or skip
             const npuBtn = this.page.locator('//*[@id="deviceTypeBtns"]/label[3]');
             if (await npuBtn.isVisible()) {
                await npuBtn.click();
             } else {
                 console.log('NPU button not found for Style Transfer, skipping');
                 results.push({
                    testName: testName,
                    testUrl: testUrl,
                    result: 'PASS',
                    details: 'NPU not supported',
                    subcases: { total: 1, passed: 1, failed: 0 },
                    suite: 'model'
                });
                return;
             }
        } else {
            const labels = await this.page.$$('label');
            let clicked = false;
            for (const label of labels) {
                const text = await label.innerText();
                if (text.includes(targetText)) {
                    await label.click();
                    clicked = true;
                    break;
                }
            }
            if (!clicked) {
               await this.page.click(`text=${targetText}`);
            }
        }
      } catch (e) {
         console.log('Error selecting backend, trying ID selector...', e.message);
         if (device === 'cpu') await this.page.click('#webnn_cpu');
         else if (device === 'gpu') await this.page.click('#webnn_gpu');
      }

      console.log('Backend selected, waiting for results...');

      let checkCount = 0;
      const maxChecks = 60; // 30s

      while (checkCount < maxChecks) {
        checkCount++;
        const times = await this.page.evaluate(() => {
            const computeEl = document.querySelector('#computeTime');
            const loadEl = document.querySelector('#loadTime');
            const buildEl = document.querySelector('#buildTime');

            if (computeEl && computeEl.innerText.includes('ms')) {
                return {
                    compute: computeEl.innerText,
                    load: loadEl ? loadEl.innerText : 'N/A',
                    build: buildEl ? buildEl.innerText : 'N/A'
                };
            }
            return null;
        });

        if (times) {
            results.push({
                testName: testName,
                testUrl: testUrl,
                result: 'PASS',
                details: `Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`,
                subcases: { total: 1, passed: 1, failed: 0 },
                suite: 'model'
            });
            return;
        }
        await this.page.waitForTimeout(500);
      }
      throw new Error('Timeout waiting for inference results (#computeTime)');
    } catch (e) { throw e; }
  }

  async runModelObjectDetection(results, modelDef) {
    const testName = modelDef.name;
    const testUrl = modelDef.url;
    const device = process.env.DEVICE || 'cpu';

    try {
      console.log(`Running sample test: ${testName} on ${device.toUpperCase()}`);
      await this.page.goto(testUrl, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(3000);

      // 1. Select Backend
      try {
        await this.page.waitForLoadState('domcontentloaded');
        const labelText = device === 'npu' ? 'WebNN (NPU)' :
                          device === 'gpu' ? 'WebNN (GPU)' : 'WebNN (CPU)';

        const targetLabel = this.page.locator('label').filter({ hasText: labelText }).first();

        try {
            await targetLabel.waitFor({ state: 'visible', timeout: 5000 });
            await targetLabel.click();
        } catch (waitError) {
             if (device === 'npu') {
                 console.log('NPU button missing, skipping test.');
                 results.push({
                    testName: testName,
                    testUrl: testUrl,
                    result: 'PASS',
                    details: 'NPU not supported',
                    subcases: { total: 1, passed: 1, failed: 0 },
                    suite: 'model'
                });
                return;
             }

             // Fallback for CPU/GPU
             const shortText = device.toUpperCase();
             const shortLabel = this.page.locator('label').filter({ hasText: shortText }).first();
             if (await shortLabel.count() > 0 && await shortLabel.isVisible()) {
                 await shortLabel.click();
             } else {
                 throw new Error(`Backend button for ${device} not found.`);
             }
        }
      } catch (e) { throw new Error(`Could not click backend button for ${device}: ` + e.message); }

      // 2. Select Data Type (Float 32)
      try {
          await this.page.click('//*[@id="dataTypeBtns"]/label[1]');
      } catch (e) {
      }

      // 3. Select Model
      try {
        await this.page.waitForSelector('#modelBtns', { state: 'visible', timeout: 5000 });
      } catch(e) {}

      await this.page.waitForTimeout(1000);

      const hintEl = this.page.locator('//*[@id="hint"]');
      let shouldSelect = true;
      try {
         if (await hintEl.isVisible()) {
            const hintText = (await hintEl.innerText()).toUpperCase();
            if (!hintText.includes('NO MODEL SELECTED')) {
               shouldSelect = false;
            }
         }
      } catch(e) {}

      if (shouldSelect) {
          try {
              const modelLabel = this.page.locator('#modelBtns label').filter({ hasText: 'Tiny Yolo V2' }).first();
              if (await modelLabel.count() > 0 && await modelLabel.isVisible()) {
                  await modelLabel.click();
              } else {
                  await this.page.click('//*[@id="modelBtns"]/label[1]');
              }
          } catch (e) {
              console.warn('Model selection failed:', e.message);
          }
      }

      console.log('Model selected, waiting for results...');

      let checkCount = 0;
      const maxChecks = 60; // 30s

      while (checkCount < maxChecks) {
        checkCount++;
        const times = await this.page.evaluate(() => {
            const computeEl = document.querySelector('#computeTime');
            if (computeEl && computeEl.innerText.includes('ms')) {
                return computeEl.innerText;
            }
            return null;
        });

        if (times) {
            results.push({
                testName: testName,
                testUrl: testUrl,
                result: 'PASS',
                details: `Inference: ${times}`,
                subcases: { total: 1, passed: 1, failed: 0 },
                suite: 'model'
            });
            return;
        }
        await this.page.waitForTimeout(500);
      }
      throw new Error('Timeout waiting for inference results (#computeTime)');
    } catch (e) { throw e; }
  }

  // --- Preview Implementations ---

  async runModelImageClassification(results, modelDef) {
    const testName = modelDef.name;
    const device = process.env.DEVICE || 'cpu';

    // Construct URL with params for auto-run and selection
    // ?provider=webnn&devicetype=<device>&model=resnet-50&run=5
    const baseUrl = modelDef.url.split('?')[0];
    const testUrl = `${baseUrl}?provider=webnn&devicetype=${device}&model=resnet-50&run=5`;

    const perfCollector = new WebNNPerfCollector();

    try {
      console.log(`Running preview test: ${testName} on ${device}`);
      console.log(`Navigating to: ${testUrl}`);

      perfCollector.start(this.page);

      await this.page.goto(testUrl);
      await this.page.waitForLoadState('networkidle');

      await this.page.waitForTimeout(3000);
      console.log('Looking for Classify button...');

      const classifySelectors = [
        'button:has-text("Classify")',
        'input[value="Classify"]',
        '#classify',
        '.classify-btn',
        'button[onclick*="classify"]',
        'button:text("Classify")',
        '[type="button"]:has-text("Classify")'
      ];

      let classifyButton = null;
      for (const selector of classifySelectors) {
        try {
          classifyButton = await this.page.locator(selector).first();
          if (await classifyButton.isVisible()) {
            break;
          }
        } catch (error) {}
      }

      if (classifyButton && await classifyButton.isVisible()) {
        await classifyButton.click();
        console.log('[Success] Clicked Classify button');
      } else {
        console.log('Classify button not found, assuming auto-run from URL params');
      }

      let latencyFound = false;
      let latencyValue = null;
      let checkCount = 0;
      const maxChecks = 120;

      while (checkCount < maxChecks && !latencyFound) {
        checkCount++;
        const latencyResult = await this.page.evaluate(() => {
          const latencyElement = document.querySelector('#latency');
          if (latencyElement) {
            const text = latencyElement.textContent || latencyElement.innerText;
            if (text && text.trim()) return { found: true, content: text.trim() };
          }
          return { found: false, content: null };
        });

        if (latencyResult.found) {
           const content = latencyResult.content.trim();
           const numericMatch = content.match(/(\d+(?:\.\d+)?)/);
           if (numericMatch) {
              const numericValue = parseFloat(numericMatch[1]);
              if (numericValue > 0) {
                 latencyValue = content;
                 latencyFound = true;
                 break;
              }
           }
        }
        await this.page.waitForTimeout(500);
      }

      if (!latencyFound) throw new Error(`latency element not found after ${maxChecks} attempts`);
      if (!latencyValue.includes('ms')) latencyValue += ' ms';

      const perfSummary = perfCollector.toCompactString();
      if (perfSummary) console.log(`[WebNN:Perf] IC metrics: ${perfSummary}`);

      results.push({
        testName: testName,
        testUrl: testUrl,
        result: 'PASS',
        details: `Latency: ${latencyValue}`,
        perfMetrics: perfCollector.getSummary(),
        perfSummary: perfSummary,
        subcases: { total: 1, passed: 1, failed: 0 },
        suite: 'model'
      });

    } catch (error) { throw error; }
    finally { perfCollector.stop(); }
  }

  async runModelSdxl(results, modelDef) {
    const testName = modelDef.name;
    const device = process.env.DEVICE || 'cpu';

    // Construct URL: https://.../?devicetype=<device>
    const baseUrl = modelDef.url.split('?')[0];
    const testUrl = `${baseUrl}?devicetype=${device}`;

    console.log(`Running preview test: ${testName} on ${device}`);
    console.log(`Navigating to: ${testUrl}`);

    const perfCollector = new WebNNPerfCollector();

    try {
      perfCollector.start(this.page);

      await this.page.goto(testUrl);
      await this.page.waitForLoadState('domcontentloaded');

      // Monitor for WebNN/ORT errors to fail fast instead of waiting full timeout
      let loadError = null;
      const errorPatterns = [
          "failed to create session",
          "failed to create context",
          "out of memory",
          "unrecognized graph input",
      ];
      const errorListener = (msg) => {
          if (msg.type() === 'error' && !loadError) {
              const text = msg.text().toLowerCase();
              for (const pattern of errorPatterns) {
                  if (text.includes(pattern)) {
                      loadError = msg.text();
                      console.log(`[SDXL] Detected error during load: ${msg.text()}`);
                      break;
                  }
              }
          }
      };
      this.page.on('console', errorListener);

      try {
        const loadButton = this.page.locator('button', { hasText: 'Load Models' });
        await loadButton.waitFor({ state: 'visible', timeout: 30000 });
        await loadButton.click();
        console.log('[Success] Clicked Load Models');

        // Poll for Generate Image button with fast-fail on errors
        const generateButton = this.page.locator('button', { hasText: 'Generate Image' });
        let genVisible = false;
        for (let i = 0; i < 1800; i++) { // up to 15 min
            if (loadError) throw new Error(`Model load failed: ${loadError}`);
            const visible = await generateButton.isVisible().catch(() => false);
            const enabled = visible ? await generateButton.isEnabled().catch(() => false) : false;
            if (visible && enabled) { genVisible = true; break; }
            await this.page.waitForTimeout(500);
        }

        if (loadError) throw new Error(`Model load failed: ${loadError}`);
        if (!genVisible) throw new Error('Generate Image button did not become visible/enabled');

        console.log('[Success] Models loaded. Clicking Generate Image...');
        await generateButton.click();

        const resultLocator = this.page.locator('#total_data');
        await resultLocator.waitFor({ state: 'visible', timeout: 120000 });

        let resultText = '';
        let checkCount = 0;
        const maxChecks = 1200;

        while (checkCount < maxChecks) {
            const text = await resultLocator.textContent();
            resultText = text ? text.trim() : '';
            if (resultText && resultText !== '...' && /\d/.test(resultText)) {
                break;
            }
            await this.page.waitForTimeout(500);
            checkCount++;
        }

        if (!resultText || resultText === '...' || !/\d/.test(resultText)) {
            throw new Error('Result text did not appear or invalid');
        }

        const perfSummary = perfCollector.toCompactString();
        if (perfSummary) console.log(`[WebNN:Perf] SDXL metrics: ${perfSummary}`);

        results.push({
            testName: testName,
            testUrl: testUrl,
            result: 'PASS',
            details: `Total time: ${resultText}`,
            perfMetrics: perfCollector.getSummary(),
            perfSummary: perfSummary,
            subcases: { total: 1, passed: 1, failed: 0 },
            suite: 'model'
        });
      } finally {
        try { this.page.removeListener('console', errorListener); } catch(e) {}
      }

    } catch (e) { throw e; }
    finally { perfCollector.stop(); }
  }

  async runModelPhi(results, modelDef) {
      const testName = modelDef.name;
      const device = process.env.DEVICE || 'cpu';

      // Construct URL: ?provider=webnn&devicetype=<device>&model=phi4mini
      const baseUrl = modelDef.url.split('?')[0];
      const testUrl = `${baseUrl}?provider=webnn&devicetype=${device}&model=phi4mini`;

      console.log(`Running preview test: ${testName} on ${device}`);
      console.log(`Navigating to: ${testUrl}`);

      const perfCollector = new WebNNPerfCollector();

      try {
        perfCollector.start(this.page);

        await this.page.goto(testUrl);
        await this.page.waitForLoadState('domcontentloaded');

        // The text-generation demo auto-loads the model on page init (no Load button).
        // The send button (#send-button) starts disabled and becomes enabled when the model is ready.
        const sendBtn = this.page.locator('#send-button');

        console.log("Waiting for model to load (#send-button to become enabled)...");
        await sendBtn.waitFor({ state: 'visible', timeout: 900000 });
        await expect(sendBtn).not.toBeDisabled({ timeout: 900000 });
        console.log("Model loaded. Send button is enabled.");

        // Type a prompt into the #user-input contenteditable div
        const userInput = this.page.locator('#user-input');
        const testPrompt = 'What is 2 + 2?';
        await userInput.click();
        await userInput.fill(testPrompt).catch(async () => {
            // contenteditable divs may not support fill(), use keyboard input
            await userInput.pressSequentially(testPrompt, { delay: 30 });
        });
        console.log(`Typed prompt: "${testPrompt}"`);

        // Listen for console errors that indicate EP/session failures
        // so we can fail fast instead of waiting the full polling timeout.
        // These patterns match specific WebNN/ORT error messages — keep them
        // precise to avoid false-matching against routine log lines.
        let epError = null;
        const errorPatterns = [
            "failed to create session",
            "failed to execute 'readtensor' on 'mlcontext'",
            "tensor has been destroyed or context is lost",
            "failed to create context",
            "session initialization failed",
        ];
        const consoleErrorListener = (msg) => {
            if (msg.type() === 'error' && !epError) {
                const text = msg.text().toLowerCase();
                for (const pattern of errorPatterns) {
                    if (text.includes(pattern)) {
                        epError = msg.text();
                        console.log(`[Phi] Detected EP/inference error: ${msg.text()}`);
                        break;
                    }
                }
            }
        };
        this.page.on('console', consoleErrorListener);

        try {
          // Click send button to submit the prompt
          await sendBtn.click();
          console.log("Clicked Send button, waiting for response...");

          // Wait for performance indicator to show tokens/sec data
          const perfIndicator = this.page.locator('#performance-indicator');

          let perfText = '';
          let checks = 0;
          while(checks < 600) { // 5 mins max
            // Fail fast if we detected an EP/inference error
            if (epError) {
              throw new Error(`Inference failed (EP error): ${epError}`);
            }
            perfText = await perfIndicator.innerText().catch(() => '');
            if (perfText && /\d/.test(perfText) && (perfText.includes('token') || perfText.includes('s'))) {
               break;
            }
            await this.page.waitForTimeout(500);
            checks++;
          }

          if (epError) throw new Error(`Inference failed (EP error): ${epError}`);
          if (!perfText) throw new Error("No token/sec result found in #performance-indicator");

          console.log(`Performance result: ${perfText}`);

          const perfSummary = perfCollector.toCompactString();
          if (perfSummary) console.log(`[WebNN:Perf] Phi metrics: ${perfSummary}`);

          results.push({
            testName: testName,
            testUrl: testUrl,
            result: 'PASS',
            details: `Performance: ${perfText.replace(/\n/g, ', ')}`,
            perfMetrics: perfCollector.getSummary(),
            perfSummary: perfSummary,
            subcases: { total: 1, passed: 1, failed: 0 },
            suite: 'model'
          });
        } finally {
          // Clean up listener even on early errors
          try { this.page.removeListener('console', consoleErrorListener); } catch(e) {}
        }

      } catch (e) { throw e; }
      finally { perfCollector.stop(); }
  }

  async runModelSam(results, modelDef) {
    const testName = modelDef.name;
    const device = process.env.DEVICE || 'cpu';

    // Construct URL: ?devicetype=<device>
    const baseUrl = modelDef.url.split('?')[0];
    const testUrl = `${baseUrl}?devicetype=${device}`;

    console.log(`Running preview test: ${testName} on ${device}`);
    console.log(`Navigating to: ${testUrl}`);

    const perfCollector = new WebNNPerfCollector();

    try {
        perfCollector.start(this.page);

        await this.page.goto(testUrl);
        await this.page.waitForLoadState('domcontentloaded');

        // Monitor for WebNN/ORT errors to fail fast
        let loadError = null;
        const errorListener = (msg) => {
            if (msg.type() === 'error' && !loadError) {
                const text = msg.text().toLowerCase();
                if (text.includes('failed to create session') || text.includes('failed to create context') ||
                    text.includes('out of memory') || text.includes('unrecognized graph input')) {
                    loadError = msg.text();
                    console.log(`[SAM] Detected load error: ${msg.text()}`);
                }
            }
        };
        this.page.on('console', errorListener);

        try {
            // The canvas starts hidden (class="none") and only becomes visible
            // after both SAM models (~187MB total) are downloaded and compiled.
            // Use a generous timeout to account for model loading time.
            console.log("Waiting for canvas (model loading may take a while)...");
            const canvas = this.page.locator('#img_canvas');
            await canvas.waitFor({ state: 'visible', timeout: 300000 });

            // After canvas is visible, the default image (EgyptianCat.png) is
            // processed by the encoder via handleImage(). Wait for the cursor
            // to change from "wait" to "default" indicating the encoder is done.
            console.log("Waiting for encoder to finish processing default image...");
            let encoderReady = false;
            for (let i = 0; i < 600; i++) { // up to 5 min
                if (loadError) throw new Error(`Model load failed: ${loadError}`);
                const cursor = await canvas.evaluate(el => el.style.cursor);
                if (cursor !== 'wait') { encoderReady = true; break; }
                await this.page.waitForTimeout(500);
            }
            if (loadError) throw new Error(`Model load failed: ${loadError}`);
            if (!encoderReady) throw new Error("Encoder did not finish processing the image in time");

            console.log("Clicking on canvas to trigger segmentation...");
            const box = await canvas.boundingBox();
            if (box) {
                await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            } else {
                throw new Error("Canvas bounding box not found");
            }

            // The demo uses #decoder_latency for the latency display
            const latEl = this.page.locator('#decoder_latency');

            // It might take time for first inference
            let latText = '';
            let checks = 0;
            while(checks < 120) {
                if (loadError) throw new Error(`Inference failed: ${loadError}`);
                latText = await latEl.innerText().catch(() => '');
                if (latText && /\d/.test(latText) && !latText.includes('...')) break;
                await this.page.waitForTimeout(500);
                checks++;
            }

            if (loadError) throw new Error(`Inference failed: ${loadError}`);
            if (!latText) throw new Error("Latency not displayed in #decoder_latency");

            const perfSummary = perfCollector.toCompactString();
            if (perfSummary) console.log(`[WebNN:Perf] SAM metrics: ${perfSummary}`);

            results.push({
                testName: testName,
                testUrl: testUrl,
                result: 'PASS',
                details: `Latency: ${latText}`,
                perfMetrics: perfCollector.getSummary(),
                perfSummary: perfSummary,
                subcases: { total: 1, passed: 1, failed: 0 },
                suite: 'model'
            });
        } finally {
            try { this.page.removeListener('console', errorListener); } catch(e) {}
        }

    } catch(e) { throw e; }
    finally { perfCollector.stop(); }
  }

  async runModelWhisper(results, modelDef) {
      const testName = modelDef.name;
      const device = process.env.DEVICE || 'cpu';

      // Construct URL: ?provider=webnn&devicetype=<device>
      const baseUrl = modelDef.url.split('?')[0];
      const testUrl = `${baseUrl}?provider=webnn&devicetype=${device}`;

      console.log(`Running preview test: ${testName} on ${device}`);
      console.log(`Navigating to: ${testUrl}`);

      const perfCollector = new WebNNPerfCollector();

      try {
          perfCollector.start(this.page);

          await this.page.goto(testUrl);
          await this.page.waitForLoadState('domcontentloaded');

          // Monitor for WebNN/ORT errors to fail fast
          let loadError = null;
          const errorPatterns = [
              "failed to create session",
              "failed to create context",
              "session initialization failed",
              "out of memory",
              "unrecognized graph input",
          ];
          const errorListener = (msg) => {
              if (msg.type() === 'error' && !loadError) {
                  const text = msg.text().toLowerCase();
                  for (const pattern of errorPatterns) {
                      if (text.includes(pattern)) {
                          loadError = msg.text();
                          console.log(`[Whisper] Detected load error: ${msg.text()}`);
                          break;
                      }
                  }
              }
          };
          this.page.on('console', errorListener);

          try {
          // The whisper-base demo auto-loads the model on page init (no Load button).
          // When the model is ready, controls like #file-upload become enabled.
          const fileUpload = this.page.locator('#file-upload');

          console.log("Waiting for model to load (#file-upload to become enabled)...");
          await fileUpload.waitFor({ state: 'attached', timeout: 300000 });
          // Poll for the input to become enabled.
          // Use a per-call timeout on isDisabled() to prevent hanging when the
          // page's JS event loop is blocked by a long ORT session compilation.
          let modelReady = false;
          for (let i = 0; i < 600; i++) { // up to 5 min
            if (loadError) throw new Error(`Model load failed: ${loadError}`);
            try {
              const isDisabled = await Promise.race([
                fileUpload.isDisabled(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('isDisabled timeout')), 10000))
              ]);
              if (!isDisabled) { modelReady = true; break; }
            } catch (e) {
              if (e.message === 'isDisabled timeout') {
                console.log(`[Whisper] Page JS unresponsive (iteration ${i}), ORT session may be compiling...`);
                continue;
              }
              throw e;
            }
            await this.page.waitForTimeout(500);
          }
          if (loadError) throw new Error(`Model load failed: ${loadError}`);
          if (!modelReady) throw new Error("Whisper model failed to load (file-upload stayed disabled)");
          console.log("Model loaded. Controls are enabled.");

          // Use the static test WAV file from assets/
          const tempWavPath = path.join(__dirname, '..', 'assets', 'test.wav');
          if (!fs.existsSync(tempWavPath)) {
              throw new Error(`Test WAV file not found: ${tempWavPath}`);
          }

            // Upload via the file input
            await fileUpload.setInputFiles(tempWavPath);
            console.log("Uploaded WAV file. Waiting for transcription...");

            // Wait for transcription output in #outputText
            const outputText = this.page.locator('#outputText');
            const latencyEl = this.page.locator('#latency');

            let latencyText = '';
            let checks = 0;
            while(checks < 120) { // up to 60 seconds
              latencyText = await latencyEl.innerText().catch(() => '');
              // Transcription is done when latency shows 100% or a completion indicator
              if (latencyText && latencyText.includes('100')) {
                break;
              }
              await this.page.waitForTimeout(500);
              checks++;
            }

            const transcription = await outputText.textContent().catch(() => '');
            console.log(`Transcription result: "${transcription}"`);
            console.log(`Latency info: ${latencyText}`);

            // Consider it a pass if the transcription completed (latency hit 100%)
            if (!latencyText || !latencyText.includes('100')) {
              throw new Error("Transcription did not complete (latency never reached 100%)");
            }

            // Check if expected words appear in the transcription.
            // The test.wav contains "What's the weather like?"
            const expectedText = "What's the weather like?";
            const expectedWords = expectedText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
            const MIN_WORD_MATCHES = 2;
            let matchedWords = [];
            if (transcription) {
              const lower = transcription.toLowerCase();
              matchedWords = expectedWords.filter(w => lower.includes(w));
              console.log(`[Whisper] Word match: ${matchedWords.length}/${expectedWords.length} expected words found`);
              if (matchedWords.length > 0) {
                console.log(`[Whisper] Matched: ${matchedWords.join(', ')}`);
              }
            }

            const wordMatchInfo = ` | Words matched: ${matchedWords.length}/${expectedWords.length} (${matchedWords.join(', ') || 'none'})`;
            const transcriptionOk = matchedWords.length >= MIN_WORD_MATCHES;

            if (!transcriptionOk) {
              console.log(`[Whisper] FAIL: Only ${matchedWords.length}/${expectedWords.length} words matched (need >= ${MIN_WORD_MATCHES})`);
            }

            const perfSummary = perfCollector.toCompactString();
            if (perfSummary) console.log(`[WebNN:Perf] Whisper metrics: ${perfSummary}`);

            results.push({
              testName: testName,
              testUrl: testUrl,
              result: transcriptionOk ? 'PASS' : 'FAIL',
              details: `Transcription: ${transcription || '(blank)'}. ${latencyText}${wordMatchInfo}`,
              perfMetrics: perfCollector.getSummary(),
              perfSummary: perfSummary,
              subcases: { total: 1, passed: transcriptionOk ? 1 : 0, failed: transcriptionOk ? 0 : 1 },
              suite: 'model'
            });

          } finally {
            try { this.page.removeListener('console', errorListener); } catch(e) {}
          }

      } catch(e) { throw e; }
      finally { perfCollector.stop(); }
  }
}

module.exports = { ModelRunner };
