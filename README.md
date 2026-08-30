# OverSeer Browser

<p align="center">
  <img src="extension/public/icon-128.png" alt="OverSeer Browser icon" width="112" />
</p>

<p align="center">
  <strong>Local-first, model-agnostic browser automation for Chromium.</strong><br />
  <a href="#install-from-source-on-macos">Install</a> ·
  <a href="#first-use">Quick start</a> ·
  <a href="PRIVACY.md">Privacy</a> ·
  <a href="PROTOCOL.md">Protocol</a>
</p>

OverSeer Browser is an open-source, local-first browser automation bridge for Chromium. A command-line client connects to a per-user native host over a Unix socket; the host connects to the extension through Chrome Native Messaging. The browser contract is model-agnostic: any client or agent that speaks the documented protocol can use it without a model SDK or vendor-specific transport.

The project is designed for explicit, visible automation:

- Browser control stays on the local machine. The repository does not require a remote browser or control service.
- A session owns a dedicated Agent Window by default. A normal tab must be explicitly borrowed and is returned when the session ends.
- HTTP(S) site access is off by default. The popup grants only the current origin or, when the user explicitly chooses it, unlimited HTTP(S) access.
- The extension does not request `chrome.debugger`, CDP, history, bookmarks, `webRequest`, or `activeTab`. Debugger-only capabilities return structured `unsupported_capability` errors.
- Page observations, screenshots, uploads, and action results remain local unless the calling client deliberately forwards them under its own privacy policy.
- Optional anonymous usage sharing is disabled until consent. It is not required for browser control; see [PRIVACY.md](PRIVACY.md) for the data boundary.

