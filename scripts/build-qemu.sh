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
# versions.env pins an abbreviated hash, so compare full hashes: a short
# pin never equals `rev-parse HEAD`, and the checkout below then ran on every
# build; two concurrent gate builds raced on index.lock and the loser's
# `checkout -f` fallback wiped uncommitted qemu edits (2026-09-24).
PIN="$(git -C "$QEMU_SRC" rev-parse --verify -q "$QEMU_PMB887X_REV^{commit}")"
if [ "$(git -C "$QEMU_SRC" rev-parse HEAD)" != "$PIN" ]; then
  git -C "$QEMU_SRC" checkout -q -B "$QEMU_PMB887X_BRANCH" "$PIN" 2>/dev/null \
    || { git -C "$QEMU_SRC" diff --quiet HEAD \
          || { echo "$(basename "$0"): qemu/ has uncommitted changes and is not at the pin $QEMU_PMB887X_REV; refusing to force a checkout" >&2; exit 1; }
        git -C "$QEMU_SRC" checkout -q -f "$PIN"; }
fi

# --- board configs from bsp (pinned rev) ---
bash "$WEB_DIR/scripts/sync-bsp.sh"
bash "$WEB_DIR/scripts/pack-boards.sh"

# --- the Siemens key module the Firmware panel drives (site/dist/) ---
bash "$WEB_DIR/scripts/build-recalc-wasm.sh"

# --- build: wasm64 TCG backend (site/dist-jit/, the page default) ---
bash "$WEB_DIR/scripts/build-qemu-wasm64.sh"

echo "=== web dist ready: $WEB_DIR/site/dist-jit ==="
