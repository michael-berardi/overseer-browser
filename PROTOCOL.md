# Protocol

This document defines the public local protocol for the CLI, native host, and Chromium extension. Transport details are fixed at the frame boundary; message payloads are versioned and stable.

## Trust model and transports

There are two local hops:

1. **CLI → native host:** a user-only Unix-domain socket. Each frame is a 4-byte **big-endian** unsigned length followed by one UTF-8 JSON object.
2. **Native host ↔ extension:** Chrome Native Messaging. Each frame is a 4-byte **little-endian** unsigned length followed by one UTF-8 JSON object, as required by Chromium.

The generated Native Messaging registration must list only the exact extension identity in `allowed_origins`; the host rejects other callers. The CLI socket directory is mode `0700`, and the socket and random token file are mode `0600` where supported. The host checks the peer UID where supported.

Frames are bounded before allocation and parsed as one JSON value. Malformed, oversized, truncated, stale, or unauthorized frames receive a structured error or close the connection. Implementations must use request timeouts and cancellation rather than waiting forever.

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
- `request_id` is a client-generated ID unique for the connection and echoed in the response.
- `command` is a documented command string.
- `params` is a command-specific JSON object.
- `token` authenticates the CLI to the native host. It is stripped before forwarding and is never treated as browser content.

## Extension response

A successful response is:

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
    "message": "This operation requires a capability that is not available.",
    "reason": "capability_unavailable"
  }
}
```

`result` appears only on success. `error.code` is stable enough for a client to branch on; `message` is human-readable and must not contain URLs, page text, credentials, or other captured browser content. Typical codes include `invalid_request`, `unauthorized`, `not_connected`, `not_found`, `not_borrowed`, `timeout`, `cancelled`, `conflict`, `rate_limited`, and `unsupported_capability`. Optional `reason` and `fallback` strings are bounded to 4,096 characters; callers must treat them as hints, not instructions to weaken security.

## Commands and ownership

The required command families are:

- `health` / `status`
- `sessions.start`, `sessions.stop`, `sessions.list`
- `windows.resize`
- `tabs.list`, `tabs.create`, `tabs.select`, `tabs.close`, `tabs.borrow`, `tabs.return`
- `navigate`, `back`, `forward`, `reload`
- `snapshot` / `observe` with stable element references; `observe` can return a bounded per-document delta
- event-driven bounded `wait.for` conditions
- `click`, `hover`, `fill`, `type`, `select`, `press`, `scroll`
- capability-gated `evaluate`
- visible-tab or element screenshots
- bounded chunked upload of 1–16 files
- opt-in bounded console capture and redacted Resource Timing metadata
- sequential batches of up to 20 explicit actions, or bounded parallel read batches across distinct explicit tab IDs
- visible `takeover` request and `takeover resume`
- `help` and `cancel`
- `capture.start`, `capture.stop`

Commands operate on the active session/tab or IDs supplied in `params`. Automation code is injected only into session-owned or explicitly borrowed tabs. Traversal covers the top document, open shadow roots, and visible same-origin nested frames; cross-origin frame DOM remains opaque. There is no passive general-browsing collection.

A session owns a dedicated Agent Window by default. A normal tab is read-only until `tabs.borrow` succeeds. `tabs.return` restores ownership, and stopping a session returns borrowed tabs before releasing session state.

`health.status` reports effective required-host access and retains the version-1 permission fields for compatibility. The extension never requests site permission at runtime.

## Bounds and concurrency

`wait.for` accepts `tab_id`, `timeout_ms` (default 15,000; bounded 1–45,000), and exactly one condition: `ready`, `url_contains`, text present/absent, selector state (`visible`, `hidden`, or `enabled`), or DOM stability (100–30,000 ms). Conditions resolve at most once and always clean up on timeout or tab closure.

`observe` with `changes: true` returns `{ changes, baseline, added, changed, removed, unchanged, total_nodes }` relative to the same tab and document. Node identity is the stable `osr-*` reference. State is bounded and dropped on navigation, tab removal/return, session stop, and disconnect.

Uploads accept 1–16 files, 8 MiB aggregate, and at most 32 chunks of 256 KiB. The extension retains at most eight incomplete transactions and 32 MiB of incomplete bytes, expires abandoned transactions after 60 seconds, and clears retained data on disconnect or session stop. Local filesystem paths and the token never enter extension payloads.

Batches are sequential unless `stop_on_error: false` and `max_parallel` is between 2 and 8. Parallel mode accepts only read-only actions with distinct explicit tab IDs. The extension validates the complete batch before execution, preserves result order, and rejects mutation or same-tab parallelism.

Across concurrent CLI clients, page mutations are serialized per tab. A queued mutation that outlives its deadline or cancellation never executes. Reads, waits, and mutations on distinct tabs may run concurrently.

## Unsupported capabilities

The following operations require browser-privileged debugger/CDP access and are intentionally unsupported:

- response-body interception or capture;
- print-to-PDF through debugger control;
- device emulation;
- trusted CDP input or equivalent privileged input;
- cross-origin frame DOM access;
- interception of dialogs invoked through page-retained native function references;
- any operation whose only safe implementation requires `chrome.debugger`.

Return `unsupported_capability` with a stable reason. Never request debugger access or silently substitute a less trustworthy action.

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
    "meeting_key": "<64-lowercase-hex-sha256>",
    "detected_at_ms": 1770000000000
  }
}
```

`provider` is one of the supported providers, `meeting_key` is exactly 64 lowercase hexadecimal characters and is an opaque salted SHA-256 value, and `detected_at_ms` is an epoch-millisecond timestamp. The event must not include a source URL, raw meeting ID, title, page content, participant, credential, cookie, or recording data. Implementations deduplicate with a bounded TTL and retain undelivered events only for that bounded period.

The native host may forward the minimized event to an optional same-user local adapter as:

```json
{
  "version": 1,
  "requestId": "det_01J...",
  "command": "meeting_detected",
  "detection": {
    "version": 1,
    "detection_id": "det_01J...",
    "provider": "google_meet",
    "meeting_key": "<64-lowercase-hex-sha256>",
    "detected_at_ms": 1770000000000
  }
}
```

The adapter must answer with a bounded response whose `requestId` matches the request:
```json
{
  "version": 1,
  "requestId": "det_01J...",
  "ok": true,
  "state": "prompted"
}
```

After a valid successful response, the host emits this acknowledgement to the extension:

```json
{
  "version": 1,
  "kind": "meeting_ack",
  "detection_id": "det_01J...",
  "delivered": true
}
```

Missing, malformed, mismatched, or unsuccessful adapter responses produce `delivered: false` while the bounded queue entry remains valid. Adapters must preserve the opaque payload, treat detection IDs idempotently, and never start recording without a separate visible user action.

## Versioning

Version `1` is the current public contract. Additive fields require documented compatibility behavior. A breaking change requires a new protocol version and an explicit handshake or migration path. Unknown fields must be ignored when safe; unknown commands must return `invalid_request` rather than being guessed.