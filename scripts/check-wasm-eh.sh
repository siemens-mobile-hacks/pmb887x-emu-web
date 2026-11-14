#!/bin/bash
# Fail when a wasm64 ninja dir predates wasm-EH setjmp. configure fixes the
# compiler's argv (CPU_CFLAGS) when the build dir is made, and the build
# scripts never reconfigure one: a dir made before it still builds, in
# emscripten's slower JS setjmp or in the legacy EH instructions that
# Firefox deprecates.
#
#   scripts/check-wasm-eh.sh <ninja build dir>
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$1"
if grep -q -- "-wasm-use-legacy-eh=0" "$WEB_DIR/qemu/configure" &&
   ! grep -q -- "-wasm-use-legacy-eh=0" "$BUILD_DIR/config-meson.cross"; then
  echo "$BUILD_DIR predates wasm-EH setjmp (configure CPU_CFLAGS);" \
       "remove it and run scripts/build-qemu-wasm64.sh" >&2
  exit 1
fi
