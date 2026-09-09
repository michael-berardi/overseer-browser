#Requires -Version 5.1
# Install/update the local OverSeer Browser native host on Windows.
# Chrome's unmanaged-extension security confirmation is never bypassed.
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $env:LOCALAPPDATA) { $env:LOCALAPPDATA = $env:USERPROFILE }
$RuntimeRoot = Join-Path $env:LOCALAPPDATA 'OverSeer\browser'
$HostDir = Join-Path $RuntimeRoot 'native_host'
$CliDir = Join-Path $RuntimeRoot 'cli'
$HostLauncher = Join-Path $RuntimeRoot 'overseer-browser-native-host.cmd'
$CliLauncher = Join-Path $RuntimeRoot 'overseer-browser.cmd'
$ManifestPath = Join-Path $RuntimeRoot 'native-host.json'
$ExtensionDir = Join-Path $RepoRoot 'chrome-extension'

function Resolve-Python {
  $py = Get-Command 'py' -ErrorAction SilentlyContinue
  if ($py) {
    $exe = & py -3 -c 'import sys; print(sys.executable)' 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe) { return ([string]($exe | Select-Object -First 1)).Trim() }
  }
  $py = Get-Command 'python' -ErrorAction SilentlyContinue
  if ($py) {
    $exe = & python -c 'import sys; print(sys.executable)' 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe) { return ([string]($exe | Select-Object -First 1)).Trim() }
  }
  throw 'overseer-browser: Python 3 is required to install the native host (install it from python.org or via the Microsoft Store).'
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $temporary = Join-Path (Split-Path -Parent $Path) ('.publish-' + [guid]::NewGuid().ToString('N'))
  try {
    [System.IO.File]::WriteAllText($temporary, $Content, (New-Object System.Text.UTF8Encoding($false)))
    if ([System.IO.File]::Exists($Path)) {
      [System.IO.File]::Replace($temporary, $Path, $null)
    } else {
      [System.IO.File]::Move($temporary, $Path)
    }
  } finally {
    if (Test-Path $temporary) { Remove-Item $temporary -Force }
  }
}

$Python = Resolve-Python

$Versions = Join-Path $RuntimeRoot 'runtimes'
New-Item -ItemType Directory -Force -Path $Versions | Out-Null
$Version = [guid]::NewGuid().ToString('N')
$Stage = Join-Path $Versions ('.stage-' + $Version)
$Runtime = Join-Path $Versions ('runtime-' + $Version)
try {
  $HostDir = Join-Path $Stage 'native_host'
  $CliDir = Join-Path $Stage 'cli'
  New-Item -ItemType Directory -Path $Stage, $HostDir, $CliDir | Out-Null
  foreach ($Module in @('__init__', 'host', 'protocol', 'runtime', 'isolation')) {
    Copy-Item (Join-Path $RepoRoot "native_host\$Module.py") $HostDir
  }
  foreach ($Module in @('__init__', 'main', 'runtime_discovery', 'evidence', 'recording', 'dom_query', 'temp_outputs')) {
    Copy-Item (Join-Path $RepoRoot "cli\$Module.py") $CliDir
  }
  $ExtensionSource = Join-Path $RepoRoot 'extension\.output\chrome-mv3'
  if (-not (Test-Path (Join-Path $ExtensionSource 'manifest.json'))) { $ExtensionSource = $ExtensionDir }
  if (-not (Test-Path (Join-Path $ExtensionSource 'manifest.json'))) { throw 'Build the extension before installing.' }
  Copy-Item -Recurse $ExtensionSource (Join-Path $Stage 'extension')
  $Validate = @'
import importlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root))
for package in ('native_host', 'cli'):
    for path in (root / package).glob('*.py'):
        compile(path.read_bytes(), str(path), 'exec')
        importlib.import_module(package + '.' + path.stem)
assert json.loads((root / 'extension/manifest.json').read_text()).get('manifest_version') == 3
'@
  & $Python -I -B -c $Validate $Stage
  if ($LASTEXITCODE -ne 0) { throw 'Staged Python import/compile validation failed; prior launchers preserved.' }
  [System.IO.Directory]::Move($Stage, $Runtime)
} finally {
  if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
}
$HostDir = Join-Path $Runtime 'native_host'
$CliDir = Join-Path $Runtime 'cli'
$ExtensionDir = Join-Path $Runtime 'extension'

Write-Utf8NoBom $HostLauncher @"
@echo off
set "PYTHONPATH=$Runtime"
"$Python" -B "$HostDir\host.py" %*
"@
Write-Utf8NoBom $CliLauncher @"
@echo off
"$Python" -B "$CliDir\main.py" %*
"@

# Build via ConvertTo-Json so Windows backslashes in the launcher path are
# escaped correctly; hand-interpolated JSON would corrupt the path.
$ManifestObject = [ordered]@{
  name = 'com.imploselabs.overseer_browser'
  description = 'Private local OverSeer Browser native host'
  path = $HostLauncher
  type = 'stdio'
  allowed_origins = @('chrome-extension://iabfdeokmilpklblkgccpjlekchfjcno/')
}
Write-Utf8NoBom $ManifestPath ($ManifestObject | ConvertTo-Json)

$RegistryKeys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.imploselabs.overseer_browser',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.imploselabs.overseer_browser',
  'HKCU:\Software\BraveSoftware\Brave\NativeMessagingHosts\com.imploselabs.overseer_browser'
)
foreach ($Key in $RegistryKeys) {
  New-Item -Path $Key -Force | Out-Null
  Set-Item -Path $Key -Value $ManifestPath
}

Write-Host "Load unpacked extension directory: $ExtensionDir"
Write-Host "Native host launcher: $HostLauncher"
Write-Host "CLI launcher: $CliLauncher"
if (($env:PATH -split ';') -notcontains $RuntimeRoot) {
  Write-Host "To run 'overseer-browser' from any shell, add the runtime root to your user PATH:"
  Write-Host "  $RuntimeRoot"
  Write-Host "For example, to append it to your existing user PATH (printed here, not executed):"
  Write-Host "  setx PATH `"%PATH%;$RuntimeRoot`""
}
Write-Host "The extension is loaded and reloaded manually: open your browser's extensions page"
Write-Host "(e.g. chrome://extensions), enable Developer mode, and load/unload the unpacked"
Write-Host "directory above yourself."
Write-Host "Note: the native host uses an AF_UNIX socket, which requires Windows 10 1803 or later."

Write-Host "Coordinate this NEW Load unpacked path with session owners; reconfirm connection/site permissions."
Write-Host "Chrome does not follow path changes automatically. Old runtime trees and running hosts are retained."
