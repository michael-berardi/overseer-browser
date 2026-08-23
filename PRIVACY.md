# Privacy

OverSeer Browser is a local-first Chromium extension, native host, and CLI. It has no user account and no cloud browser-control plane. Browser control works without telemetry or an external service.

## What stays on the device

The extension, native host, and CLI may keep bounded local state needed to execute a request:

- session, window, tab, element-reference, and meeting-delivery state;
- command arguments supplied by the calling client;
- screenshots, uploads, and page observations explicitly requested by that client;
- a random local host token and connection metadata.

The extension and native host do not independently upload these values. A calling client may deliberately forward returned observations, screenshots, uploads, or action results to another service; that transfer is outside this repository and must be evaluated under the client's privacy policy. Shell history, browser profiles, operating-system logs, backups, browser sync, and user-selected upload destinations can also retain data independently.

Runtime state is bounded and local. Session state and pending meeting delivery are cleared when the browser restarts or the connection/session ends. Uninstalling removes the native host registration and this application's local runtime files; it does not delete shared browser data.

## Optional anonymous usage sharing

Usage sharing is **off by default** and requires an affirmative choice in the extension popup. Before consent, the extension creates no telemetry identifier, stores no usage counters, and makes no telemetry request. Declining is silent.

When enabled, events contain only:

```text
schema, app, event, installId, version, platform, arch, day, batchId (usage only)
```

The event is `launch`, `heartbeat`, or `usage`. `installId` is a random local UUID, `day` is the current UTC calendar day, and `batchId` is a random lowercase UUID v4 retained across retries for one usage batch. Usage contains only these counters:

```text
sessionsStarted, sessionsEnded, tabsOpened, tabsClosed, navigations,
screenshots, meetingsDetected, popupsHandled, permissionsGranted,
permissionsDenied
```

Telemetry never contains URLs, titles, page data, screenshots, form values, command arguments, cookies, credentials, meeting details, raw meeting identifiers, or identifiers derived from browser content. A release may configure the telemetry destination; it is disclosed by that release and is not required for browser control. Disable sharing in the popup to delete the local identifier, cadence markers, and pending counters. Events already accepted by a telemetry service cannot be recalled by uninstall or disable.

## Permissions and access boundaries

- **Required `<all_urls>` host access:** permits navigation, inspection, screenshots, and interaction on HTTP(S) origins without repeated origin prompts. It does not authorize a command by itself; every action still requires the local transport, an active session, and a session-owned or explicitly borrowed tab.
- **Native Messaging:** connects the extension to the local native host and is not a network permission.
- **Storage, scripting, tabs, and windows:** support the visible popup, session ownership, content traversal, and browser actions.
- **No debugger permission:** the extension does not invoke `chrome.debugger` or request debugger access.
- **Limited meeting content scripts:** meeting detection is matched only to the supported meeting hosts. No persistent general-site content script is registered.

The manifest must not add history, bookmarks, `webRequest`, `activeTab`, or optional host permissions. Uninstalling or disabling the extension revokes its browser access.

## Session and tab ownership

A dedicated Agent Window is the default. The extension automates tabs created in that window. A normal tab is read-only until the user explicitly borrows it through the popup. Borrowed tabs are returned when requested and during session stop. The extension does not passively inventory arbitrary tabs or inject automation code into tabs that are not session-owned or borrowed.

This is an access boundary, not a claim that a webpage is trustworthy. A page can still display or receive anything the user explicitly asks the automation to display or enter. Do not use browser control with credentials or sensitive data unless that is the intended task.

## Meeting data minimization

Meeting reminders support only the hosts documented by the current build. A detector emits a versioned event containing a detection ID, provider, timestamp, and a 64-character lowercase hexadecimal opaque salted SHA-256 `meeting_key`.

The raw URL, query string, meeting ID, title, page content, participant list, credentials, cookies, and recording data are not included. The native host may deliver the same minimized event over same-user local IPC to an optional adapter. Adapters must preserve the schema, keep the opaque key, bound retention, and never add page data. The extension never records audio or video and never starts recording; any recording action must be a separate visible user choice.

## Threat boundaries

| Boundary | Protected by | Remaining risk |
| --- | --- | --- |
| CLI → host | random token, framed messages, user-only socket, peer-UID check where supported | another process running as the same user may access local IPC or state |
| Host → extension | Chrome Native Messaging, exact extension identity in `allowed_origins`, versioned frames | a user who can modify the browser profile or host registration can alter the trust chain |
| Extension → page | active session, Agent Window/borrow ownership, isolated-world scripts, required host access | explicitly controlled pages can observe actions and values sent to them |
| Meeting page → reminder | exact host matches, parser, opaque salted key, bounded deduplication | a compromised page or browser can present false UI |
| Local files → privacy | per-user paths, restrictive modes, no external upload by default | backups, shell history, browser sync, malware, or an administrator may expose local files |

No browser extension can protect against a compromised browser, operating system, malicious same-user process, or misuse of required all-site access. Use a separate browser profile or OS account for high-sensitivity work.

## Security invariants

A release or local build must fail review if it adds debugger access, passive browsing collection, broad external control, runtime permission prompts, unbounded frames, or raw meeting data to a host/adapter message. Debugger-only capabilities must return an explicit `unsupported_capability` result rather than silently using a weaker substitute. See [SECURITY.md](SECURITY.md) for the vulnerability-reporting process and release checklist.
