# Changelog

## 0.10.5

- macOS: the isolated supervisor and its Chrome for Testing now start in their own launchd process coalition instead of the caller's. Previously a browser started from a terminal pane shared the terminal multiplexer's coalition, so quitting Chrome from the Dock could stop the multiplexer and every session in it. If launchd refuses, the cause is logged once and the process starts directly as before. `status` and `doctor` report whether the live browser shares a coalition with the calling shell. Linux and Windows are unchanged.
