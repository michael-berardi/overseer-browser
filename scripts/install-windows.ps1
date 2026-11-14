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

# .cmd files are read by cmd.exe in the OEM code page, not UTF-8: a UTF-8 or ASCII file turns a
# non-ASCII profile or Python path (C:\Users\Jos<e acute>) into garbage. Paths under the runtime
# root are written relative to the launcher (%~dp0); only the Python path stays absolute.
function Get-CmdEncoding {
  try { return [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage) }
  catch { return (New-Object System.Text.UTF8Encoding($false)) }
}

function Write-Utf8NoBom([string]$Path, [string]$Content, [Text.Encoding]$Encoding = (New-Object System.Text.UTF8Encoding($false))) {
  $temporary = Join-Path (Split-Path -Parent $Path) ('.publish-' + [guid]::NewGuid().ToString('N'))
  try {
    [System.IO.File]::WriteAllText($temporary, $Content, $Encoding)
    if ([System.IO.File]::Exists($Path)) {
      [System.IO.File]::Replace($temporary, $Path, $null)
    } else {
      [System.IO.File]::Move($temporary, $Path)
    }
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
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
  foreach ($Module in @('__init__', 'host', 'protocol', 'runtime', 'isolation', 'coalition')) {
    Copy-Item -LiteralPath (Join-Path $RepoRoot "native_host\$Module.py") -Destination $HostDir
  }
  foreach ($Module in @('__init__', 'main', 'internal_qa', 'runtime_discovery', 'evidence', 'recording', 'dom_query', 'temp_outputs')) {
    Copy-Item -LiteralPath (Join-Path $RepoRoot "cli\$Module.py") -Destination $CliDir
  }
  $ExtensionSource = Join-Path $RepoRoot 'extension\.output\chrome-mv3'
  if (-not (Test-Path -LiteralPath (Join-Path $ExtensionSource 'manifest.json'))) { $ExtensionSource = $ExtensionDir }
  if (-not (Test-Path -LiteralPath (Join-Path $ExtensionSource 'manifest.json'))) { throw 'Build the extension before installing.' }
  Copy-Item -Recurse -LiteralPath $ExtensionSource -Destination (Join-Path $Stage 'extension')
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
  if (Test-Path -LiteralPath $Stage) { Remove-Item -Recurse -Force -LiteralPath $Stage }
}
$HostDir = Join-Path $Runtime 'native_host'
$CliDir = Join-Path $Runtime 'cli'
$ExtensionDir = Join-Path $Runtime 'extension'

$RuntimeRel = 'runtimes\runtime-' + $Version
$CmdEncoding = Get-CmdEncoding
$HostCmd = @"
@echo off
set "PYTHONPATH=%~dp0$RuntimeRel"
"$Python" -B "%~dp0$RuntimeRel\native_host\host.py" %*
"@
$CliCmd = @"
@echo off
"$Python" -B "%~dp0$RuntimeRel\cli\main.py" %*
"@
Write-Utf8NoBom $HostLauncher $HostCmd $CmdEncoding
Write-Utf8NoBom $CliLauncher $CliCmd $CmdEncoding

# Build via ConvertTo-Json so Windows backslashes in the launcher path are
# escaped correctly; hand-interpolated JSON would corrupt the path.
$ManifestObject = [ordered]@{
  name = 'com.paretocybernetics.overseer_browser'
  description = 'Private local OverSeer Browser native host'
  path = $HostLauncher
  type = 'stdio'
  allowed_origins = @('chrome-extension://iabfdeokmilpklblkgccpjlekchfjcno/')
}
Write-Utf8NoBom $ManifestPath ($ManifestObject | ConvertTo-Json)

$RegistryKeys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.paretocybernetics.overseer_browser',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.paretocybernetics.overseer_browser',
  'HKCU:\Software\BraveSoftware\Brave\NativeMessagingHosts\com.paretocybernetics.overseer_browser'
)
foreach ($Key in $RegistryKeys) {
  New-Item -Path $Key -Force | Out-Null
  Set-Item -Path $Key -Value $ManifestPath
}

# pareto-legacy: remove after 2027-08-23. One-time migration off the pre-rebrand native host name:
# the new keys above are written first, then the old keys are removed and each removal is reported.
$LegacyHostName = 'com.imploselabs.overseer_browser' # pareto-legacy
foreach ($Browser in @('Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave')) {
  $LegacyKey = "HKCU:\Software\$Browser\NativeMessagingHosts\$LegacyHostName"
  if (Test-Path -LiteralPath $LegacyKey) {
    Remove-Item -LiteralPath $LegacyKey -Recurse -Force
    Write-Host "Migrated native messaging host to com.paretocybernetics.overseer_browser; removed legacy registry key: $LegacyKey"
  }
}

Write-Host "Load unpacked extension directory: $ExtensionDir"
Write-Host "Native host launcher: $HostLauncher"
Write-Host "CLI launcher: $CliLauncher"
if (($env:PATH -split ';') -notcontains $RuntimeRoot) {
  Write-Host "To run 'overseer-browser' from any shell, add this folder to your user PATH"
  Write-Host "(Settings > System > About > Advanced system settings > Environment Variables):"
  Write-Host "  $RuntimeRoot"
  Write-Host "The one-step installer (install.ps1) does this for you with its own bin folder."
}
Write-Host "The extension is loaded and reloaded manually: open your browser's extensions page"
Write-Host "(e.g. chrome://extensions), enable Developer mode, and load/unload the unpacked"
Write-Host "directory above yourself."
Write-Host "Note: the native host uses an AF_UNIX socket, which requires Windows 10 1803 or later."

Write-Host "Coordinate this NEW Load unpacked path with session owners; reconfirm connection/site permissions."
Write-Host "Chrome does not follow path changes automatically. Old runtime trees and running hosts are retained."
