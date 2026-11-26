# CLI reference

From a checkout, run `./cli/overseer-browser ...`; the installed command is
`overseer-browser`.

```sh
overseer-browser --version
overseer-browser [--session KEY] health
overseer-browser [--session KEY] status [--json]
overseer-browser doctor
overseer-browser sessions start [name] [--mobile [--width PX] [--height PX]] | stop | list
overseer-browser windows resize <width> <height>
overseer-browser tabs list | create [url] | select <id> | close <id> | borrow <id> | return <id>
overseer-browser navigate <url> [--wait-until load|interactive]
overseer-browser back | forward | reload [--wait-until load|interactive]
overseer-browser snapshot [--max-nodes N]
overseer-browser observe [--max-nodes N] [--changes]
overseer-browser wait --ready | --url TEXT | --text TEXT [--absent] | --selector CSS [--state visible|hidden|enabled] | --stable MS [--timeout-ms N]
overseer-browser click | hover <ref>
overseer-browser fill | type <ref> <text>
overseer-browser select <ref> <value>
overseer-browser press <key> [ref]
overseer-browser scroll <y> | <x> <y> | <ref> [<x> <y>]
overseer-browser evaluate <script>
overseer-browser screenshot [path]
overseer-browser screenshot-element <ref> [path]
overseer-browser upload [--via] <ref> <path> [path...]
overseer-browser dom find LOCATOR | get QUERY LOCATOR [NAMES...] | is STATE LOCATOR
overseer-browser console start | read | stop
overseer-browser network start | stop | read [limit]
overseer-browser batch '<json-actions>'
overseer-browser qa pack <dir>
overseer-browser timelapse <dir> <frames> <interval-seconds>
overseer-browser record start [fps seconds max-bytes] | status | stop <path> | restart | clear
overseer-browser capture start | stop
overseer-browser takeover [resume]
overseer-browser cancel <request-id>
overseer-browser update [--check | --skip | --auto on|off|status | --auto-check on|off | --rollback]
overseer-browser help
```

`update --check` exits 0 when current, 10 when a newer release exists and 1
when the check failed (the JSON result names the cause). Update notices go to
stderr in a terminal only, never into JSON. See [Updates](updates.md).

Automation results are minified JSON on stdout, including errors with stable
codes. Help and the default `status` view are human-readable; use `status --json`
for JSON status. `--json` and `--raw-json` are accepted as aliases.

`network read` shows Resource Timing entries. After `network start`, it also
shows bounded `navigator.sendBeacon` metadata (method, redacted URL, content
type and body size) captured for 60 seconds; bodies, headers and query values
are never returned. `network stop` restores the page immediately. On a borrowed
tab the page is temporarily patched, so use it only for pages you intend to
instrument.

`upload --via <ref>` is for sites that open the file picker from a button
(for example, a media composer) instead of exposing an `<input type=file>`.
It clicks `<ref>`, intercepts the picker the page opens (a file input's
`click`/`showPicker`, or `showOpenFilePicker`) so no native dialog appears,
and delivers the files to it. The interception is one-shot and is removed
afterwards; if nothing opens a picker within 5 seconds it fails with
`chooser_not_opened`.

Ref-based actions work through the top document, open shadow roots and
visible same-origin frames; cross-origin frame DOM stays opaque. Mutations
report a bounded `dom_mutations` count. Use explicit tab IDs for concurrent
clients and serialize navigation per tab. `evaluate` in the session's own Agent
Window needs no popup grant; elsewhere the tab needs a site grant and the
evaluate capability grant. Evaluation uses User Scripts where available and
falls back to bounded MAIN-world injection on pages that permit it;
strict-CSP pages still require the **Allow User Scripts** setting.

Keyboard events are synthetic. `press Enter` includes legacy key code 13 for
older controls as well as the modern key and code. A cancelled keydown prevents
the tool's default form submission; this does not manufacture trusted input.

**Temporary output.** Screenshots without a path go to `/tmp/screenshots/` on
POSIX. Screenshots, evidence packs, timelapses and recordings written to the OS
temp directory expire after about 15 minutes (sooner under a 512 MiB /
512-entry budget) unless marked `--keep`. Files outside the temp directory are
never deleted. Cleanup runs when the native host starts and while it is idle.

