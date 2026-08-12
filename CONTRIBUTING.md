# Contributing

Contributions are welcome when they preserve the local-only, least-privilege contract. Read [README.md](README.md), [PROTOCOL.md](PROTOCOL.md), [PRIVACY.md](PRIVACY.md), and [SECURITY.md](SECURITY.md) first.

## Design rules

- Keep all browser control local. Do not add telemetry, analytics, external servers, remote logging, or hidden network fallbacks.
- Never use `chrome.debugger`, CDP, the `debugger` permission, history, bookmarks, or webRequest to make a feature easier. `<all_urls>` may be offered only as an optional user-gesture grant for Chrome's screenshot API; it must never be a required host permission.
- Preserve exact meeting-host permissions, popup user-gesture gating for automation origins, and the separate warning for optional broad screenshot access.
- Keep the Agent Window as the default. Require an explicit borrow for normal tabs and return borrowed tabs on stop.
- Never put raw meeting URLs, IDs, titles, page content, participants, credentials, cookies, or recording data into host or adapter messages.
- Unsupported debugger-only work must return an explicit structured error and point callers to an approved fallback.
- Do not add proprietary application code or private infrastructure configuration. UltraVox integration is an optional adapter around the public meeting event.

## Local setup

Use a clean checkout and a supported Node.js/npm version. Do not commit generated output or personal configuration.

```sh
npm ci --prefix extension
npm run dev --prefix extension
```

`npm run dev` is for local extension development. Load the generated development directory through the browser's **Load unpacked** flow, and use a test browser profile whenever possible. Native-host registration should be per-user and use the documented installer/OS adapter; never paste an absolute home path, token, or private key into a public manifest.

For a reproducible extension build, keep the lockfile under review, start from a clean checkout, use `npm ci --prefix extension`, and build with `npm run build --prefix extension`. Compare the generated manifest, extension ID, permissions, and artifact checksums before release; never hand-edit generated output.

## Before opening a change

Run the focused checks relevant to the change:

```sh
npm test --prefix extension
npm run build --prefix extension
python3 -m unittest tests.test_browser_bridge
```

The test suite should cover observable behavior, not implementation snapshots. At minimum, changes touching these boundaries need focused coverage for:

- protocol schema, framing, request IDs, bounded messages, timeouts, cancellation, and host authentication;
- session ownership, Agent Window defaults, borrow/return transitions, and disconnect cleanup;
- required meeting-host parsing, opaque hash format, deduplication, capture suppression, and payload minimization;
- optional permission gating and the no-debugger manifest invariant;
- explicit unsupported errors and UltraVox accept/decline state.

Exercise the smoke path in a real Chromium profile when browser behavior changes: connect, create an Agent Window, navigate, observe, click/fill, screenshot, borrow/return, stop, and confirm no debugger infobar. Use deterministic Meet/Zoom fixtures or local pages and verify that only the opaque meeting event reaches the host.

Do not add GitHub Actions. Use local/manual release checks and document any platform-specific command needed to reproduce them.

## Accessibility and interaction review

The popup and takeover surfaces are operator tools, not decorative dashboards:

- Every action is keyboard reachable with visible focus.
- Buttons and status indicators have accessible names and meaningful states.
- The connection state and primary action are announced without relying on color alone.
- Error and permission text is readable, concise, and associated with the relevant control.
- Reduced-motion preferences disable entrance motion.
- The UltraVox meeting prompt has one clear question, a visible focus trap, an inert background, `Start recording` as the primary action, `Not now` as the secondary action, and Escape-to-decline behavior.
- Check compact popup sizing and prompt layouts at narrow, tablet-equivalent, and desktop widths without clipping or inaccessible overflow.

## Pull requests

Describe the user-visible behavior, permissions affected, data flow, and tests run. Call out any protocol or error-code change and update [PROTOCOL.md](PROTOCOL.md). Include screenshots only from deterministic fixtures; remove URLs, tokens, page content, and personal data.

Reviewers should inspect the manifest diff, generated permissions, native-host registration, and public artifacts—not only the TypeScript or Rust diff. A change is not ready if it weakens the no-debugger, no-telemetry, exact-host, or explicit-consent invariants.

## Commit and license

Use focused commits and do not include secrets or generated local state. New source is released under the MIT License in [LICENSE](LICENSE). If adapting an external implementation rather than merely using a concept, identify the source and license in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) and preserve required notices.
