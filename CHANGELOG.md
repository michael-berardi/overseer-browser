# Changelog

## 0.10.13

- Hidden Agent Window screenshots: when Chrome refuses one of the positions tried (a large window cannot be placed there), the extension skips it and tries the next, so a 1920x1080 Agent Window is captured as well as a mobile one.

## 0.10.12

- Screenshots of an Agent Window that Chrome reports as hidden (covered by another window, so `document.visibilityState` is `hidden`) now work. For the session's own Agent Window only, the extension moves it by `left`/`top` to a position where it is visible, waits for the document to report visible, runs the usual paint and scroll checks, captures, and puts the window back. It never focuses, raises or resizes the window, never touches the operator's windows or borrowed tabs, and keeps the operator's authenticated session. A window that stays hidden at every position, or is minimized, maximized or fullscreen, still fails with `screenshot_tab_not_painting`; the stale-frame guard is unchanged.

## 0.10.11

- Isolated Chrome launches no longer inherit the caller's environment. The supervisor, Chrome and its version probe get an allowlist of runtime variables only, so credentials exported in a terminal never reach the launched browser's command line or environment.

## 0.10.10

- When scoped control is refused, the CLI says whether its dedicated browser was stopped, left running, or could not be stopped. It no longer suggests retrying `sessions stop` against the same rejected connection.
- Document screenshot probe limits: Chrome pages that disallow script injection now return `screenshot_probe_failed` rather than an unverified image.

## 0.10.9

- Screenshots no longer return silent stale pixels. Every capture first proves the tab is painting (visibility plus two animation frames inside a 500 ms bound, retried once so a busy but painting page is not refused) and pins the scroll offset it belongs to, then re-checks both after the capture: an unpainted or hidden tab fails fast as `screenshot_tab_not_painting` instead of returning its last painted frame (typically the top of the page, long after a scroll), a viewport that moves under the frame fails as `screenshot_viewport_changed`, and a probe that cannot run is `screenshot_probe_failed`. Successful results report the verified `frame` state. No new permission, no debugger escalation and no forced focus.
- A refused scoped command now says why. `extension_upgrade_required` keeps the same capability and scope check but reports `reason`, the observed extension version, the required CLI version, the connection mode (`operator-relay` or `managed-isolated`) and the remediation in the error `details`; when the managed lane had to launch the isolated browser for that command, the instance it started is stopped instead of being left running after the refusal.
## 0.10.8

- Fix screenshot retries triggering Chrome capture quota errors, and report covered or minimized Agent Windows and persistent rate limits with actionable messages.
- Make isolation tests independent of launchd.

## 0.10.7

- Refuse overlong runtime socket paths with an actionable error naming `OVERSEER_BROWSER_RUNTIME`, instead of crashing during socket binding.

- Malformed DOM query transport errors now return `invalid_response` instead of raising an exception or passing through an invalid envelope. Valid transport errors are unchanged.
- Shorten the README and move installation, usage and CLI details into guides. Correct stale installer instructions; retain release-first installation.

## 0.10.6

- macOS: a failed or slow process lookup is no longer read as the isolated browser having exited. The launchd process handle reads the start time through `proc_pidinfo` without forking, so a running Chrome stays supervised and a second instance never starts on the same profile; the supervisor also no longer forks `ps` about ten times a second.
- macOS: roughly one launchd start in twenty lost its child because the wrapper exited before the child left the job's process group, so Chrome fell back to a direct start. The wrapper now waits for that.
- macOS: when launchd starts the wrapper after the wait, the start is cancelled (exclusive-create marker) and only then started directly, so the late wrapper never runs a second copy on the same profile. A command that fails to exec after its pid was reported now names the cause in `chrome.log`.
- `launchctl` is resolved to an absolute path, so a PATH without `/bin` still uses launchd.
- `status` shows the coalition hint when the live browser shares the caller's coalition, even when the socket is connected.

## 0.10.5

- macOS: the isolated supervisor and its Chrome for Testing now start in their own launchd process coalition instead of the caller's. Previously a browser started from a terminal pane shared the terminal multiplexer's coalition, so quitting Chrome from the Dock could stop the multiplexer and every session in it. If launchd refuses, the cause is logged once and the process starts directly as before. `status` and `doctor` report whether the live browser shares a coalition with the calling shell. Linux and Windows are unchanged.
