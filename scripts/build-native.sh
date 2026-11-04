#!/bin/bash
# Build the native (Linux) qemu-system-arm for pmb887x.
#
# Builds the qemu/ submodule as it is checked out — the very tree the wasm
# builds compile (the emscripten parts are inert natively) — into
# build/qemu-native-build.  That binary is the reference of every native
# gate (tests/run.mjs, the lockstep drivers), so it must be built from
# exactly what the dist under test was built from; tools/lockstep-wasm.mjs
# checks that through scripts/qemu-source-id.sh.  It used to build a
# worktree at the versions.env pin, which nothing kept in step with the
# submodule: the gate then compared new dists against month-old code.
# Run with: scripts/build-native.sh   -> build/qemu-native-build/qemu-system-arm
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/qemu"
BUILD="$ROOT/build/qemu-native-build"

[ -e "$SRC/.git" ] || git -C "$ROOT" submodule update --init qemu

# a build dir configured from another tree (the old pinned worktree) is
# rebuilt from scratch: meson cannot move a build dir between sources
INFO="$BUILD/meson-info/meson-info.json"
if [ -f "$INFO" ] && ! grep -q "\"source\": *\"$SRC\"" "$INFO"; then
  rm -rf "$BUILD"
fi

mkdir -p "$BUILD"
cd "$BUILD"
[ -f Makefile ] || "$SRC/configure" \
  --target-list=arm-softmmu \
  --disable-docs --disable-werror

# taken before the build, so an edit made while it runs cannot be claimed
ID="$(bash "$ROOT/scripts/qemu-source-id.sh" "$SRC")"
# first run can fail on a generated-qapi-header race (dsp_core.cpp compiled
# before qapi-types-error.h existed) — a second ninja pass resolves it
ninja -j"$(nproc)" qemu-system-arm || ninja -j"$(nproc)" qemu-system-arm
# what tools/lockstep-wasm.mjs matches against the dist's qemu-source.txt
echo "$ID" > qemu-source.txt
echo "=== native qemu ready: $BUILD/qemu-system-arm (qemu $ID) ==="
echo "board configs: bash scripts/sync-bsp.sh (build/bsp)"
echo "run: scripts/run-native.sh fullflashes/<device>.bin"
