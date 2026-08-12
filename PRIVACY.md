# Privacy

OverSeer Browser is designed for local, operator-directed automation. It has no account, cloud control plane, analytics SDK, telemetry pipeline, or external server. This document describes the intended data boundary; the built manifest and protocol are authoritative for a particular release.

## What stays local

The extension, native host, CLI, and optional meeting adapter communicate on the same device. They may hold local state needed to execute an operator request:

- session, window, tab, stable element-reference, and meeting-delivery state kept in browser session storage and cleared on browser restart;
- command arguments entered by the operator;
- screenshots, uploads, and page observations requested by the operator;
- a random local host token and connection metadata;
- a bounded allowlist of exact origins for which the operator explicitly enabled automation.

The extension and native host do not independently send these values to a vendor, external API, remote browser, or telemetry service. Page observations, screenshots, and action results explicitly requested by the operator are returned to the calling OverSeer runtime and may be sent to its configured AI provider under that runtime's privacy terms. A local shell history, browser profile, operating-system logs, browser sync, or user-selected upload destination can also retain data independently; the project does not control those facilities.

## Permissions

Permissions are deliberately separated:

- **Required meeting-host access:** persistent content scripts are limited to the exact Google Meet and Zoom hosts needed for reminders. This permission does not authorize snapshots, clicks, uploads, evaluation, or other automation on meeting tabs.
- **Explicit automation access:** general browser control is off until the operator enables the active origin from a popup user gesture. For Meet and Zoom, that separate decision is retained as an exact-origin local allowlist because Chromium already treats the reminder host permission as granted. Granting access is not a request to collect or index the site; actions still require an active session and tab ownership.
- **Optional screenshot access:** Chromium's extension screenshot API requires a broad optional host grant. `<all_urls>` is declared only under `optional_host_permissions` and requested from the popup's explicitly labeled advanced control. It is never a required host permission. Session ownership, explicit tab borrowing, HTTP(S)-only validation, and the separate page-evaluation opt-in continue to constrain commands after the grant.
- **Native Messaging:** connects the extension to the local host only. It is not a network permission.
- **No debugger permission:** the extension does not use `chrome.debugger` and cannot access debugger-only capabilities.

The manifest must not add broad required origins, history, bookmarks, or webRequest merely to make automation easier. The optional `<all_urls>` screenshot capability must remain user-gesture gated, separately labeled, and absent from required `host_permissions`. Browser permission prompts are controlled by Chromium and may vary by version; the user should grant only the access needed for a task.

## Agent Window and borrow model

The default Agent Window is visibly separate from normal browsing. The extension owns and automates tabs created in that window. A normal tab is read-only until the operator explicitly borrows it through the CLI/popup. Borrowed tabs are returned when requested and as part of session stop. The extension never passively inventories arbitrary tabs or injects automation code into tabs that are not session-owned or borrowed.

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
| Extension → page | active session, Agent Window/borrow ownership, isolated-world content scripts, optional permissions | explicitly controlled pages can observe actions and values sent to them |
| Meeting page → reminder | exact hosts, parser, opaque salted key, bounded deduplication | a compromised page or browser can present false UI; detection is a reminder, not proof of attendance |
| Local files → privacy | per-user paths, restrictive modes, no external upload by default | OS backups, shell history, browser sync, malware, or an administrator may expose local files |

No browser extension can protect against a compromised browser, compromised operating system, malicious same-user process, or an operator who grants excessive site access. Use a separate browser profile or OS account for high-sensitivity work.

## No-debugger and no-infobar invariant

The project does not request `debugger` and never invokes `chrome.debugger`. It does not rely on a Chrome launch switch to hide an infobar. A release or local build that contains the debugger permission, debugger API calls, or broad required origins fails the privacy review and must not be used. Optional `<all_urls>` access is acceptable only for the documented popup-granted screenshot capability and does not weaken tab ownership or command gating. Debugger-only operations return explicit unsupported errors and must be handled by an approved OverSeer cloud/desktop fallback instead.

## Retention and deletion

There is no server-side account or cloud retention. Runtime state is bounded and local; session ownership and pending meeting delivery clear on browser restart. On uninstall, stop sessions, return borrowed tabs, revoke automation access in the popup or browser controls, remove the extension, unregister the native host, and remove this application's socket, token, configuration, logs, and generated artifacts using the platform cleanup command. Do not delete shared browser profile data. UltraVox users should also disable its meeting-detection setting and remove only the adapter's local state.

## Privacy review checklist

Before publishing a build, reviewers should inspect the manifest and source for:

- no telemetry, analytics, external fetch, remote logging, or cloud endpoint;
- exact meeting host permissions separated from popup user-gesture-gated automation origins and optional broad screenshot access;
- no debugger API or `debugger` permission;
- no raw meeting identifiers in host or adapter messages;
- no passive tab/history/bookmark collection;
- bounded frames, timeouts, cancellation, and restrictive local file permissions.
