#!/bin/bash
# Build the native (Linux) qemu-system-arm for pmb887x.
#
# Uses a pristine worktree of the pinned qemu-pmb887x revision (no wasm
# patches) at build/qemu-native and builds it into build/qemu-native-build.
# Run with: scripts/build-native.sh   -> build/qemu-native-build/qemu-system-arm
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/versions.env"
SRC="$ROOT/build/qemu"
WT="$ROOT/build/qemu-native"
BUILD="$ROOT/build/qemu-native-build"

# worktree at the pinned revision (shares the existing clone's objects)
if [ ! -d "$WT" ]; then
  git -C "$SRC" worktree add --detach "$WT" "$QEMU_PMB887X_REV"
  (cd "$WT" \
    && git config submodule."subprojects/teakra".url https://github.com/siemens-mobile-hacks/teakra.git \
    && git submodule update --init --recursive --depth 1 \
    && (cd subprojects/teakra && git checkout -q -f HEAD))
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
echo "run: scripts/run-native.sh fullflashes/<device>.bin"
