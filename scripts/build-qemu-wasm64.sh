#!/usr/bin/env bash
# build-qemu-wasm64.sh — one-shot build of the wasm64 TCG backend dist.
#
# Builds the emscripten wasm64 qemu (memory64, pthreads, ASYNCIFY) into
# build/qemu-wasm64/ and deploys qemu-system-arm.{js,wasm} into
# site/dist-jit/ (the emulator page's dist).
#
# The default is the 32-bit-address-limit memory model (-sMEMORY64=2): i64
# pointers, i32 memory index.  It is worth +19.2 % on J2ME (round thirty-six)
# because a wasm32 memory is guard-page bounded and needs no explicit bound
# check; it gates green and the op-suite is byte-identical to native.
# (The W64_MEM64 / W64_O3 comparison variants this script used to build
# were removed once their rounds closed — the record is in
# doc/performance-handoff.md, rounds thirty-six and thirty-seven.)
#
# Prereqs (already present in this tree):
#   - build/deps/emsdk (emsdk env + wasm64 sysroot under build/deps/target)
#   - qemu (submodule) on the wasm-browser-port branch (all patches
#     committed); scripts/build-qemu.sh initializes it —
#     0017 is the wasm64 backend this script builds, 0018 the cputlb
#     MMIO dispatch fix both engines share)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

source build/deps/emsdk/emsdk_env.sh >/dev/null
export CPATH="$ROOT/build/deps/target/include"
export PKG_CONFIG_PATH="$ROOT/build/deps/target/lib/pkgconfig"
# emconfigure overwrites PKG_CONFIG_PATH with EM_PKG_CONFIG_PATH, empty if
# unset (emscripten tools/building.py, get_building_env), so the line above is
# invisible to configure on its own.  It went unnoticed until W64_MEM32 made
# this script configure a build dir from scratch for the first time: the
# default one was configured by build-qemu.sh, which sets both.
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"

SRC="$ROOT/qemu"

# The default memory model: clang/lld still emit wasm64 with i64 pointers,
# Binaryen lowers the memory to wasm32 at link (-sMEMORY64=2), and
# -DW64_MEM32 makes the JIT backend wrap the addresses in the code it emits
# itself, which Binaryen never sees.
#
# -DW64_MEM32 is NOT passed in --extra-cflags on purpose: that lands in the
# meson cross file's [built-in options], which meson does not apply to
# compile lines (-O3 and -DWASM_BIGINT are dropped the same way).  configure
# adds the define to CPU_CFLAGS instead, keyed off the same
# --wasm64-32bit-address-limit that selects -sMEMORY64=2, so the define and
# the memory mode cannot drift apart -- out of step, every JIT module fails
# to instantiate with "cannot import i32 memory as i64".
#
# The deps under build/deps/target need no rebuild when switching -- emscripten
# compiles -sMEMORY64=1 and =2 identically (same wasm64 triple, same -mwasm64)
# and caches their system libraries in one wasm64-emscripten lib dir; only the
# link differs.
#
# The build dir is never reconfigured once it exists (the configure guard
# below), so a flags change means wiping build/qemu-wasm64 first.
BUILD="build/qemu-wasm64"
DIST="site/dist-jit"

if [ ! -f "$BUILD/build.ninja" ] || [ ! -f "$BUILD/meson-private/coredata.dat" ]; then
  echo "== configuring $BUILD"
  mkdir -p "$BUILD"
  ( cd "$BUILD" && emconfigure "$SRC/configure" \
      --static \
      --cpu=wasm64 \
      --wasm64-32bit-address-limit \
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
      --extra-cflags="-O3 -pthread -DWASM_BIGINT -sMEMORY64=2" )
fi

# Instrument ONLY the functions that can be on the stack at a coroutine
# switch (configs/meson/asyncify-only.txt): ~45 MB -> ~27 MB wasm,
# boot-to-idle -18 %.  Absolute path so meson's compile probes (run from
# temp dirs on a reconfigure) find the list.
# -O2 on the link: without it emcc links at -O0 — ASSERTIONS on (an
# Asyncify state check after every call) and no Binaryen pass over the
# linked module.  With it: 28 -> 11 MB wasm, video -3 %, J2ME -5 %.
ONLY="$ROOT/qemu/configs/meson/asyncify-only.txt"
LA="['-O2','-pthread','--emit-symbol-map','-sASYNCIFY=1','-sPROXY_TO_PTHREAD=1','-sFORCE_FILESYSTEM','-sALLOW_TABLE_GROWTH','-sTOTAL_MEMORY=2GB','-sWASM_BIGINT','-sEXPORT_ES6=1','-sASYNCIFY_IMPORTS=ffi_call_js','-sASYNCIFY_ONLY=@$ONLY','-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS,ENV,HEAPU8,HEAPU32','-sEXIT_RUNTIME=1']"
# qom_cast_debug: OBJECT_CHECK() casts assert the QOM type on every call —
# the display path (lcd_transfer, the LCD/SSI pin handlers) does that per
# FIFO word (~1.6 % of the vCPU in a redrawing J2ME app); a release build
# does not need it
# A command-line -D is the one route a cross file loaded later cannot
# override, which is why every flag that has to survive goes through here.
# (qemu's configure pins meson's optimization to -O2 through the same
# built-in option; -O3 was measured a tie in round thirty-seven and
# rejected — see doc/performance-handoff.md § Open items.)
( cd "$BUILD" && meson configure -Dc_link_args="$LA" -Dcpp_link_args="$LA" -Dqom_cast_debug=false >/dev/null )

echo "== ninja qemu-system-arm.js"
ninja -C "$BUILD" qemu-system-arm.js

echo "== deploy -> $DIST (atomic: temp name + rename — the server may
   be serving the previous artifact; a plain cp can serve a torn 45 MB file)"
mkdir -p "$DIST"
for f in qemu-system-arm.js qemu-system-arm.wasm; do
  cp "$BUILD/$f" "$DIST/.$f.tmp"
  mv -f "$DIST/.$f.tmp" "$DIST/$f"
done
# Refresh the symbol-map sidecar too (stale maps poison wprof2 profiles —
# the 2026-09-11 session burned a whole profile round on this).
for f in "$BUILD"/qemu-system-arm.js.symbols; do
  [ -f "$f" ] && cp "$f" "$DIST/" && break
done
# board configs (site/dist/boards.tar, what the page always fetches) are not
# part of this build's ninja graph — refresh them with the deploy.
# Both of these live in the shared site/dist/ and are live inputs to whatever
# is being benchmarked out of it.
bash scripts/pack-boards.sh
# same for the Siemens key module (site/dist/siemens-recalc.wasm), which is
# built from the pmb887x-emu submodule, not from qemu
bash scripts/build-recalc-wasm.sh
# The lockstep fold reads the insn budget + grid from the URL (ls-* params).
ls -la "$DIST"/qemu-system-arm.{js,wasm}
echo "== done. Serve: node serve.mjs   Run: cd tools && node lockstep-wasm.mjs --runs 3"
