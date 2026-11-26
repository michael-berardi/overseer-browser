# Installation and updates

[Back to README](../README.md)

## Requirements

- macOS, Linux, or Windows 10 1803+.
- [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)
  for the default isolated agent browser. On macOS the CLI looks for
  `/Applications/Google Chrome for Testing.app`; set `OVERSEER_BROWSER_CHROME`
  to use another location. The dedicated-browser lifecycle supports macOS and
  Linux.
- Node.js and npm only for the manual source route below (the one-step
  installer ships the extension already built, so users need no Node).
- Python 3.9 or newer for the native host and CLI.
- Any Chromium-family browser (Chrome, Edge, Brave, Chromium) if you also want
  to lend tabs from your everyday browser.

Automatic media cleanup and recording export need POSIX file locking, so they
are available on macOS and Linux only. On Windows they fail with an explicit
error rather than leaving temporary data behind.

## Install

### Release bundles

Release bundles include the built extension and do not need Node.

macOS and Linux:

```sh
curl -fsSL https://github.com/michael-berardi/overseer-browser/releases/latest/download/install.sh | sh
```

Windows (PowerShell 5.1 or 7; Windows 10 1803+ is experimental):

```powershell
irm https://github.com/michael-berardi/overseer-browser/releases/latest/download/install.ps1 | iex
```

The installer downloads the release bundle (`overseer-browser.tar.gz`, or
`overseer-browser.zip` on Windows) with the extension already built, verifies
its SHA-256 against `SHA256SUMS` before installing anything, unpacks it into a
versioned folder under `~/.overseer-browser` (`%LOCALAPPDATA%\OverSeerBrowser`
on Windows), and runs the platform installer from there. That registers the
per-user native host and puts `overseer-browser` in `~/.local/bin` (a `.cmd`
shim in the tool's `bin` folder on Windows, added to your user PATH). It needs
Python 3.9+ and says exactly how to install it when missing; it never uses
sudo and never edits shell profiles. It finishes with a version check and
prints the one manual step it cannot do for you: open `chrome://extensions`,
enable Developer mode, click **Load unpacked** and select the printed
`~/.overseer-browser/extension` folder (the dedicated agent browser loads the
extension by itself; this step is for your everyday Chrome).

Update by re-running the same one-liner (`overseer-browser update` does this for
release installs). Each update keeps the previous verified release in
`<install>/rollback/previous`; `overseer-browser update --rollback` restores it.
An anonymous, at-most-daily release check and its opt-outs are described in
[Updates](updates.md). Remove by deleting the tool folder
(`~/.overseer-browser` or `%LOCALAPPDATA%\OverSeerBrowser`), the
`overseer-browser` shim in your bin folder, and the native host entries the
installer printed; then remove the extension from `chrome://extensions`.
Overrides for tests and pins: `OVERSEER_BROWSER_HOME`, `OVERSEER_BROWSER_BIN_DIR`,
`OVERSEER_BROWSER_VERSION`, `OVERSEER_BROWSER_RELEASE_BASE`.

### macOS from source

```sh
git clone https://github.com/michael-berardi/overseer-browser.git
cd overseer-browser
./scripts/manage-macos.sh install
overseer-browser status
```

The installer builds the extension, stages it, and registers a per-user native
host and the `overseer-browser` CLI. It never opens or reloads your everyday
Chrome.

To update, pull, rerun the installer's update step, and move the extension
Chrome already loaded to the new version (Chrome's Reload button only rereads
the folder it loaded from), then have the extension reload itself:

```sh
git pull --ff-only
overseer-browser update
overseer-browser refresh-extension   # refuses while agent sessions are active
overseer-browser --session default extension reload
```

`extension reload` needs 0.9.2 or later already loaded; an older loaded
extension needs one Reload click in `chrome://extensions`. The extension
reconnects to the native host on its own within seconds.

`overseer-browser status` reports `extension_update` when the loaded extension
is older than the installed CLI.

`overseer-browser uninstall` removes the native host and CLI; remove the
extension from `chrome://extensions` yourself.

### Linux from source

```sh
git clone https://github.com/michael-berardi/overseer-browser.git
cd overseer-browser
npm ci --prefix extension && npm run build --prefix extension
./scripts/install-linux.sh
```

The script registers the native host and CLI for Chrome, Chromium, Brave and
Edge. After `git pull --ff-only`, rebuild the extension and rerun the installer to update.
Load the new extension directory printed by the installer; old runtime trees are retained.

### Windows from source (experimental)

```powershell
git clone https://github.com/michael-berardi/overseer-browser.git
cd overseer-browser
npm ci --prefix extension; npm run build --prefix extension
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

The installer copies the host and CLI into `%LOCALAPPDATA%\OverSeer\browser`
and registers the native host under HKCU for Chrome, Edge and Brave. Load the
extension directory printed by the installer from `chrome://extensions` (Developer mode
→ **Load unpacked**).


### Long runtime paths

Unix sockets have a platform-specific path limit (103 bytes on macOS, 107 on
Linux). If the host reports that its socket path is too long, set
`OVERSEER_BROWSER_RUNTIME` to a shorter, private directory for both the CLI and
the native host. This also applies to unusually long home directories.
