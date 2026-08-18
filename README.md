# OverSeer Browser

OverSeer Browser is a local-first Chromium extension and native host for autonomous browser control. It keeps the browser-control transport on the same machine: a local CLI talks to a user-only Unix socket, the native host talks to the extension through Chrome Native Messaging, and the extension performs actions only in an Agent Window or in tabs the operator explicitly borrows.

The extension and native host do **not** use `chrome.debugger`, the `debugger` permission, CDP, or an external control service. Page observations or screenshots requested by the operator are returned to the calling OverSeer runtime; that runtime may send them to its configured AI provider. Optional anonymous product telemetry is disabled until the popup consent choice is accepted.

The browser contract is model-agnostic. Claude, Codex, Kimi, and other general agents use the same CLI commands, `--json` responses, `osr-*` element references, error codes, limits, and explicit session lifecycle; no model SDK or vendor-specific transport is required.

## Guarantees and boundaries

- **Opt-in telemetry only.** The first popup visit asks whether to share anonymous usage totals. Until the operator accepts, the extension creates no telemetry identifier, stores no telemetry counters, and makes no telemetry request. Declining is silent. Acceptance sends only a random installation ID, extension version, coarse platform/architecture, UTC day, and `launch`/daily `heartbeat` events; normally one successful `usage` batch is sent per UTC day, with a lowercase UUID v4 `batchId` retained unchanged across retries.
  Usage contains only these counters: `sessionsStarted`, `sessionsEnded`, `tabsOpened`, `tabsClosed`, `navigations`, `screenshots`, `meetingsDetected`, `popupsHandled`, `permissionsGranted`, and `permissionsDenied`. It never contains URLs, titles, page data, screenshots, form values, command arguments, meeting details, or identifiers derived from browser content. Disable sharing from the popup to delete the identifier, cadence markers, and pending counters.
- **Local-first transport.** Browser control remains on the same machine and does not depend on telemetry. When opted in, the only telemetry destination is `https://analytics.libertydesign.studio/api/app-telemetry/event`.
- **Autonomous site access.** Required `<all_urls>` host access lets agents navigate and control any HTTP(S) site without a popup grant for each origin. Commands still require an active session and a session-owned or explicitly borrowed tab.
- **Visible tab ownership.** A dedicated Agent Window is the default. Normal tabs are read-only until explicitly borrowed and are returned when a session stops.
- **No debugger path.** Debugger-only operations such as response-body capture, print-to-PDF, device emulation, and trusted CDP input return structured `unsupported` errors; they are never silently downgraded.
- **Meeting minimization.** Google Meet and Zoom detection produces only an opaque salted SHA-256 meeting key, provider, detection ID, and timestamp. Raw URLs, meeting IDs, titles, page content, participants, and credentials do not leave the extension.
- **No automatic recording.** The extension never starts recording. An optional UltraVox adapter shows a visible prompt and requires an affirmative `Start recording` action.

