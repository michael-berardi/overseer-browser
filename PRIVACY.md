# Privacy

OverSeer Browser is a local-first Chromium extension, native host, and CLI. It has no user account and no cloud browser-control plane. The app sends no telemetry or usage data to us. Browser control works without an external service.

## Network

Nothing is sent to us. There is no telemetry, analytics, or crash reporting. Apart from the anonymous daily update check described below, the extension, native host, and CLI make no outbound HTTP requests in normal operation. Installing or updating a release fetches only the release files (installer, archive, and `SHA256SUMS`) from GitHub by HTTPS. Building from source also downloads npm packages from the npm registry, with audit, funding, and `DO_NOT_TRACK` telemetry opt-outs set by the build scripts.

The extension talks to the local native host through Chrome Native Messaging; the CLI talks to that host over a same-user local socket with a random local token. No account or cloud control service is involved. Browser traffic happens when you navigate or act on a page. A client, model provider, or other service you configure receives whatever you send it; that transfer is outside this project.

## Update checks

The only automatic outgoing request is an anonymous `GET` of the project's public GitHub "latest release" record, at most once every 24 hours. The CLI makes it only after a command run in a terminal (never in CI, agent, JSON or non-interactive runs); the extension popup asks the local native host, which makes the same check. The request carries a fixed User-Agent (`overseer-browser-update-check`) and no version, identifier, machine data, usage data or credentials.

The result (check time, latest version, its first release-note lines, a failure cause, and your skip and automatic-update choices) is kept in one file, `update-check.json` (mode `0600`), in the platform cache folder. Its start time is recorded in that file before the GET so a second command — including `update --check` — does not send another request while one is in flight. The claim expires after 60 seconds if a check was killed, so neither it nor a completed check hides the result for a day: only a completed check gates automatic checks for 24 hours. Turn checks off with `OVERSEER_BROWSER_NO_UPDATE_CHECK=1`, `overseer-browser update --auto-check off` or the popup setting. Automatic installation is off until you turn it on. Downloads for `overseer-browser update` come from the same GitHub release and are checked against its `SHA256SUMS`. `overseer-browser uninstall` deletes the state file, the update log and the CLI rollback copy. See [Updates](docs/updates.md).

## What stays on the device

The extension, native host, and CLI may keep bounded local state needed to execute a request:

- session, window, tab, element-reference, and meeting-delivery state;
- command arguments supplied by the calling client;
- screenshots, uploads, and page observations explicitly requested by that client;
- a random local host token and connection metadata.

The extension and native host do not independently upload these values. A calling client may deliberately forward returned observations, screenshots, uploads, or action results to another service; that transfer is outside this repository and must be evaluated under the client's privacy policy. Shell history, browser profiles, operating-system logs, backups, browser sync, and user-selected upload destinations can also retain data independently.

Runtime state is bounded and local. Session, permission, and pending meeting state live in Chrome's `storage.session`, which Chrome clears when the browser session ends; queued meeting events also expire after 90 seconds. On macOS, `overseer-browser uninstall` removes the native host registration, CLI, and token; on other platforms use the manual removal steps in [docs/install.md](docs/install.md). Uninstalling does not delete the runtime directory, exported evidence, or shared browser data.

The host keeps its token and a bounded, `0600` `host.log` (and, for the isolated Agent Window, a `0600` `agent-v1/chrome.log`, trimmed to its newest 256 KiB once it passes 1 MiB) in a `0700` runtime directory: macOS `~/Library/Application Support/OverSeer/browser`; Linux `$XDG_RUNTIME_DIR/overseer-browser`, or `~/.config/overseer-browser` when that is unset; Windows `%LOCALAPPDATA%\OverSeer\browser`. `OVERSEER_BROWSER_RUNTIME` overrides all of these. Screenshots, QA packs, timelapses, and recordings are written only when you ask for them and can contain page content. OS-temp copies expire; files you keep or write elsewhere are yours to delete. An optional local UltraVox adapter can receive minimized meeting detections over same-user IPC when its private socket is present (see below).

## Local writes, lifetimes, and automatic cleanup

