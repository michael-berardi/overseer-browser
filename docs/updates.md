# Updates

<!-- update-contract: v1 -->

OverSeer Browser checks for a newer release itself, but only in an interactive
terminal and only when you have not turned checks off. The check is one
anonymous HTTPS GET to this repository's public GitHub "latest release" record
(`/repos/<owner>/<repo>/releases/latest`). Source checkouts and released
installs use this project's real repository; there is no placeholder owner in
the shipped sources and no build-time owner rewrite. It sends a fixed
`overseer-browser-update-check` User-Agent and no account, version, usage,
machine, session, or browser data. Nothing is sent to any other endpoint.
Only stable `x.y.z` releases count; drafts, prereleases and unparseable tags
are ignored.

The check runs once in a detached, low-priority child process with a 3-second
HTTP timeout, so it never blocks your command and keeps running after a fast
CLI exits. A completed result gates automatic checks for 24 hours; the
timestamp, the newest tag, and any failure cause are stored in an owner-only
cache file under the platform cache directory (override test state with
`OVERSEER_BROWSER_UPDATE_STATE_DIR`). An interrupted check may be retried once
its brief claim expires.
Before the GET is sent, the worker records its start time in the owner-only
cache and a private in-flight claim. It clears the claim and writes a completed
result or failure when it finishes. The claim is only a short in-flight guard:
after 60 seconds a claim left by a dead worker is recoverable, and the old
start no longer suppresses a later check for 24 hours, so `update --check`
never reports "current" from an unfinished check. A failed check is never
printed as noise and is never retried in a loop; `overseer-browser update
--check` reports the recorded cause.

Checks are off automatically when stdout or stderr is not a TTY, `CI`,
`GITHUB_ACTIONS`, `BUILD_NUMBER` or an agent marker (`ULTRATERM_SLOT`,
`ULTRATERM_TMUX_SESSION`, `OVERSEER_BROWSER_AGENT`) is set, `TERM=dumb`, or
`--json`/`--raw-json` is in use. Opt out permanently with:

```sh
export OVERSEER_BROWSER_NO_UPDATE_CHECK=1          # env switch
overseer-browser update --checks off                # persistent config switch
```

`update --checks on` turns them back on; `--checks status` reports the setting.
When a new version is found you see at most one notice per version per 24 hours
on stderr, after the command finishes:

```
overseer-browser 0.11.2 available (you have 0.11.1) · run: overseer-browser update
turn on automatic updates: overseer-browser update --auto on · skip: overseer-browser update --skip
```

`update --skip [VERSION]` hides that version until a newer one appears.

## Installing

`overseer-browser update` downloads the release bundle from the same GitHub
release, verifies its SHA-256 against that release's `SHA256SUMS` before
installing, swaps the release atomically, and keeps the previous release under
`<install>/rollback/previous`. `overseer-browser update --rollback` restores it
and re-registers the local host; it reports plainly when no previous release
was kept.

Only one rollback copy is retained. Each update replaces that single copy with
the release it displaced; it has no expiry and stays on disk until the next
update replaces it, so clearing it sooner means it must be removed manually.
`overseer-browser update --auto off` only stops future automatic installs — it
does not delete the retained copy. Remove `<install>/rollback/previous`
manually if you no longer want it (after which `--rollback` reports that no
previous release was kept).

An explicit update installs without questions and never overwrites a
package manager's files: this project ships its own per-user release bundles
and native-host registration, with no Homebrew, npm, pip or cargo formula
owning them. Source checkouts update with `git pull --ff-only` followed by
`overseer-browser update` (or the platform install steps in
[install.md](install.md)).

## Automatic installation (opt-in)

Off by default. `overseer-browser update --auto on` (or `--auto off` / `--auto status`)
stores the choice in per-user config next to the update settings, so it survives
updates. When it is on, a detected release is installed in a detached,
low-priority background process that logs to `update-install.log` beside the
cache and applies to the next command. That owner-only log is capped to its
newest 256 KiB. A failed install leaves the current
version working, records the cause in that log, and you can fall back to the
notice and `overseer-browser update`. Automatic installation is for release
installs only: a source checkout has no verified artifact to swap, so it logs
an explicit reason and waits for a manual pull/update.

## What does not check

The browser extension and the native messaging host have no release-check
runtime: they are local components loaded from the installed release and have
no standalone update channel or UI. The CLI owns the single check and the
installer; the extension is moved into the stable folder by that installer, and
`overseer-browser refresh-extension` moves it into the folder Chrome already
loaded. No separate extension/network check or silent browser UI prompt exists.

## Documentation deviations

The contract asks for 3-6 short lines in the README Privacy section. This
project keeps a detailed [README Privacy section](../README.md#privacy) instead,
because the anonymous release check, detached worker, owner-only cache and
logs, and local browser/agent state each need an accurate boundary statement;
[PRIVACY.md](../PRIVACY.md) carries the full data flow. This is a documentation
deviation only: the privacy guarantees are not relaxed, and no release-check
behavior or version changed.

The contract's §2 prompt also asks an interactive `update` command to show
current → new and the first release-note lines, ask `Install <new> now? [Y/n]`,
and after success ask once about future automatic updates. This CLI installs
immediately on an explicit `update` and does not ask either question; its
`auto_asked` preference is currently unused. That prompt UX is an unimplemented
gap, not a privacy change, and must be closed before release.
