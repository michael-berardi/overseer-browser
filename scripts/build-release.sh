#!/bin/sh
# Builds the one-step release assets for the current commit into <out> (default dist/release):
#   overseer-browser.tar.gz   source bundle WITH the built extension (install.sh; no Node needed by users)
#   overseer-browser.zip      the same bundle for Windows (install.ps1)
#   install.sh, install.ps1   the one-step installers
#   SHA256SUMS                checksums of the four files above
# Building the extension needs Node.js and npm on the BUILD machine only.
# Usage: scripts/build-release.sh [out-dir]   (run from a clean checkout of the release tag)
set -eu
cd "$(dirname "$0")/.."
OUT="${1:-dist/release}"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "build-release: the working tree has changes; build from a clean checkout" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "build-release: Node.js and npm are required to build the extension" >&2; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "build-release: zip is required to build the Windows archive" >&2; exit 1; }
commit=$(git rev-parse HEAD)

echo "build-release: building the extension (npm ci + npm run build)"
# Build-time telemetry and registry audit/funding requests are disabled.
export DO_NOT_TRACK=1
export npm_config_audit=false
export npm_config_fund=false
npm ci --prefix extension
npm run build --prefix extension
[ -f extension/.output/chrome-mv3/manifest.json ] || { echo "build-release: the extension build did not produce extension/.output/chrome-mv3/manifest.json" >&2; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT"
case "$OUT" in /*) OUT_ABS="$OUT" ;; *) OUT_ABS="$(pwd)/$OUT" ;; esac
stage=$(mktemp -d "${TMPDIR:-/tmp}/overseer-browser-build.XXXXXX"); trap 'rm -rf "$stage"' EXIT
git archive --format=tar HEAD | tar -x -C "$stage"
mkdir -p "$stage/extension/.output"
cp -R extension/.output/chrome-mv3 "$stage/extension/.output/chrome-mv3"
printf '%s\n' "$commit" > "$stage/COMMIT"

# The checker and both installers already name the project's own repository;
# there is no owner substitution at build time. Fail loudly if a placeholder
# or an unrelated owner is shipped, since source installs use these files too.
for f in cli/update.py scripts/install.sh scripts/install.ps1; do
  if grep -q 'example-user' "$f"; then
    echo "build-release: $f still has the placeholder owner" >&2; exit 1
  fi
  if ! grep -q 'https://github.com/michael-berardi/overseer-browser' "$f"; then
    echo "build-release: $f does not name the project repository" >&2; exit 1
  fi
done

# Deterministic: sorted names, fixed owner and times (1980-01-01 is the zip epoch floor).
( cd "$stage" && find . -mindepth 1 | LC_ALL=C sort | sed 's|^\./||' > "$stage.list" )
( cd "$stage" && find . -mindepth 1 -exec touch -t 198001010000 {} + )
if tar --version 2>/dev/null | grep -qi gnu; then
  tar -C "$stage" --owner=0 --group=0 --numeric-owner --mtime=@0 --no-recursion -cf "$stage.tar" -T "$stage.list" && gzip -n -c "$stage.tar" > "$OUT/overseer-browser.tar.gz" && rm -f "$stage.tar"
else
  COPYFILE_DISABLE=1 tar -C "$stage" --uid 0 --gid 0 --uname root --gname root --no-xattrs --no-recursion -cf "$stage.tar" -T "$stage.list" && gzip -n -c "$stage.tar" > "$OUT/overseer-browser.tar.gz" && rm -f "$stage.tar"
fi
( cd "$stage" && zip -X -q "$OUT_ABS/overseer-browser.zip" -@ < "$stage.list" )
rm -f "$stage.list"
for f in install.sh install.ps1; do
  cp "scripts/$f" "$OUT/$f"
  chmod 755 "$OUT/$f"
done
echo "build-release: release URLs point at the project repository"
( cd "$OUT" && if command -v sha256sum >/dev/null 2>&1; then sha256sum overseer-browser.tar.gz overseer-browser.zip install.sh install.ps1; else shasum -a 256 overseer-browser.tar.gz overseer-browser.zip install.sh install.ps1; fi > SHA256SUMS )
echo "built $OUT for $commit"
ls -l "$OUT"