Every local write this project makes on its own behalf is listed here, bounded, and never uploaded. Paths are defaults; `OVERSEER_BROWSER_RUNTIME`, `OVERSEER_BROWSER_HOME`, `OVERSEER_BROWSER_CACHE_DIR` and their documented XDG equivalents override them. `<install>` is the per-user install folder named in [docs/install.md](docs/install.md): `~/.overseer-browser` on macOS/Linux and `%LOCALAPPDATA%\OverSeerBrowser` on Windows unless overridden at install time. The update cache folder is `~/Library/Caches/overseer-browser` on macOS, `$XDG_CACHE_HOME/overseer-browser` (default `~/.cache/overseer-browser`) on Linux, and `%LOCALAPPDATA%\overseer-browser\Cache` on Windows.

| Local write | Contents | Lifetime and cleanup |
| --- | --- | --- |
| Runtime directory (`0700`: macOS `~/Library/Application Support/OverSeer/browser`, Linux `$XDG_RUNTIME_DIR/overseer-browser` or `~/.config/overseer-browser` when unset, Windows `%LOCALAPPDATA%\OverSeer\browser`) | random host token (`0600`), local socket, connection metadata, `0600` `host.log`, `0600` `agent-v1/chrome.log` | `host.log` keeps the last 200 start/stop lines; `agent-v1/chrome.log` is trimmed to its newest 256 KiB once it passes 1 MiB. Survives uninstall until you delete the directory. |
| Update state (`update-check.json`, mode `0600`, in the update cache folder) | check start time and completion, newest stable tag, first release-note lines, failure cause, shown/skipped versions, your opt-in choices | Owner-only, rewritten in place with a fixed field set. The pre-GET `checking_at` claim prevents concurrent requests and expires after 60 seconds; completed checks gate automatic checks for 24 hours. Removed by `overseer-browser uninstall`. |
| Automatic-update log (`auto-update.log`, in the update cache folder) | opt-in automatic-update output and failure cause | Owner-only, capped to its newest 256 KiB on every write; removed by uninstall. |
| Rollback copies (`<install>/rollback/previous` from the one-step installer and `<install>/previous` from the CLI update) | the release tree an update displaced | The installer copy is deleted once the new release passes its version and start check; a failed update keeps a copy for `update --rollback`. The CLI copy is removed after the new version's first successful command or after 7 days. A deletion failure is reported and the install still succeeds. |
| Installed code and native-host registration (Linux `~/.local/share/overseer-browser` or `$XDG_DATA_HOME/overseer-browser`, macOS `~/Library/Application Support/OverSeer/browser`, Windows `%LOCALAPPDATA%\OverSeer\browser`) | native-host launcher, CLI copies, versioned `runtimes/` trees and native-messaging manifests | Replaced in place by each install; the current tree, trees named by a launcher, manifest or `OVERSEER_BROWSER_RUNTIME` override, symlinked and recent trees are kept, while other runtime trees whose files are all older than 30 days are pruned by the next macOS/Linux install. Registration is removed by the uninstall steps below. |
| Dedicated agent browser profile cache (`<runtime>/profile/Default/Service Worker`, with a `0600` `<runtime>/profile/overseer-extension-version` marker) | Chrome's cached MV3 service worker for the unpacked extension and its loaded version | The cache is deleted when the extension version changes so a stale worker cannot call an old native host; the rest of the profile stays until you delete the runtime directory. |
| Installer temp (`$TMPDIR/overseer-browser-install.*`, Windows `%TEMP%\overseer-browser-install*`) | downloaded archive, `SHA256SUMS`, unpacked bundle | Removed when the installer exits; leftovers of a killed run older than six hours are swept by the next install. |
| Install staging (`releases/*.tmp`, `extension.tmp`, `rollback/.restoring`, `runtimes/.stage-*`, `.publish-*`) | half-staged release, extension, manifest and managed script files | Removed on success or failure; leftovers of a killed run older than an hour are swept by the next install or platform installer. |
| OS-temp outputs and media staging (`overseer-outputs-v1-<uid>`, `overseer-media-v1-<uid>`) | requested screenshots, QA files and recording conversions named to an OS-temp destination | Registered for automatic expiry (15 minutes, with a request-lifetime cap) and reaped by the native host at startup and while idle; `--keep` and outside-temp destinations are never deleted. |
| Requested evidence and kept exports (QA packs, timelapses, recordings you keep) | page content | Written only when explicitly requested, never uploaded, and never deleted automatically. Deleting them is yours. |

