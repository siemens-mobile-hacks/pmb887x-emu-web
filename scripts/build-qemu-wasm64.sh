#!/usr/bin/env bash
# build-qemu-wasm64.sh — one-shot build of the wasm64 TCG backend dist.
#
# Builds the emscripten wasm64 qemu (memory64, pthreads, ASYNCIFY) into
# build/qemu-wasm64/ and deploys qemu-system-arm.{js,wasm} into
# site/dist-jit/ (served by the emulator page's ?dist=dist-jit switch).
#
# Prereqs (already present in this tree):
#   - build/deps/emsdk (emsdk env + wasm64 sysroot under build/deps/target)
#   - build/qemu checked out @ b31b98fe1e with patches 0001-0016 + 0017 applied
#
# The 0017 patch is the wasm64 backend skeleton (tcg/wasm64/ + the
# meson/tcg.h/getpc.h integration). Apply it first if it isn't already:
#   cd build/qemu && git apply /workspace/patches/0017-tcg-wasm64-backend.patch
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

source build/deps/emsdk/emsdk_env.sh >/dev/null
export CPATH="$ROOT/build/deps/target/include"
export PKG_CONFIG_PATH="$ROOT/build/deps/target/lib/pkgconfig"

BUILD=build/qemu-wasm64
SRC=build/qemu

if [ ! -f "$BUILD/build.ninja" ] || [ ! -f "$BUILD/meson-private/coredata.dat" ]; then
  echo "== configuring $BUILD"
  mkdir -p "$BUILD"
  ( cd "$BUILD" && meson setup --werror=no . "$SRC" \
      --static \
      --cpu=wasm64 \
      --target-list=arm-softmmu \
      --without-default-features \
      --enable-system \
      --enable-tcg \
      --enable-pixman \
      --with-coroutine=wasm \
      --disable-tools \
      --disable-docs \
      --disable-install-blobs \
      --disable-werror \
      -Dcpp_std=gnu++20 \
      --extra-cflags="-O3 -pthread -DWASM_BIGINT -sMEMORY64=1" )
fi

echo "== ninja qemu-system-arm.js"
ninja -C "$BUILD" qemu-system-arm.js

echo "== deploy -> site/dist-jit (atomic: temp name + rename — the server may
   be serving the previous artifact; a plain cp can serve a torn 45 MB file)"
mkdir -p site/dist-jit
for f in qemu-system-arm.js qemu-system-arm.wasm; do
  cp "$BUILD/$f" "site/dist-jit/.$f.tmp"
  mv -f "site/dist-jit/.$f.tmp" "site/dist-jit/$f"
done
# The lockstep fold reads the insn budget + grid from the URL (ls-* params).
ls -la site/dist-jit/qemu-system-arm.{js,wasm}
echo "== done. Serve: node scripts/serve.mjs 8094   Run: cd tools && node lockstep-wasm.mjs --runs 3"
