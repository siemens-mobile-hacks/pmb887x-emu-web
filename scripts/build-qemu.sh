#!/bin/bash
# Build qemu-system-arm (pmb887x) as WebAssembly + assemble dist.
#
# Clones the pinned qemu-pmb887x revision into build/qemu (pristine
# upstream + patches/*.patch), configures it for emscripten/wasm64 with
# the TCG interpreter, and produces:
#   dist/qemu-system-arm.js / .wasm / .worker.js   (emscripten output)
#   dist/boards.tar                                 (board configs from bsp)
#   dist/index.html, app.js, style.css, ...         (copied from site)
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$WEB_DIR/versions.env"

BUILD="${WEB_BUILD:-$WEB_DIR/build}"
DEPS_ROOT="${WASM_DEPS:-$BUILD/deps}"
TARGET="$DEPS_ROOT/target"
DIST="$WEB_DIR/dist"
mkdir -p "$BUILD" "$DIST"

source "$DEPS_ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1
export PATH="$HOME/.local/bin:$PATH"
export CPATH="$TARGET/include"
export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"

# --- qemu source: pinned clone + patches ---
bash "$WEB_DIR/scripts/fetch-qemu.sh" "$BUILD/qemu"
# optional teakra submodule (used by older qemu-pmb887x trees; the current
# tree has its own native DSP). HTTPS rewrite like the sie-mcp Dockerfile.
if grep -q 'subprojects/teakra' "$BUILD/qemu/.gitmodules" 2>/dev/null; then
  (cd "$BUILD/qemu" \
    && git config submodule."subprojects/teakra".url https://github.com/siemens-mobile-hacks/teakra.git \
    && git submodule update --init --recursive --depth 1 \
    && (cd subprojects/teakra && git checkout -q -f HEAD))
fi
cd "$BUILD/qemu"
if [ -e tcg/wasm32.c ] || [ -n "$(git status --porcelain -- tcg/wasm32.c tcg/wasm32 2>/dev/null)" ]; then
  echo "REFUSING to reset the qemu tree: uncommitted wasm32 draft work present." >&2
  echo "  (re-commit patches/0005 first, or delete tcg/wasm32* to force)" >&2
  exit 1
fi
git fetch --all --quiet 2>/dev/null || true
git checkout -q -- . 2>/dev/null || true
# stale nested repo from older trees (teakra) blocks clean checkouts
rm -rf "$BUILD/qemu/subprojects/teakra"
git checkout -q -f "$QEMU_PMB887X_REV"
git reset -q --hard "$QEMU_PMB887X_REV"
git clean -qfd
git apply --check "$WEB_DIR"/patches/*.patch 2>/dev/null || true
for p in "$WEB_DIR"/patches/*.patch; do
  if git apply --check "$p" 2>/dev/null; then
    echo "applying $(basename "$p")"
    git apply "$p"
  else
    echo "skip $(basename "$p") (already applied?)"
  fi
done

# --- board configs from bsp (pinned rev + patches/bsp workarounds) ---
bash "$WEB_DIR/scripts/sync-bsp.sh"
tar -cf "$DIST/boards.tar" -C "$BUILD/bsp/lib/data/board" .

# --- configure + build ---
# Flags follow qemu's CI wasm64 job (tests/docker/dockerfiles/emsdk-wasm64-cross.docker
# + .gitlab-ci.d/buildtest.yml build-wasm64-64bit), plus the flags needed to
# drive it from a browser: pthreads with main() proxied to a worker, ES6
# module output, MEMFS for the fullflash, exported wasm_* helpers.
# Emscripten link settings (threads, ASYNCIFY, ES6, ENV export, memory
# growth) come from qemu's own configs/meson/emscripten.txt, extended by
# patches/0001 (ENV + EXIT_RUNTIME + growable memory).
EXTRA_CFLAGS="-O3 -pthread -DWASM_BIGINT -sMEMORY64=1"

BUILD_DIR="$BUILD/qemu-wasm"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

emconfigure "$BUILD/qemu/configure" \
  --static --cpu=wasm64 \
  --target-list=arm-softmmu \
  --without-default-features \
  --enable-system --enable-tcg --enable-tcg-interpreter \
  --enable-pixman \
  --with-coroutine=wasm \
  --disable-tools --disable-docs --disable-install-blobs --disable-werror \
  -Dcpp_std=gnu++20 \
  --extra-cflags="$EXTRA_CFLAGS" \
  --extra-cxxflags="$EXTRA_CFLAGS"

emmake ninja -j"$(nproc)" qemu-system-arm.js

cp qemu-system-arm.js qemu-system-arm.wasm "$DIST/"
[ -f qemu-system-arm.worker.js ] && cp qemu-system-arm.worker.js "$DIST/" || true
[ -f qemu-system-arm.wasm.map ] && cp qemu-system-arm.wasm.map "$DIST/" || true

# --- site ---
cp "$WEB_DIR"/site/* "$DIST/"

echo "=== web dist ready: $DIST ==="
