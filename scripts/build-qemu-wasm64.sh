#!/usr/bin/env bash
# build-qemu-wasm64.sh — one-shot build of the wasm64 TCG backend dist.
#
# Builds the emscripten wasm64 qemu (memory64, pthreads, ASYNCIFY) into
# build/qemu-wasm64/ and deploys qemu-system-arm.{js,wasm} into
# site/dist-jit/ (the emulator page's default dist; ?dist=dist opts into
# the TCI build instead).
#
# Prereqs (already present in this tree):
#   - build/deps/emsdk (emsdk env + wasm64 sysroot under build/deps/target)
#   - build/qemu checked out @ b31b98fe1e with patches/ applied
#     (0001-0018; scripts/build-qemu.sh applies the whole series —
#     0017 is the wasm64 backend this script builds, 0018 the cputlb
#     MMIO dispatch fix both engines share)
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

# wasm64 backend: the hot path is JIT'd per-TB modules, not the TCI
# interpreter, so instrument ONLY the functions that can be on the stack at
# a coroutine switch (configs/meson/asyncify-only.txt) instead of "everything
# but tcg_qemu_tb_exec".  ~45 MB -> ~27 MB wasm, boot-to-idle -18 %.  The TCI
# dist keeps ASYNCIFY_REMOVE (its hot path IS the interpreter; the onlylist
# regresses it +26 %), so this override is wasm64-only and is applied here
# rather than in the shared configs/meson/emscripten.txt.  Absolute path so
# meson's compile probes (run from temp dirs on a reconfigure) find the list.
ONLY="$ROOT/build/qemu/configs/meson/asyncify-only.txt"
LA="['-pthread','--emit-symbol-map','-sASYNCIFY=1','-sPROXY_TO_PTHREAD=1','-sFORCE_FILESYSTEM','-sALLOW_TABLE_GROWTH','-sTOTAL_MEMORY=2GB','-sWASM_BIGINT','-sEXPORT_ES6=1','-sASYNCIFY_IMPORTS=ffi_call_js','-sASYNCIFY_ONLY=@$ONLY','-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS,ENV,HEAPU8,HEAPU32','-sEXIT_RUNTIME=1']"
# qom_cast_debug: OBJECT_CHECK() casts assert the QOM type on every call —
# the display path (lcd_transfer, the LCD/SSI pin handlers) does that per
# FIFO word (~1.6 % of the vCPU in a redrawing J2ME app); a release build
# does not need it
( cd "$BUILD" && meson configure -Dc_link_args="$LA" -Dcpp_link_args="$LA" -Dqom_cast_debug=false >/dev/null )

echo "== ninja qemu-system-arm.js"
ninja -C "$BUILD" qemu-system-arm.js

echo "== deploy -> site/dist-jit (atomic: temp name + rename — the server may
   be serving the previous artifact; a plain cp can serve a torn 45 MB file)"
mkdir -p site/dist-jit
for f in qemu-system-arm.js qemu-system-arm.wasm; do
  cp "$BUILD/$f" "site/dist-jit/.$f.tmp"
  mv -f "site/dist-jit/.$f.tmp" "site/dist-jit/$f"
done
# Refresh the symbol-map sidecar too (stale maps poison wprof2 profiles —
# the 2026-09-11 session burned a whole profile round on this).
for f in "$BUILD"/qemu-system-arm.js.symbols; do
  [ -f "$f" ] && cp "$f" "site/dist-jit/" && break
done
# board configs (site/dist/boards.tar, what the page always fetches) are not
# part of this build's ninja graph — refresh them with the deploy
bash scripts/pack-boards.sh
# The lockstep fold reads the insn budget + grid from the URL (ls-* params).
ls -la site/dist-jit/qemu-system-arm.{js,wasm}
echo "== done. Serve: node scripts/serve.mjs 8094   Run: cd tools && node lockstep-wasm.mjs --runs 3"
