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
CLI_FALLBACK="$APP_SUPPORT/overseer-browser"
CLI_MARKER="# OverSeer Browser managed launcher"
EXTENSION_DIR="$ROOT/chrome-extension"
EXTENSION_SOURCE="$ROOT/extension/.output/chrome-mv3"
[ -f "$EXTENSION_SOURCE/manifest.json" ] || EXTENSION_SOURCE="$EXTENSION_DIR"
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

# Retention: a run killed before its EXIT trap leaves staging and publish debris;
# sweep only what is older than an hour so a concurrent install is never disturbed.
prune_stale_staging() {
  find "$APP_SUPPORT/runtimes" -maxdepth 1 -name '.stage-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
  find "$APP_SUPPORT" -maxdepth 1 -name '.publish-*' -mmin +60 -exec rm -f {} + 2>/dev/null || true
}

# Each install stages a full immutable runtime copy. Keep the published copy and
# any copy still named by a launcher, manifest, or explicit runtime override; prune
# the rest only when every entry in it is at least 30 days old, so a recent or
# still-in-use copy survives an interrupted or in-flight rollout.
prune_old_runtimes() {
  local -a references=(
    "$HOST_PATH" "$CLI_FALLBACK" "$CLI_LAUNCHER"
    "${OVERSEER_BROWSER_RUNTIME:-}"
  )
  local browser_dir
  for browser_dir in google-chrome chromium BraveSoftware/Brave-Browser microsoft-edge; do
    references+=(
      "$CONFIG_HOME/$browser_dir/NativeMessagingHosts/com.paretocybernetics.overseer_browser.json"
      "$CONFIG_HOME/$browser_dir/NativeMessagingHosts/com.imploselabs.overseer_browser.json"
    )
  done
  "$PYTHON" -I - "$APP_SUPPORT/runtimes" "$RUNTIME" "${references[@]}" <<'PYPRUNE'
import os, re, shutil, sys, time
from pathlib import Path

root, current, *references = sys.argv[1:]
root = Path(root)
if not root.is_dir():
    raise SystemExit(0)
pattern = re.compile(re.escape(str(root)) + r'/runtime-[A-Za-z0-9_-]+')
protected = {os.path.realpath(current)}
for reference in references:
    if not reference:
        continue
    try:
        text = Path(reference).read_text(encoding='utf-8', errors='replace')
    except OSError:
        continue
    for match in pattern.finditer(text):
        protected.add(os.path.realpath(match.group(0)))
cutoff = time.time() - 30 * 24 * 60 * 60
for path in sorted(root.iterdir()):
    if path.is_symlink() or not path.is_dir() or not re.fullmatch(r'runtime-[A-Za-z0-9_-]+', path.name):
        continue
    if os.path.realpath(path) in protected:
        continue
    try:
        entries = [path, *path.rglob('*')]
        if any(entry.is_symlink() for entry in entries):
            continue
        if any(entry.stat().st_mtime > cutoff for entry in entries):
            continue
        shutil.rmtree(path)
        print(f'Pruned old runtime copy: {path}')
    except OSError as exc:
        print(f'overseer-browser: could not prune old runtime copy {path}: {exc}', file=sys.stderr)
PYPRUNE
}

stage_runtime() {
  mkdir -p "$APP_SUPPORT/runtimes"
  prune_stale_staging
  STAGE="$(mktemp -d "$APP_SUPPORT/runtimes/.stage-XXXXXXXX")"
  trap 'if [ -n "${STAGE:-}" ]; then rm -rf "$STAGE"; fi' EXIT
  mkdir "$STAGE/native_host" "$STAGE/cli" "$STAGE/extension"
  for module in __init__ host protocol runtime isolation coalition; do
    install -m 600 "$ROOT/native_host/$module.py" "$STAGE/native_host/$module.py"
  done
  for module in __init__ main internal_qa runtime_discovery evidence recording dom_query temp_outputs update; do
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
  prune_old_runtimes
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
  atomic_write "$CLI_FALLBACK" 700 <<EOF
#!/bin/sh
# OverSeer Browser managed launcher
exec "$PYTHON" -I -B -c 'import runpy,sys; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module("cli.main", run_name="__main__")' "$RUNTIME" "\$@"
EOF
  # Never overwrite a file this installer did not write.
  if [ -e "$CLI_LAUNCHER" ] && [ "$(sed -n '2p' "$CLI_LAUNCHER" 2>/dev/null || true)" != "$CLI_MARKER" ]; then
    say "CLI launcher exists and is not managed; preserving it: $CLI_LAUNCHER"
    say "Use the executable fallback CLI: $CLI_FALLBACK"
    return 0
  fi
  mkdir -p "$(dirname "$CLI_LAUNCHER")"
  atomic_write "$CLI_LAUNCHER" 700 <<EOF
#!/bin/sh
# OverSeer Browser managed launcher
exec "$PYTHON" -I -B -c 'import runpy,sys; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module("cli.main", run_name="__main__")' "$RUNTIME" "\$@"
EOF
}

# pareto-legacy: remove after 2027-08-23. Pre-rebrand native host name; install_manifests replaces and removes its manifests.
LEGACY_HOST_NAME="com.imploselabs.overseer_browser" # pareto-legacy

remove_legacy_manifest() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    rm -f "$1"
    say "Migrated native messaging host to com.paretocybernetics.overseer_browser; removed legacy manifest: $1"
  fi
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
    publish_manifest "$browser_dir/NativeMessagingHosts/com.paretocybernetics.overseer_browser.json"
    remove_legacy_manifest "$browser_dir/NativeMessagingHosts/$LEGACY_HOST_NAME.json"
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

say "Coordinate the NEW Load unpacked path with session owners and reconfirm connection/site permissions."
say "Old runtime/extension trees are retained; no running host is restarted or extension reloaded."
