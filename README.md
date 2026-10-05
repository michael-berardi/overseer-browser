# OverSeer Browser

<p align="center">
  <img src="extension/public/icon-128.png" alt="OverSeer Browser icon" width="112" />
</p>

<p align="center">
  <strong>Local-first, model-agnostic browser automation for Chromium.</strong><br />
  Give any agent its own browser window. Your tabs stay yours until you lend one.
</p>

<p align="center">
  <a href="https://github.com/michael-berardi/overseer-browser/releases/latest"><img src="https://img.shields.io/github/v/release/michael-berardi/overseer-browser?label=release" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/michael-berardi/overseer-browser" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="macOS, Linux and Windows" />
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#guides">Guides</a> ·
  <a href="#cli-reference">CLI</a> ·
  <a href="PROTOCOL.md">Protocol</a> ·
  <a href="PRIVACY.md">Privacy</a>
</p>

OverSeer Browser lets coding agents, scripts and any other local client drive a
real Chromium browser through a small CLI and a documented JSON protocol. There
is no cloud service, no model SDK and no remote browser: a command-line client
talks to a per-user native host over a Unix socket, and the host talks to the
extension through Chrome Native Messaging.

## Why OverSeer Browser

- **Agents get their own browser.** By default each session runs in a dedicated
  Chrome for Testing instance with a private profile. Your everyday browser is
  never queried, focused or closed.
- **Borrowing is explicit.** A normal tab is only automated after you lend it
  from the extension popup, and it is returned when the session ends.
- **Parallel agents stay apart.** Up to 32 sessions run at once, each with its
  own window, tabs, uploads and cleanup.
- **Works with any model.** Commands print plain JSON on stdout, so any agent
  that can run a shell command can use it.
- **Local by design.** Page content, screenshots, uploads and recordings stay on
  your machine unless the calling client forwards them.
- **Narrow permissions.** No `debugger`, CDP, history, bookmarks or
  `webRequest`. Video capture needs a fresh click in the popup every time.

## How it works

```text
agent or script ──► overseer-browser CLI ──► native host ──► extension ──► Chromium
                    (JSON on stdout)       (Unix socket)   (Native Messaging)
```

`overseer-browser sessions start` launches Chrome for Testing with a private
profile and the built extension, then waits for its native connection. Every
command is scoped to a session key, so one agent can never act in another
agent's window. See [PROTOCOL.md](PROTOCOL.md) for framing, limits and schemas.

## Requirements

- macOS, Linux, or Windows 10 1803+.
- [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)
  for the default isolated agent browser. On macOS the CLI looks for
  `/Applications/Google Chrome for Testing.app`; set `OVERSEER_BROWSER_CHROME`
  to use another location. The dedicated-browser lifecycle supports macOS and
  Linux.
- Node.js and npm to build the extension.
- Python 3.9 or newer for the native host and CLI.
- Any Chromium-family browser (Chrome, Edge, Brave, Chromium) if you also want
  to lend tabs from your everyday browser.

Automatic media cleanup and recording export need POSIX file locking, so they
are available on macOS and Linux only. On Windows they fail with an explicit
error rather than leaving temporary data behind.

## Install

OverSeer Browser installs from source. Each
[release](https://github.com/michael-berardi/overseer-browser/releases) also
attaches the built extension as a ZIP with `SHA256SUMS`; the CLI and native
host still come from the source checkout.

### macOS

```sh
git clone https://github.com/michael-berardi/overseer-browser.git
cd overseer-browser
./scripts/manage-macos.sh install
overseer-browser status
```

The installer builds the extension, stages it, and registers a per-user native
host and the `overseer-browser` CLI. It never opens or reloads your everyday
Chrome.

To update, pull and rerun the installer's update step, then reload the
extension wherever you loaded it:

```sh
git pull --ff-only
overseer-browser update
```

`overseer-browser uninstall` removes the native host and CLI; remove the
extension from `chrome://extensions` yourself.

### Linux

```sh
git clone https://github.com/michael-berardi/overseer-browser.git
cd overseer-browser
npm ci --prefix extension && npm run build --prefix extension
./scripts/install-linux.sh
```

The script registers the native host and CLI for Chrome, Chromium, Brave and
Edge. Rerun it after `git pull --ff-only` to update.

### Windows (experimental)

```powershell
git clone https://github.com/michael-berardi/overseer-browser.git
cd overseer-browser
npm ci --prefix extension; npm run build --prefix extension
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

The installer copies the host and CLI into `%LOCALAPPDATA%\OverSeer\browser`
and registers the native host under HKCU for Chrome, Edge and Brave. Load the
built `chrome-extension\` directory from `chrome://extensions` (Developer mode
→ **Load unpacked**).

