# WebNN Automation Tests

This project contains automated tests for WebNN (Web Neural Network) using Playwright.

## Prerequisites

1. **Browser**: Install Chrome or Microsoft Edge (stable, canary, dev, or beta)
2. **Node.js**: Install Node.js (version 16 or higher)
3. **Playwright**: Will be installed via npm

## Setup

1. Install dependencies:
```bash
npm install
```

## Running Tests

```bash
# Run with configuration file
node src/main.js --config config/example.json

# Run all WPT tests (--suite wpt is default)
node src/main.js
node src/main.js --suite wpt

# Run specific WPT test case
node src/main.js --suite wpt --wpt-case abs

# Run multiple WPT test cases (comma-separated)
node src/main.js --suite wpt --wpt-case abs,add,mul

# Run with different Chrome channel (Canary is default)
node src/main.js --suite wpt --chrome-channel canary
node src/main.js --suite wpt --chrome-channel dev
node src/main.js --suite wpt --chrome-channel beta

# Run the WebNN CTS with Edge Canary
node src/main.js --suite wpt --browser edge --browser-channel canary

# Run with parallel execution (faster)
node src/main.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 4

# Run tests multiple times (repeat mode)
node src/main.js --suite wpt --wpt-case "add,sub" --repeat 3

# Combine options
node src/main.js --suite wpt --wpt-case "add,sub" --jobs 2 --repeat 3 --chrome-channel canary
```

## Configuration File

Use `--config` to run tests defined in a JSON file. This allows defining complex test suites with specific devices and browser arguments.

```bash
node src/main.js --config config/example.json
```

Example configuration format:
```json
[
    {
        "name": "ORT WPT",
        "browser-arg": "--enable-features=WebNNOnnxRuntime",
        "suite": "wpt",
        "wpt-case": "add",
        "device": "cpu,gpu"
    }
]
```

## Test Case Selection

Use `--wpt-case` to run only tests that start string(s). Multiple cases can be specified separated by commas (no spaces):

```bash
# Run only tests with names starting with "abs"
node src/main.js --suite wpt --wpt-case abs

# Run tests with names starting with "abs" OR "add"
node src/main.js --suite wpt --wpt-case abs,add

# Run specific test indices (0-based)
node src/main.js --suite wpt --wpt-range 0,1,3-7
# This will run tests at indices 0, 1, 3, 4, 5, 6, 7 from the discovered list
```

The case selection is case-insensitive and matches the prefix of the test filename.

## Model Tests (Samples & Previews)

Run tests against WebNN samples and developer previews using the `model` suite:

```bash
# Run all model tests
node src/main.js --suite model

# Run specific model cases
node src/main.js --suite model --model-case lenet
node src/main.js --suite model --model-case sdxl,whisper
```

Available model cases include:
- `lenet`: LeNet Digit Recognition
- `segmentation`: Semantic Segmentation
- `style`: Fast Style Transfer
- `od`: Object Detection
- `ic`: Image Classification
- `sdxl`: SDXL Turbo
- `phi`: Phi-3 WebGPU
- `sam`: Segment Anything
- `whisper`: Whisper-base WebGPU

## Parallel Execution

Run multiple tests in parallel to speed up execution:

```bash
# Run with 2 parallel jobs
node src/main.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2

# Run with 4 parallel jobs
node src/main.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 4

# Run with 8 parallel jobs
node src/main.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 8
```

## Repeat Mode

Run the entire test suite multiple times for stability testing:

```bash
# Run tests 3 times
node src/main.js --suite wpt --wpt-case "add,sub" --repeat 3

# Run with parallel execution, repeated 5 times
node src/main.js --suite wpt --wpt-case "add,sub,mul,div" --jobs 2 --repeat 5
```

## Browser Selection

Run the WebNN CTS (the WPT conformance suite) with Chrome or Microsoft Edge:

```bash
# Chrome Canary (default)
node src/main.js --suite wpt

# Edge Canary
node src/main.js --suite wpt --browser edge

# Edge stable
node src/main.js --suite wpt --browser edge --browser-channel stable
```

**Supported browsers:** chrome (default), edge

**Supported channels:** canary (default), stable, dev, beta

The older `--chrome-channel` option remains available as an alias for `--browser-channel`.

## Browser Channel Selection

Switch between Chrome and Edge channels using `--browser-channel`:

