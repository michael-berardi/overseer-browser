#!/bin/bash
# Install/update/uninstall the local OverSeer Browser native host on macOS.
# Chrome's unmanaged-extension security confirmation is never bypassed.
set -euo pipefail

ACTION="${1:-status}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
APP_SUPPORT="${HOME:?HOME is required}/Library/Application Support/OverSeer/browser"
HOST_DIR="$APP_SUPPORT/native_host"
CLI_DIR="$APP_SUPPORT/cli"
CLI_MAIN="$CLI_DIR/main.py"
MANAGER_DIR="$APP_SUPPORT/scripts"
MANAGER_PATH="$MANAGER_DIR/manage-macos.sh"
SOURCE_ROOT_PATH="$APP_SUPPORT/source-root"
CLI_LAUNCHER_PATH="$APP_SUPPORT/cli-launcher-path"
HOST_PATH="$APP_SUPPORT/overseer-browser-native-host"
EXTENSION_DIR="$ROOT/chrome-extension"
DEFAULT_CLI_LAUNCHER="${OVERSEER_BROWSER_BIN_DIR:-$HOME/.local/bin}/overseer-browser"
CLI_LAUNCHER="$DEFAULT_CLI_LAUNCHER"
if [ -r "$CLI_LAUNCHER_PATH" ]; then
  saved_cli_launcher="$(cat "$CLI_LAUNCHER_PATH" 2>/dev/null || true)"
  [ -z "$saved_cli_launcher" ] || CLI_LAUNCHER="$saved_cli_launcher"
fi
CLI_FALLBACK="$CLI_DIR/overseer-browser"
TOKEN_PATH="$APP_SUPPORT/token"
MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.imploselabs.overseer_browser.json"
TESTING_MANIFEST="$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.imploselabs.overseer_browser.json"
CHROME_EXTENSIONS_PAGE="chrome://extensions"

say() { printf '%s\n' "$*"; }
fail() { printf 'overseer-browser: %s\n' "$*" >&2; exit 1; }


PYTHON="$("$PYTHON" -c 'import os,sys; print(os.path.realpath(sys.executable))')" ||
  fail "Python 3 is required to install the native host"
[ -x "$PYTHON" ] || fail "resolved Python interpreter is not executable"
private_setup() {
  umask 077
  mkdir -p "$APP_SUPPORT" "$HOST_DIR" "$CLI_DIR" "$MANAGER_DIR"
  chmod 700 "$APP_SUPPORT" "$HOST_DIR" "$CLI_DIR" "$MANAGER_DIR"
}
resolve_npm() {
  if [ -n "${NPM:-}" ] && command -v "$NPM" >/dev/null 2>&1; then
    command -v "$NPM"
    return
  fi
  if command -v npm >/dev/null 2>&1; then
    command -v npm
    return
  fi
  for candidate in \
    /opt/homebrew/opt/node@22/bin/npm \
    /opt/homebrew/opt/node/bin/npm \
    /usr/local/bin/npm
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}



build_extension() {
  [ -f "$ROOT/extension/package.json" ] ||
    fail "extension/package.json is missing"
  local npm_bin npm_path
  npm_bin="$(resolve_npm)" ||
    fail "Node.js and npm are required to build the extension"
  npm_path="$(dirname "$npm_bin"):${PATH:-/usr/bin:/bin}"
  say "Building extension"
  if [ -f "$ROOT/extension/package-lock.json" ]; then
    PATH="$npm_path" "$npm_bin" ci --prefix "$ROOT/extension"
  fi
  PATH="$npm_path" "$npm_bin" run build --prefix "$ROOT/extension"
  [ -f "$ROOT/extension/.output/chrome-mv3/manifest.json" ] ||
    fail "extension build did not produce .output/chrome-mv3/manifest.json"
  EXTENSION_SOURCE="$ROOT/extension/.output/chrome-mv3"

}


# Publish individual files by same-directory rename; readers never see partial bytes.
atomic_write() {
  "$PYTHON" -c 'import os,sys,tempfile
from pathlib import Path
p=Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True)
fd,t=tempfile.mkstemp(prefix=".publish-",dir=p.parent)
try:
 with os.fdopen(fd,"wb") as f: f.write(sys.stdin.buffer.read()); f.flush(); os.fsync(f.fileno())
 os.chmod(t,int(sys.argv[2],8)); os.replace(t,p)
finally:
 if os.path.exists(t): os.unlink(t)' "$1" "${2:-600}"
}

