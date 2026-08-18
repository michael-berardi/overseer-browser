# Privacy

OverSeer Browser is designed for local-first, autonomous agent automation. It has no account or cloud browser-control plane. A separate, explicit popup choice enables a minimal anonymous telemetry stream described below; the built manifest and protocol are authoritative for a particular release.

## What stays local

The extension, native host, CLI, and optional meeting adapter communicate on the same device. They may hold local state needed to execute an operator request:

- session, window, tab, stable element-reference, and meeting-delivery state kept in browser session storage and cleared on browser restart;
- command arguments entered by the operator;
- screenshots, uploads, and page observations requested by the operator;
- a random local host token and connection metadata;

The extension and native host do not independently send these values to a vendor, external API, remote browser, or telemetry service. Page observations, screenshots, and action results explicitly requested by the operator are returned to the calling OverSeer runtime and may be sent to its configured AI provider under that runtime's privacy terms. If telemetry is enabled, it is the separate minimal event described below and never contains these values. A local shell history, browser profile, operating-system logs, browser sync, or user-selected upload destination can also retain data independently; the project does not control those facilities.

## Optional anonymous telemetry

Telemetry is **off by default** and requires an affirmative popup choice. Before acceptance, the extension creates no telemetry identifier, stores no telemetry counters, and makes no telemetry request. Declining is silent. The endpoint is `https://analytics.libertydesign.studio/api/app-telemetry/event` and accepts schema `lds.app-telemetry.event.v2` for app `overseer-browser`.

After acceptance, events contain only:

```text
schema, app, event, installId, version, platform, arch, day, batchId (usage only)
```

`event` is `launch`, `heartbeat`, or `usage`. Only `usage` includes `batchId`, a random lowercase RFC 4122 UUID v4 that remains unchanged for retries; `launch` and `heartbeat` never include it. `day` is the current UTC calendar day. `installId` is a random UUID generated locally after acceptance and is not derived from a URL, title, page, account, meeting, or command. A daily heartbeat is attempted at most once per UTC day. Normally one successful usage event is sent per UTC day; failed delivery may retry while sharing remains enabled and counters remain pending.

Telemetry never sends URLs, titles, page data, screenshots, form values, command arguments, meeting details, raw meeting identifiers, cookies, credentials, or content. Failed usage delivery remains locally pending only while sharing is enabled and may retry when the background cadence is invoked. Disabling sharing deletes the local telemetry identifier, cadence markers, and pending counters; it does not recall an event already accepted by the endpoint. No telemetry request is needed for browser control, and decline/disable is silent.

## Permissions

Permissions separate autonomous site reach from command authority:

- **Required all-site access:** `<all_urls>` is a required host permission so agents can navigate, inspect, screenshot, and interact with any HTTP(S) origin without runtime permission prompts. It does not authorize commands by itself: every action still requires the user-only native transport, an active session, and a session-owned or explicitly borrowed tab.
- **Limited persistent meeting detection:** content scripts remain matched only to the exact Google Meet and Zoom hosts needed for reminders. No persistent general-site content script is registered.
- **Native Messaging:** connects the extension to the local host only. It is not a network permission.
- **No debugger permission:** the extension does not use `chrome.debugger` and cannot access debugger-only capabilities.

The manifest must not add history, bookmarks, webRequest, `activeTab`, or `optional_host_permissions`. Broad required host access is intentional for autonomous operation; uninstalling or disabling the extension is the revocation path.

## Agent Window and borrow model

The default Agent Window is visibly separate from normal browsing. The extension owns and automates tabs created in that window. A normal tab is read-only until the operator explicitly borrows it through the popup. Borrowed tabs are returned when requested and as part of session stop. The extension never passively inventories arbitrary tabs or injects automation code into tabs that are not session-owned or borrowed.

This is a privacy boundary, not a claim that a webpage is trustworthy. A page can still display or receive whatever the operator explicitly asks the automation to display or enter. Do not use browser control with credentials or sensitive data unless that is the intended task.

