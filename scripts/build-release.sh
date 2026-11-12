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
# The shipped sources keep a neutral placeholder owner (tests/test_neutrality.py); the released
# installers get the real GitHub owner/repo, from OVERSEER_BROWSER_RELEASE_REPO or the origin remote.
PLACEHOLDER="example-user/overseer-browser"
slug="${OVERSEER_BROWSER_RELEASE_REPO:-}"
if [ -z "$slug" ]; then
  slug=$(git remote get-url origin 2>/dev/null | sed -E -n 's#^(git@github\.com:|https://github\.com/)([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)$#\2/\3#p' | sed 's#\.git$##')
fi
printf '%s\n' "$slug" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' ||
  { echo "build-release: cannot tell the GitHub owner/repo; set OVERSEER_BROWSER_RELEASE_REPO=owner/repo (or add a GitHub origin remote)" >&2; exit 1; }
for f in install.sh install.ps1; do
  sed "s#$PLACEHOLDER#$slug#g" "scripts/$f" > "$OUT/$f"
  chmod 755 "$OUT/$f"
  grep -q "$PLACEHOLDER" "$OUT/$f" && { echo "build-release: $f still has the placeholder owner" >&2; exit 1; }
done
echo "build-release: release URLs point at github.com/$slug"
( cd "$OUT" && if command -v sha256sum >/dev/null 2>&1; then sha256sum overseer-browser.tar.gz overseer-browser.zip install.sh install.ps1; else shasum -a 256 overseer-browser.tar.gz overseer-browser.zip install.sh install.ps1; fi > SHA256SUMS )
echo "built $OUT for $commit"
ls -l "$OUT"