stage_runtime() {
  mkdir -p "$APP_SUPPORT/runtimes"
  STAGE="$(mktemp -d "$APP_SUPPORT/runtimes/.stage-XXXXXXXX")"
  trap 'if [ -n "${STAGE:-}" ]; then rm -rf "$STAGE"; fi' EXIT
  mkdir "$STAGE/native_host" "$STAGE/cli" "$STAGE/extension"
  for module in __init__ host protocol runtime isolation; do
    install -m 600 "$ROOT/native_host/$module.py" "$STAGE/native_host/$module.py"
  done
  for module in __init__ main runtime_discovery evidence recording dom_query temp_outputs; do
    install -m 600 "$ROOT/cli/$module.py" "$STAGE/cli/$module.py"
  done
  [ -f "$EXTENSION_SOURCE/manifest.json" ] || fail "Build the extension first: missing $EXTENSION_SOURCE/manifest.json"
  cp -R "$EXTENSION_SOURCE/." "$STAGE/extension/"
  # Isolated interpreter excludes checkout/PYTHONPATH; compile without leaving caches.
  "$PYTHON" -I -B - "$STAGE" "$HOST_PATH" <<'PYVALIDATE'
import importlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root))
for package in ('native_host', 'cli'):
    for path in (root / package).glob('*.py'):
        compile(path.read_bytes(), str(path), 'exec')
        importlib.import_module(package + '.' + path.stem)
manifest = json.loads((root / 'extension/manifest.json').read_text())
assert manifest.get('manifest_version') == 3, 'expected MV3 extension'
from native_host.runtime import native_manifest
(root / 'native-manifest.json').write_text(json.dumps(native_manifest(sys.argv[2]), indent=2))
PYVALIDATE
  RUNTIME="$APP_SUPPORT/runtimes/runtime-${STAGE##*.stage-}"
  mv "$STAGE" "$RUNTIME"
  STAGE=""
  HOST_DIR="$RUNTIME/native_host"
  CLI_MAIN="$RUNTIME/cli/main.py"
  EXTENSION_DIR="$RUNTIME/extension"
}

publish_manifest() {
  atomic_write "$1" <"$RUNTIME/native-manifest.json"
}

install_host() {
  stage_runtime
  atomic_write "$HOST_PATH" 700 <<EOF
#!/bin/sh
exec "$PYTHON" -I -B -c 'import runpy,sys; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module("native_host.host", run_name="__main__")' "$RUNTIME" "\$@"
EOF
  install_manager
  install_cli_launcher
  publish_manifest "$MANIFEST"
  publish_manifest "$TESTING_MANIFEST"
}


install_manager() {
  printf '%s\n' "$ROOT" | atomic_write "$SOURCE_ROOT_PATH"
  chmod 600 "$SOURCE_ROOT_PATH"
  atomic_write "$MANAGER_PATH" 700 <<'EOF'
#!/bin/sh
set -eu
action="${1:-status}"
app_support="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
host_path="$app_support/overseer-browser-native-host"
cli_dir="$app_support/cli"
cli_fallback="$cli_dir/overseer-browser"
default_cli_launcher="${OVERSEER_BROWSER_BIN_DIR:-$HOME/.local/bin}/overseer-browser"
cli_launcher_path_file="$app_support/cli-launcher-path"
cli_launcher="$default_cli_launcher"
if [ -r "$cli_launcher_path_file" ]; then
  saved_cli_launcher="$(cat "$cli_launcher_path_file" 2>/dev/null || true)"
  [ -z "$saved_cli_launcher" ] || cli_launcher="$saved_cli_launcher"
fi
manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.imploselabs.overseer_browser.json"
testing_manifest="$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.imploselabs.overseer_browser.json"
source_root_file="$app_support/source-root"

status() {
  host_state=missing
  manifest_state=missing
  cli_state=missing
  fallback_state=missing
  [ -x "$host_path" ] && host_state=installed
  [ -f "$manifest" ] && manifest_state=installed
  [ -x "$cli_fallback" ] && fallback_state=installed
  [ -x "$cli_launcher" ] && [ "$(sed -n '2p' "$cli_launcher" 2>/dev/null || true)" = "# OverSeer Browser managed launcher" ] && cli_state=installed
  [ "$fallback_state" = installed ] && cli_state=installed
  printf 'native host: %s\n' "$host_state"
  printf 'native manifest: %s\n' "$manifest_state"
  printf 'CLI launcher: %s (%s)\n' "$cli_state" "$cli_launcher"
  printf 'CLI fallback: %s (%s)\n' "$fallback_state" "$cli_fallback"
  [ "$host_state" = installed ] && [ "$manifest_state" = installed ] && [ "$cli_state" = installed ]
}

uninstall() {
  if [ -e "$cli_launcher" ] && [ "$(sed -n '2p' "$cli_launcher" 2>/dev/null || true)" = "# OverSeer Browser managed launcher" ]; then
    rm -f "$cli_launcher"
  elif [ -e "$cli_launcher" ]; then
    printf 'Preserved unrelated CLI launcher: %s\n' "$cli_launcher"
  fi
  rm -f "$manifest" "$testing_manifest" "$host_path" "$app_support/token" "$source_root_file" "$cli_launcher_path_file"
  rm -rf "$app_support/native_host" "$app_support/cli" "$app_support/scripts"
  printf 'Removed native host and manifest\n'
}

case "$action" in
  status) status ;;
  uninstall) uninstall ;;
  install|update)
    source_root="$(cat "$source_root_file" 2>/dev/null || true)"
    manager="$source_root/scripts/manage-macos.sh"
    [ -x "$manager" ] || { printf 'overseer-browser: source checkout is unavailable; reinstall from the public repository\n' >&2; exit 1; }
    exec "$manager" "$@"
    ;;
  *) printf 'usage: %s {install|update|uninstall|status}\n' "$0" >&2; exit 2 ;;
