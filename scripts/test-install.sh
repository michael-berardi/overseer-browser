#!/bin/sh
# One-step installer test suite. Builds the release assets once, then exercises:
#   macOS: install into a throwaway HOME, version, upgrade re-run, corrupt archive, missing Python
#          (tests/test_release_install.py, the repo's unittest runner)
#   Linux: the same install/upgrade/corrupt flow in ubuntu:24.04 (sh is dash; busybox ash also tried)
#   Windows script: install.ps1 under PowerShell 7 on Linux (local pwsh-install-test:7.4.6 image),
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

# mcr.microsoft.com/powershell publishes no arm64 Linux image (amd64 and 32-bit arm only), so the
# PowerShell 7 tests run in a small local image built from ubuntu:24.04 plus Microsoft's official
# arm64 tarball (built once when absent). No amd64 emulation. Each phase runs in a fresh pwsh process.
PS_VERSION=7.4.6
PWSH_IMAGE="pwsh-install-test:$PS_VERSION"
if ! docker image inspect "$PWSH_IMAGE" >/dev/null 2>&1; then
  echo "building $PWSH_IMAGE (ubuntu:24.04 + PowerShell $PS_VERSION tarball)"
  docker build -q -t "$PWSH_IMAGE" - >/dev/null <<DOCKERFILE || { echo "cannot build the PowerShell $PS_VERSION test image" >&2; exit 1; }
FROM ubuntu:24.04
RUN apt-get update -qq && apt-get install -y -qq ca-certificates curl libicu74 >/dev/null \\
 && case "\$(uname -m)" in aarch64) a=arm64 ;; x86_64) a=x64 ;; *) echo "unsupported CPU \$(uname -m)" >&2; exit 1 ;; esac \\
 && curl -fsSL --retry 3 -o /tmp/ps.tgz "https://github.com/PowerShell/PowerShell/releases/download/v$PS_VERSION/powershell-$PS_VERSION-linux-\$a.tar.gz" \\
 && mkdir -p /opt/powershell && tar -xzf /tmp/ps.tgz -C /opt/powershell && chmod +x /opt/powershell/pwsh \\
 && ln -s /opt/powershell/pwsh /usr/bin/pwsh && rm /tmp/ps.tgz
DOCKERFILE
fi

echo "== Windows script under PowerShell 7 on Linux =="
docker run --rm --name overseer-browser-pwsh-test \
  -v "$DIST:/rel:ro" -v "$CORRUPT:/bad:ro" "$PWSH_IMAGE" \
  pwsh -NoProfile -Command '
    $ErrorActionPreference = "Stop"
    & apt-get update -qq *> $null
    & apt-get install -y -qq python3 *> $null
    $env:OVERSEER_BROWSER_RELEASE_BASE = "file:///rel"
    & pwsh -NoProfile -Command "& /rel/install.ps1"
    if ($LASTEXITCODE -ne 0) { throw "install failed" }
    & "$HOME/.local/bin/overseer-browser" --version
    if ($LASTEXITCODE -ne 0) { throw "version check failed" }
    Write-Host "-- upgrade re-run --"
    & pwsh -NoProfile -Command "& /rel/install.ps1"
    if ($LASTEXITCODE -ne 0) { throw "upgrade re-run failed" }
    Write-Host "-- corrupt archive must be refused --"
    $env:OVERSEER_BROWSER_RELEASE_BASE = "file:///bad"
    $env:OVERSEER_BROWSER_HOME = "/tmp/badhome/.overseer-browser"
    $env:OVERSEER_BROWSER_BIN_DIR = "/tmp/badhome/bin"
    $badOut = (& pwsh -NoProfile -Command "& /rel/install.ps1" 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 0) { throw "corrupt archive was accepted" }
    if ($badOut -notmatch "checksum mismatch") { throw "corrupt run failed for the wrong reason: $badOut" }
    if (Test-Path "/tmp/badhome/.overseer-browser/releases") { throw "corrupt run installed something" }
    Write-Host "PowerShell 7 on Linux tests passed"
  '

echo "== PSScriptAnalyzer (skipped when it does not install quickly) =="
docker run --rm --name overseer-browser-psa-test \
  -v "$DIST:/rel:ro" "$PWSH_IMAGE" \
  pwsh -NoProfile -Command '
    $ErrorActionPreference = "Stop"
    try {
      Install-Module PSScriptAnalyzer -Force -Scope CurrentUser -ErrorAction Stop
      $results = @(Invoke-ScriptAnalyzer -Path /rel/install.ps1)
      foreach ($r in $results) { [Console]::WriteLine(("{0} {1} line {2}: {3}" -f $r.Severity, $r.RuleName, $r.Line, $r.Message)) }
      if ($results | Where-Object { $_.Severity -eq "Error" }) { exit 1 }
      [Console]::WriteLine(("PSScriptAnalyzer: {0} findings, no errors" -f $results.Count))
    } catch { [Console]::WriteLine("PSScriptAnalyzer did not install; skipped: " + $_.Exception.Message); exit 0 }
  '

echo "all installer tests passed"