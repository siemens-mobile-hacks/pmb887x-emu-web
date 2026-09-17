#!/bin/bash
# Build site/dist/siemens-recalc.{js,wasm} — the browser build of pmb887x-emu's
# Siemens fullflash library ("siemensfw", src/siemens/, namespace SiemensFW),
# plus the page's glue (site-src/recalc/recalc_wasm.cpp).
#
# What the page uses it for: the "Siemens keys" radio (key recalculation,
# ESN recovery — sr_read_identity/sr_recalc/sr_scan/sr_verify) and the
# Siemens half of device detection (sr_probe → probeFullflash).
#
# It deploys to site/dist/ and not site/dist-jit/: that is the directory the
# page fetches unconditionally whatever ?dist= selects, the same rule
# boards.tar follows (see scripts/pack-boards.sh).
#
# wasm32, unlike qemu — this module stands alone, so there is no reason to
# pay MEMORY64 for it. No -pthread either: the page spreads the sweep over
# its own Web Workers with one module instance each (the library's CMake
# adds -pthread for EMSCRIPTEN because its own recoverEsn() fans out over
# std::thread; that path is never called from here, and a SharedArrayBuffer
# would only constrain where the module can load). -msimd128 matches the
# library's build flags: the batched MD5 that dominates the ESN sweep is
# written to auto-vectorize over its lanes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EMU="$ROOT/pmb887x-emu"
SRC="$EMU/src"
if [ ! -f "$SRC/siemens/fullflash.cpp" ]; then
  echo "build-recalc-wasm: pmb887x-emu submodule is not checked out at the pinned rev" >&2
  echo "  git submodule update --init pmb887x-emu" >&2
  exit 1
fi
# spdlog (log capture) and tomlplusplus (esn.cpp) are submodules of the
# submodule; the root-level submodule update does not reach them.
for dep in spdlog tomlplusplus; do
  if [ ! -e "$EMU/third_party/$dep" ] || [ -z "$(ls -A "$EMU/third_party/$dep" 2>/dev/null)" ]; then
    git -C "$EMU" submodule update --init "third_party/$dep"
  fi
done

# shellcheck disable=SC1091
source build/deps/emsdk/emsdk_env.sh >/dev/null

DIST="$ROOT/site/dist"
mkdir -p "$DIST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The siemensfw library, compiled from its own sources (src/siemens/
# CMakeLists.txt): everything it is made of, with the two util TUs it pulls
# in. Nothing is #included or copied — the page's module is the upstream
# library plus glue, so an upstream change to the arithmetic or the probe
# offsets lands here by rebuilding.
emcc -O3 -std=gnu++20 -msimd128 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSiemensRecalc \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB \
  -sENVIRONMENT=web,worker,node \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,stringToUTF8,UTF8ToString \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXIT_RUNTIME=0 \
  -I"$SRC" \
  -I"$EMU/third_party/spdlog/include" \
  -I"$EMU/third_party/tomlplusplus/include" \
  "$SRC/siemens/bruteforce.cpp" \
  "$SRC/siemens/crypto.cpp" \
  "$SRC/siemens/eeprom.cpp" \
  "$SRC/siemens/esn.cpp" \
  "$SRC/siemens/fullflash.cpp" \
  "$SRC/siemens/otp.cpp" \
  "$SRC/siemens/recalc.cpp" \
  "$SRC/crypto/md4.cpp" \
  "$SRC/crypto/md5.cpp" \
  "$SRC/utils/file.cpp" \
  "$SRC/utils/string.cpp" \
  site-src/recalc/recalc_wasm.cpp \
  -o "$TMP/siemens-recalc.js"

# atomic: serve.mjs may be serving the previous pair
for f in siemens-recalc.js siemens-recalc.wasm; do
  cp "$TMP/$f" "$DIST/.$f.tmp"
  mv -f "$DIST/.$f.tmp" "$DIST/$f"
done

echo "recalc module ready: site/dist/siemens-recalc.wasm ($(stat -c%s "$DIST/siemens-recalc.wasm") bytes)"
