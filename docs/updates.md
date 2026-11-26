# Updates

<!-- update-contract: v1 -->

OverSeer Browser checks for a newer release itself, but only in an interactive
terminal and only when you have not turned checks off. The check is one
anonymous HTTPS GET to this repository's public GitHub "latest release" record
(`/repos/<owner>/<repo>/releases/latest`). It sends a fixed
`overseer-browser-update-check` User-Agent and no account, version, usage,
machine, session, or browser data. Nothing is sent to any other endpoint.
Only stable `x.y.z` releases count; drafts, prereleases and unparseable tags
are ignored.

The check runs in a background thread with a 3-second timeout and never blocks
your command. It runs at most once per 24 hours; the timestamp, the newest tag,
and any failure cause are stored in an owner-only cache file under the platform
cache directory (override test state with `OVERSEER_BROWSER_UPDATE_STATE_DIR`).
A failed check is never printed as noise and is never retried in a loop;
`overseer-browser update --check` reports the recorded cause.

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
overseer-browser 0.10.20 available (you have 0.10.19) · run: overseer-browser update
turn on automatic updates: overseer-browser update --auto on · skip: overseer-browser update --skip
```

`update --skip [VERSION]` hides that version until a newer one appears.

## Installing

`overseer-browser update` downloads the release bundle from the same GitHub
release, verifies its SHA-256 against that release's `SHA256SUMS` before
installing, swaps the release atomically, and keeps the previous release under
`<install>/rollback/previous`. `overseer-browser update --rollback` restores it
and re-registers the local host; it reports plainly when no previous release
was kept. An explicit update installs without questions and never overwrites a
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
cache and applies to the next command. A failed install leaves the current
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
