#!/usr/bin/env bash
# build-qemu-wasm64.sh — one-shot build of the wasm64 TCG backend dist.
#
# Builds the emscripten wasm64 qemu (memory64, pthreads, ASYNCIFY) into
# build/qemu-wasm64/ and deploys qemu-system-arm.{js,wasm} into
# site/dist-jit/ (the emulator page's default dist; ?dist=dist opts into
# the TCI build instead).
#
# The default is the 32-bit-address-limit memory model (-sMEMORY64=2): i64
# pointers, i32 memory index.  It is worth +19.2 % on J2ME (round thirty-six)
# because a wasm32 memory is guard-page bounded and needs no explicit bound
# check; it gates green and the op-suite is byte-identical to native.
# W64_MEM64=1 builds the old -sMEMORY64=1 model into build/qemu-wasm64-mem64/
# and site/dist-jit-mem64/ for comparison.  W64_O3=1 does the same for an -O3
# build (build/qemu-wasm64-o3/, site/dist-jit-o3/).
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
# Each variant gets its own build and dist directory for two reasons: the
# configure guard below does not reconfigure an existing build dir, so a
# shared one would silently keep the other mode's flags; and an A/B wants
# both artifacts on disk at once.  The knobs compose, and they have to: once
# one of them is winning, the next experiment has to be priced on top of it
# rather than against a build nobody intends to ship.
VARIANT=
MEMFLAGS="-sMEMORY64=2"
CONF_MEM=(--wasm64-32bit-address-limit)
if [ "${W64_MEM64:-0}" = 1 ]; then
  VARIANT="$VARIANT-mem64"
  MEMFLAGS="-sMEMORY64=1"
  CONF_MEM=()
fi
if [ "${W64_O3:-0}" = 1 ]; then
  # qemu's configure pins meson's optimization option to 2; the -O3 in
  # --extra-cflags below has never applied to a compile line and never could.
  # The option is set on the meson configure line further down.
  VARIANT="$VARIANT-o3"
fi
BUILD="build/qemu-wasm64$VARIANT"
DIST="site/dist-jit$VARIANT"

if [ ! -f "$BUILD/build.ninja" ] || [ ! -f "$BUILD/meson-private/coredata.dat" ]; then
  echo "== configuring $BUILD"
  mkdir -p "$BUILD"
  ( cd "$BUILD" && emconfigure "$SRC/configure" \
      --static \
      --cpu=wasm64 \
      "${CONF_MEM[@]}" \
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
      --extra-cflags="-O3 -pthread -DWASM_BIGINT $MEMFLAGS" )
fi

# wasm64 backend: the hot path is JIT'd per-TB modules, not the TCI
# interpreter, so instrument ONLY the functions that can be on the stack at
# a coroutine switch (configs/meson/asyncify-only.txt) instead of "everything
# but tcg_qemu_tb_exec".  ~45 MB -> ~27 MB wasm, boot-to-idle -18 %.  The TCI
# dist keeps ASYNCIFY_REMOVE (its hot path IS the interpreter; the onlylist
# regresses it +26 %), so this override is wasm64-only and is applied here
# rather than in the shared configs/meson/emscripten.txt.  Absolute path so
# meson's compile probes (run from temp dirs on a reconfigure) find the list.
ONLY="$ROOT/qemu/configs/meson/asyncify-only.txt"
LA="['-pthread','--emit-symbol-map','-sASYNCIFY=1','-sPROXY_TO_PTHREAD=1','-sFORCE_FILESYSTEM','-sALLOW_TABLE_GROWTH','-sTOTAL_MEMORY=2GB','-sWASM_BIGINT','-sEXPORT_ES6=1','-sASYNCIFY_IMPORTS=ffi_call_js','-sASYNCIFY_ONLY=@$ONLY','-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS,ENV,HEAPU8,HEAPU32','-sEXIT_RUNTIME=1']"
# qom_cast_debug: OBJECT_CHECK() casts assert the QOM type on every call —
# the display path (lcd_transfer, the LCD/SSI pin handlers) does that per
# FIFO word (~1.6 % of the vCPU in a redrawing J2ME app); a release build
# does not need it
# A command-line -D is the one route a cross file loaded later cannot
# override, which is why every flag that has to survive goes through here.
VOPT=()
if [ "${W64_O3:-0}" = 1 ]; then
  VOPT=(-Doptimization=3)
fi
( cd "$BUILD" && meson configure -Dc_link_args="$LA" -Dcpp_link_args="$LA" -Dqom_cast_debug=false "${VOPT[@]}" >/dev/null )

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
# part of this build's ninja graph — refresh them with the deploy
#
# Both of these live in the shared site/dist/, are identical in either memory
# mode, and are live inputs to whatever is being benchmarked out of it, so the
# W64_MEM32 variant only creates them when they are missing: rebuilding them
# would add CPU noise to a run in progress and buy nothing.
if [ -z "$VARIANT" ] || [ ! -f site/dist/boards.tar ]; then
  bash scripts/pack-boards.sh
fi
# same for the Siemens key module (site/dist/siemens-recalc.wasm), which is
# built from the pmb887x-emu submodule, not from qemu
if [ -z "$VARIANT" ] || [ ! -f site/dist/siemens-recalc.wasm ]; then
  bash scripts/build-recalc-wasm.sh
fi
# The lockstep fold reads the insn budget + grid from the URL (ls-* params).
ls -la "$DIST"/qemu-system-arm.{js,wasm}
echo "== done. Serve: node scripts/serve.mjs 8094   Run: cd tools && node lockstep-wasm.mjs --runs 3"
