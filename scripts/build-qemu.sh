#!/bin/bash
# Build qemu-system-arm (pmb887x) as WebAssembly + assemble dist.
#
# Uses the qemu submodule at the pinned rev (the series branch — all
# patches committed there), then builds:
# the wasm64 TCG backend -> site/dist-jit/, plus site/dist/boards.tar
# (board configs from bsp; the page always fetches it from dist/).
# site/ is served directly by serve.mjs — nothing is copied for it.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$WEB_DIR/versions.env"

BUILD="${WEB_BUILD:-$WEB_DIR/build}"
DEPS_ROOT="${WASM_DEPS:-$BUILD/deps}"
TARGET="$DEPS_ROOT/target"
DIST="$WEB_DIR/site/dist"
mkdir -p "$BUILD" "$DIST"

source "$DEPS_ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1
export PATH="$HOME/.local/bin:$PATH"
export CPATH="$TARGET/include"
export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"

# --- qemu source: qemu submodule (patches committed on the
# wasm-patches branch, see versions.env) ---
QEMU_SRC="$WEB_DIR/qemu"
# init only the top-level submodules (not pmb887x-emu's nested qemu) and
# move qemu to the pin (a detached HEAD elsewhere is moved, not an error)
git -C "$WEB_DIR" submodule update --init
if [ "$(git -C "$QEMU_SRC" rev-parse HEAD)" != "$QEMU_PMB887X_REV" ]; then
  git -C "$QEMU_SRC" checkout -q -B "$QEMU_PMB887X_BRANCH" "$QEMU_PMB887X_REV" 2>/dev/null \
    || git -C "$QEMU_SRC" checkout -q -f "$QEMU_PMB887X_REV"
fi

# --- board configs from bsp (pinned rev) ---
bash "$WEB_DIR/scripts/sync-bsp.sh"
bash "$WEB_DIR/scripts/pack-boards.sh"

# --- the Siemens key module the Firmware panel drives (site/dist/) ---
bash "$WEB_DIR/scripts/build-recalc-wasm.sh"

# --- build: wasm64 TCG backend (site/dist-jit/, the page default) ---
bash "$WEB_DIR/scripts/build-qemu-wasm64.sh"

echo "=== web dist ready: $WEB_DIR/site/dist-jit ==="
