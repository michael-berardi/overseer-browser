# Windows installer checks that run under PowerShell 7 on Linux (called by test-install.sh inside
# the pwsh-install-test container, after the release assets were built into /rel).
$ErrorActionPreference = 'Stop'

Write-Host '-- both Windows scripts must parse --'
foreach ($f in '/rel/install.ps1', '/scripts/install-windows.ps1') {
  $errs = $null; $tok = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tok, [ref]$errs)
  if ($errs.Count) { throw "$f does not parse: $($errs[0].Message)" }
}

$env:OVERSEER_BROWSER_RELEASE_BASE = 'file:///rel'

Write-Host '-- relative / separated overrides must keep the release just installed --'
New-Item -ItemType Directory -Force /tmp/w4 | Out-Null
$inner = '$env:OVERSEER_BROWSER_HOME = ''rel/./home''; $env:OVERSEER_BROWSER_BIN_DIR = ''rel/bin''; Set-Location /tmp/w4; & /rel/install.ps1'
& pwsh -NoProfile -Command $inner
if ($LASTEXITCODE -ne 0) { throw 'relative-override install failed' }
if (-not (Get-ChildItem /tmp/w4/rel/home/releases -Directory | Where-Object { $_.Name -like 'release-*' })) { throw 'the release just installed was deleted' }
& /tmp/w4/rel/bin/overseer-browser --version
if ($LASTEXITCODE -ne 0) { throw 'relative-override CLI does not run' }

Write-Host '-- irm | iex style dot-sourcing must not change the caller session --'
$inner = '$ErrorActionPreference = ''Continue''; $env:OVERSEER_BROWSER_HOME = ''/tmp/leak/h''; $env:OVERSEER_BROWSER_BIN_DIR = ''/tmp/leak/b''; . /rel/install.ps1 *> $null; ''EAP='' + $ErrorActionPreference + '' HomeDir='' + [bool](Get-Variable HomeDir -ErrorAction SilentlyContinue)'
$r = (& pwsh -NoProfile -Command $inner | Select-Object -Last 1)
if ("$r" -ne 'EAP=Continue HomeDir=False') { throw "install.ps1 leaked session state: $r" }

Write-Host 'Windows installer checks passed'
