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
- The extension declares broad HTTP(S) host permission at installation for its dedicated Agent Window and screenshots; operator-browser tabs remain blocked until the popup explicitly grants the current origin or unlimited HTTP(S) access.
- The extension does not enable debugger access, history, bookmarks, or `webRequest`. Explicit video capture uses popup-consented `activeTab`/`tabCapture`/`offscreen` access. Debugger-dependent operations are not included in this release and no debugger permission is requested. Missing capabilities never silently switch transports.
- Page observations, screenshots, uploads, and action results remain local unless the calling client deliberately forwards them under its own privacy policy.
- Optional anonymous usage sharing is disabled until consent. It is not required for browser control; see [PRIVACY.md](PRIVACY.md) for the data boundary.

Read [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before using the extension with sensitive data.

## Requirements

- A Chromium-family browser (Chrome, Edge, Brave, Chromium, and derivatives) with Chrome Native Messaging and User Scripts support.
- Node.js and npm to build the extension.
- Python 3.9 or newer to run the native host and CLI.
- Automatic media cleanup and recording export require POSIX file locking (macOS/Linux). Those workflows are not supported on Windows in this release; they fail explicitly rather than silently retain temporary data. Windows existing-relay installation remains experimental.
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
off for operator-browser tabs until the popup grants the current site or explicitly enables unlimited
HTTP(S) access. The dedicated Agent Window is exempt from this operator gate.

To update an installation, coordinate with other agents, stop only the sessions you own, update the checkout, rebuild, and reload the unpacked extension. Chrome requires the operator to confirm the reload; do not close another agent's windows or weaken browser security. Site grants remain in local storage. Session bindings survive service-worker suspension, but extension reload/browser restart can clear Chrome session storage; start fresh owned sessions after an upgrade rather than silently adopting old windows:

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
2. For borrowed operator tabs, open the popup on the intended page and choose **Allow this site**; **Enable unlimited** grants every HTTP(S) origin until disabled. Dedicated Agent Window tabs use the extension's installed broad host permission and do not require this operator grant.
3. Start a session with `overseer-browser sessions start`.
4. Create or select a tab, navigate, observe, and perform actions using the CLI.
5. To automate a normal browsing tab, open it and choose **Borrow active tab** in the extension popup. Return it explicitly or stop the session before closing the browser.
6. End work with `overseer-browser sessions stop`. Confirm that borrowed tabs were returned.

## Parallel agents (0.3.0)

Each session key owns a separate Agent Window, selected tab, borrowed-tab claims, pause state, uploads, and cleanup. Up to 32 sessions may run at once. Commands never fall back to another active agent's session. Session keys are routing identifiers inside the same authenticated OS-user trust domain, **not credentials or hostile-process isolation**; windows still share the browser profile's cookies and site permissions.

Use a unique key per agent or independent delegated task:

```sh
# Agent A
export OVERSEER_BROWSER_SESSION=agent-a
overseer-browser sessions start research
overseer-browser tabs create https://example.com

# Agent B, concurrently in another agent's environment
export OVERSEER_BROWSER_SESSION=agent-b
overseer-browser sessions start qa
overseer-browser tabs create https://example.org

# Explicit flags override the environment; stop only your own session.
overseer-browser --session agent-a sessions stop
```

`--session KEY` overrides `OVERSEER_BROWSER_SESSION`. Otherwise the CLI derives an opaque stable key from an available agent-session identity (`PI_SESSION_ID`, `CODEX_THREAD_ID`, or `CLAUDE_SESSION_ID`; combined UltraTerm tmux-session/slot identity is a fallback). Delegates inheriting the parent's environment **must supply their own explicit key**. Clients without an identity use the isolated legacy `default` scope, not an inferred active session. Generic protocol clients must provide `session_key` themselves.

`sessions list` and `status` show all session summaries, including `sessionKey`; tab lists and actions remain scoped. The popup requires an explicit recipient when borrowing a normal tab with multiple sessions active. One tab cannot be borrowed by two sessions. CLI takeover pauses/resumes only its own session; the popup's operator-wide pause remains authoritative. Meeting capture controls remain operator-wide and require explicit `--session default` when automatic agent scoping is active.

The CLI and host fail closed against older extensions: upgrade both parts and confirm `status --raw-json` reports extension `0.3.0` or newer and `multi_session: true` before concurrent work. `overseer-browser --version` reports the installed CLI version. Screenshots are paced to Chrome's extension-wide capture limit; other agents' page operations remain concurrent.

## CLI surface

From a checkout, use `./cli/overseer-browser ...`; the examples below use an installed `overseer-browser` on `PATH`.

```sh
overseer-browser --version
overseer-browser [--session KEY] health
overseer-browser [--session KEY] status [--json]
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
overseer-browser screenshot [path]            # dedicated Agent Window works without popup grant; borrowed tabs require site access
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

Command results are plain minified JSON on stdout, including errors and terminal output. `--json` and `--raw-json` remain compatibility aliases. No compression codec, native encoding library, decoder, or encoding subprocess is needed.

### Managed temporary outputs

Screenshots without a filename use `/tmp/screenshots/` on POSIX. Explicit OS-temp screenshots, evidence packs, timelapses and recording exports remain temporary unless marked `--keep`. Completed outputs normally expire after 15 minutes and may be evicted earlier under the 512 MiB / 512-entry budget; active reservations are protected. Separate conversion staging has four 128 MiB slots. Journaling precedes file publication, so interrupted writes and publications can be reclaimed without adopting unrelated files. Replaced/edited files and unrelated directory additions are preserved.

The native host reaps on startup and while idle. If the host is stopped, cleanup waits for the next host/CLI startup; no always-running OS cleanup guarantee is claimed. Outside-temp and `--keep` exports are deliberately persistent. Update the native host as well as the CLI to obtain idle cleanup.

`evaluate` requires an explicit site-access scope and Chrome’s one-time **Allow User Scripts** setting. It runs in the CSP-exempt User Scripts world, so strict websites do not need `unsafe-eval`. Uploads, console capture, Resource Timing metadata, screenshots, and batches are bounded; see [PROTOCOL.md](PROTOCOL.md) for limits and response shapes. Commands return structured errors with stable codes. Unsupported debugger-only capabilities are never silently downgraded.

Ref-based actions work through the top document, open shadow roots, and visible same-origin nested frames. Cross-origin frame DOM remains opaque. Mutation actions report a bounded `dom_mutations` count. Use explicit tab IDs for concurrent clients and serialize navigation or other mutations per tab.

## Privacy and security

The extension has no user account and no cloud browser-control plane. Native host and CLI state is local and protected with per-user file and socket permissions where supported. The extension does not passively inventory arbitrary tabs or collect general browsing history.

Meeting detection, when enabled by a build, is limited to its documented supported hosts and emits only a versioned opaque event for local delivery. It does not include raw URLs, meeting IDs, titles, page content, participants, credentials, or recording data. Meeting detection never starts recording; explicit video recording requires separate popup consent.

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
### Dedicated agent Chrome (0.4.0)

By default, CLI automation does not connect to the daily-browser runtime. `sessions start`
launches Chrome for Testing directly with a private `agent-v1/profile` user-data-dir
under the OverSeer runtime, loads the built extension, and waits for its native
connection. Default native launchers reject connections without the inherited
isolated-profile marker before opening a control socket. An explicitly authorized
existing-browser launcher can instead use `--operator-relay`; it still validates
the exact extension identity and preserves per-session ownership and site grants. No personal Chrome windows/tabs are
queried, focused, navigated, or closed; install/update no longer opens daily Chrome.

Run `scripts/update-macos.sh` to build/stage the extension and update the native
host, then `overseer-browser sessions start`. If CfT is not in `/Applications`, set
`OVERSEER_BROWSER_CHROME` to its executable. The installed CLI discovers the staged
extension via its source-root file; `OVERSEER_BROWSER_EXTENSION` can override it.
In **the dedicated CfT instance only**, enable the extension's native connection,
site access, and evaluation capability in the popup (Chrome's extension/user-script
approval may also be required). Retry session start after first-use approval.
Existing personal-profile permissions are deliberately not copied.

Session keys and response payloads are unchanged. Multiple sessions share only the
agent instance; stopping the last session terminates that owned child process.
A supervisor holds its process handle; it never searches for Chrome processes or
signals a PID discovered from disk. Launch failures leave the dedicated instance
available for first-use approval. On supervisor crash, `agent-v1/supervisor.running`
may need manual recovery after confirming the dedicated instance has exited;
automatic PID-based recovery is intentionally avoided. Lifecycle currently supports
macOS/Linux, not Windows. Linux requires CfT and its native manifest configured.

### Explicit existing-relay connection (0.4.1+)

In 0.6.1+, an owner-configured native launcher may explicitly pass
`--operator-relay` and set `OVERSEER_BROWSER_RUNTIME` to that relay's private
runtime. Do not spoof the isolated-profile marker or silently enable this mode.
Keep the regular-browser registration separate from the default isolated launcher.
During updates, preserve this explicit configuration and coordinate reloading the
extension actually installed in that browser; updating another profile is not a
completed rollout.

When an operator authorizes an already-running compatible relay, select that
connection explicitly rather than changing its host or guessing from sockets:

```sh
python3 scripts/select-relay.py /absolute/path/to/private/relay-runtime
overseer-browser status --raw-json
overseer-browser --session my-own-task sessions start
```

Selection authenticates a health request and requires multi-session support. It
atomically writes a private `~/.config/overseer-browser/active-connection.json`
descriptor binding the runtime to its token fingerprint (not the token itself).
`status`, health, and commands use the same selected transport and report
`connection_mode: operator-relay`. Session keys, site grants, and tab ownership
remain enforced; selecting a connection does not borrow another agent's session.
The CLI never launches or stops a selected relay's host, even after the last
session ends. A stale, insecure, or changed-token descriptor fails closed with
`active_connection_unavailable`; it never silently starts another browser.

`OVERSEER_BROWSER_CONNECTION=managed` explicitly retains the managed isolated
browser. `OVERSEER_BROWSER_CONNECTION=/path/to/descriptor.json` selects an alternate
private descriptor. An explicit `OVERSEER_BROWSER_RUNTIME` takes precedence over
all descriptors and preserves the existing managed `agent-v1` semantics. Without
a descriptor or override, managed isolation remains the default. Re-run the
selection helper after an authorized relay runtime/token change; it keeps a
private timestamped backup of the previous descriptor. Do not copy tokens or
change native-host registrations to resolve a connection mismatch.

### Evidence composition (0.5.0)

Source CLI commands (no install or extension build needed to inspect help):

```bash
python3 -m cli.main doctor --raw-json
python3 -m cli.main --session fresh-qa sessions start qa --raw-json
python3 -m cli.main --session fresh-qa navigate http://localhost:3000 --raw-json
python3 -m cli.main --session fresh-qa console start --raw-json
# Exercise the page after console start to collect console evidence.
python3 -m cli.main --session fresh-qa qa pack /tmp/screenshots/fresh-qa-pack --raw-json
python3 -m cli.main --session fresh-qa timelapse /tmp/screenshots/fresh-qa-frames 5 2 --raw-json
python3 -m cli.main --session fresh-qa sessions stop --raw-json
```

Use a unique session key and new output directories each run. `qa pack DIR`
collects snapshot JSON, visible screenshot PNG and its response metadata,
console JSON, network JSON, and `manifest.json`. It does not start/stop console
capture, navigate, or manage sessions. Console evidence requires `console start`
before the activity of interest. Network evidence is redacted Resource Timing
metadata, not response bodies or a HAR. Evidence is sequential, not atomic;
a page may change between artifacts. Each failure is preserved separately in
the manifest, remaining artifacts are attempted, and partial packs exit nonzero.
Pack directories must not exist (including symlinks); files are atomically
written private (0600) in a private (0700) directory on POSIX. Evidence can still
contain sensitive page content; handle and delete it accordingly.

`doctor` reports the CLI/source host versions and observed `health.status`
including permissions, User Scripts availability, multi-session state and
extension version. Version drift or a failed status exits nonzero. The current
transport does not expose the loaded host version: its check is explicitly
`unknown`, not inferred from source. Local composition capability descriptions
are not a claim that a disconnected browser can capture.

`timelapse DIR FRAMES INTERVAL_SECONDS` is explicit, bounded, foreground
screenshot sampling, **not video recording**. It accepts 1–120 frames and 2–30
seconds minimum between frame starts (at most 0.5 FPS, often slower with shared
Chrome capture pacing). Actual monotonic frame-start offsets and total elapsed
time are recorded; there is no catch-up burst, background process, encoder or
new dependency. Ctrl-C preserves the manifest as incomplete. `--timeout` is per
transport request, not a whole-pack deadline. `--session` (or resolved automatic
session identity) is mandatory for capture; `--tab-id` targets every artifact.
Composition rejects `--request-id`, `--max-nodes`, and `--wait-until` rather than
silently misapplying them. Every request gets a fresh transport request ID.

### Consented native video (0.6.0; Chrome 116+)

`record start [FPS SECONDS MAX_BYTES]` requests recording of the session's
selected, active owned tab. Defaults: 30 FPS, 60 seconds, 32 MiB; limits:
60 FPS, 300 seconds, 64 MiB. This captures video only, without debugger/CDP,
navigation, reload, or page-state reset. Requested FPS is not achieved FPS.
Open the toolbar popup on that tab and click **Approve recording** within
60 seconds. Denial, expiration, tab/selection changes and wrong sessions
cannot authorize capture. `record restart` always requires a fresh popup click.

Operator smoke sequence (only after installing/reloading is separately approved):

```sh
python3 -m cli.main --session video-smoke sessions start
python3 -m cli.main --session video-smoke tabs create https://example.com
python3 -m cli.main --session video-smoke record start 30 10 33554432
# Focus the requested tab; open the real toolbar popup; click Approve recording.
python3 -m cli.main --session video-smoke record status
# Exercise the page without reloading it, then export to a NEW local path:
python3 -m cli.main --session video-smoke record stop capture.webm
python3 -m cli.main --session video-smoke record restart 30 10 33554432
# Verify fresh consent is required; deny it in the popup.
python3 -m cli.main --session video-smoke record clear
python3 -m cli.main --session video-smoke sessions stop
```

WebM is native; MP4 export requires an installed ffmpeg with a successful local
H.264 encode probe. `doctor` does not claim live browser verification. ffprobe,
when installed, reports encoded frame evidence. Export is bounded, private
(0600), atomic and refuses existing paths. Failed exports leave no published
file and preserve browser bytes until expiration. Stop is idempotent. One
recorder is allowed extension-wide. Retained browser bytes expire five minutes
after stop (or earlier at the request lifetime cap), and clear/session stop/tab
closure/native disconnect discard them. Service-worker suspension can lose
request metadata; a new start clears orphaned bytes. The offscreen document
independently enforces duration and retention. Exported files remain until the
operator deletes them; there is no automatic deletion of user exports.

Read-only [DOM queries](DOM_QUERIES.md) use fixed native `dom.query` with an explicit
session and owned tab; no User Scripts permission or evaluate fallback. Requires
the 0.6.0 (unreleased) extension source and operator-approved reload.
