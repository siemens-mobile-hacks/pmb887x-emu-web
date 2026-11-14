#!/bin/bash
# Build the native TCG plugins the test harnesses load:
#
#   tests/insncount.so   tests/run.mjs (the native gate job)
#   tests/lockstep.so    tools/lockstep.mjs, tools/lockstep-wasm.mjs
#
#   scripts/build-plugins.sh
#
# A plugin is rebuilt when its source or qemu's plugin API header is newer
# than the .so (a qemu merge that changes the API otherwise kills every
# boot with "emulator died"). The build goes to a temp file renamed over
# the old one, so a qemu loading the plugin at that moment never sees a
# half-written file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HDR="$ROOT/qemu/include"
API="$HDR/plugins/qemu-plugin.h"

[ -f "$API" ] || { echo "!! $API missing — git submodule update --init qemu" >&2; exit 2; }
GLIB_CFLAGS="$(pkg-config --cflags glib-2.0)"

for name in insncount lockstep; do
  src="$ROOT/tests/$name.c" so="$ROOT/tests/$name.so"
  if [ -f "$so" ] && [ ! "$src" -nt "$so" ] && [ ! "$API" -nt "$so" ]; then
    continue
  fi
  echo "== building tests/$name.so"
  tmp="$(mktemp "$so.XXXXXX")"
  # shellcheck disable=SC2086  # GLIB_CFLAGS is a flag list
  if ! gcc -O2 -Wall -fPIC -shared -I "$HDR" $GLIB_CFLAGS "$src" -o "$tmp"; then
    rm -f "$tmp"
    exit 1
  fi
  chmod 755 "$tmp"
  mv -f "$tmp" "$so"
done
