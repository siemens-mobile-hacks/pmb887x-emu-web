#!/bin/bash
# Build the native TCI (Linux) qemu-system-arm for pmb887x, with TCG
# plugins enabled — the b-side binary of the phase-0b lockstep gate
# (scripts/run-lockstep.sh; the a-side JIT comes from build-native.sh).
#
# Same source as build-native.sh: the qemu/ submodule as it is checked
# out, so both lockstep sides run the code under test. Upstream's configure disables
# plugins by default when --enable-tcg-interpreter is set (CI cost of
# the mem-instrumentation test, not a hard incompatibility — see commit
# 7866b0f721 "deprecation: don't enable TCG plugins by default with
# TCI"), so after configure we force -Dplugins=true through meson.
#
# Uses build/qemu-native-tci-build (kept separate from the plain native
# build). Run with: scripts/build-native-tci.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/qemu"
BUILD="$ROOT/build/qemu-native-tci-build"

[ -e "$SRC/.git" ] || git -C "$ROOT" submodule update --init qemu

# meson cannot move a build dir between sources (the old pinned worktree)
INFO="$BUILD/meson-info/meson-info.json"
if [ -f "$INFO" ] && ! grep -q "\"source\": *\"$SRC\"" "$INFO"; then
  rm -rf "$BUILD"
fi

mkdir -p "$BUILD"
cd "$BUILD"
[ -f Makefile ] || "$SRC/configure" \
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
