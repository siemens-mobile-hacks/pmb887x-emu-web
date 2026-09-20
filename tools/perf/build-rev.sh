#!/bin/bash
# Build a given qemu rev into build/qemu-native-build (native arm-softmmu).
set -euo pipefail
REV="$1"
WT=/workspace/build/qemu-native
BUILD=/workspace/build/qemu-native-build
if [ "$(git -C "$WT" rev-parse HEAD)" != "$(git -C /workspace/qemu rev-parse "$REV")" ]; then
  git -C "$WT" checkout -q -f --detach "$REV"
fi
cd "$BUILD"
[ -f Makefile ] || ../qemu-native/configure --target-list=arm-softmmu --disable-docs --disable-werror
ninja -j"$(nproc)" qemu-system-arm || ninja -j"$(nproc)" qemu-system-arm
echo "=== built: $BUILD/qemu-system-arm @ $REV ==="
