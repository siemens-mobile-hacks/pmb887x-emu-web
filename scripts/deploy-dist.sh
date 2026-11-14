#!/bin/bash
# Deploy a wasm64 qemu build into a page dist — the one deploy that
# build-qemu-wasm64.sh and ninja-fast.sh share:
#   - the engine files by temp name + rename: the server may be serving
#     the previous ones, and a plain cp can hand out a torn wasm
#   - no stale .gz sidecar, which serve.mjs would prefer over the new file
#   - qemu-source.txt, what tools/lockstep-wasm.mjs matches the native
#     reference against
#   - the two site/dist/ assets outside qemu's ninja graph, which the page
#     reads next to any dist: boards.tar and the Siemens key module
#
#   scripts/deploy-dist.sh <ninja build dir> <dist dir> <source id>
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$1"
DIST="$2"
SRC_ID="$3"

mkdir -p "$DIST"
for f in qemu-system-arm.js qemu-system-arm.wasm qemu-system-arm.worker.js \
         qemu-system-arm.wasm.map qemu-system-arm.js.symbols; do
  [ -f "$BUILD_DIR/$f" ] || continue
  cp "$BUILD_DIR/$f" "$DIST/.$f.tmp"
  mv -f "$DIST/.$f.tmp" "$DIST/$f"
done
rm -f "$DIST/qemu-system-arm.wasm.gz" "$DIST/qemu-system-arm.js.gz"
echo "$SRC_ID" > "$DIST/.qemu-source.txt.tmp"
mv -f "$DIST/.qemu-source.txt.tmp" "$DIST/qemu-source.txt"
bash "$WEB_DIR/scripts/pack-boards.sh"
bash "$WEB_DIR/scripts/build-recalc-wasm.sh"
