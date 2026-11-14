# Changelog

## 0.10.6

- macOS: a failed or slow process lookup is no longer read as the isolated browser having exited. The launchd process handle reads the start time through `proc_pidinfo` without forking, so a running Chrome stays supervised and a second instance never starts on the same profile; the supervisor also no longer forks `ps` about ten times a second.
- macOS: roughly one launchd start in twenty lost its child because the wrapper exited before the child left the job's process group, so Chrome fell back to a direct start. The wrapper now waits for that.
- macOS: when launchd starts the wrapper after the wait, the start is cancelled (exclusive-create marker) and only then started directly, so the late wrapper never runs a second copy on the same profile. A command that fails to exec after its pid was reported now names the cause in `chrome.log`.
- `launchctl` is resolved to an absolute path, so a PATH without `/bin` still uses launchd.
- `status` shows the coalition hint when the live browser shares the caller's coalition, even when the socket is connected.

## 0.10.5

- macOS: the isolated supervisor and its Chrome for Testing now start in their own launchd process coalition instead of the caller's. Previously a browser started from a terminal pane shared the terminal multiplexer's coalition, so quitting Chrome from the Dock could stop the multiplexer and every session in it. If launchd refuses, the cause is logged once and the process starts directly as before. `status` and `doctor` report whether the live browser shares a coalition with the calling shell. Linux and Windows are unchanged.