Read [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before installing.

## Requirements

- Chromium-based browser with Chrome Native Messaging support.
- Node.js and npm for building from source.
- A local account with permission to install a per-user native messaging host.
- macOS for the included per-user adapter; other platforms may use an adapter that preserves the same Native Messaging and least-privilege rules. Commands below use repository-relative paths; do not copy a developer-specific path into a manifest.

The stable unpacked-extension ID for the published build is `iabfdeokmilpklblkgccpjlekchfjcno`. The corresponding public manifest key may be included in a release build; its private signing key must remain outside Git and outside backups shared with others.
The public manifest key for that identity is:

```text
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtsB8TWcXWqPl4DKi7y9AEri4e0ZXYzLEv/WM3T+qY6IkAskSX/WNcWwJNETRm5f6Pq02XONBu0SxJGW5gjVWcQ6+zd6Ke5jl/xKHFAJHdFOwXxul7qDlqSt4kTDiD7xECAT5c83FzhXHtiNO8xSM4cfFN40zK+moBA/mStTysLs1xHyG79ia19yOE2kNY9QmnvLSBRlfwrTxI7AbPWbEKV9LAYsucvqH40MdAaHS9Gem52dbdr/RUjy47rcLL/Cvm5buTHS7BSdj8fVGyQNCV6DXxs7ix7OLuNnHjC0lgdd25EhivYJ2h1oTFy7HCJ8Pg/fuRaImOODSdRcFNDcJswIDAQAB
```

This is public identity material, not a signing secret. Do not regenerate it for a release that promises the stable ID.

## Install from source

Clone the public repository, then run the macOS installer. It builds the WXT package, stages a visible `chrome-extension/` directory for Chrome, and installs the per-user native host and CLI:

```sh
git clone https://github.com/michael-berardi/overseer-browser.git
cd overseer-browser
./scripts/manage-macos.sh install
./scripts/manage-macos.sh status
```

Load `./chrome-extension` using Chrome's **Load unpacked** flow (`chrome://extensions`, with Developer mode enabled). Confirm that the loaded ID is `iabfdeokmilpklblkgccpjlekchfjcno`. Never accept a different ID by weakening `allowed_origins`; fix the build key or use the release artifact.

## GitHub source updates

GitHub is the distribution source for this extension. Chrome loads the generated
`chrome-extension/` directory as an unpacked extension; there is no Chrome Web
Store listing or store-managed update channel.

Update the checkout and rebuild both the extension and native host:

```sh
git pull --ff-only
./scripts/manage-macos.sh update
```

Then open `chrome://extensions` and choose **Reload** on OverSeer Browser. Confirm
that the extension ID remains `iabfdeokmilpklblkgccpjlekchfjcno`. The public
manifest key keeps that identity stable across source rebuilds. Generated
`.output/` and `chrome-extension/` directories stay out of Git; source under
`extension/` and the lockfile are authoritative.

The equivalent installed CLI commands are `overseer-browser install`, `overseer-browser status`, `overseer-browser update`, and `overseer-browser uninstall`. Installed `status` and `uninstall` are self-contained; `install` and `update` require the recorded source checkout so the extension and native host can be rebuilt together. The registration must use the exact host name `com.imploselabs.overseer_browser`, the loaded extension ID in `allowed_origins`, and a user-owned host executable. Use the platform adapter for Linux or Windows when provided; it must preserve the same per-user and exact-origin rules. Do not place a token, private key, absolute home path, or production endpoint in source, manifests, or shell history.

## First use

1. Run `overseer-browser status --json`. A fresh install connects automatically to the same-user native host; an operator can still disconnect or reconnect from the popup.
2. Start a session. A dedicated Agent Window is created by default.
3. Use the CLI commands below to inspect the session, create or select a tab, navigate, observe, and perform visible actions.
4. To use a normal user tab, open that tab and click **Borrow active tab** in the extension popup. Return it before ending work, or stop the session and verify it was returned.
5. End agent work in a `finally`/cleanup path with `sessions stop` and confirm borrowed tabs were returned. Leave the local connection enabled for autonomous agent use; disconnecting explicitly persists until the operator reconnects.

### CLI surface

The CLI uses framed JSON over a user-only Unix socket. Human-facing commands are:

From a checkout, invoke `./cli/overseer-browser ...`; the examples below use `overseer-browser` for an installed copy on `PATH`.

```sh
overseer-browser health
overseer-browser status
overseer-browser install
overseer-browser update
overseer-browser uninstall

overseer-browser sessions start [name]
overseer-browser sessions stop
overseer-browser sessions list
overseer-browser windows resize <width> <height>
overseer-browser tabs list
overseer-browser tabs create [url]
overseer-browser tabs select <tab-id>
overseer-browser tabs close <tab-id>
overseer-browser tabs borrow <tab-id>  # confirms an operator-borrowed tab; cannot newly borrow one
overseer-browser tabs return <tab-id>
overseer-browser navigate <url>
overseer-browser back
overseer-browser forward
overseer-browser reload
overseer-browser snapshot
overseer-browser observe
overseer-browser click <ref>
overseer-browser hover <ref>
overseer-browser fill <ref> <text>
overseer-browser type <ref> <text>
overseer-browser select <ref> <value>
overseer-browser press <key> [ref]
overseer-browser scroll <y>
overseer-browser scroll <x> <y>
overseer-browser scroll <ref>
overseer-browser scroll <ref> <x> <y>
overseer-browser evaluate <script>
overseer-browser screenshot [path]
overseer-browser screenshot-element <ref> [path]
overseer-browser upload <ref> <path> [path...]
overseer-browser console start
overseer-browser console read
overseer-browser console stop
overseer-browser network read [limit]
overseer-browser batch '<json-actions>'
overseer-browser capture start
overseer-browser capture stop
overseer-browser help
overseer-browser takeover
overseer-browser takeover resume
overseer-browser cancel <request-id>
```

`eval <script>` is an alias for `evaluate <script>` and is intentionally capability-gated. `upload` accepts 1–16 files with an aggregate 8 MiB/32-chunk limit. At most eight incomplete upload transactions and 32 MiB of incomplete upload bytes are retained; abandoned chunks expire after 60 seconds and disconnect/session cleanup releases them immediately. `console` captures a bounded in-page console buffer only after an explicit start; `network read` returns bounded Resource Timing metadata with query strings, fragments, and response bodies omitted. `batch` accepts up to 20 explicit actions in one local request and is rejected locally when its complete forwarded request would exceed the extension's 512 KiB parser limit. It is sequential by default. An object contract may set `{"stop_on_error":false,"max_parallel":2..8}` for `tabs.list` or read-only `snapshot`, `observe`, and `network.read` actions targeting distinct explicit tab IDs; mutation, duplicate-target, and rollback-ambiguous parallel batches fail before any action starts. `--json` emits the structured response; `--timeout <seconds>` bounds a request. Automation callers may supply `--request-id <id>` before the command so that a concurrent `cancel <id>` can target the in-flight operation.

For multi-agent work, give each agent an explicit tab ID, combine independent reads into a bounded parallel batch, and keep navigation or page mutations sequential per tab. Example:

```sh
overseer-browser batch '{"actions":[{"command":"observe","params":{"tab_id":101}},{"command":"network.read","params":{"tab_id":102,"limit":50}}],"stop_on_error":false,"max_parallel":2}' --json
```

`observe` and ref-based actions traverse the top document, open shadow roots, and visible same-origin nested frames; cross-origin frame DOM remains opaque. For direct calls through the page's current dialog globals, `click`, Enter, and Space acknowledge synchronous alerts, safely dismiss confirmations/prompts, and return bounded dialog metadata. A page-retained reference to a native dialog function predating the guard cannot be intercepted without debugger privileges; use OverSeer cloud/desktop tooling for that unsupported case.

Run `overseer-browser --help` for the installed command list. Commands return structured errors with stable error codes; unsupported debugger-only capabilities are not emulated.

`health` checks the installed local runtime without requiring an extension connection. `status` additionally queries the connected extension and reports its identity, all-site access, evaluation capability, takeover state, sessions, in-flight request count, and retained incomplete-upload count/bytes; automation readiness and cleanup monitoring should use `status --json`.

The CLI request contract is documented in [PROTOCOL.md](PROTOCOL.md). The CLI token authenticates the local client to the host; it is stripped before a request is sent to the extension.

## Autonomous site access

The manifest requires `<all_urls>` so an active local agent session can navigate, inspect, screenshot, and interact with any HTTP or HTTPS origin without runtime permission prompts. This broad host permission does not create passive browsing collection: commands still require the user-only native transport, an active session, and a session-owned or explicitly borrowed tab. Persistent meeting detection remains limited to its explicit Meet and Zoom content-script matches.

## Optional UltraVox meeting adapter

The generic `meeting_detected` event can be consumed by a local adapter such as UltraVox. The adapter uses same-user local IPC and must preserve the minimised payload. It may show a provider-specific prompt, but only the visible affirmative action may invoke an existing recording command. See [PROTOCOL.md](PROTOCOL.md) for the event shape and [PRIVACY.md](PRIVACY.md) for the data boundary.

## Verify the privacy invariants

Before trusting an installation:

- Inspect the built manifest: it must contain required `<all_urls>` host access and must not contain `optional_host_permissions`, `activeTab`, `debugger`, `chrome.debugger`, history, bookmarks, or webRequest.
- Confirm the extension ID and `allowed_origins` are exact; the host name is `com.imploselabs.overseer_browser`.
- Confirm the host socket and token file are user-only (directory mode `0700`, socket/token mode `0600` where supported).
- Run `overseer-browser status`, disconnect, and confirm the popup state changes without any network dependency.
- Exercise Agent Window creation and navigate across at least two unrelated origins without a permission prompt. Then borrow a normal tab only through the popup and return it. Confirm there is no debugger infobar.
- Trigger a deterministic meeting fixture, then inspect only the host/adapter frame: it must contain an opaque `meeting_key` and no raw URL, meeting ID, title, page content, participants, or credentials.
- Confirm no automatic recording occurs; a prompt must require `Start recording`.

## Update

Stop active sessions before updating. The installed updater rebuilds from the source checkout recorded at installation and opens `chrome://extensions` so the unpacked extension can be reloaded:

```sh
overseer-browser update
overseer-browser status
```

If the recorded checkout moved or was deleted, clone the public repository again and run `./scripts/manage-macos.sh update` from that checkout. Confirm the stable extension ID and exact `allowed_origins` after every update; never broaden permissions to repair an ID mismatch. This path is for unpacked local installs and always requires a manual reload. Store-installed builds follow Chrome's automatic update checks after a release is reviewed and published.


## Uninstall and revoke access completely

1. Disconnect the popup and stop the active session: `overseer-browser sessions stop`.
2. Return borrowed tabs and close Agent Windows.
3. Remove the extension through `chrome://extensions` (or the browser's equivalent) to revoke its required all-site access.
4. Unregister the native host with `./scripts/manage-macos.sh uninstall` on macOS, or `overseer-browser uninstall` through the installed CLI. Verify `overseer-browser status` no longer finds a host.
5. Remove only this application's user configuration, socket, token, logs, and generated build artifacts using the documented platform cleanup command. Do not delete shared browser data.
6. If UltraVox was connected, disable its meeting-detection setting and remove only the adapter's local configuration.

The extension has no user account or cloud browser-control plane. Opted-in telemetry is limited to the disclosed anonymous event schema; disabling it deletes the local identifier, cadence markers, and pending counters but cannot recall events already accepted by the telemetry endpoint. Native-host uninstall must not silently leave a runnable host or a valid token behind.

## Development and tests

```sh
npm ci --prefix extension
npm run dev --prefix extension
npm run build --prefix extension
npm test --prefix extension
```

Use the focused tests for protocol framing/validation, session ownership, autonomous site access, meeting parsing/hash/deduplication, host authentication, and the no-debugger manifest invariant. The smoke path is: connect, create an Agent Window, navigate across unrelated origins without a permission prompt, observe, click/fill, screenshot, borrow, return, stop, and verify no infobar. Run the Meet/Zoom detector fixture and confirm the minimised payload and consent prompt. See [CONTRIBUTING.md](CONTRIBUTING.md) for the reproducible-build and review rules.

## Documentation

- [PROTOCOL.md](PROTOCOL.md) — local CLI, native messaging, and meeting-event frames.
- [PRIVACY.md](PRIVACY.md) — data-flow and threat boundaries.
- [SECURITY.md](SECURITY.md) — reporting and security invariants.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development, testing, accessibility, and review.
- [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) — licenses and concept references.

## License

This repository is released under the [MIT License](LICENSE). Third-party licenses and attribution are listed in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
