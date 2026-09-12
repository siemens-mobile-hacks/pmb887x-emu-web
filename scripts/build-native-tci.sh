#!/bin/bash
# Build the native TCI (Linux) qemu-system-arm for pmb887x, with TCG
# plugins enabled — the b-side binary of the phase-0b lockstep gate
# (scripts/run-lockstep.sh; the a-side JIT comes from build-native.sh).
#
# Same pinned qemu-pmb887x worktree as build-native.sh
# (build/qemu-native @ QEMU_PMB887X_REV). Upstream's configure disables
# plugins by default when --enable-tcg-interpreter is set (CI cost of
# the mem-instrumentation test, not a hard incompatibility — see commit
# 7866b0f721 "deprecation: don't enable TCG plugins by default with
# TCI"), so after configure we force -Dplugins=true through meson.
#
# Uses build/qemu-native-tci-build (kept separate from the plain native
# build). Run with: scripts/build-native-tci.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/versions.env"
SRC="$ROOT/pmb887x-emu/qemu"
WT="$ROOT/build/qemu-native"
BUILD="$ROOT/build/qemu-native-tci-build"

# worktree at the pinned revision (shares the existing clone's objects;
# build-native.sh normally creates it — do it here too for standalone use)
bash "$ROOT/scripts/fetch-qemu.sh" "$SRC"
if [ ! -d "$WT" ]; then
  git -C "$SRC" worktree add --detach "$WT" "$QEMU_PMB887X_REV"
  if grep -q 'subprojects/teakra' "$WT/.gitmodules" 2>/dev/null; then
    (cd "$WT" \
      && git config submodule."subprojects/teakra".url https://github.com/siemens-mobile-hacks/teakra.git \
      && git submodule update --init --depth 1 subprojects/teakra \
      && (cd subprojects/teakra && git checkout -q -f HEAD))
  fi
fi

mkdir -p "$BUILD"
cd "$BUILD"
[ -f Makefile ] || "$WT/configure" \
  --target-list=arm-softmmu \
  --disable-docs --disable-werror --enable-tcg-interpreter --enable-plugins

# force plugins on regardless of the TCI default-off heuristic
MESON="$BUILD/pyvenv/bin/meson"
[ -x "$MESON" ] || MESON=meson
"$MESON" configure -Dplugins=true

# first run can fail on a generated-qapi-header race — a second pass fixes it
ninja -j"$(nproc)" qemu-system-arm || ninja -j"$(nproc)" qemu-system-arm

if "$BUILD/qemu-system-arm" -plugin help 2>&1 | grep -q "plugin interface not enabled"; then
  echo "!! plugins still disabled in $BUILD — inspect meson configuration" >&2
  exit 1
fi
echo "=== native TCI qemu ready (plugins on): $BUILD/qemu-system-arm ==="
