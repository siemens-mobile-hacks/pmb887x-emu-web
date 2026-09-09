#!/bin/bash
# Build qemu-system-arm (pmb887x) with the wasm32 runtime-JIT TCG backend.
#
# CLOSED PATH (2026-09-09): the backend measured ~1.3-2.3x TCI at best and
# has an unresolved boot hang -- it is NOT part of the shipping series.
# The rebased sources live in patches/attic/wasm32-rebase/; this script is
# kept for anyone retrying (apply patches/attic/0005-*.patch or the
# wasm32-rebase files onto build/qemu first, then run this).
# Uses the wasm32 deps (build/deps32). Patches from patches/ must be
# applied to build/qemu first (scripts/build-qemu.sh does this for the
# shared tree; we reuse build/qemu as the source tree).
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$WEB_DIR/versions.env"

BUILD="${WEB_BUILD:-$WEB_DIR/build}"
DEPS_ROOT="$BUILD/deps32"
TARGET="$DEPS_ROOT/target"
DIST="$WEB_DIR/site/dist-jit"
mkdir -p "$DIST"

source "$DEPS_ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1
export PATH="$HOME/.local/bin:$PATH"
export CPATH="$TARGET/include"
export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"

BUILD_DIR="$BUILD/qemu-wasm32"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

EXTRA_CFLAGS="-O2 -pthread -DNDEBUG -DG_DISABLE_ASSERT -Wno-incompatible-function-pointer-types -matomics -mbulk-memory"

emconfigure "$BUILD/qemu/configure" \
  --static --cpu=wasm32 \
  --target-list=arm-softmmu \
  --without-default-features \
  --enable-system --enable-tcg \
  --enable-pixman \
  --with-coroutine=wasm \
  --disable-tools --disable-docs --disable-install-blobs --disable-werror \
  -Dcpp_std=gnu++20 \
  --extra-cflags="$EXTRA_CFLAGS" \
  --extra-cxxflags="$EXTRA_CFLAGS" \
  --extra-ldflags="-sASYNCIFY=1 -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2GB -sWASM_BIGINT -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js -sASYNCIFY_REMOVE=tcg_qemu_tb_exec -sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS,ENV,HEAPU8,HEAPU32 -sEXIT_RUNTIME=1 -sINITIAL_MEMORY=2GB"

emmake ninja -j"$(nproc)" qemu-system-arm.js

cp qemu-system-arm.js qemu-system-arm.wasm "$DIST/" 2>/dev/null || true
[ -f qemu-system-arm.worker.js ] && cp qemu-system-arm.worker.js "$DIST/" || true
echo "=== jit dist ready: $DIST ==="