The extension also keeps session, permission, and short-lived meeting state in the browser profile; Chrome clears the session part when the browser session ends.

### Deleting local data

Remove the extension in `chrome://extensions`, delete the runtime directory above, the update cache folder above, `<install>` (including any `rollback` folder), the Linux data directory `~/.local/share/overseer-browser` (`$XDG_DATA_HOME/overseer-browser`, with the equivalent macOS and Windows data folders), and any evidence or recording directories you created, then remove the native-host registration and CLI with the uninstall steps in [docs/install.md](docs/install.md) (`overseer-browser uninstall` on macOS also removes the update state, log, and CLI rollback copy). macOS/Linux installs prune unreferenced runtime trees older than 30 days, but current and referenced copies remain until you delete the directory. Nothing else is written on your behalf.

## Explicit QA evidence (0.5.0)

`qa pack` writes requested snapshots, screenshots, existing console entries and Resource Timing metadata into a new private local directory. `timelapse` explicitly samples up to 120 visible screenshots in the foreground, no faster than one every two seconds. It is not audio/video recording and never starts automatically. Both require a resolved agent session, preserve the existing tab-access boundary, and make no external upload. Manifests contain the task session key and timestamps; page artifacts can contain sensitive content. The caller must choose appropriate retention and delete the evidence when no longer needed; stopping a browser session does not delete these exported files.

## Permissions and access boundaries

- **HTTP(S) host access:** the installed extension declares broad `<all_urls>` access for the dedicated Agent Window and screenshots. Runtime automation of borrowed operator tabs remains gated by an explicit popup grant for the current origin or every HTTP(S) origin with **Enable unlimited**; those grants can be revoked.
- **User Scripts:** page evaluation uses Chrome’s `userScripts` API when the one-time **Allow User Scripts** setting is enabled, otherwise a bounded MAIN-world fallback on pages that permit injection. Dedicated Agent Window tabs need no popup grant; borrowed tabs require a popup site-access grant and the evaluate capability grant. Strict-CSP pages still require the User Scripts setting.
- **Native Messaging:** connects the extension to the local native host and is not a network permission.
- **Storage, scripting, tabs, and windows:** support the visible popup, session ownership, content traversal, and browser actions.
- **Debugger access:** not enabled or requested by this release. Debugger-dependent operations are unsupported; there is no automatic attachment, raw CDP passthrough, or passive debugger collection.
- **Meeting detection:** local reminder detection uses a content script scoped to the documented Meet and Zoom hosts. No general-site content script is registered; the broader installed permission supports explicit automation.

The manifest must not add history, bookmarks, `webRequest`, or required debugger access. `activeTab`, `tabCapture`, and `offscreen` support only the explicit, popup-consented recording workflow. Do not add debugger permission until the installation-permission decision above is explicitly approved. Its required `<all_urls>` host permission is intentional for the isolated Agent Window and screenshot implementation. Uninstalling or disabling the extension revokes its browser access.

## Session and tab ownership

A dedicated Agent Window is the default. The extension automates tabs created in that window. A normal tab is read-only until the user explicitly borrows it through the popup. Borrowed tabs are returned when requested and during session stop. The extension does not passively inventory arbitrary tabs or inject automation code into tabs that are not session-owned or borrowed.

The isolated browser and its launcher receive only the environment entries needed for local operation. They do not inherit the calling shell’s API tokens or other unrelated credentials.

This is an access boundary, not a claim that a webpage is trustworthy. A page can still display or receive anything the user explicitly asks the automation to display or enter. Do not use browser control with credentials or sensitive data unless that is the intended task.

## Meeting data minimization

Meeting reminders support only the hosts documented by the current build. A detector emits a versioned event containing a detection ID, provider, timestamp, and a 64-character lowercase hexadecimal opaque salted SHA-256 `meeting_key`.

