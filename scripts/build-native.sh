#!/bin/bash
# Build the native (Linux) qemu-system-arm for pmb887x.
#
#   scripts/build-native.sh       JIT  -> build/qemu-native-build/qemu-system-arm
#   scripts/build-native.sh tci   TCI  -> build/qemu-native-tci-build/qemu-system-arm
#                                 (scripts/build-native-tci.sh runs this)
#
# Builds the qemu/ submodule as it is checked out — the very tree the wasm
# builds compile (the emscripten parts are inert natively).  The JIT binary
# is the reference of every native gate (tests/run.mjs, the lockstep
# drivers), so it must be built from exactly what the dist under test was
# built from; tools/lockstep-wasm.mjs checks that through
# scripts/qemu-source-id.sh.  It used to build a worktree at the versions.env
# pin, which nothing kept in step with the submodule: the gate then compared
# new dists against month-old code.
#
# The TCI build has TCG plugins on: it is the b-side binary of the phase-0b
# lockstep gate (scripts/run-lockstep.sh; the a-side is the JIT build).
# Upstream's configure disables plugins by default when
# --enable-tcg-interpreter is set (CI cost of the mem-instrumentation test,
# not a hard incompatibility — see commit 7866b0f721 "deprecation: don't
# enable TCG plugins by default with TCI"), so after configure plugins are
# forced on through meson.
set -euo pipefail

MODE="${1:-jit}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/qemu"
case "$MODE" in
  jit) BUILD="$ROOT/build/qemu-native-build" ;;
  tci) BUILD="$ROOT/build/qemu-native-tci-build" ;;
  *) echo "usage: $0 [jit|tci]" >&2; exit 2 ;;
esac

[ -e "$SRC/.git" ] || git -C "$ROOT" submodule update --init qemu

# a build dir configured from another tree (the old pinned worktree) is
# rebuilt from scratch: meson cannot move a build dir between sources
INFO="$BUILD/meson-info/meson-info.json"
if [ -f "$INFO" ] && ! grep -q "\"source\": *\"$SRC\"" "$INFO"; then
  rm -rf "$BUILD"
fi

mkdir -p "$BUILD"
cd "$BUILD"
MESON="$BUILD/pyvenv/bin/meson"
if [ "$MODE" = jit ]; then
  # slirp (libslirp-dev) is the network behind the GSM cell's GPRS that
  # tools/gprscheck.mjs uses
  [ -f Makefile ] || "$SRC/configure" \
    --target-list=arm-softmmu \
    --disable-docs --disable-werror --enable-slirp
  if ! grep -q '^#define CONFIG_SLIRP' config-host.h; then
    [ -x "$MESON" ] || MESON=meson
    "$MESON" configure -Dslirp=enabled
  fi
else
  [ -f Makefile ] || "$SRC/configure" \
    --target-list=arm-softmmu \
    --disable-docs --disable-werror --enable-tcg-interpreter --enable-plugins
  [ -x "$MESON" ] || MESON=meson
  "$MESON" configure -Dplugins=true
fi

# taken before the build, so an edit made while it runs cannot be claimed
ID="$(bash "$ROOT/scripts/qemu-source-id.sh" "$SRC")"
# first run can fail on a generated-qapi-header race (dsp_core.cpp compiled
# before qapi-types-error.h existed) — a second ninja pass resolves it
ninja -j"$(nproc)" qemu-system-arm || ninja -j"$(nproc)" qemu-system-arm
# what tools/lockstep-wasm.mjs matches against the dist's qemu-source.txt
echo "$ID" > qemu-source.txt

if [ "$MODE" = tci ]; then
  if "$BUILD/qemu-system-arm" -plugin help 2>&1 | grep -q "plugin interface not enabled"; then
    echo "!! plugins still disabled in $BUILD — inspect meson configuration" >&2
    exit 1
  fi
  echo "=== native TCI qemu ready (plugins on): $BUILD/qemu-system-arm (qemu $ID) ==="
else
  echo "=== native qemu ready: $BUILD/qemu-system-arm (qemu $ID) ==="
  echo "board configs: bash scripts/sync-bsp.sh (the bsp/ submodule)"
  echo "run: scripts/run-native.sh fullflashes/<device>.bin"
fi
