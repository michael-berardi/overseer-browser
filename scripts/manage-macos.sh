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
DEFAULT_CLI_LAUNCHER="${OVERSEER_BROWSER_BIN_DIR:-$HOME/.local/bin}/overseer-browser"
CLI_LAUNCHER="$DEFAULT_CLI_LAUNCHER"
if [ -r "$CLI_LAUNCHER_PATH" ]; then
  saved_cli_launcher="$(cat "$CLI_LAUNCHER_PATH" 2>/dev/null || true)"
  [ -z "$saved_cli_launcher" ] || CLI_LAUNCHER="$saved_cli_launcher"
fi
CLI_FALLBACK="$CLI_DIR/overseer-browser"
TOKEN_PATH="$APP_SUPPORT/token"
MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.imploselabs.overseer_browser.json"
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
}


install_host() {
  install -m 600 "$ROOT/native_host/protocol.py" "$HOST_DIR/protocol.py"
  install -m 600 "$ROOT/native_host/runtime.py" "$HOST_DIR/runtime.py"
  install -m 700 "$ROOT/native_host/host.py" "$HOST_DIR/host.py"
  install -m 600 "$ROOT/cli/__init__.py" "$CLI_DIR/__init__.py"
  install -m 600 "$ROOT/cli/main.py" "$CLI_MAIN"
  install -m 700 "$ROOT/native_host/__init__.py" "$HOST_DIR/__init__.py"
  cat >"$HOST_PATH" <<EOF
#!/bin/sh
exec "$PYTHON" "$HOST_DIR/host.py" "\$@"
EOF
  chmod 700 "$HOST_PATH"
  install_manager
  install_cli_launcher
  "$PYTHON" "$ROOT/scripts/generate_manifest.py" "$MANIFEST" "$HOST_PATH"
}


install_manager() {
  printf '%s\n' "$ROOT" >"$SOURCE_ROOT_PATH"
  chmod 600 "$SOURCE_ROOT_PATH"
  cat >"$MANAGER_PATH" <<'EOF'
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
  rm -f "$manifest" "$host_path" "$app_support/token" "$source_root_file" "$cli_launcher_path_file"
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
  cat >"$CLI_FALLBACK" <<EOF
#!/bin/sh
# OverSeer Browser managed launcher
exec "$PYTHON" "$CLI_MAIN" "\$@"
EOF
  chmod 700 "$CLI_FALLBACK"
  printf '%s\n' "$CLI_LAUNCHER" >"$CLI_LAUNCHER_PATH"
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
  if ! cat >"$CLI_LAUNCHER" <<EOF
#!/bin/sh
# OverSeer Browser managed launcher
exec "$PYTHON" "$CLI_MAIN" "\$@"
EOF
  then
    say "CLI launcher is unavailable; preserving preferred path: $CLI_LAUNCHER"
    return
  fi
  chmod 700 "$CLI_LAUNCHER"
}

reload_chrome() {
  if command -v open >/dev/null 2>&1; then
    # Opening this page is the maximum safe automation for unmanaged Chrome.
    open -a "Google Chrome" "$CHROME_EXTENSIONS_PAGE" >/dev/null 2>&1 || true
    say "Chrome extensions page opened. Confirm the extension's reload/load action in Chrome; unmanaged Chrome security confirmation cannot be bypassed."
  else
    say "Open $CHROME_EXTENSIONS_PAGE and confirm the extension's reload/load action; unmanaged Chrome security confirmation cannot be bypassed."
  fi
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
  reload_chrome
}

uninstall() {
  if [ -e "$CLI_LAUNCHER" ] && [ "$(sed -n '2p' "$CLI_LAUNCHER" 2>/dev/null || true)" = "# OverSeer Browser managed launcher" ]; then
    rm -f "$CLI_LAUNCHER"
  elif [ -e "$CLI_LAUNCHER" ]; then
    say "Preserved unrelated CLI launcher: $CLI_LAUNCHER"
  fi
  rm -f "$MANIFEST" "$HOST_PATH" "$TOKEN_PATH" "$SOURCE_ROOT_PATH" "$CLI_LAUNCHER_PATH"
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