esac
EOF
  chmod 700 "$MANAGER_PATH"
}

install_cli_launcher() {
  atomic_write "$CLI_FALLBACK" 700 <<EOF
#!/bin/sh
# OverSeer Browser managed launcher
exec "$PYTHON" -I -B -c 'import runpy,sys; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module("cli.main", run_name="__main__")' "$RUNTIME" "\$@"
EOF
  chmod 700 "$CLI_FALLBACK"
  printf '%s\n' "$CLI_LAUNCHER" | atomic_write "$CLI_LAUNCHER_PATH"
  chmod 600 "$CLI_LAUNCHER_PATH"
  say "Executable fallback CLI: $CLI_FALLBACK"
  if ! mkdir -p "$(dirname "$CLI_LAUNCHER")" 2>/dev/null; then
    say "CLI launcher parent is unavailable; preserving preferred path: $CLI_LAUNCHER"
    return
  fi
  if [ -e "$CLI_LAUNCHER" ] && [ "$(sed -n '2p' "$CLI_LAUNCHER" 2>/dev/null || true)" != "# OverSeer Browser managed launcher" ]; then
    say "CLI launcher exists and is not managed; preserving it: $CLI_LAUNCHER"
    say "Use the executable fallback CLI: $CLI_FALLBACK"
    return
  fi
  if ! atomic_write "$CLI_LAUNCHER" 700 <<EOF
#!/bin/sh
# OverSeer Browser managed launcher
exec "$PYTHON" -I -B -c 'import runpy,sys; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module("cli.main", run_name="__main__")' "$RUNTIME" "\$@"
EOF
  then
    say "CLI launcher is unavailable; preserving preferred path: $CLI_LAUNCHER"
    return
  fi
  chmod 700 "$CLI_LAUNCHER"
}

reload_chrome() {
  say "Daily Chrome was not opened or reloaded. Start a dedicated instance with: overseer-browser sessions start"
  say "Load unpacked the NEW directory explicitly in chrome://extensions: $EXTENSION_DIR"
  say "Coordinate switching with session owners; existing loaded directories and running hosts are retained."
  say "Reconfirm extension connection/site permissions; Chrome does not follow a changed path automatically."
  say "Set OVERSEER_BROWSER_EXTENSION=$EXTENSION_DIR for the installed CLI."
  say "In dedicated Chrome for Testing only, enable the extension connection, site access and evaluation as needed."
}

status() {
  local host_state="missing" manifest_state="missing" cli_state="missing" fallback_state="missing"
  [ -x "$HOST_PATH" ] && host_state="installed"
  [ -f "$MANIFEST" ] && manifest_state="installed"
  [ -x "$CLI_FALLBACK" ] && fallback_state="installed"
  [ -x "$CLI_LAUNCHER" ] && [ "$(sed -n '2p' "$CLI_LAUNCHER" 2>/dev/null || true)" = "# OverSeer Browser managed launcher" ] && cli_state="installed"
  [ "$fallback_state" = installed ] && cli_state="installed"
  say "native host: $host_state"
  say "native manifest: $manifest_state"
  say "CLI launcher: $cli_state ($CLI_LAUNCHER)"
  say "CLI fallback: $fallback_state ($CLI_FALLBACK)"
  say "extension id: iabfdeokmilpklblkgccpjlekchfjcno"
  if [ "$cli_state" != installed ]; then
    say "Executable fallback CLI: $CLI_FALLBACK"
  fi
  [ "$host_state" = installed ] && [ "$manifest_state" = installed ] && [ "$cli_state" = installed ]
}

install_or_update() {
  private_setup
  build_extension
  install_host
  say "Installed $HOST_PATH"
  say "Native messaging manifest: $MANIFEST"
  say "Chrome for Testing native messaging manifest: $TESTING_MANIFEST"
  reload_chrome
}

uninstall() {
  if [ -e "$CLI_LAUNCHER" ] && [ "$(sed -n '2p' "$CLI_LAUNCHER" 2>/dev/null || true)" = "# OverSeer Browser managed launcher" ]; then
    rm -f "$CLI_LAUNCHER"
  elif [ -e "$CLI_LAUNCHER" ]; then
    say "Preserved unrelated CLI launcher: $CLI_LAUNCHER"
  fi
  rm -f "$MANIFEST" "$TESTING_MANIFEST" "$HOST_PATH" "$TOKEN_PATH" "$SOURCE_ROOT_PATH" "$CLI_LAUNCHER_PATH"
  rm -rf "$HOST_DIR" "$CLI_DIR" "$MANAGER_DIR"
  say "Removed native host and manifest"
  say "If Chrome still shows the extension, remove/reload it from $CHROME_EXTENSIONS_PAGE."
}

case "$ACTION" in
  install|update) install_or_update ;;
  uninstall) uninstall ;;
  status) status ;;
  *) fail "usage: $0 {install|update|uninstall|status}" ;;
esac
