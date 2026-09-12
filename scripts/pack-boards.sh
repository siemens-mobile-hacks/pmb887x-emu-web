#!/bin/bash
# Pack the bsp board configs into site/dist/boards.tar.
#
# That is the ONLY copy the page reads: site/app.js fetches "dist/boards.tar"
# unconditionally, whatever ?dist= selects, and feeds it both the device list
# and preRun's untar.  Keeping the pack in one script lets every path that
# deploys a build refresh it (scripts/build-qemu.sh, scripts/ninja-fast.sh),
# so an incremental rebuild can no longer leave a board config behind — a
# stale tar silently reverts board settings such as [rtc] format to their
# defaults, which looks exactly like the qemu-side fix having regressed.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${WEB_BUILD:-$WEB_DIR/build}"
DIST="$WEB_DIR/site/dist"
BOARDS="$BUILD/bsp/lib/data/board"

if [ ! -d "$BOARDS" ]; then
  echo "pack-boards: no bsp checkout at $BOARDS — run scripts/sync-bsp.sh" >&2
  exit 1
fi

mkdir -p "$DIST"
# atomic: serve.mjs may be serving the previous tar
tar -cf "$DIST/.boards.tar.tmp" -C "$BOARDS" .
mv -f "$DIST/.boards.tar.tmp" "$DIST/boards.tar"

# Per-dist copies are never fetched; an old one next to a build is a trap
# for anyone reading the tree, so drop them as we refresh the real one.
for stale in "$WEB_DIR"/site/dist-jit/boards.tar; do
  [ -f "$stale" ] && rm -f "$stale"
done

echo "pack-boards: site/dist/boards.tar <- $(basename "$BOARDS") ($(tar tf "$DIST/boards.tar" | grep -c '\.toml$') configs)"
