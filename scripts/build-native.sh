#!/bin/bash
# Build the native (Linux) qemu-system-arm for pmb887x.
#
# Uses a worktree of the pinned qemu-pmb887x revision (the qemu submodule's
# series branch — the same tree the wasm builds use; the emscripten parts
# are inert natively) at build/qemu-native and builds it into
# build/qemu-native-build.
# Run with: scripts/build-native.sh   -> build/qemu-native-build/qemu-system-arm
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/versions.env"
SRC="$ROOT/qemu"
WT="$ROOT/build/qemu-native"
BUILD="$ROOT/build/qemu-native-build"

# worktree at the pinned revision (shares the existing clone's objects).
# It is moved to the pin on every run, not only created: an existing
# worktree left behind at an older rev used to build silently and hand
# tests/run.mjs a stale binary as if it were the gate.
git -C "$ROOT" submodule update --init
if [ "$(git -C "$SRC" rev-parse HEAD)" != "$QEMU_PMB887X_REV" ]; then
  git -C "$SRC" checkout -q -B "$QEMU_PMB887X_BRANCH" "$QEMU_PMB887X_REV" 2>/dev/null \
    || git -C "$SRC" checkout -q -f "$QEMU_PMB887X_REV"
fi
if [ ! -d "$WT" ]; then
  git -C "$SRC" worktree add --detach "$WT" "$QEMU_PMB887X_REV"
elif [ "$(git -C "$WT" rev-parse HEAD)" != "$QEMU_PMB887X_REV" ]; then
  git -C "$WT" checkout -q -f --detach "$QEMU_PMB887X_REV"
fi

mkdir -p "$BUILD"
cd "$BUILD"
[ -f Makefile ] || ../qemu-native/configure \
  --target-list=arm-softmmu \
  --disable-docs --disable-werror

# first run can fail on a generated-qapi-header race (dsp_core.cpp compiled
# before qapi-types-error.h existed) — a second ninja pass resolves it
ninja -j"$(nproc)" qemu-system-arm || ninja -j"$(nproc)" qemu-system-arm
echo "=== native qemu ready: $BUILD/qemu-system-arm ==="
echo "board configs: bash scripts/sync-bsp.sh (build/bsp)"
echo "run: scripts/run-native.sh fullflashes/<device>.bin"
