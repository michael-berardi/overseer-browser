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
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

$Python = Resolve-Python

New-Item -ItemType Directory -Force -Path $HostDir, $CliDir | Out-Null
Copy-Item -Force (Join-Path $RepoRoot 'native_host\*.py') $HostDir
Copy-Item -Force (Join-Path $RepoRoot 'cli\*.py') $CliDir

Write-Utf8NoBom $HostLauncher @"
@echo off
"$Python" "$HostDir\host.py" %*
"@
Write-Utf8NoBom $CliLauncher @"
@echo off
"$Python" "$CliDir\main.py" %*
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