## Quick start

```sh
overseer-browser health                       # local runtime check
overseer-browser sessions start research      # launches the dedicated browser
overseer-browser tabs create https://example.com
overseer-browser observe                      # page tree with stable osr-* element refs
overseer-browser click osr-12                 # act on a ref from observe
overseer-browser screenshot
overseer-browser sessions stop
```

On first launch, open the extension popup **in the dedicated Chrome for
Testing window** and enable its native connection, site access and evaluation
as needed. Chrome may also ask you to approve the extension and its user
scripts once. Retry `sessions start` after approving. Permissions from your
personal profile are never copied.

For CSP-safe `evaluate`, open the extension details and enable Chrome's
**Allow User Scripts** setting once.

## Guides

### Run agents in parallel

Each session key owns its own window, selected tab, borrowed tabs, pause state,
uploads and cleanup. Commands never fall back to another session.

```sh
# Agent A
export OVERSEER_BROWSER_SESSION=agent-a
overseer-browser sessions start research
overseer-browser tabs create https://example.com

# Agent B, in its own environment
export OVERSEER_BROWSER_SESSION=agent-b
overseer-browser sessions start qa
overseer-browser tabs create https://example.org

# Explicit flags override the environment
overseer-browser --session agent-a sessions stop
```

`--session KEY` overrides `OVERSEER_BROWSER_SESSION`. Without either, the CLI
derives a stable key from the agent's own session identity (`PI_SESSION_ID`,
`CODEX_THREAD_ID` or `CLAUDE_SESSION_ID`). Subagents that inherit a parent's
environment must pass their own key. Clients with no identity use an isolated
`default` scope. Protocol clients must send `session_key` themselves.

Session keys route requests inside one OS user's trust domain. They are not
credentials and do not isolate hostile processes: sessions share the dedicated
profile's cookies and site permissions. Screenshots are paced to Chrome's
extension-wide capture limit; everything else runs concurrently.

**Screenshot size and scale.** A screenshot is the visible tab at the display's
pixel density, so a 1920×1080 viewport on a 2× display is a 3840×2160 bitmap.
`screenshot-element` crops that bitmap to the element's rectangle, clipped to the
viewport (scroll it into view first). If the image does not fit the 850 KB
native frame, it is shrunk in steps (scale 1, 0.8, 0.64, 0.5, 0.4, with lower
JPEG quality at each step). The result says what happened: `viewport` (CSS
pixels and `devicePixelRatio`), `source` (the captured bitmap), `crop` (the kept
region, in bitmap pixels), `scale` (returned size ÷ crop size) and `quality`
(JPEG only), next to the returned `width` and `height`. To map a point in the
image back to the page: `css = (crop.left + x / scale) / devicePixelRatio`.

### Lend a tab from your everyday browser

To let an agent work in a normal tab, load the built extension in that browser
(`chrome://extensions` → Developer mode → **Load unpacked** → the generated
`chrome-extension/` directory), open the popup on the page, and choose **Allow
this site** or **Borrow active tab**. **Enable unlimited** grants every HTTP(S)
origin until you turn it off. With several sessions active, the popup asks
which session receives the tab. A tab can be borrowed by only one session, and
it is returned when that session stops.

### Connect to an existing browser

A native launcher you configure can pass `--operator-relay` and set
`OVERSEER_BROWSER_RUNTIME` to that relay's private runtime, so agents can use a
browser that is already running. Select the relay explicitly:

```sh
python3 scripts/select-relay.py /absolute/path/to/private/relay-runtime
overseer-browser status --raw-json
overseer-browser --session my-task sessions start
```

Selection authenticates a health request, requires multi-session support, and
writes a private `~/.config/overseer-browser/active-connection.json` that binds
the runtime to its token fingerprint (never the token). `status`, health and
commands then report `connection_mode: operator-relay`. The CLI never starts or
stops a selected relay's host. A stale, insecure or changed-token descriptor
fails with `active_connection_unavailable` instead of starting another browser.

