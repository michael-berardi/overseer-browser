#!/bin/sh
# OverSeer Browser one-step installer for macOS and Linux:
#   curl -fsSL https://github.com/michael-berardi/overseer-browser/releases/latest/download/install.sh | sh
# Downloads the release bundle (source plus the ALREADY BUILT extension, so no Node is needed),
# checks its SHA-256 before anything is installed, unpacks it into a versioned folder under
# $OVERSEER_BROWSER_HOME (default ~/.overseer-browser), then runs the repo's own platform installer
# (scripts/manage-macos.sh on macOS, scripts/install-linux.sh on Linux) from there. That installer
# registers the per-user native host and puts `overseer-browser` in $OVERSEER_BROWSER_BIN_DIR
# (default ~/.local/bin). No sudo, no shell-profile edits; re-running upgrades in place.
# Local writes are disposable: the download temp folder is removed on exit, leftovers of a killed
# run are swept by the next install, and the retained previous release is deleted once the newly
# installed release passes its start check.
# Environment: OVERSEER_BROWSER_HOME, OVERSEER_BROWSER_BIN_DIR, OVERSEER_BROWSER_VERSION (pin, e.g. 0.10.3),
# OVERSEER_BROWSER_RELEASE_BASE (override the download base URL, used by tests; file:// works).
set -eu

