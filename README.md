# OverSeer Browser

OverSeer Browser is a local-first Chromium extension and native host for operator-directed browser control. It keeps the browser-control transport on the same machine: a local CLI talks to a user-only Unix socket, the native host talks to the extension through Chrome Native Messaging, and the extension performs actions only in an Agent Window or in tabs the operator explicitly borrows.

The extension and native host do **not** use `chrome.debugger`, the `debugger` permission, CDP, telemetry, or an external control service, and they do not create a browser-wide debugging infobar. Page observations or screenshots requested by the operator are returned to the calling OverSeer runtime; that runtime may send them to its configured AI provider. This project is not a remote browser, passive recorder, or telemetry product.

## Guarantees and boundaries

- **Zero telemetry.** There is no analytics, tracking, crash upload, remote logging, or external server.
- **Least privilege.** Meeting reminders use only the exact first-party meeting hosts declared by the extension. General site access is optional and is requested only after a popup user gesture.
- **Visible control.** A dedicated Agent Window is the default. Normal tabs are read-only until explicitly borrowed and are returned when a session stops.
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

The equivalent installed CLI commands are `overseer-browser install`, `overseer-browser status`, `overseer-browser update`, and `overseer-browser uninstall`. Installed `status` and `uninstall` are self-contained; `install` and `update` require the recorded source checkout so the extension and native host can be rebuilt together. The registration must use the exact host name `com.imploselabs.overseer_browser`, the loaded extension ID in `allowed_origins`, and a user-owned host executable. Use the platform adapter for Linux or Windows when provided; it must preserve the same per-user and exact-origin rules. Do not place a token, private key, absolute home path, or production endpoint in source, manifests, or shell history.

## First use

1. Open the extension popup and confirm **Disconnected** is shown before connecting.
2. Enable the local host connection from the popup. The choice persists; disconnect remains explicit.
3. Start a session. A dedicated Agent Window is created by default.
4. Use the CLI commands below to inspect the session, create or select a tab, navigate, observe, and perform visible actions.
5. To use a normal user tab, open that tab and click **Borrow active tab** in the extension popup. Return it before ending work, or stop the session and verify it was returned.
6. Disconnect when finished. The extension reconnects only when enabled and the local host is available; no remote connection is attempted.

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
overseer-browser press <key>
overseer-browser scroll <y>
overseer-browser scroll <x> <y>
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
overseer-browser cancel <request-id>
```

`eval <script>` is an alias for `evaluate <script>` and is intentionally capability-gated. `upload` accepts 1–16 files with an aggregate 8 MiB/32-chunk limit. `console` captures a bounded in-page console buffer only after an explicit start; `network read` returns bounded Resource Timing metadata with query strings, fragments, and response bodies omitted. `batch` executes up to 20 explicit actions sequentially in one local request and is rejected locally when its complete forwarded request would exceed the extension's 512 KiB parser limit. `--json` emits the structured response; `--timeout <seconds>` bounds a request. Automation callers may supply `--request-id <id>` before the command so that a concurrent `cancel <id>` can target the in-flight operation. Commands return stable structured error codes; unsupported debugger-only capabilities are not emulated.

Run `overseer-browser --help` for the installed command list. Commands return structured errors with stable error codes; unsupported debugger-only capabilities are not emulated.

The CLI request contract is documented in [PROTOCOL.md](PROTOCOL.md). The CLI token authenticates the local client to the host; it is stripped before a request is sent to the extension.

## Optional site access

General browser control is disabled until the operator explicitly grants optional site access from the popup. Grant only the origins needed for the current task. Revoke them from the browser's extension site-access controls or from the popup disconnect/access control. Meeting reminders remain limited to their exact declared hosts and do not turn into passive general browsing collection.

## Optional UltraVox meeting adapter

The generic `meeting_detected` event can be consumed by a local adapter such as UltraVox. The adapter uses same-user local IPC and must preserve the minimised payload. It may show a provider-specific prompt, but only the visible affirmative action may invoke an existing recording command. See [PROTOCOL.md](PROTOCOL.md) for the event shape and [PRIVACY.md](PRIVACY.md) for the data boundary.

## Verify the privacy invariants

Before trusting an installation:

- Inspect the built manifest: it must not contain `debugger`, `chrome.debugger`, history, bookmarks, webRequest, or broad required origins. `<all_urls>` may appear only as an optional operator-granted capability needed for extension screenshots; it must never appear under `host_permissions`.
- Confirm the extension ID and `allowed_origins` are exact; the host name is `com.imploselabs.overseer_browser`.
- Confirm the host socket and token file are user-only (directory mode `0700`, socket/token mode `0600` where supported).
- Run `overseer-browser status`, disconnect, and confirm the popup state changes without any network dependency.
- Exercise Agent Window creation, then borrow a normal tab only through the popup and return it. Confirm there is no debugger infobar.
- Trigger a deterministic meeting fixture, then inspect only the host/adapter frame: it must contain an opaque `meeting_key` and no raw URL, meeting ID, title, page content, participants, or credentials.
- Confirm no automatic recording occurs; a prompt must require `Start recording`.

## Update

Stop active sessions before updating. The installed updater rebuilds from the source checkout recorded at installation and opens `chrome://extensions` so the unpacked extension can be reloaded:

```sh
overseer-browser update
overseer-browser status
```

If the recorded checkout moved or was deleted, clone the public repository again and run `./scripts/manage-macos.sh update` from that checkout. Confirm the stable extension ID and exact `allowed_origins` after every update; never broaden permissions to repair an ID mismatch.


## Uninstall and revoke access completely

1. Disconnect the popup and stop the active session: `overseer-browser sessions stop`.
2. Return borrowed tabs and close Agent Windows.
3. Revoke optional site access in the browser's extension settings.
4. Remove the extension through `chrome://extensions` (or the browser's equivalent).
5. Unregister the native host with `./scripts/manage-macos.sh uninstall` on macOS, or `overseer-browser uninstall` through the installed CLI. Verify `overseer-browser status` no longer finds a host.
6. Remove only this application's user configuration, socket, token, logs, and generated build artifacts using the documented platform cleanup command. Do not delete shared browser data.
7. If UltraVox was connected, disable its meeting-detection setting and remove only the adapter's local configuration.

The extension has no cloud account and no server-side deletion step. Native-host uninstall must not silently leave a runnable host or a valid token behind.

## Development and tests

```sh
npm ci --prefix extension
npm run dev --prefix extension
npm run build --prefix extension
npm test --prefix extension
```

Use the focused tests for protocol framing/validation, session ownership, permission gating, meeting parsing/hash/deduplication, host authentication, and the no-debugger manifest invariant. The smoke path is: connect, create Agent Window, navigate, observe, click/fill, screenshot, borrow, return, stop, and verify no infobar. Run the Meet/Zoom detector fixture and confirm the minimised payload and consent prompt. See [CONTRIBUTING.md](CONTRIBUTING.md) for the reproducible-build and review rules.

## Documentation

- [PROTOCOL.md](PROTOCOL.md) — local CLI, native messaging, and meeting-event frames.
- [PRIVACY.md](PRIVACY.md) — data-flow and threat boundaries.
- [SECURITY.md](SECURITY.md) — reporting and security invariants.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development, testing, accessibility, and review.
- [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) — licenses and concept references.

## License

This repository is released under the [MIT License](LICENSE). Third-party licenses and attribution are listed in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
