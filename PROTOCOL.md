# Protocol

This document defines the public local protocol. It is intentionally transport-specific at the frame boundary and payload-stable at the message boundary.

## Trust model and transports

There are two local hops:

1. **CLI → native host:** a user-only Unix-domain socket. Each frame is a 4-byte **big-endian** unsigned length followed by one UTF-8 JSON object.
2. **Native host ↔ extension:** Chrome Native Messaging. Each frame is a 4-byte **little-endian** unsigned length followed by one UTF-8 JSON object, as required by Chrome.

The host is registered as `com.imploselabs.overseer_browser`. Chrome launches it only for the exact extension origin in `allowed_origins`; the host must reject any other caller. The CLI socket directory is mode `0700`, the socket and random token file are mode `0600` where the platform supports those modes, and the host checks the peer UID where supported.

Frames are bounded before allocation and parsed as one JSON value. Malformed, oversized, truncated, stale, or unauthorized frames receive a structured error or cause the connection to close. The implementation must use request timeouts and cancellation rather than waiting forever.

## CLI request

Every CLI request has this shape:

```json
{
  "version": 1,
  "kind": "request",
  "request_id": "req_01J...",
  "command": "tabs.list",
  "params": {},
  "token": "<random local token>"
}
```

Fields:

- `version` is the integer protocol version (`1`).
- `kind` is exactly `request`.
- `request_id` is a client-generated ID unique for the connection. It is echoed in the response.
- `command` is a documented command string.
- `params` is a command-specific JSON object.
- `token` authenticates the CLI to the native host. It is never forwarded to the extension, UltraVox, or any external process.

The host validates the token, removes it, and forwards the remaining request fields to the extension over Native Messaging. The extension must not treat a token as browser content or expose it in diagnostics.

## Extension response

The extension responds with:

```json
{
  "version": 1,
  "kind": "response",
  "request_id": "req_01J...",
  "ok": true,
  "result": {
    "session_id": "session_01J..."
  }
}
```

An error response is:

```json
{
  "version": 1,
  "kind": "response",
  "request_id": "req_01J...",
  "ok": false,
  "error": {
    "code": "unsupported_capability",
    "message": "This operation requires the debugger API and is not available.",
    "reason": "debugger_api_unavailable",
    "fallback": "overseer_cloud_or_desktop"
  }
}
```

`error.reason` and `error.fallback` are optional top-level strings, each bounded to 4,096 characters. `reason` gives a stable machine-readable explanation when available; `fallback` identifies an explicitly supported alternative.

`result` is present only for a successful response. `error.code` is stable enough for a CLI to branch on; `message` is human-readable and must not contain URLs, page text, credentials, or other captured browser content. Typical codes include `invalid_request`, `unauthorized`, `not_connected`, `not_found`, `not_borrowed`, `timeout`, `cancelled`, `conflict`, `rate_limited`, and `unsupported_capability`.

## Commands

The required command families are:

- `health` / `status`
- `sessions.start`, `sessions.stop`, `sessions.list`
- `windows.resize`
- `tabs.list`, `tabs.create`, `tabs.select`, `tabs.close`, `tabs.borrow`, `tabs.return`
- `navigate`, `back`, `forward`, `reload`
- `snapshot` / `observe` with stable element references
- `click`, `hover`, `fill`, `type`, `select`, `press`, `scroll`
- `evaluate` only when the explicit capability is enabled
- visible-tab or element screenshots
- bounded chunked upload of 1–16 files
- opt-in bounded console capture and redacted Resource Timing metadata
- sequential batches of up to 20 explicit actions, or bounded parallel read batches across distinct explicit tab IDs
- `help` / visible `takeover` prompt and operator-CLI `takeover resume`
- `cancel`
- `capture.start`, `capture.stop`

Commands operate on the active session/tab selected by the caller or on IDs supplied in `params`. Automation code is injected only into session-owned or explicitly borrowed tabs. The isolated-world traversal covers the top document, open shadow roots, and visible same-origin nested frames; cross-origin frame DOM remains opaque. Direct synchronous calls through the current page dialog globals caused by click, Enter, or Space are bounded: alerts are acknowledged, confirmations and prompts are dismissed, and captured dialog metadata is returned with the action. Page-retained references to native dialog functions that predate the guard require debugger-level interception and remain unsupported. There is no passive general-browsing collection.

`health.status` retains the version-1 permission fields (`meetingHosts`, `optionalSiteAccess`, `currentOrigin`, and `currentOriginAccess`) and adds `allSiteAccess`. The all-site booleans report Chromium's effective required `<all_urls>` grant; the extension never requests permission at runtime.

