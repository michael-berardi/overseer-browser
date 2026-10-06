# QA navigation classification

The validated CLI navigation branch marks exact owned apex/www URLs with one
`overseer_internal=1` before its RPC. Other URL values and fragments retain their
original bytes. Duplicate/encoded marker keys collapse to one canonical marker.
This is measurement classification, never authentication or a security bypass.

`navigate`/`open` checks the selected session's current Agent Window and pins the
owned tab. Unknown scope fails with `qa_scope_unverified`. Confirmed borrowed tabs
retain unchanged URL bytes but are also pinned by tab ID: a selection change
between the scope snapshot and final RPC must not reroute an unmarked URL to an
owned tab. `tabs create` uses the existing Agent Window contract. Batch
navigation requires an explicit target after a scope-changing action. Help,
version, invalid arguments and unrelated opaque values remain read-only.

Explicit HTTP(S) navigation with parser-ambiguous syntax is refused locally with
`qa_scope_unverified` before any RPC. This conservative gate also refuses such
syntax on unowned hosts: encoded/non-ASCII hostnames, ASCII control/space bytes,
backslashes and noncanonical scheme/slash forms. It does not normalize outgoing
URL bytes; canonical unowned URLs and percent-encoded credential/query/fragment
values remain untouched. Opaque values in non-navigation commands are not gated.

The generic RPC API is unchanged. Site guards and owned browser contexts must
preserve classification through redirects and page-generated navigation. The
CLI cannot prove arbitrary history/popup ownership atomically; do not describe
this URL preparation as a universal network sandbox. Existing native permission
and session guards remain authoritative.

## Installation

Every supported installer must package `cli/internal_qa.py` with `cli/main.py`.
The macOS copylist already includes it; the actual Linux/Windows installers are
`scripts/install-linux.sh` and `scripts/install-windows.ps1` (not `manage-*`).
Their missing helper copylist entries remain a release blocker until repaired
in the authorized installer scope.

CLI-only publication is the release parent's responsibility, only after PASS.
The proposed procedure is to publish the helper first, then atomically replace
main in the pinned runtime, preserving a durable previous main for rollback and
refusing an unexpected installed hash. This source repair does not implement or
execute that publication transaction. No extension/host reload, permission
expansion, connection-descriptor edit or peer-session interruption is required
by this unchanged RPC contract.

## Verification

`python3 -m unittest tests.test_internal_qa tests.test_cli_help` exercises actual
CLI parsing and actual managed `runpy` module/script entrypoints with mocked
transport, exact host scope, duplicate markers, opaque values, WHATWG aliases,
borrowed selection races, structured scope errors, shared timeout budgets and
post-marker request-size bounds. These checks do not start a browser, host or
installer and do not verify a published runtime or grant release approval.