The raw URL, query string, meeting ID, title, page content, participant list, credentials, cookies, and recording data are not included. The native host can deliver the same minimized event over same-user local IPC to an optional UltraVox adapter: it uses `ULTRAVOX_VOICE_SOCKET` or `ULTRAVOX_RUNTIME_DIR` when set, and on macOS also checks `<system temp>/com.paretocybernetics.ultravox/voice-v1.sock` when that private socket exists. Only a same-user socket with private permissions is accepted; no network endpoint is involved. Adapters must preserve the schema, keep the opaque key, bound retention, and never add page data. Meeting detection never starts recording; explicit video recording requires separate visible popup consent.

## Threat boundaries

| Boundary | Protected by | Remaining risk |
| --- | --- | --- |
| CLI → host | random token, framed messages, user-only socket, peer-UID check where supported | another process running as the same user may access local IPC or state |
| Host → extension | Chrome Native Messaging, exact extension identity in `allowed_origins`, versioned frames | a user who can modify the browser profile or host registration can alter the trust chain |
| Extension → page | active session, Agent Window/borrow ownership, explicit current-origin or unlimited HTTP(S) grant for borrowed tabs, User Scripts or bounded MAIN-world evaluation | explicitly controlled pages can observe actions and values sent to them; unlimited access widens the set of reachable pages |
| Meeting page → reminder | exact host matches, parser, opaque salted key, bounded deduplication | a compromised page or browser can present false UI |
| Local files → privacy | per-user paths, restrictive modes, no external upload by default | backups, shell history, browser sync, malware, or an administrator may expose local files |

No browser extension can protect against a compromised browser, operating system, malicious same-user process, or misuse of an explicitly granted site scope. Keep unlimited access off in general browsing profiles; use it only in a dedicated agent profile or for a deliberate automation window.

## Security invariants

A release or local build must fail review if it adds required or non-consensual debugger access, passive browsing collection, broad external control, a required all-site content script or unconditional borrowed-tab grant, unbounded frames, or raw meeting data to a host/adapter message. Optional current-origin and unlimited HTTP(S) grants must remain visible, user-initiated, and revocable. Debugger-only capabilities must fail explicitly when permission or tab consent is missing; never silently substitute weaker input. See [SECURITY.md](SECURITY.md) for the vulnerability-reporting process and release checklist.

## User-approved video (0.6.0)

The explicit `record` command can capture video of one owned, active selected
tab only after a real toolbar-popup approval. It captures no audio, never starts
passively, and never uses debugger/CDP. Consent expires in 60 seconds; restart
needs fresh approval. Media is capped at 64 MiB and five minutes. In-memory
artifacts expire five minutes after stop, with an additional request-lifetime
cap; session stop, tab closure, clear and native disconnect discard them.
Temporary export directories are private and cleaned on success or failure;
source WebM is at most 64 MiB and MP4 conversion has a separate 64 MiB cap
(near-cap output is rejected conservatively). Published exports are private and never overwritten. OS-temp outputs are
registered for automatic expiry, including explicitly named temp destinations.
Outside-temp exports and explicit `--keep` outputs require operator deletion;
no global quota or automatic deletion of these intentionally kept files is claimed. No media is uploaded.

### Disposable staging versus kept exports

Recording conversion uses a private `overseer-media-v1-<uid>` temporary
namespace, with four concurrent 128 MiB reservations. Active leases are locked;
completed leases are deleted eagerly. Failed deletions are retried every 30
seconds while a CLI process remains alive; expired unlocked leftovers (15
minutes) are also reaped at startup. The native host calls
`cli.recording.reap_staging()` and the output reaper at startup and while idle.
When the host is not running, recovery waits for the next host/CLI startup;
the CLI daemon thread alone does not provide continuous wall-clock expiry. Unrelated temporary
files and legacy staging directories are not swept. Recording publication uses
an atomic no-clobber hard link and fails safely across filesystems.

Explicit OS-temp `record export`, QA and timelapse destinations remain disposable
unless marked `--keep`. Outside-temp exports are intentionally kept. Cleanup
must preserve replaced files, unrelated additions, and explicitly kept outputs. Recorder memory
has a 1,200-chunk cap in addition to its byte/time caps and releases media on
clear, expiry and setup failure. No indefinite-use claim applies to accumulating
explicitly kept exports or to unavailable cleanup services.