Read [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before using the extension with sensitive data.

## Requirements

- A Chromium-family browser (Chrome, Edge, Brave, Chromium, and derivatives) with Chrome Native Messaging and User Scripts support.
- Node.js and npm to build the extension.
- Python 3.9 or newer to run the native host and CLI.
- macOS, Linux, or Windows 10 1803+ (the native host uses a per-user AF_UNIX socket; on Windows it registers through HKCU registry keys and mode-bit privacy checks yield to NTFS ACLs).

## Install from source on macOS

The macOS installer builds the extension, stages an unpacked `chrome-extension/` directory, and registers a per-user native host and CLI:

```sh
git clone https://github.com/michael-berardi/overseer-browser.git
cd overseer-browser
./scripts/manage-macos.sh install
./scripts/manage-macos.sh status
```

In Chrome or another Chromium browser, open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select the generated `chrome-extension/` directory. The installer writes the matching Native Messaging registration; never weaken `allowed_origins` to work around an extension-ID mismatch.
For CSP-safe page evaluation, open the extension details and enable Chrome’s
**Allow User Scripts** setting once. OverSeer Browser still keeps agent access
off until the popup grants the current site or explicitly enables unlimited
HTTP(S) access.

To update an installation, stop active sessions, update the checkout, rebuild, and reload the unpacked extension:

```sh
git pull --ff-only
./scripts/manage-macos.sh update
overseer-browser status
```

The installed CLI also provides `install`, `status`, `update`, and `uninstall`. `install` and `update` rebuild from the source checkout recorded at installation; `status` and `uninstall` do not require the checkout. Remove the extension from `chrome://extensions` and run `overseer-browser uninstall` when you are finished.

The generated `.output/` and `chrome-extension/` directories are staging output and are ignored by Git. Source under `extension/` and its lockfile are authoritative.

## Install from source on Linux

The Linux installer registers the per-user native host and CLI for Chrome, Chromium, Brave, and Edge (it does not build the extension — build once with `npm ci && npm run build --prefix extension`):

```sh
git clone https://github.com/michael-berardi/overseer-browser.git
cd overseer-browser
npm ci --prefix extension && npm run build --prefix extension
./scripts/install-linux.sh
```

Re-run `./scripts/install-linux.sh` after `git pull --ff-only` to update. Then load the unpacked `chrome-extension/` directory from your browser's extensions page as described above.

## Install from source on Windows

Build the extension first (Node.js required), then run the PowerShell installer, which copies the host and CLI into `%LOCALAPPDATA%\OverSeer\browser`, writes the native-host manifest, and registers it under HKCU for Chrome, Edge, and Brave:

```powershell
git clone https://github.com/michael-berardi/overseer-browser.git
cd overseer-browser
npm ci --prefix extension; npm run build --prefix extension
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

Re-run the installer after `git pull --ff-only` to update. Then load the unpacked `chrome-extension\` directory from `chrome://extensions` (Developer mode → **Load unpacked**).

## First use

1. Run `overseer-browser health` to check the local runtime, then `overseer-browser status --json` to inspect the extension connection.
2. Open the popup on the intended page and choose **Allow this site**. For a dedicated agent profile, **Enable unlimited** grants every HTTP(S) origin until disabled.
3. Start a session with `overseer-browser sessions start`.
4. Create or select a tab, navigate, observe, and perform actions using the CLI.
5. To automate a normal browsing tab, open it and choose **Borrow active tab** in the extension popup. Return it explicitly or stop the session before closing the browser.
6. End work with `overseer-browser sessions stop`. Confirm that borrowed tabs were returned.

## CLI surface

From a checkout, use `./cli/overseer-browser ...`; the examples below use an installed `overseer-browser` on `PATH`.

```sh
overseer-browser health
overseer-browser status [--json]
overseer-browser sessions start [name]
overseer-browser sessions stop
overseer-browser sessions list
overseer-browser windows resize <width> <height>
overseer-browser tabs list
overseer-browser tabs create [url] [--wait-until load|interactive]
overseer-browser tabs select <tab-id>
overseer-browser tabs close <tab-id>
overseer-browser tabs borrow <tab-id>
overseer-browser tabs return <tab-id>
overseer-browser navigate <url> [--wait-until load|interactive]
overseer-browser back [--wait-until load|interactive]
overseer-browser forward [--wait-until load|interactive]
overseer-browser reload [--wait-until load|interactive]
overseer-browser snapshot [--max-nodes N]
overseer-browser observe [--max-nodes N] [--changes]
overseer-browser wait --ready [--timeout-ms N]
overseer-browser wait --url TEXT [--timeout-ms N]
overseer-browser wait --text TEXT [--absent] [--timeout-ms N]
overseer-browser wait --selector CSS [--state visible|hidden|enabled] [--timeout-ms N]
overseer-browser wait --stable MS [--timeout-ms N]
overseer-browser click <ref>
overseer-browser hover <ref>
overseer-browser fill <ref> <text>
overseer-browser type <ref> <text>
overseer-browser select <ref> <value>
overseer-browser press <key> [ref]
overseer-browser scroll <y> | <x> <y> | <ref> [<x> <y>]
overseer-browser evaluate <script>
overseer-browser screenshot [path]            # requires unlimited access (Chrome's <all_urls> capture rule)
overseer-browser screenshot-element <ref> [path]
overseer-browser upload <ref> <path> [path...]
overseer-browser console start|read|stop
overseer-browser network read [limit]
overseer-browser batch '<json-actions>'
overseer-browser capture start|stop
overseer-browser help
overseer-browser takeover
overseer-browser takeover resume
overseer-browser cancel <request-id>
```

Structured results are served as UltraCompact packets when stdout is not a terminal (and under `--json`), cutting agent token cost; `uc decode` restores the exact JSON and `--raw-json` always emits it directly. Interactive terminals keep pretty-printed JSON. UltraCompact encoding uses the UltraCompact encoder when available (`UC_BIN`/`UC_LIB` environment overrides, a `uc` binary on `PATH`, or `~/.local/lib/ultracompact/`); without it the CLI emits canonical JSON with a warning, so nothing breaks.

`evaluate` requires an explicit site-access scope and Chrome’s one-time **Allow User Scripts** setting. It runs in the CSP-exempt User Scripts world, so strict websites do not need `unsafe-eval`. Uploads, console capture, Resource Timing metadata, screenshots, and batches are bounded; see [PROTOCOL.md](PROTOCOL.md) for limits and response shapes. Commands return structured errors with stable codes. Unsupported debugger-only capabilities are never silently downgraded.

Ref-based actions work through the top document, open shadow roots, and visible same-origin nested frames. Cross-origin frame DOM remains opaque. Mutation actions report a bounded `dom_mutations` count. Use explicit tab IDs for concurrent clients and serialize navigation or other mutations per tab.

## Privacy and security

The extension has no user account and no cloud browser-control plane. Native host and CLI state is local and protected with per-user file and socket permissions where supported. The extension does not passively inventory arbitrary tabs or collect general browsing history.

Meeting detection, when enabled by a build, is limited to its documented supported hosts and emits only a versioned opaque event for local delivery. It does not include raw URLs, meeting IDs, titles, page content, participants, credentials, or recording data. The extension never starts recording.

Optional telemetry is off until an affirmative popup choice. If enabled by a release, it sends only the coarse fields and counters documented in [PRIVACY.md](PRIVACY.md) to that release's configured telemetry service. Disable sharing in the popup to remove the local identifier and pending counters. Browser control does not depend on telemetry.

No browser extension can protect against a compromised browser, operating system, malicious same-user process, or an unsafe page. Use a separate browser profile or OS account for sensitive work, and do not enter credentials unless that is the intended task.

## Development

```sh
npm ci --prefix extension
npm run dev --prefix extension
npm run build --prefix extension
npm test --prefix extension
python3 -m unittest tests.test_browser_bridge
```

Load the generated development directory with **Load unpacked**. Do not commit generated output, release archives, credentials, or personal configuration. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review guidelines.

## Documentation

- [PROTOCOL.md](PROTOCOL.md) — local framing, commands, limits, and event schemas.
- [PRIVACY.md](PRIVACY.md) — local data flow, permissions, retention, and threat boundaries.
- [SECURITY.md](SECURITY.md) — vulnerability reporting and security invariants.
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, testing, accessibility, and contribution guidance.
- [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) — dependency licenses and attribution.

## License

This repository is released under the [MIT License](LICENSE).