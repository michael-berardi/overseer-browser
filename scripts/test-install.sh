#!/bin/sh
# One-step installer test suite. Builds the release assets once, then exercises:
#   macOS: install into a throwaway HOME, version, upgrade re-run, corrupt archive, missing Python
#          (tests/test_release_install.py, the repo's unittest runner)
#   Linux: the same install/upgrade/corrupt flow in ubuntu:24.04 (sh is dash; busybox ash also tried)
#   Windows script: install.ps1 under PowerShell 7 on Linux (mcr.microsoft.com/powershell),
#          install, version, upgrade re-run, corrupt archive; PSScriptAnalyzer when it installs.
# Every release base is a local folder passed as file://; no server and no port is used.
# Containers are named overseer-browser-*, run with --rm, one at a time.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DIST="$ROOT/dist/release"

echo "== shellcheck =="
shellcheck scripts/install.sh scripts/build-release.sh

echo "== build release assets =="
scripts/build-release.sh "$DIST"

echo "== macOS (throwaway HOME) =="
OVERSEER_BROWSER_TEST_DIST="$DIST" python3 -m unittest tests.test_release_install -v

# The corrupt fixture lives under dist/ (gitignored): Docker Desktop file sharing
# does not reliably expose host /tmp bind mounts to containers.
CORRUPT="$ROOT/dist/corrupt-test"
rm -rf "$CORRUPT"; mkdir -p "$CORRUPT"
trap 'rm -rf "$CORRUPT"' EXIT
cp "$DIST/overseer-browser.tar.gz" "$DIST/overseer-browser.zip" "$DIST/SHA256SUMS" "$DIST/install.sh" "$DIST/install.ps1" "$CORRUPT/"
printf 'corrupted bytes' >> "$CORRUPT/overseer-browser.tar.gz"
printf 'corrupted bytes' >> "$CORRUPT/overseer-browser.zip"

echo "== Linux container (ubuntu:24.04, dash + busybox ash) =="
docker run --rm --name overseer-browser-linux-test \
  -v "$DIST:/rel:ro" -v "$CORRUPT:/bad:ro" ubuntu:24.04 bash -eu -c '
    apt-get update -qq >/dev/null
    apt-get install -y -qq python3 curl busybox >/dev/null
    export OVERSEER_BROWSER_RELEASE_BASE=file:///rel
    sh /rel/install.sh
    "$HOME/.local/bin/overseer-browser" --version
    echo "-- upgrade re-run under busybox ash --"
    busybox sh /rel/install.sh
    "$HOME/.local/bin/overseer-browser" --version
    echo "-- corrupt archive must be refused --"
    mkdir -p /tmp/badhome
    if HOME=/tmp/badhome OVERSEER_BROWSER_RELEASE_BASE=file:///bad sh /rel/install.sh >/tmp/bad.out 2>&1; then
      echo "corrupt archive was accepted"; exit 1
    fi
    grep -q "checksum mismatch" /tmp/bad.out
    test ! -e /tmp/badhome/.overseer-browser/releases
    test ! -e /tmp/badhome/.local/bin/overseer-browser
    echo "Linux container tests passed"
  '

echo "== Windows script under PowerShell 7 on Linux =="
docker run --rm --name overseer-browser-pwsh-test \
  -v "$DIST:/rel:ro" -v "$CORRUPT:/bad:ro" mcr.microsoft.com/powershell:latest \
  pwsh -NoProfile -Command '
    $ErrorActionPreference = "Stop"
    & apt-get update -qq *> $null
    & apt-get install -y -qq python3 *> $null
    $env:OVERSEER_BROWSER_RELEASE_BASE = "file:///rel"
    & /rel/install.ps1
    & "$HOME/.local/bin/overseer-browser" --version
    if ($LASTEXITCODE -ne 0) { throw "version check failed" }
    Write-Host "-- upgrade re-run --"
    & /rel/install.ps1
    Write-Host "-- corrupt archive must be refused --"
    $env:OVERSEER_BROWSER_RELEASE_BASE = "file:///bad"
    $env:OVERSEER_BROWSER_HOME = "/tmp/badhome/.overseer-browser"
    $env:OVERSEER_BROWSER_BIN_DIR = "/tmp/badhome/bin"
    $failed = $false
    try { & /rel/install.ps1 } catch { $failed = $true; if ("$_" -notmatch "checksum mismatch") { throw } }
    if (-not $failed) { throw "corrupt archive was accepted" }
    if (Test-Path "/tmp/badhome/.overseer-browser/releases") { throw "corrupt run installed something" }
    Write-Host "PowerShell 7 on Linux tests passed"
  '

echo "== PSScriptAnalyzer (skipped when it does not install quickly) =="
docker run --rm --name overseer-browser-psa-test \
  -v "$DIST:/rel:ro" mcr.microsoft.com/powershell:latest \
  pwsh -NoProfile -Command '
    try { Install-Module PSScriptAnalyzer -Force -Scope CurrentUser -ErrorAction Stop }
    catch { Write-Host "PSScriptAnalyzer did not install; skipped: $_"; exit 0 }
    $results = Invoke-ScriptAnalyzer -Path /rel/install.ps1
    $results | Format-Table -AutoSize | Out-String | Write-Host
    if ($results | Where-Object { $_.Severity -eq "Error" }) { exit 1 }
    Write-Host "PSScriptAnalyzer: no errors"
  '

echo "all installer tests passed"