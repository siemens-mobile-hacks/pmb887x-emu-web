#!/bin/bash
# Fast incremental rebuild + deploy of the default wasm build
# (build/qemu-wasm64, the wasm64 TCG backend -> site/dist-jit).
# Skips the tree reset/patch/reconfigure that
# scripts/build-qemu.sh does; use it while iterating on files already
# committed on the qemu wasm-patches branch (qemu submodule).
#
# With no arguments: builds qemu-system-arm.js and DEPLOYS the emscripten
# artifacts to $WEB_DIST (default site/dist-jit/) so the
# next page load runs the
# new build — no manual cp, no stale-wasm traps (also drops stale .gz
# sidecars, which serve.mjs would otherwise prefer over the fresh file).
# With arguments they are passed to ninja verbatim and no deploy happens.
#
# Env:
#   VERBOSE=1   full ninja output (default: warnings + last lines + summary)
#   NO_DEPLOY=1 skip the dist/ deploy
#   GZ=1        also refresh the wasm .gz sidecar (slower deploy;
#               only worth it when serving to a phone over the LAN)
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${WEB_BUILD:-$WEB_DIR/build}"
DEPS_ROOT="${WASM_DEPS:-$BUILD/deps}"
TARGET="$DEPS_ROOT/target"
BUILD_DIR="$BUILD/qemu-wasm64"
DIST="${WEB_DIST:-$WEB_DIR/site/dist-jit}"

source "$DEPS_ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1
export PATH="$HOME/.local/bin:$PATH"
export CPATH="$TARGET/include"
export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"

cd "$BUILD_DIR"

T0=$SECONDS
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

if [ "${VERBOSE:-0}" = "1" ]; then
  ninja -j"$(nproc)" "$@" 
else
  if ! ninja -j"$(nproc)" "$@" >"$LOG" 2>&1; then
    cat "$LOG"
    echo "ninja-fast: BUILD FAILED" >&2
    exit 1
  fi
  grep -i "warning" "$LOG" | head -20 || true
  tail -2 "$LOG"
fi
BT=$((SECONDS - T0))

if [ $# -gt 0 ]; then
  echo "ninja-fast: ok (${BT}s, explicit targets — no deploy)"
  exit 0
fi
if [ "${NO_DEPLOY:-0}" = "1" ]; then
  echo "ninja-fast: ok (${BT}s, NO_DEPLOY=1)"
  exit 0
fi

mkdir -p "$DIST"
for f in qemu-system-arm.js qemu-system-arm.wasm qemu-system-arm.worker.js qemu-system-arm.wasm.map qemu-system-arm.js.symbols; do
  [ -f "$f" ] && cp -f "$f" "$DIST/"
done
rm -f "$DIST/qemu-system-arm.wasm.gz" "$DIST/qemu-system-arm.js.gz"
# board configs live outside the ninja graph (build/bsp), and the page always
# reads site/dist/boards.tar — repack on every deploy so iterating here can
# never run a fresh qemu against yesterday's board configs
bash "$WEB_DIR/scripts/pack-boards.sh"
# likewise the Siemens key module: it comes from the pmb887x-emu submodule,
# so a qemu-only rebuild would otherwise leave an old one next to a new dist
bash "$WEB_DIR/scripts/build-recalc-wasm.sh"
if [ "${GZ:-0}" = "1" ] && command -v gzip >/dev/null; then
  gzip -9 -k "$DIST/qemu-system-arm.wasm"
fi

WASM_MB="$(du -m "$DIST/qemu-system-arm.wasm" | cut -f1)"
echo "ninja-fast: ok + deployed to ${DIST#$(dirname "$DIST")/} (${BT}s, wasm ${WASM_MB} MB) — reload the page to pick it up"
