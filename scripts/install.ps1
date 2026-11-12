#Requires -Version 5.1
# OverSeer Browser one-step installer for Windows (PowerShell 5.1 and 7):
#   irm https://github.com/example-user/overseer-browser/releases/latest/download/install.ps1 | iex
# Downloads the release bundle (source plus the ALREADY BUILT extension, so no Node is needed),
# checks its SHA-256 before anything is installed, unpacks it into a versioned folder under
# $env:OVERSEER_BROWSER_HOME (default %LOCALAPPDATA%\OverSeerBrowser), then runs the repo's own
# scripts/install-windows.ps1 from there. That installer registers the per-user native host under
# HKCU; this script adds an overseer-browser.cmd shim in the bin folder to the USER Path.
# PowerShell 7 on Linux and macOS is supported for testing: it runs the matching POSIX platform
# installer instead of the Windows one, and skips the registry and USER Path calls.
# Environment: OVERSEER_BROWSER_HOME, OVERSEER_BROWSER_BIN_DIR, OVERSEER_BROWSER_VERSION (pin),
# OVERSEER_BROWSER_RELEASE_BASE (override the download base URL, used by tests; file:// works).
function Install-OverSeerBrowser {
  # Inside the function so 'irm | iex' leaves the caller's session settings alone.
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # the 5.1 progress bar makes downloads very slow
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }
  $isWinVar = Get-Variable -Name IsWindows -ErrorAction SilentlyContinue
  $OnWindows = (-not $isWinVar) -or $isWinVar.Value   # PowerShell 5.1 has no $IsWindows and is always Windows

  $repo = 'example-user/overseer-browser'
  if ($env:OVERSEER_BROWSER_RELEASE_BASE) { $base = $env:OVERSEER_BROWSER_RELEASE_BASE }
  elseif ($env:OVERSEER_BROWSER_VERSION) { $base = "https://github.com/$repo/releases/download/v$($env:OVERSEER_BROWSER_VERSION.TrimStart('v'))" }
  else { $base = "https://github.com/$repo/releases/latest/download" }

  if ($env:OVERSEER_BROWSER_HOME) { $HomeDir = $env:OVERSEER_BROWSER_HOME }
  elseif ($OnWindows) {
    if (-not $env:LOCALAPPDATA) { throw 'overseer-browser install: LOCALAPPDATA is not set; set OVERSEER_BROWSER_HOME to an absolute folder and run this again.' }
    $HomeDir = Join-Path $env:LOCALAPPDATA 'OverSeerBrowser'
  } else { $HomeDir = Join-Path $HOME '.overseer-browser' }
  if ($env:OVERSEER_BROWSER_BIN_DIR) { $BinDir = $env:OVERSEER_BROWSER_BIN_DIR }
  elseif ($OnWindows) { $BinDir = Join-Path $HomeDir 'bin' }
  else { $BinDir = Join-Path $HOME '.local/bin' }

  # Normalise now: a relative or '/'-separated override must compare equal to what Get-ChildItem returns.
  $HomeDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($HomeDir)
  $BinDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($BinDir)

  function Get-Asset([string]$Url, [string]$Dest) {
    if ($Url.StartsWith('file://')) { Copy-Item -LiteralPath ([Uri]$Url).LocalPath -Destination $Dest }
    else { Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing }
  }

  # Python 3.9+ runs the native host and CLI. Never install a system Python here.
  $python = $null
  if ($OnWindows) {
    foreach ($candidate in @('py', 'python')) {
      $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
      if (-not $cmd) { continue }
      $probeArgs = if ($candidate -eq 'py') { @('-3', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)') } else { @('-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)') }
      try { & $cmd.Source @probeArgs 2>$null } catch { }
      if ($LASTEXITCODE -eq 0) { $python = $cmd.Source; break }
    }
    if (-not $python) { throw 'overseer-browser install: Python 3.9 or newer is required and was not found; install it with: winget install -e --id Python.Python.3.12 (then run this again)' }
  } else {
    $cmd = Get-Command python3 -ErrorAction SilentlyContinue
    if ($cmd) {
      try { & $cmd.Source -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>$null } catch { }
      if ($LASTEXITCODE -eq 0) { $python = $cmd.Source }
    }
    if (-not $python) { throw 'overseer-browser install: Python 3.9 or newer is required and was not found; install it with: sudo apt-get install -y python3 (or your platform equivalent, then run this again)' }
    if (-not (Get-Command bash -ErrorAction SilentlyContinue)) { throw 'overseer-browser install: bash is required for the POSIX platform installer; install it, then run this again.' }
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('overseer-browser-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $savedBinDirEnv = $env:OVERSEER_BROWSER_BIN_DIR   # restored in finally: the child installer needs it only during this run
  try {
    Write-Host 'Downloading OverSeer Browser...'
    $zip = Join-Path $tmp 'overseer-browser.zip'
    $sums = Join-Path $tmp 'SHA256SUMS'
    Get-Asset "$base/overseer-browser.zip" $zip
    Get-Asset "$base/SHA256SUMS" $sums
    $want = (Get-Content -LiteralPath $sums | Where-Object { $_ -match '\soverseer-browser\.zip$' } | Select-Object -First 1)
    $want = if ($want) { ($want -split '\s+')[0].ToLower() } else { '' }
    if (-not $want) { throw 'overseer-browser install: no checksum for overseer-browser.zip in SHA256SUMS; nothing was installed.' }
    $got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want) { throw 'overseer-browser install: checksum mismatch for overseer-browser.zip; the download is corrupted or tampered with; nothing was installed.' }

    $src = Join-Path $tmp 'src'
    Expand-Archive -LiteralPath $zip -DestinationPath $src -Force
    foreach ($marker in @('cli/main.py', 'native_host/host.py', 'extension/.output/chrome-mv3/manifest.json')) {
      if (-not (Test-Path -LiteralPath (Join-Path $src $marker))) { throw "overseer-browser install: the download is not an OverSeer Browser release bundle ($marker is missing)." }
    }
    $versionLine = Select-String -LiteralPath (Join-Path $src 'cli/main.py') -Pattern '^CLI_VERSION = "([^"]+)"' | Select-Object -First 1
    if (-not $versionLine) { throw 'overseer-browser install: cannot read the release version from cli/main.py.' }
    $version = $versionLine.Matches[0].Groups[1].Value

    $releases = Join-Path $HomeDir 'releases'
    $rel = Join-Path $releases "release-$version"
    Write-Host "Installing OverSeer Browser $version into $rel..."
    New-Item -ItemType Directory -Force -Path $releases, $BinDir | Out-Null
    if (Test-Path -LiteralPath $rel) { Remove-Item -Recurse -Force -LiteralPath $rel }
    # Copy, not Move: the temp folder and the home folder can be on different filesystems.
    Copy-Item -Recurse -LiteralPath $src -Destination $rel

    # The repo's own platform installer registers the native host and the CLI launcher.
    # The bundle already contains the built extension, so Node is not needed.
    $env:OVERSEER_BROWSER_BIN_DIR = $BinDir
    if ($OnWindows) {
      # Run the platform installer in a child process with the execution policy bypassed for that
      # one process: the default Restricted policy refuses to run a script file, even this one.
      $installer = Join-Path $rel 'scripts/install-windows.ps1'
      $psExe = if ($PSVersionTable.PSEdition -eq 'Core') { (Get-Process -Id $PID).Path } else { Join-Path $PSHOME 'powershell.exe' }
      & $psExe -NoProfile -ExecutionPolicy Bypass -File $installer
      if ($LASTEXITCODE -ne 0) { throw "overseer-browser install: the Windows platform installer failed (exit $LASTEXITCODE); the native host was not registered." }
      # The shim holds only ASCII: %LOCALAPPDATA% is expanded by cmd at run time, so a profile
      # folder with non-ASCII characters (for example C:\Users\Jose with an accent) still resolves.
      $rootVar = if ($env:LOCALAPPDATA) { '%LOCALAPPDATA%' } else { '%USERPROFILE%' }
      $cliTarget = $rootVar + '\OverSeer\browser\overseer-browser.cmd'
      $shim = Join-Path $BinDir 'overseer-browser.cmd'
      $shimMarker = 'REM overseer-browser-shim'
      # Ours when absent, when it carries the marker, or when it is the exact 0.10.0 shim (no marker):
      # two lines, the second pointing at ...\OverSeer\browser\overseer-browser.cmd and nothing else.
      $legacyShimPattern = '^@echo off\r?\n"[^"\r\n]*\\OverSeer\\browser\\overseer-browser\.cmd" %\*\s*$'
      $ownShim = -not (Test-Path -LiteralPath $shim)
      if (-not $ownShim) {
        $ownShim = [bool](Select-String -LiteralPath $shim -SimpleMatch $shimMarker -Quiet)
        if (-not $ownShim) {
          $shimBody = Get-Content -LiteralPath $shim -Raw
          $ownShim = [bool]($shimBody -and ($shimBody -match $legacyShimPattern))
        }
      }
      if ($ownShim) {
        $shimText = "@echo off`r`n$shimMarker (written by the OverSeer Browser installer)`r`n`"$cliTarget`" %*`r`n"
        [IO.File]::WriteAllText($shim, $shimText, [Text.Encoding]::ASCII)
        $cli = $shim
      } else {
        $cliReal = Join-Path $(if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }) 'OverSeer\browser\overseer-browser.cmd'
        Write-Host "$shim exists and is not ours; left alone. Run the CLI as $cliReal instead."
        $cli = $cliReal
      }
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if (-not $userPath) { $userPath = '' }
      if (($userPath -split ';') -notcontains $BinDir) {
        $newPath = if ($userPath.TrimEnd(';')) { $userPath.TrimEnd(';') + ';' + $BinDir } else { $BinDir }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "Added $BinDir to your USER Path; open a new terminal to pick it up."
      }
    } else {
      $uname = (& uname -s).Trim()
      if ($uname -eq 'Darwin') {
        $env:OVERSEER_BROWSER_PREBUILT_EXTENSION = '1'
        & bash (Join-Path $rel 'scripts/manage-macos.sh') install
      } else {
        & bash (Join-Path $rel 'scripts/install-linux.sh')
      }
      if ($LASTEXITCODE -ne 0) { throw "overseer-browser install: the POSIX platform installer failed (exit $LASTEXITCODE); the native host was not registered." }
      $cli = Join-Path $BinDir 'overseer-browser'
    }

    # One stable extension folder survives upgrades, so Chrome's Load unpacked path never changes.
    $extStable = Join-Path $HomeDir 'extension'
    $extTmp = Join-Path $HomeDir 'extension.tmp'
    if (Test-Path -LiteralPath $extTmp) { Remove-Item -Recurse -Force -LiteralPath $extTmp }
    Copy-Item -Recurse -LiteralPath (Join-Path $rel 'extension/.output/chrome-mv3') -Destination $extTmp
    if (Test-Path -LiteralPath $extStable) { Remove-Item -Recurse -Force -LiteralPath $extStable }
    Move-Item -LiteralPath $extTmp -Destination $extStable

    # Keep only the release that is installed now.
    Get-ChildItem -LiteralPath $releases -Directory | Where-Object { $_.Name -like 'release-*' -and $_.FullName -ne $rel } | Remove-Item -Recurse -Force

    if (-not (Test-Path -LiteralPath $cli)) { throw "overseer-browser install: the platform installer did not leave a CLI at $cli." }
    # PowerShell 7.4+ turns nonzero native exits into terminating errors under EAP Stop;
    # the version probe and the informational health call must not do that here.
    $savedEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $got = (& $cli --version 2>&1 | Out-String).Trim()
    $versionExit = $LASTEXITCODE
    $ErrorActionPreference = $savedEap
    if ($versionExit -ne 0) { throw "overseer-browser install: the installed CLI does not run: $got" }
    $parsed = $null
    try { $parsed = $got | ConvertFrom-Json } catch { }
    if (-not $parsed -or $parsed.ok -ne $true -or $parsed.result.cli_version -ne $version) {
      throw "overseer-browser install: the installed CLI reports '$got', not $version."
    }
    Write-Host "Version check passed: $got"
    Write-Host "Local health (the extension is not loaded in a browser yet, so 'ok' stays false until it is):"
    $ErrorActionPreference = 'Continue'
    $health = (& $cli health 2>&1 | Out-String).Trim()
    $ErrorActionPreference = $savedEap
    Write-Host $health

    Write-Host ''
    Write-Host "OverSeer Browser $version installed. One manual step remains (a browser action no script can do):"
    Write-Host "  Open chrome://extensions, enable Developer mode, click 'Load unpacked' and select this folder:"
    Write-Host "  $extStable"
    Write-Host 'The dedicated agent browser loads the extension by itself; the manual step is for your everyday Chrome.'
    Write-Host 'Next: overseer-browser sessions start'
    Write-Host "Update later by re-running this installer. Remove by deleting $HomeDir and the overseer-browser shim in $BinDir"
    Write-Host '(plus the native host entries the platform installer printed above).'
  } finally {
    $env:OVERSEER_BROWSER_BIN_DIR = $savedBinDirEnv
    Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
  }
}

Install-OverSeerBrowser