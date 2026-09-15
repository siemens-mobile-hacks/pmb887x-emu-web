#!/bin/bash
# Build site/dist/siemens-recalc.{js,wasm} — the Siemens fullflash key
# recalculation / ESN recovery module the Firmware panel's "Siemens keys"
# radio drives (site-src/recalc/recalc_wasm.cpp wrapping pmb887x-emu's
# src/siemens_recalc.cpp).
#
# It deploys to site/dist/ and not site/dist-jit/: that is the directory the
# page fetches unconditionally whatever ?dist= selects, the same rule
# boards.tar follows (see scripts/pack-boards.sh).
#
# wasm32, unlike qemu — this module stands alone, so there is no reason to
# pay MEMORY64 for it. No -pthread either: the page spreads the sweep over
# its own Web Workers with one module instance each, and the std::thread in
# siemensRecoverEsn() (compiled, never called) is dead-code eliminated, so
# the module needs no SharedArrayBuffer of its own.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f "pmb887x-emu/src/siemens_recalc.cpp" ]; then
  echo "build-recalc-wasm: pmb887x-emu submodule is not checked out" >&2
  echo "  git submodule update --init pmb887x-emu" >&2
  exit 1
fi

# shellcheck disable=SC1091
source build/deps/emsdk/emsdk_env.sh >/dev/null

DIST="$ROOT/site/dist"
mkdir -p "$DIST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

emcc -O3 -std=gnu++20 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSiemensRecalc \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB \
  -sENVIRONMENT=web,worker,node \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,stringToUTF8,UTF8ToString \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXIT_RUNTIME=0 \
  site-src/recalc/recalc_wasm.cpp \
  -o "$TMP/siemens-recalc.js"

# atomic: serve.mjs may be serving the previous pair
for f in siemens-recalc.js siemens-recalc.wasm; do
  cp "$TMP/$f" "$DIST/.$f.tmp"
  mv -f "$DIST/.$f.tmp" "$DIST/$f"
done

echo "recalc module ready: site/dist/siemens-recalc.wasm ($(stat -c%s "$DIST/siemens-recalc.wasm") bytes)"