```bash
# Use stable Chrome
node src/main.js --suite wpt --browser-channel stable

# Use Chrome Canary
node src/main.js --suite wpt --browser-channel canary

# Use Chrome Dev
node src/main.js --suite wpt --browser-channel dev

# Use Chrome Beta
node src/main.js --suite wpt --browser-channel beta

# Run an Edge Canary smoke test using the latest installed preview/experimental SDK
node src/main.js --suite wpt --wpt-case "abs,add" --device cpu,gpu --jobs 1 --browser edge --browser-channel canary --skip-retry
```

**Supported channels:** canary (default), stable, dev, beta

On Windows, test runs select the latest installed **preview or experimental**
Windows App SDK for the runner's architecture and enable `WebNNOnnxRuntime` by
default. Selection compares the SDK generation before the numeric package version,
so older 1.x packages with `8000.x` versions do not outrank 2.x releases. If none is
installed, the run stops with an installation hint. Help and test listing do not
require an SDK. This selects installed packages; it does not download updates.

Selection uses Chromium's `--webnn-ort-library-path-for-testing` override with
`--allow-third-party-modules`. After each configuration, the runner verifies the
loaded `onnxruntime.dll` path and fails if it cannot confirm the selected runtime.
This selects the ONNX Runtime library; EP packages remain selected by the browser.

## Browser Arguments

Pass extra arguments to the browser launch sequence using `--browser-arg`:

```bash
# Pass GPU selection flags
node src/main.js --suite wpt --browser-arg "--webnn-ort-ep-device=WebGpuExecutionProvider,0x8086,0x7d55"

# Pass multiple arguments
node src/main.js --suite wpt --browser-arg "--use-gl=angle --use-angle=gl"
```

## Skip Retry

By default, failed WPT test cases are retried automatically. Use `--skip-retry` to disable this behavior:

```bash
# Run without retrying failed cases
node src/main.js --suite wpt --skip-retry
```

## Email Report

Send test results via email after completion using `--email`:

```bash
# Send to default address
node src/main.js --suite wpt --email

# Send to a specific address
node src/main.js --suite wpt --email user@example.com
```

> **Note:** The email feature requires **Classic Outlook** to be installed on the machine. The new Outlook app does not support COM automation. If `--email` fails, install Classic Outlook from:
> https://support.microsoft.com/en-us/office/install-or-reinstall-classic-outlook-on-a-windows-pc-5c94902b-31a5-4274-abb0-b07f4661edf5

## Baseline Comparison

Test results can be compared against a previous run (baseline) to detect regressions and improvements at both the case level and subcase level. By default, the most recent results directory containing a text report is used as the baseline.

Use `--baseline` to specify a particular baseline folder:

```bash
# Compare against a specific baseline
node src/main.js --suite wpt --baseline bl-20260209172945

# Compare against a previous run by timestamp
node src/main.js --suite wpt --baseline 20260208120000
```

Baseline directories are looked up under the `results/` folder. Directories prefixed with `bl-` are preferred over regular timestamp directories when auto-selecting a baseline.

## Test Reports

### HTML Report Generation

After test execution completes, an HTML report is automatically generated with:

- **WebNN Test Report Section**: Displays in attachments section at the bottom of the page with comprehensive test results
  - Runtime Information at the top lists ORT, Windows App SDK, and execution provider (EP) versions used by the run, with EP package and DLL versions when available; the text report includes the same snapshot
  - Test execution summary (passed, failed, error, unknown counts)
  - Detailed results for each test case with status and timing
  - Color-coded status indicators for easy identification
  - Test configuration information (suite, cases, jobs, etc.)

- **Playwright Report Details**: Contains detailed Playwright execution information
  - Individual test execution traces
  - Screenshots and videos (if configured)
  - Step-by-step test execution logs
  - Error details and stack traces for failed tests

### Report Files

Reports are saved in the `results/` directory:

- **Timestamped Reports**: Each test run generates a timestamped file (format: `YYYYMMDDHHMMSS.html`)
- **Iteration Reports**: When using `--repeat`, each iteration gets a suffix `_iter1`, `_iter2`, etc.
- **Direct Links**: The console output provides direct file:// links to view reports

### Viewing Reports

Reports are automatically opened in your default browser after test completion. To view reports manually:

```bash
# Open the report directory
start results/

# Open a specific report
start results/20251022143025.html

# Open an iteration report
start results/20251022143025_iter1.html
```