On macOS, name that launcher `overseer-browser-operator-relay` in the OverSeer
Browser support folder and register it as Chrome's native host. Updates
(`scripts/update-macos.sh`) then keep that registration and point the launcher at
the new runtime, so the relay survives the next extension reload. The extension
Chrome loads unpacked still has to be reloaded in `chrome://extensions` after an
update; Chrome never reloads it on its own.

Agent Windows never take focus (0.6.2+). `sessions start` opens them unfocused
and `tabs select` switches tabs without raising the window, so an agent working
in your everyday browser does not interrupt you. A new Agent Window first shows
a blank page titled `OverSeer Agent Window`, which window managers can match to
keep it off your workspace.

### Phone-width window

Chrome keeps a normal window at least about 500 px wide, so `windows resize 375 812`
cannot make one. Start a mobile Agent Window instead:

```sh
overseer-browser --session m sessions start --mobile                      # 375x812
overseer-browser --session m sessions start --mobile --width 414 --height 896
```

It opens as an unfocused popup window (no tab strip), and the result carries a
`viewport` the page measured itself (`innerWidth`, `innerHeight`,
`devicePixelRatio`). If Chrome cannot make the viewport the requested width,
`sessions start` fails with `window_size_clamped`, closes the window and says what
width Chrome gave; `windows resize` fails the same way when the applied size
differs from the request. Width and height are CSS pixels, 200-1000 and 200-3000.
A display shorter than the request only limits the height: compare the reported
`viewport` with what you asked for.

This is a narrow desktop Chrome window, not a phone: the user agent, touch input
and device pixel ratio are the desktop's. It holds exactly one tab (navigate it;
`tabs create` is refused), and a link that opens a new tab can open it in another
window. A session keeps its window mode: stop it before starting a different one.

The extension must be 0.6.4 or later. An older loaded extension ignores `--mobile`; the CLI then reports `extension_outdated` instead of a normal-width session.

`OVERSEER_BROWSER_CONNECTION=managed` keeps the isolated browser;
`OVERSEER_BROWSER_CONNECTION=/path/to/descriptor.json` selects another
descriptor. An explicit `OVERSEER_BROWSER_RUNTIME` takes precedence over both.
Rerun the selection helper after the relay's runtime or token changes.

### Collect QA evidence

```sh
overseer-browser --session qa sessions start qa
overseer-browser --session qa navigate http://localhost:3000
overseer-browser --session qa console start
# ...exercise the page...
overseer-browser --session qa qa pack ./evidence/qa-pack
overseer-browser --session qa timelapse ./evidence/frames 5 2
overseer-browser --session qa sessions stop
```

`qa pack DIR` writes snapshot JSON, a screenshot with its metadata, console
JSON, network JSON and `manifest.json` into a new private directory. Console
evidence only covers activity after `console start`. Network evidence is
redacted Resource Timing metadata, not response bodies. Artifacts are captured
one after another, so the page can change between them; failures are recorded
in the manifest and a partial pack exits nonzero.

`timelapse DIR FRAMES INTERVAL_SECONDS` takes 1–120 screenshots at least 2–30
seconds apart. It is foreground sampling, not video. Actual frame offsets are
recorded, and Ctrl-C keeps the manifest marked incomplete.

`overseer-browser doctor` reports CLI and host versions, permissions, User
Scripts availability and the extension version, and exits nonzero on drift.

### Record video with consent (Chrome 116+)

```sh
overseer-browser --session demo sessions start
overseer-browser --session demo tabs create https://example.com
overseer-browser --session demo record start 30 10 33554432   # FPS, seconds, max bytes
# Focus the tab, open the extension popup and click "Approve recording".
overseer-browser --session demo record status
overseer-browser --session demo record stop capture.webm
overseer-browser --session demo sessions stop
```

Recording captures the session's active owned tab, with no debugger, reload or
page reset. Defaults are 30 FPS, 60 seconds and 32 MiB; limits are 60 FPS, 300
seconds and 64 MiB. Approval expires after 60 seconds, and `record restart`
always needs a fresh click. WebM is native; MP4 export needs a local `ffmpeg`
with H.264. Exports are private (`0600`), atomic and never overwrite an existing
file. Unexported browser bytes are discarded five minutes after stop, or
immediately on clear, session stop, tab close or disconnect.

### Query the DOM without scripts

Read-only [DOM queries](DOM_QUERIES.md) run through the native `dom.query`
command against an owned tab. They need no User Scripts permission and never
fall back to `evaluate`.

