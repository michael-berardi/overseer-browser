# Usage guide

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

### Isolated browser startup

The isolated supervisor owns everything the instance needs. It writes
`<runtime>/agent-v1/overseer-browser-native-host`, a launcher for this runtime's
own native host, and names it in the isolated profile's native-messaging
manifest, so any private `OVERSEER_BROWSER_RUNTIME` can host an isolated
instance (previously only the installed support folder had a launcher, and every
other runtime root ended as an unnamed `isolation_unavailable`). It records each
launch in `<runtime>/agent-v1/isolation-state.json`: Chrome's build, the
extension folder and version it loaded, the load mode, the Chrome process and,
when it ends, the exit code.

A startup that cannot connect is diagnosed from that record, the native host's
`host.log` and Chrome's own registration of the extension in the profile, not
from a folder existing on disk. `isolation_unavailable` then names the cause
(the launcher is missing or not executable, Chrome did not register the
extension from that folder, the extension never opened its port, the runtime path
is too long for a Unix socket, or Chrome exited with which error). When the
instance cannot connect, the CLI stops it and retries once with Chrome's
exclusive load path (`--disable-extensions-except` plus `--load-extension`), then
closes the second instance if it also fails. `status` reports the same evidence under `isolated`. First-run extension
approvals can still require manual action before retrying `sessions start`.

On macOS the isolated supervisor and its Chrome start in their own launchd
process coalition, not the caller's. A process inherits its parent's coalition,
and force-quitting an application stops every coalition holding a process
registered as that application, so a Chrome started from a terminal pane used to
share the terminal multiplexer's coalition and could take it down when Chrome was
quit from the Dock. A one-shot `launchctl submit` job starts each process, is
removed once it is up, and the process keeps running. If launchd refuses, the
named cause is logged once in `chrome.log` and the process starts directly as
before; `OVERSEER_BROWSER_COALITION=direct` skips launchd. `status` reports
`isolated.coalition.shared_with_caller`, and `doctor` reports `coalition`. Linux
and Windows are unchanged.

### Lend a tab from your everyday browser

To let an agent work in a normal tab, load the built extension in that browser
(`chrome://extensions` → Developer mode → **Load unpacked** → the extension directory printed by your installer), open the popup on the page, and choose **Allow
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

`OVERSEER_BROWSER_CONNECTION=managed` keeps the isolated browser;
`OVERSEER_BROWSER_CONNECTION=/path/to/descriptor.json` selects another
descriptor. An explicit `OVERSEER_BROWSER_RUNTIME` takes precedence over both.
Rerun the selection helper after the relay's runtime or token changes.

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
redacted Resource Timing metadata, plus bounded `sendBeacon` metadata when
`network start` was used; bodies, headers and query values are never returned.
Artifacts are captured
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

Read-only [DOM queries](../DOM_QUERIES.md) run through the native `dom.query`
command against an owned tab. They need no User Scripts permission and never
fall back to `evaluate`.

