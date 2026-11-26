# OverSeer Browser

<img src="extension/public/icon-128.png" alt="OverSeer Browser icon" width="112" />

Control Chromium from a CLI that returns JSON. Built for local scripts and
coding agents: an extension and Python native host handle browser commands,
without a model SDK or cloud service.

Sessions use dedicated agent windows in a separate Chrome for Testing profile.
You can also explicitly lend tabs from an everyday browser. Session keys route
commands, but are not security credentials: sessions share cookies and site
permissions within the dedicated profile.

[![Release](https://img.shields.io/github/v/release/michael-berardi/overseer-browser?label=release)](https://github.com/michael-berardi/overseer-browser/releases/latest)
[![MIT License](https://img.shields.io/github/license/michael-berardi/overseer-browser)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

## Install

Requires Python 3.9+ and [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/).
The dedicated-browser lifecycle supports macOS and Linux. Windows installation
is experimental; isolated startup and POSIX-only media cleanup are unavailable.

macOS and Linux (no Node.js needed):

```sh
curl -fsSL https://github.com/michael-berardi/overseer-browser/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/michael-berardi/overseer-browser/releases/latest/download/install.ps1 | iex
```

### From source

On macOS (also requires Node.js and npm):

```sh
git clone https://github.com/michael-berardi/overseer-browser.git
cd overseer-browser
./scripts/manage-macos.sh install
```

The installer builds the extension, registers a per-user native host, and puts
the CLI in `~/.local/bin`. Add that directory to PATH if needed. It does not
open a browser.

See [installation and updates](docs/install.md) for source builds, Windows,
uninstalling, and loading the extension to lend everyday tabs. See
[Updates](docs/updates.md) for the anonymous release check, opt-outs, and
rollback.

## First session

```sh
export OVERSEER_BROWSER_SESSION=demo
overseer-browser sessions start demo
overseer-browser tabs create https://example.com
overseer-browser observe
overseer-browser screenshot
overseer-browser sessions stop
```

`sessions start` launches a dedicated browser. On first launch, approve the
extension and enable its native connection and site access in its popup, then
retry if startup timed out. `evaluate` uses Chrome's **Allow User Scripts** setting where available and
falls back to MAIN-world injection on pages that permit it. Strict-CSP pages
still need that setting. Your personal profile's permissions are not copied.

Screenshots retry Chrome capture-rate limits. A covered Agent Window is moved
clear of its cover for the capture (never focused or resized) and put back;
persistent limits or a window that stays hidden return an actionable error.

Use refs returned by `observe` for actions such as `click osr-12`.
Use a distinct `--session KEY` or `OVERSEER_BROWSER_SESSION` for each concurrent
agent. Video recording requires a fresh approval click in the extension popup.

## Privacy

There is no telemetry, analytics, or crash reporting. In an interactive terminal
the CLI makes one anonymous HTTPS GET per day to this repository's public GitHub
"latest release" record, with a fixed `overseer-browser-update-check`
User-Agent and no account, version, usage, or machine data. It is off in CI,
agents, non-TTY/JSON use, and with `OVERSEER_BROWSER_NO_UPDATE_CHECK=1` or
`overseer-browser update --checks off`; automatic installation is opt-in. The
extension and native host make no network requests. Installing or updating a
release fetches only the release archive and its checksum file from GitHub by
HTTPS. Building from source also downloads npm packages from the npm registry,
with audit, funding and `DO_NOT_TRACK` telemetry opt-outs set by the build
scripts. See [Updates](docs/updates.md) for details.

The extension talks to the local native host through Chrome Native Messaging;
the CLI talks to that host over a same-user local socket with a random local
token. No account or cloud control service is involved. Browser traffic happens
when you navigate or act on a page. A client, model provider, or other service
you configure receives whatever you send it; that transfer is outside this
project.

Locally, the extension keeps session, permission, and short-lived meeting state
in the browser profile. The host keeps its token and a bounded, `0600`
`host.log` (and, for the isolated Agent Window, a `0600` `agent-v1/chrome.log` trimmed past 1 MiB) in a `0700` runtime directory (macOS `~/Library/Application Support/OverSeer/browser`,
Linux `$XDG_RUNTIME_DIR/overseer-browser`, or `~/.config/overseer-browser` when that is unset; `OVERSEER_BROWSER_RUNTIME` overrides all, Windows `%LOCALAPPDATA%\OverSeer\browser`).
Screenshots, QA packs, timelapses, and recordings are written only when you ask
for them and can contain page content. OS-temp copies expire; files you keep or
write elsewhere are yours to delete. An optional local UltraVox adapter can
receive minimized meeting detections over same-user IPC when its private socket
is present.

To delete local data, remove the extension in `chrome://extensions`, delete the
runtime directory above and any evidence or recording directories you created,
and remove the native-host registration and CLI using the uninstall steps in
[installation and updates](docs/install.md) (`overseer-browser uninstall` on
macOS). See [PRIVACY.md](PRIVACY.md) for the full data flow and boundaries.

## Reference

- [Usage guide](docs/usage.md): parallel sessions, tab lending, mobile-width
  windows, screenshots, QA evidence, recording and connection troubleshooting.
- [CLI reference](docs/cli.md), or `overseer-browser help`.
- [Protocol](PROTOCOL.md) and [read-only DOM queries](DOM_QUERIES.md).
- [Privacy](PRIVACY.md) and [security](SECURITY.md): local data flow and trust boundaries.
- [Updates](docs/updates.md): anonymous daily check, opt-outs, install and rollback.
- [Contributing](CONTRIBUTING.md) and [changelog](CHANGELOG.md).

## Development

```sh
npm ci --prefix extension
npm run check --prefix extension
npm test --prefix extension
npm run build --prefix extension
python3 -m unittest tests.test_browser_bridge
```

The extension tests use Node-based browser doubles, not a running browser.
The Python bridge tests use fixtures and local sockets. For local npm commands,
prefix with `DO_NOT_TRACK=1 npm_config_audit=false npm_config_fund=false` on a
POSIX shell to skip registry audit/funding requests. See
[Contributing](CONTRIBUTING.md) for manual browser checks.

## License

[MIT](LICENSE). [Third-party notices](THIRD_PARTY_NOTICES.txt).

Part of [Pareto Cybernetics](https://paretocybernetics.com/projects/overseer-browser/): free, private, open-source tools for working with AI agents.