## CLI reference

From a checkout, run `./cli/overseer-browser ...`; the installed command is
`overseer-browser`.

```sh
overseer-browser --version
overseer-browser [--session KEY] health
overseer-browser [--session KEY] status [--json]
overseer-browser doctor
overseer-browser sessions start [name] [--mobile [--width PX] [--height PX]] | stop | list
overseer-browser windows resize <width> <height>
overseer-browser tabs list | create [url] | select <id> | close <id> | borrow <id> | return <id>
overseer-browser navigate <url> [--wait-until load|interactive]
overseer-browser back | forward | reload [--wait-until load|interactive]
overseer-browser snapshot [--max-nodes N]
overseer-browser observe [--max-nodes N] [--changes]
overseer-browser wait --ready | --url TEXT | --text TEXT [--absent] | --selector CSS [--state visible|hidden|enabled] | --stable MS [--timeout-ms N]
overseer-browser click | hover <ref>
overseer-browser fill | type <ref> <text>
overseer-browser select <ref> <value>
overseer-browser press <key> [ref]
overseer-browser scroll <y> | <x> <y> | <ref> [<x> <y>]
overseer-browser evaluate <script>
overseer-browser screenshot [path]
overseer-browser screenshot-element <ref> [path]
overseer-browser upload <ref> <path> [path...]
overseer-browser dom find LOCATOR | get QUERY LOCATOR [NAMES...] | is STATE LOCATOR
overseer-browser console start | read | stop
overseer-browser network read [limit]
overseer-browser batch '<json-actions>'
overseer-browser qa pack <dir>
overseer-browser timelapse <dir> <frames> <interval-seconds>
overseer-browser record start [fps seconds max-bytes] | status | stop <path> | restart | clear
overseer-browser capture start | stop
overseer-browser takeover [resume]
overseer-browser cancel <request-id>
overseer-browser help
```

Results are minified JSON on stdout, including errors, which carry stable
codes. `--json` and `--raw-json` are accepted as aliases.

Ref-based actions work through the top document, open shadow roots and
visible same-origin frames; cross-origin frame DOM stays opaque. Mutations
report a bounded `dom_mutations` count. Use explicit tab IDs for concurrent
clients and serialize navigation per tab. `evaluate` needs a site grant and
Chrome's **Allow User Scripts** setting, and runs in the CSP-exempt User Scripts
world, so strict sites do not need `unsafe-eval`.

**Temporary output.** Screenshots without a path go to `/tmp/screenshots/` on
POSIX. Screenshots, evidence packs, timelapses and recordings written to the OS
temp directory expire after about 15 minutes (sooner under a 512 MiB /
512-entry budget) unless marked `--keep`. Files outside the temp directory are
never deleted. Cleanup runs when the native host starts and while it is idle.

## Privacy and security

The extension has no account and no cloud control plane. Host and CLI state is
local and protected with per-user file and socket permissions. The extension
does not inventory tabs or collect browsing history.

Meeting detection, when a build enables it, is limited to documented hosts and
emits only an opaque event with no URL, meeting ID, title, participants or page
content. It never starts a recording.

Optional anonymous usage sharing is off until you opt in from the popup, and
browser control never depends on it. [PRIVACY.md](PRIVACY.md) lists exactly
what is sent.

No extension can protect against a compromised browser, operating system,
malicious same-user process or hostile page. Use a separate profile or OS
account for sensitive work. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## Development

```sh
npm ci --prefix extension
npm run check --prefix extension     # WXT types + TypeScript
npm test --prefix extension
npm run build --prefix extension
python3 -m unittest tests.test_browser_bridge
```

`npm run dev --prefix extension` builds a development extension to load with
**Load unpacked**. Generated `.output/` and `chrome-extension/` directories are
ignored by Git. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [PROTOCOL.md](PROTOCOL.md): framing, commands, limits and event schemas.
- [DOM_QUERIES.md](DOM_QUERIES.md): read-only DOM query contract.
- [PRIVACY.md](PRIVACY.md): data flow, permissions, retention and threat boundaries.
- [SECURITY.md](SECURITY.md): vulnerability reporting and security invariants.
- [CONTRIBUTING.md](CONTRIBUTING.md): design rules, setup and review checklist.
- [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt): dependency licenses.

## License

[MIT](LICENSE)
