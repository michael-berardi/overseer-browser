# Security

OverSeer Browser controls a real browser, so a bug can expose page data or cause unintended actions. Security fixes take priority over convenience. Please do not disclose a vulnerability in a public issue until maintainers have had a reasonable opportunity to investigate.

## Reporting

Use GitHub's private vulnerability-reporting channel when it is enabled for this repository. If no private channel is available, open an issue containing only **private security report requested** and no exploit details; maintainers will provide a private channel.

Include:

- affected release, commit, browser, and operating system;
- a concise description and impact;
- reproducible steps or a minimal proof of concept;
- whether the issue depends on all-site host access, a borrowed tab, native-host access, or same-user access;
- any suggested mitigation.

Do not include passwords, cookies, meeting URLs, raw meeting IDs, participant data, page content, tokens, private keys, device identifiers, or personal data. Redact logs and screenshots. Do not test against another person's browser or data.

## Security invariants

A release is not acceptable if it violates any of these:

- no `chrome.debugger` call and no `debugger` permission;
- required `<all_urls>` host access for autonomous HTTP(S) control, with no runtime permission-request path and no history, bookmarks, `webRequest`, `activeTab`, or `optional_host_permissions`;
- no telemetry before explicit opt-in; opted-in telemetry must use only the release's disclosed schema, fields, and exact allowlisted counters;
- exact extension identity and native-host `allowed_origins` binding;
- CLI socket directory mode `0700`, socket/token mode `0600` where supported, and peer-UID validation where supported;
- native and CLI length-prefixed frames are bounded and authenticated;
- request IDs, timeouts, cancellation, and disconnect handling prevent indefinite or cross-request confusion;
- automation code runs only in session-owned or explicitly borrowed tabs;
- meeting events contain only the versioned minimized payload with an opaque 64-character lowercase hexadecimal key;
- meeting events never start recording without a visible affirmative user action.

Debugger-only capabilities—response bodies, print-to-PDF through debugger control, device emulation, and trusted CDP input—must return an explicit `unsupported_capability` result. A hidden fallback is a security bug.

## Maintainer response

Maintainers should acknowledge private reports, reproduce in an isolated profile, assess whether page data or credentials could cross a boundary, and coordinate a fix and release note. Do not include sensitive reproduction data in commits or tests. Credit reporters only with consent.

## Dependency and release hygiene

Review dependency licenses and changes before release. Build from a clean checkout with a lockfile and a pinned Node/npm toolchain. Inspect the generated manifest and native-host registration before loading the extension. Keep signing private keys, tokens, local paths, credentials, and production configuration outside the repository. Releases must be reproducible from source without GitHub Actions.