# The project's own repository is the default; operators can mirror releases by
# setting OVERSEER_BROWSER_RELEASE_REPO.
CANONICAL_REPO_URL="https://github.com/michael-berardi/overseer-browser"
REPO="${OVERSEER_BROWSER_RELEASE_REPO:-${CANONICAL_REPO_URL#https://github.com/}}"
HOME_DIR="${OVERSEER_BROWSER_HOME:-$HOME/.overseer-browser}"
case "$HOME_DIR" in /*) ;; *) HOME_DIR="$(pwd)/$HOME_DIR" ;; esac
BIN_DIR="${OVERSEER_BROWSER_BIN_DIR:-$HOME/.local/bin}"
case "$BIN_DIR" in /*) ;; *) BIN_DIR="$(pwd)/$BIN_DIR" ;; esac
if [ -n "${OVERSEER_BROWSER_RELEASE_BASE:-}" ]; then BASE="$OVERSEER_BROWSER_RELEASE_BASE"
elif [ -n "${OVERSEER_BROWSER_VERSION:-}" ]; then BASE="https://github.com/$REPO/releases/download/v${OVERSEER_BROWSER_VERSION#v}"
else BASE="https://github.com/$REPO/releases/latest/download"; fi

say() { printf '%s\n' "$*"; }
die() { printf 'overseer-browser install: %s\n' "$*" >&2; exit 1; }

MODE="${1:-install}"
case "$MODE" in
  install|--install) MODE=install ;;
  rollback|--rollback) MODE=rollback ;;
  *) printf 'usage: install.sh [install|--rollback]\n' >&2; exit 2 ;;
esac

# Retention bounds for this installer's own local writes. Only debris older
# than these bounds is swept, so a concurrent install is never disturbed.
INSTALL_TEMP_MAX_AGE_MINUTES=360
STAGING_MAX_AGE_MINUTES=60

# Older than N minutes? Keeps fresh debris a concurrent installer may still own.
older_than() {
  [ -n "$(find "$1" -maxdepth 0 -mmin +"$2" 2>/dev/null)" ]
}

# Bounded retention: a run killed before its EXIT trap leaves its download and
# staging debris behind, so the next install sweeps the stale copies.
sweep_install_debris() {
  for stale in "${TMPDIR:-/tmp}"/overseer-browser-install.*; do
    [ -d "$stale" ] && [ ! -L "$stale" ] || continue
    older_than "$stale" "$INSTALL_TEMP_MAX_AGE_MINUTES" || continue
    if rm -rf "$stale" 2>/dev/null; then say "Removed stale installer temp folder: $stale"; fi
  done
  for stale in "$HOME_DIR/extension.tmp" "$HOME_DIR"/releases/*.tmp "$HOME_DIR/rollback/.restoring"; do
    [ -e "$stale" ] && [ ! -L "$stale" ] || continue
    older_than "$stale" "$STAGING_MAX_AGE_MINUTES" || continue
    if rm -rf "$stale" 2>/dev/null; then say "Removed stale install staging folder: $stale"; fi
  done
  case "$(uname -s)" in
    Darwin) app_support="$HOME/Library/Application Support/OverSeer/browser" ;;
    *) app_support="${XDG_DATA_HOME:-$HOME/.local/share}/overseer-browser" ;;
  esac
  for stale in "$app_support"/runtimes/.stage-*; do
    [ -e "$stale" ] && [ ! -L "$stale" ] || continue
    older_than "$stale" "$STAGING_MAX_AGE_MINUTES" || continue
    if rm -rf "$stale" 2>/dev/null; then say "Removed stale runtime staging folder: $stale"; fi
  done
  for stale in "$app_support"/.publish-*; do
    [ -f "$stale" ] && [ ! -L "$stale" ] || continue
    older_than "$stale" "$STAGING_MAX_AGE_MINUTES" || continue
    if rm -f "$stale" 2>/dev/null; then say "Removed stale publish temp file: $stale"; fi
  done
}

# The retained previous release is a recovery copy for a failed update, not
# durable state, so it goes as soon as the new release runs.
drop_previous_release() {
  [ -e "$HOME_DIR/rollback/previous" ] || return 0
  if [ -L "$HOME_DIR/rollback/previous" ]; then
    say "Left the unexpected symlink at $HOME_DIR/rollback/previous alone; remove it manually"
    return 0
  fi
  rm -rf "$HOME_DIR/rollback/previous" || die "cannot delete the retained previous release"
  rmdir "$HOME_DIR/rollback" 2>/dev/null || true
  say "Removed the retained previous release: it is kept only until an update proves it starts"
}

# Keep one previous release for `overseer-browser update --rollback`.
preserve_previous() {
  for d in "$HOME_DIR"/releases/release-*; do
    [ -d "$d" ] || continue
    mkdir -p "$HOME_DIR/rollback" || die "cannot create the rollback directory"
    rm -rf "$HOME_DIR/rollback/previous"
    mv "$d" "$HOME_DIR/rollback/previous" || die "cannot keep the previous release for rollback"
    say "Previous release staged at $HOME_DIR/rollback/previous for: overseer-browser update --rollback (removed once this update verifies)"
    break
  done
}

# Atomically stage a verified tree, register it, and point the stable paths at it.
finalize_install() {
  rel="$1"; version="$2"; source_dir="$3"
  say "Installing OverSeer Browser $version into $rel..."
  mkdir -p "$HOME_DIR/releases" "$BIN_DIR" || die "cannot create the install directories"
  chmod 700 "$HOME_DIR" 2>/dev/null || true
  rm -rf "$rel.tmp"
  mv "$source_dir" "$rel.tmp" || die "cannot stage the release"
  rm -rf "$rel"
  mv "$rel.tmp" "$rel" || die "cannot swap in the release"

  # The repo's own platform installer registers the native host and the CLI launcher.
  # The bundle already contains the built extension, so Node is not needed.
  export OVERSEER_BROWSER_BIN_DIR="$BIN_DIR"
  if [ "$(uname -s)" = Darwin ]; then
    OVERSEER_BROWSER_PREBUILT_EXTENSION=1 bash "$rel/scripts/manage-macos.sh" install ||
      die "the macOS platform installer failed (see its error above); the native host was not registered"
  else
    bash "$rel/scripts/install-linux.sh" ||
      die "the Linux platform installer failed (see its error above); the native host was not registered"
  fi

  # One stable extension folder survives upgrades, so Chrome's Load unpacked path never changes.
  rm -rf "$HOME_DIR/extension.tmp"
  cp -R "$rel/extension/.output/chrome-mv3" "$HOME_DIR/extension.tmp" || die "cannot stage the extension"
  rm -rf "$HOME_DIR/extension"
  mv "$HOME_DIR/extension.tmp" "$HOME_DIR/extension"

  # Keep only the release that is installed now (the rollback copy lives elsewhere).
  for d in "$HOME_DIR"/releases/release-*; do
    [ -d "$d" ] || continue
    [ "$d" = "$rel" ] || rm -rf "$d"
  done

  CLI="$BIN_DIR/overseer-browser"
  if [ -e "$CLI" ] && [ "$(sed -n '2p' "$CLI" 2>/dev/null || true)" != "# OverSeer Browser managed launcher" ]; then
    # An unrelated command already owns that name; the platform installer left it alone.
    if [ "$(uname -s)" = Darwin ]; then CLI="$HOME/Library/Application Support/OverSeer/browser/cli/overseer-browser"
    else CLI="${XDG_DATA_HOME:-$HOME/.local/share}/overseer-browser/overseer-browser"; fi
    say "Note: $BIN_DIR/overseer-browser is not ours and was left alone; use $CLI instead."
  fi
  [ -x "$CLI" ] || die "the platform installer did not leave an executable CLI at $CLI"
  GOT=$("$CLI" --version 2>&1) || die "the installed CLI does not run: $GOT"
  case "$GOT" in *"\"cli_version\":\"$version\""*) ;; *) die "the installed CLI reports '$GOT', not $version" ;; esac
  say "Version check passed: $GOT"
  say "Local health (the extension is not loaded in a browser yet, so 'ok' stays false until it is):"
  "$CLI" health || true
  # The new release starts, so the recovery copy is no longer needed.
  drop_previous_release

  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
  say ""
  say "OverSeer Browser $version installed. One manual step remains (a browser action no script can do):"
  say "  Open chrome://extensions, enable Developer mode, click 'Load unpacked' and select this folder:"
  say "  $HOME_DIR/extension"
  say "The dedicated agent browser loads the extension by itself; the manual step is for your everyday Chrome."
  say "Next: overseer-browser sessions start"
  say "Remove by deleting $HOME_DIR and $CLI (plus the native host entries the platform installer printed above)."
}

rollback_install() {
  previous="$HOME_DIR/rollback/previous"
  [ -f "$previous/cli/main.py" ] || die "no previous release is kept; nothing to roll back (a successful update deletes the copy)"
  version=$(sed -n 's/^CLI_VERSION = "\([^"]*\)".*/\1/p' "$previous/cli/main.py" | head -n 1)
  [ -n "$version" ] || die "the kept release has no readable CLI version"
  [ -d "$previous/extension/.output/chrome-mv3" ] || die "the kept release has no built extension"
  mv "$previous" "$HOME_DIR/rollback/.restoring" || die "cannot stage the rollback"
  finalize_install "$HOME_DIR/releases/release-$version" "$version" "$HOME_DIR/rollback/.restoring"
  say "Rolled back to OverSeer Browser $version."
}

