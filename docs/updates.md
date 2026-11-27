# Updates

<!-- update-contract: v1 -->

[Back to README](../README.md)

OverSeer Browser tells you when a newer stable release exists and updates in
one command. Automatic installation is off until you turn it on.

## Notice

After a command finishes in a terminal, the CLI may print two lines on stderr:

```text
overseer-browser 0.12.0 available (you have 0.11.3) · run: overseer-browser update
turn on automatic updates: overseer-browser update --auto on · skip: overseer-browser update --skip
```

It appears at most once a day per version, never on stdout, and never when
stdout or stderr is not a terminal, with `--json`/`--raw-json`, when `CI` is
set, with `OVERSEER_BROWSER_AGENT=1`, or when checks are off. A skipped version
stays quiet; a newer one notifies again. Installs from a source checkout are
told to run `git pull --ff-only && overseer-browser update`.

The extension popup shows the same information under **Updates**: **Install
Update**, **Skip This Version**, **Remind Me Later**, the two settings below,
the current version and **Check Now**. It asks the local native host; the
extension makes no network request of its own.

## Commands

| Command | Effect |
| --- | --- |
| `overseer-browser update` | Shows current → new and the first release-note lines, asks `Install <new> now? [Y/n]` on a terminal, installs, then asks once `Install future updates automatically? [y/N]`. Without a terminal it installs without asking. |
| `overseer-browser update --check` | Checks now and reports. Exit `0` current, `10` update available, `1` check failed (`error` names the cause). |
| `overseer-browser update --skip` | Hides the notice for the newest version until a newer one appears. |
| `overseer-browser update --auto on\|off\|status` | Install updates automatically (off by default), or show the settings and the last automatic-update error. |
| `overseer-browser update --auto-check on\|off` | Check for updates automatically (on by default). |
| `overseer-browser update --rollback` | Reinstalls the kept previous version (macOS and Linux). |

From a source checkout, `update` reinstalls from that checkout as before; pull first.

## The check

One anonymous `GET` of the project's public GitHub "latest release" record
(`/repos/<owner>/<repo>/releases/latest`; the release build fills in the
owner/repo) with the fixed User-Agent `overseer-browser-update-check`. It sends
no version, identifier, machine or usage data. It runs at most once every 24
hours, in a detached background process with a 4-second timeout, so commands
never wait for it. A failure is recorded with its cause and shown only by
`update --check`; it is not retried until the next day. Only stable `x.y.z`
releases that are strictly newer count; drafts and prereleases are ignored.

## Automatic updates

When on, the daily check that finds a new release installs it in the
background at low priority. The running version keeps working; the new one
applies from the next command. Running browser sessions are not restarted.
The extension in your everyday Chrome moves to the new version when you click
Reload in `chrome://extensions`. A failed automatic update leaves the current
version in place, records the cause (`update --auto status`) and the notice
asks again.

## Install safety

`update` downloads the release's `install.sh` (`install.ps1` on Windows) and
bundle into a temporary folder and checks both against the release's
`SHA256SUMS` before anything changes; a mismatch installs nothing. It then
runs that installer on the verified files. The installed release is moved to
`~/.overseer-browser/previous/` first; if the installer fails, that version is
reinstalled. The temporary folder is deleted on success and failure.

## Files and cleanup

- State: one file, `update-check.json` (mode `0600`), in the platform cache
  folder: `~/Library/Caches/overseer-browser` on macOS,
  `$XDG_CACHE_HOME/overseer-browser` (default `~/.cache/overseer-browser`) on Linux,
  `%LOCALAPPDATA%\overseer-browser\Cache` on Windows.
- Automatic-update log: `auto-update.log` in the same folder, kept under 256 KB.
- Rollback copy: at most one, removed after the new version completes its
  first successful command, or after 7 days.
- `overseer-browser uninstall` removes the state file, the log and the rollback copy.

## Opting out and overrides

Turn off automatic checks with `OVERSEER_BROWSER_NO_UPDATE_CHECK=1` or
`overseer-browser update --auto-check off` (or the popup setting). Explicit
`update` and `update --check` still work. For tests and forks:
`OVERSEER_BROWSER_UPDATE_API` (release record URL), `OVERSEER_BROWSER_RELEASE_REPO`
(owner/repo), `OVERSEER_BROWSER_RELEASE_BASE` (asset folder, `file://` works),
`OVERSEER_BROWSER_CACHE_DIR` and `OVERSEER_BROWSER_HOME`.
