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
uninstalling, and loading the extension to lend everyday tabs.

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
retry if startup timed out. `evaluate` also needs Chrome's **Allow User Scripts**
setting. Your personal profile's permissions are not copied.

Use refs returned by `observe` for actions such as `click osr-12`.
Use a distinct `--session KEY` or `OVERSEER_BROWSER_SESSION` for each concurrent
agent. Video recording requires a fresh approval click in the extension popup.

## Reference

- [Usage guide](docs/usage.md): parallel sessions, tab lending, mobile-width
  windows, screenshots, QA evidence, recording and connection troubleshooting.
- [CLI reference](docs/cli.md), or `overseer-browser help`.
- [Protocol](PROTOCOL.md) and [read-only DOM queries](DOM_QUERIES.md).
- [Privacy](PRIVACY.md) and [security](SECURITY.md): local data flow and trust boundaries.
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
The Python bridge tests use fixtures and local sockets. See
[Contributing](CONTRIBUTING.md) for manual browser checks.

## License

[MIT](LICENSE). [Third-party notices](THIRD_PARTY_NOTICES.txt).

Part of [Pareto Cybernetics](https://paretocybernetics.com/projects/overseer-browser/): free, private, open-source tools for working with AI agents.
