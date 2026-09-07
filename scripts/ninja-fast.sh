#!/bin/bash
# Fast incremental rebuild of the wasm qemu build dir (web/build/qemu-wasm).
# Skips the tree reset/patch/reconfigure that scripts/build-qemu.sh does;
# use it while iterating on files already patched into web/build/qemu.
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${WEB_BUILD:-$WEB_DIR/build}"
DEPS_ROOT="${WASM_DEPS:-$BUILD/deps}"
TARGET="$DEPS_ROOT/target"

source "$DEPS_ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1
export PATH="$HOME/.local/bin:$PATH"
export CPATH="$TARGET/include"
export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"

cd "$BUILD/qemu-wasm"
ninja -j"$(nproc)" "$@"