A session owns a dedicated Agent Window by default. A normal user tab is read-only until `tabs.borrow` succeeds. `tabs.return` restores ownership to the user, and stopping a session returns all borrowed tabs before releasing session state.
Uploads are explicit and bounded. The CLI accepts `upload REF PATH [PATH...]`, limits each set to 1–16 files, 8 MiB aggregate, and at most 32 chunks of 256 KiB. The extension retains at most eight incomplete transactions and 32 MiB of incomplete bytes, expires abandoned transactions after 60 seconds, and clears retained data on native disconnect or session stop. It transmits only a bounded element reference plus ordered file/chunk metadata, basenames, MIME types, and contents; local filesystem paths and the token never enter the extension payload. A receiver must reject missing, duplicated, oversized, inconsistent, or out-of-order files and chunks before assigning the complete set atomically to a file input.

Batch execution is sequential unless the request sets `stop_on_error: false` and `max_parallel` between 2 and 8. Parallel mode accepts only one `tabs.list` action plus read-only `snapshot`, `observe`, or `network.read` actions with distinct explicit `tab_id` values. The extension validates the complete batch before starting work, preserves result order, shares the outer deadline/cancellation state, and rejects mutation or same-tab parallelism because those actions cannot be rolled back deterministically.

## Unsupported capabilities

The following operations require debugger/CDP privileges and are intentionally unsupported:

- response-body interception or capture;
- print-to-PDF through debugger control;
- device emulation;
- trusted CDP input or equivalent browser-privileged input;
- cross-origin frame DOM access;
- interception of dialogs invoked through page-retained native function references;
- any other operation whose only safe implementation requires `chrome.debugger`.

Return `unsupported_capability` with a fallback hint for OverSeer cloud/desktop tooling. Never request `debugger` or silently substitute a less trustworthy action. Required `<all_urls>` host access enables autonomous HTTP(S) operation; automation remains limited to session-owned or explicitly borrowed tabs.

## Meeting detection event

The extension may emit this unsolicited Native Messaging frame:

```json
{
  "version": 1,
  "kind": "meeting_detected",
  "payload": {
    "version": 1,
    "detection_id": "det_01J...",
    "provider": "google_meet",
    "meeting_key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "detected_at_ms": 1770000000000
  }
}
```

`provider` is `google_meet` or `zoom`. `meeting_key` is exactly 64 lowercase hexadecimal characters and is an opaque salted SHA-256 value. It is not a raw meeting ID and must not be reversible or accompanied by the source URL. `detected_at_ms` is an epoch-millisecond timestamp. The extension deduplicates by provider plus meeting key with a 90-second TTL, persists only bounded opaque state for the browser session, ignores detections while capture is active, and retains an undelivered event only until that TTL expires.

The native host may forward this event to an optional same-user UltraVox adapter over `voice-v1.sock` as:

```json
{
  "version": 1,
  "requestId": "req_01J...",
  "command": "meeting_detected",
  "detection": {
    "version": 1,
    "detection_id": "det_01J...",
    "provider": "google_meet",
    "meeting_key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "detected_at_ms": 1770000000000
  }
}
```

The adapter must answer with a bounded response whose `requestId` matches the detection ID:

```json
{
  "version": 1,
  "requestId": "det_01J...",
  "ok": true,
  "state": "prompted"
}
```

After an `ok: true` adapter response, the native host emits this delivery acknowledgement to the extension:

```json
{
  "version": 1,
  "kind": "meeting_ack",
  "detection_id": "det_01J...",
  "delivered": true
}
```

Missing, malformed, mismatched, or unsuccessful adapter responses produce `delivered: false`; the extension retries while the bounded browser-session queue entry remains within its 90-second TTL. Adapters must treat `detection_id` idempotently because transport failure can occur after local processing but before acknowledgement.

The adapter is optional and local. It must validate the schema, preserve the opaque key, deduplicate again if needed, and never add a URL, title, participant, page content, credential, or raw meeting ID. Detection can cause a visible provider-specific prompt, but it never starts recording. Only the affirmative `Start recording` action may invoke an existing `start_meeting`; `Not now` and Escape decline.

## Versioning

Version `1` is the current public contract. Additive fields may be introduced only with documented compatibility behavior. A breaking change requires a new protocol version and an explicit handshake or migration path. Unknown fields must be ignored when safe; unknown commands must return `invalid_request` rather than being guessed.
