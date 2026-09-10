<#
.SYNOPSIS
    Clear leftover / zombie chrome.exe (or msedge.exe) entries from a WPT /
    Playwright run.

.DESCRIPTION
    After a Chrome Canary WPT run against our user-data-dir, GPU / renderer
    subprocesses often crash (see --gpu-recent-crash-count in their command
    line). Once the process object has exited (HasExited = True) but some
    other process still holds an open handle to it, the PID entry lingers in
    Task Manager / Get-Process even though taskkill /F reports success.

    This script:
      1. Enumerates chrome/msedge processes whose CommandLine references our
         user-data-dir (safe: never touches the user's personal browser).
      2. Tries the polite path: Stop-Process -Force / taskkill /F /T.
      3. For any entries that are already dead but still lingering as
         "zombies" (HasExited = True), optionally uses Sysinternals handle.exe
         to identify which OTHER process holds a handle to them and closes
         that handle so Windows can finally reap the PID.
      4. Reports what was done and what still lingers.

    Install handle.exe once:
        winget install Microsoft.Sysinternals.Handle
      or:
        winget install Microsoft.Sysinternals.Suite

    If handle.exe is not available and zombies remain, the only remaining
    options are: (a) reboot, or (b) ignore them - they consume no CPU/RAM.

.PARAMETER UserDataDir
    Absolute path to the automation user-data-dir. Defaults to the workspace
    "user-data" directory (two levels up from this script).

.PARAMETER ProcessName
    Browser executable name(s) to target. Default: chrome.exe, msedge.exe.

.PARAMETER All
    Ignore UserDataDir and target ALL chrome/msedge processes on the box.
    DANGEROUS - will also close the user's personal browser. Off by default.

.PARAMETER UseHandleExe
    If handle.exe is present in PATH (or provided via -HandleExePath), use it
    to close open handles to zombie PIDs held by third-party processes.
    On by default when handle.exe is discoverable.

.PARAMETER HandleExePath
    Explicit path to handle.exe. Otherwise resolved from PATH.

.PARAMETER Quiet
    Suppress informational output; only warnings/errors are printed.

.EXAMPLE
    # Default: sweep our own user-data-dir, use handle.exe if installed.
    .\Clear-ZombieChromeProcesses.ps1

.EXAMPLE
    # Sweep everything - dangerous, only use if no personal browser is open.
    .\Clear-ZombieChromeProcesses.ps1 -All

.EXAMPLE
    # Pipe from npm: node ... ; npm run clean:zombies
#>
[CmdletBinding()]
param(
    [string]$UserDataDir,
    [string[]]$ProcessName = @('chrome.exe', 'msedge.exe'),
    [switch]$All,
    [switch]$UseHandleExe = $true,
    [string]$HandleExePath,
    [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-Info($msg) { if (-not $Quiet) { Write-Host "[Info] $msg" } }
function Write-Warn($msg) { Write-Warning $msg }

# Resolve default user-data-dir relative to this script:
#   <repo>\tools\Powershell\Clear-ZombieChromeProcesses.ps1 -> <repo>\user-data
if (-not $UserDataDir -and -not $All) {
    $UserDataDir = Resolve-Path (Join-Path $PSScriptRoot '..\..\user-data') -ErrorAction SilentlyContinue
    if (-not $UserDataDir) {
        Write-Warn "Could not resolve default UserDataDir. Pass -UserDataDir or -All."
        exit 1
    }
    $UserDataDir = $UserDataDir.ToString()
}

# Locate handle.exe if requested.
$handleExe = $null
if ($UseHandleExe) {
    if ($HandleExePath -and (Test-Path $HandleExePath)) {
        $handleExe = $HandleExePath
    } else {
        $cmd = Get-Command 'handle.exe', 'handle64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) { $handleExe = $cmd.Source }
    }
    if ($handleExe) {
        Write-Info "Using handle.exe: $handleExe"
    } else {
        Write-Info "handle.exe not found. Zombies held by other processes cannot be reaped without a reboot."
        Write-Info "  Install: winget install Microsoft.Sysinternals.Handle"
    }
}

# Build the WMI filter and enumerate matching processes.
$filter = ($ProcessName | ForEach-Object { "Name='$_'" }) -join ' OR '
$procs = Get-CimInstance Win32_Process -Filter $filter

if (-not $All) {
    $needle = $UserDataDir.Replace('\', '\\')
    $procs = $procs | Where-Object {
        $_.CommandLine -and ($_.CommandLine -like "*$needle*")
    }
    Write-Info "Filter: chrome/msedge with user-data-dir = $UserDataDir"
} else {
    Write-Warn "-All specified: targeting ALL chrome/msedge processes on this machine."
}

if (-not $procs) {
    Write-Info "No matching browser processes found. Nothing to clean up."
    exit 0
}

$pids = @($procs | Select-Object -ExpandProperty ProcessId)
Write-Info "Found $($pids.Count) matching PID(s): $($pids -join ', ')"

# Step 1: try to terminate live ones politely.
foreach ($p in $procs) {
    $pid_ = $p.ProcessId
    try {
        $proc = Get-Process -Id $pid_ -ErrorAction Stop
        if (-not $proc.HasExited) {
            Write-Info "Terminating live PID $pid_..."
            Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
        }
    } catch {
        # Already gone from Get-Process viewpoint - still may be a lingering zombie.
    }
    # Belt-and-braces taskkill /T for the tree.
    & taskkill.exe /F /T /PID $pid_ 2>$null | Out-Null
}

Start-Sleep -Milliseconds 500

# Step 2: identify zombies (HasExited = True but PID still enumerable).
$zombies = @()
foreach ($pid_ in $pids) {
    $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
    if ($proc -and $proc.HasExited) { $zombies += $pid_ }
}

if (-not $zombies) {
    Write-Info "All targeted processes cleared."
    exit 0
}

Write-Info "Zombies remaining after taskkill: $($zombies -join ', ')"

if (-not $handleExe) {
    Write-Warn "$($zombies.Count) zombie PID(s) still linger. Install Sysinternals handle.exe or reboot to clear."
    exit 2
}

# Step 3: use handle.exe to close open handles held by OTHER processes.
# handle.exe -a -p <pid> lists handles owned by <pid>. We need the inverse:
# find who holds a handle to each zombie PID.
#
# Sysinternals handle.exe supports:  handle.exe <string> -a
# Searching by the target process image name is fuzzy; instead we scan
# everyone and match on "Process" handles whose target PID equals a zombie.
# Output looks like:
#     4212: Process              chrome.exe(23456)
# where 4212 is the handle value in the OWNING process shown at the top of
# each block:
#     ------------------------------------------------------------------------
#     someprocess.exe pid: 7788 <user>
#
# We accept EULA silently with -accepteula.

Write-Info "Scanning for handle owners via handle.exe (this can take ~5-15s)..."
$rawArgs = @('-accepteula', '-nobanner', '-a', '-p', 'Process')
$handleOutput = & $handleExe @rawArgs 2>$null

if (-not $handleOutput) {
    # Older handle.exe versions do not support -p filter by class; fall back.
    $handleOutput = & $handleExe '-accepteula', '-nobanner', '-a' 2>$null
}

if (-not $handleOutput) {
    Write-Warn "handle.exe produced no output. Try running as Administrator."
    exit 3
}

$currentOwner = $null
$currentOwnerPid = $null
$toClose = @()  # list of @{ OwnerPid, Handle, TargetPid }

foreach ($line in $handleOutput) {
    # Block headers look like:   procname.exe pid: 12345 <domain\user>
    if ($line -match '^\s*(\S+\.exe)\s+pid:\s+(\d+)') {
        $currentOwner = $Matches[1]
        $currentOwnerPid = [int]$Matches[2]
        continue
    }
    # Process-handle lines look like:  1A4: Process     chrome.exe(23456)
    if ($line -match '^\s*([0-9A-Fa-f]+):\s+Process\s+\S+\((\d+)\)') {
        $handleValue = $Matches[1]
        $targetPid = [int]$Matches[2]
        if ($zombies -contains $targetPid) {
            $toClose += [PSCustomObject]@{
                OwnerPid   = $currentOwnerPid
                OwnerName  = $currentOwner
                Handle     = $handleValue
                TargetPid  = $targetPid
            }
        }
    }
}

if (-not $toClose) {
    Write-Warn "No open handles to zombie PIDs found. They may be held by protected processes (EDR, WerSvc)."
    Write-Warn "A reboot is required to clear them."
    exit 4
}

Write-Info "Found $($toClose.Count) open handle(s) to zombie PIDs. Closing..."
$closed = 0
foreach ($h in $toClose) {
    Write-Info "  Closing handle 0x$($h.Handle) in $($h.OwnerName)(pid=$($h.OwnerPid)) -> zombie PID $($h.TargetPid)"
    # handle.exe -c <hex> -p <ownerpid> -y   (must run elevated)
    $out = & $handleExe '-accepteula', '-nobanner', '-c', $h.Handle, '-p', $h.OwnerPid, '-y' 2>&1
    if ($LASTEXITCODE -eq 0) {
        $closed++
    } else {
        Write-Warn "  Failed: $($out -join ' ')"
    }
}

Start-Sleep -Milliseconds 500

# Recount.
$stillZombies = @()
foreach ($pid_ in $zombies) {
    if (Get-Process -Id $pid_ -ErrorAction SilentlyContinue) { $stillZombies += $pid_ }
}

if ($stillZombies) {
    Write-Warn "Closed $closed handle(s) but $($stillZombies.Count) zombie PID(s) still linger: $($stillZombies -join ', ')"
    Write-Warn "Likely held by protected processes (EDR / antivirus / WerSvc). Reboot required."
    exit 5
}

Write-Info "All zombies reaped. Closed $closed handle(s)."
exit 0