main() {
  command -v tar >/dev/null 2>&1 || die "needs tar; install it with your package manager, then run this again"
  command -v bash >/dev/null 2>&1 || die "needs bash (the platform installer is a bash script); install it with your package manager, then run this again"
  if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"; }
  elif command -v wget >/dev/null 2>&1; then fetch() { wget -q -O "$2" "$1" || die "download failed: $1"; }
  else die "needs curl or wget; install one with your package manager, then run this again"; fi
  if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else die "needs sha256sum or shasum to verify the download"; fi

  # Python 3.9+ runs the native host and CLI. Never install a system Python here.
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
    :
  else
    case "$(uname -s)" in
      Darwin) die "Python 3.9 or newer is required and was not found; install it with: brew install python3 (then run this again)" ;;
      Linux) die "Python 3.9 or newer is required and was not found; install it with: sudo apt-get install -y python3 (or your distribution's equivalent, then run this again)" ;;
      *) die "Python 3.9 or newer is required and was not found; install it, then run this again" ;;
    esac
  fi

  case "$(uname -s)" in
    Darwin) PLATFORM=macos ;;
    Linux) PLATFORM=linux ;;
    *) die "unsupported system $(uname -s); on Windows use install.ps1" ;;
  esac

  sweep_install_debris
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/overseer-browser-install.XXXXXX") || die "cannot create a temporary folder"
  trap 'rm -rf "$TMP"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # expect <file> <name> <sums-file>: the file's SHA-256 must equal the line for <name>.
  expect() {
    want=$(awk -v n="$2" '{ f=$2; sub(/^\*/, "", f); if (f == n) print $1 }' "$3")
    [ -n "$want" ] || die "no checksum for $2 in $(basename "$3")"
    [ "$(sha256 "$1")" = "$want" ] || die "checksum mismatch for $2; the download is corrupted or tampered with; nothing was installed"
  }

  say "Downloading OverSeer Browser..."
  fetch "$BASE/overseer-browser.tar.gz" "$TMP/overseer-browser.tar.gz"
  fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS"
  expect "$TMP/overseer-browser.tar.gz" overseer-browser.tar.gz "$TMP/SHA256SUMS"
  mkdir "$TMP/src"
  tar -xzf "$TMP/overseer-browser.tar.gz" -C "$TMP/src" || die "cannot unpack the download"
  [ -f "$TMP/src/cli/main.py" ] && [ -f "$TMP/src/native_host/host.py" ] &&
    [ -f "$TMP/src/extension/.output/chrome-mv3/manifest.json" ] ||
    die "the download is not an OverSeer Browser release bundle (built extension or host code is missing)"
  VERSION=$(sed -n 's/^CLI_VERSION = "\([^"]*\)".*/\1/p' "$TMP/src/cli/main.py" | head -n 1)
  [ -n "$VERSION" ] || die "cannot read the release version from cli/main.py"
  REL="$HOME_DIR/releases/release-$VERSION"

  preserve_previous
  finalize_install "$REL" "$VERSION" "$TMP/src"
}

if [ "${OSR_INSTALLER_LIB:-}" = 1 ]; then
  : # sourced by tests: functions only, no install or network
else
  case "$MODE" in
    install) main ;;
    rollback) rollback_install ;;
  esac
fi