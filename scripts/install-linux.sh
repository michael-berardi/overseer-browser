#!/bin/bash
# Install/update the local OverSeer Browser native host on Linux.
# Chrome's unmanaged-extension security confirmation is never bypassed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
# Installed code must be persistent: XDG_RUNTIME_DIR is a tmpfs wiped at
# logout, so only the runtime socket/token live there (runtime.py owns that
# directory); the host, CLI copy, and manifest targets install here.
APP_SUPPORT="${XDG_DATA_HOME:-$HOME/.local/share}/overseer-browser"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
HOST_DIR="$APP_SUPPORT/native_host"
CLI_DIR="$APP_SUPPORT/cli"
HOST_PATH="$APP_SUPPORT/overseer-browser-native-host"
CLI_LAUNCHER="${OVERSEER_BROWSER_BIN_DIR:-$HOME/.local/bin}/overseer-browser"
EXTENSION_DIR="$ROOT/chrome-extension"
GENERATE_MANIFEST="$ROOT/scripts/generate_manifest.py"

say() { printf '%s\n' "$*"; }
fail() { printf 'overseer-browser: %s\n' "$*" >&2; exit 1; }

PYTHON="$("$PYTHON" -c 'import os,sys; print(os.path.realpath(sys.executable))')" ||
  fail "Python 3 is required to install the native host"
[ -x "$PYTHON" ] || fail "resolved Python interpreter is not executable"

private_setup() {
  umask 077
  mkdir -p "$APP_SUPPORT" "$HOST_DIR" "$CLI_DIR"
  chmod 700 "$APP_SUPPORT" "$HOST_DIR" "$CLI_DIR"
}

install_host() {
  install -m 600 "$ROOT/native_host/protocol.py" "$HOST_DIR/protocol.py"
  install -m 600 "$ROOT/native_host/runtime.py" "$HOST_DIR/runtime.py"
  install -m 600 "$ROOT/native_host/__init__.py" "$HOST_DIR/__init__.py"
  install -m 700 "$ROOT/native_host/host.py" "$HOST_DIR/host.py"
  install -m 600 "$ROOT/cli/__init__.py" "$CLI_DIR/__init__.py"
  install -m 700 "$ROOT/cli/main.py" "$CLI_DIR/main.py"
  cat >"$HOST_PATH" <<EOF
#!/bin/sh
exec "$PYTHON" "$HOST_DIR/host.py" "\$@"
EOF
  chmod 700 "$HOST_PATH"
  cli_bin="$(dirname "$CLI_LAUNCHER")"
  mkdir -p "$cli_bin"
  cat >"$CLI_LAUNCHER" <<EOF
#!/bin/sh
exec "$PYTHON" "$CLI_DIR/main.py" "\$@"
EOF
  chmod 700 "$CLI_LAUNCHER"
}

install_manifests() {
  for browser_dir in \
    "$CONFIG_HOME/google-chrome" \
    "$CONFIG_HOME/chromium" \
    "$CONFIG_HOME/BraveSoftware/Brave-Browser" \
    "$CONFIG_HOME/microsoft-edge"
  do
    mkdir -p "$browser_dir/NativeMessagingHosts"
    chmod 700 "$browser_dir/NativeMessagingHosts"
    "$PYTHON" "$GENERATE_MANIFEST" \
      "$browser_dir/NativeMessagingHosts/com.imploselabs.overseer_browser.json" "$HOST_PATH"
  done
}

private_setup
install_host
install_manifests

say "Load unpacked extension directory: $EXTENSION_DIR"
say "Native host launcher: $HOST_PATH"
say "CLI launcher: $CLI_LAUNCHER"
say "The extension is loaded and reloaded manually: open your browser's extensions page"
say "(e.g. chrome://extensions), enable Developer mode, and load/unload the unpacked"
say "directory above yourself."