## Meeting data minimization

Meeting reminders support Google Meet and Zoom only. A detector emits:

```text
version, detection_id, provider, meeting_key, detected_at_ms
```

`meeting_key` is a 64-character lowercase hexadecimal opaque salted SHA-256 value derived inside the extension. The raw URL, query string, meeting ID, title, page content, participant list, credentials, cookies, and recording data never leave the extension as part of this event. The provider and opaque key are retained only long enough for bounded deduplication and local delivery.

The native host may forward the same minimised event over same-user Unix IPC to an optional UltraVox adapter. UltraVox may show a visible prompt. The extension never records audio/video and never starts recording. Recording requires an affirmative `Start recording` action; `Not now` or Escape declines. Disable the meeting-detection setting to stop reminder events.

## Threat boundaries

The local design reduces—but cannot eliminate—these risks:

| Boundary | Protected by | Remaining risk |
| --- | --- | --- |
| CLI → host | random token, framed messages, user-only socket, peer-UID check where supported | another process running as the same user may access local IPC or read local state |
| Host → extension | Chrome Native Messaging, exact extension ID in `allowed_origins`, versioned frames | a user who can modify the browser profile or host registration can alter the trust chain |
| Extension → page | active session, Agent Window/borrow ownership, isolated-world content scripts, required all-site host access | explicitly controlled pages can observe actions and values sent to them |
| Meeting page → reminder | exact hosts, parser, opaque salted key, bounded deduplication | a compromised page or browser can present false UI; detection is a reminder, not proof of attendance |
| Local files → privacy | per-user paths, restrictive modes, no external upload by default | OS backups, shell history, browser sync, malware, or an administrator may expose local files |

No browser extension can protect against a compromised browser, compromised operating system, malicious same-user process, or misuse of its required all-site access. Use a separate browser profile or OS account for high-sensitivity work.

## No-debugger and no-infobar invariant

The project does not request `debugger` and never invokes `chrome.debugger`. It does not rely on a Chrome launch switch to hide an infobar. Required `<all_urls>` host access enables autonomous HTTP(S) automation but does not weaken session ownership or command gating. A release or local build that adds debugger access, history, bookmarks, webRequest, passive general-site content scripts, or external browser control fails the privacy review and must not be used. Debugger-only operations return explicit unsupported errors and must be handled by an approved OverSeer cloud/desktop fallback instead.

## Retention and deletion

Runtime state is bounded and local; session ownership and pending meeting delivery clear on browser restart. Telemetry events already accepted by the disclosed endpoint are not recalled by uninstall or disable; disabling first removes the local telemetry identifier, cadence markers, and pending counters. Server-side rows containing the random installation ID are retained for at most 34 UTC days. ID-free daily totals contain only app/event/counter aggregates and are retained for at most 360 UTC days; a scheduled deletion worker enforces both limits even when no new events arrive. On uninstall, stop sessions, return borrowed tabs, remove the extension to revoke its required all-site access, unregister the native host, and remove this application's socket, token, configuration, logs, and generated artifacts using the platform cleanup command. Do not delete shared browser profile data. UltraVox users should also disable its meeting-detection setting and remove only the adapter's local state.

On startup, version 0.1.3 and later delete the obsolete `overseer.automation.origins.v1` allowlist left by per-origin releases.

## Privacy review checklist

Before publishing a build, reviewers should inspect the manifest and source for:

- no telemetry before explicit acceptance; when enabled, only the documented endpoint and v2 event schema with the exact allowlisted counters;
- required `<all_urls>` host access, no runtime permission-request path, exact persistent Meet/Zoom content-script matches, and session/tab ownership gating;
- no debugger API or `debugger` permission;
- no raw meeting identifiers in host or adapter messages;
- no passive tab/history/bookmark collection;
- bounded frames, timeouts, cancellation, and restrictive local file permissions.
