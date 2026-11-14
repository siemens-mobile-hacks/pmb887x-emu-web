#!/bin/bash
# Build the native (Linux) qemu-system-arm for pmb887x.
#
#   scripts/build-native.sh       JIT  -> $QEMU_NATIVE_BUILD/qemu-system-arm
#   scripts/build-native.sh tci   TCI  -> $QEMU_NATIVE_TCI_BUILD/qemu-system-arm
#                                 (scripts/build-native-tci.sh runs this)
#
# The directories come from scripts/build-dirs.sh: build/qemu-native-build
# and build/qemu-native-tci-build unless WEB_BUILD or the two variables
# move them.
#
# Builds the qemu/ submodule as it is checked out — the very tree the wasm
# builds compile (the emscripten parts are inert natively).  The JIT binary
# is the reference of every native gate (tests/run.mjs, the lockstep
# drivers), so it must be built from exactly what the dist under test was
# built from; tools/lockstep-wasm.mjs checks that through
# scripts/qemu-source-id.sh.  It used to build a worktree at a qemu pin kept
# apart from the submodule, which nothing kept in step: the gate then compared
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
WEB_DIR="$ROOT"
source "$ROOT/scripts/build-dirs.sh"
case "$MODE" in
  jit) OUT="$NATIVE_BUILD" ;;
  tci) OUT="$NATIVE_TCI_BUILD" ;;
  *) echo "usage: $0 [jit|tci]" >&2; exit 2 ;;
esac

[ -e "$SRC/.git" ] || git -C "$ROOT" submodule update --init qemu

# Gates running at the same time each bring this build up to date: one at a
# time, or two ninjas write the same objects.  The lock sits beside the
# build dir, which the check below may delete.
mkdir -p "$(dirname "$OUT")"
exec 9>"$OUT.lock"
flock 9

# a build dir configured from another tree (the old pinned worktree) is
# rebuilt from scratch: meson cannot move a build dir between sources.
# Physical paths on both sides: meson records the real path, and a checkout
# reached through a symlink is the same tree.
INFO="$OUT/meson-info/meson-info.json"
if [ -f "$INFO" ]; then
  BUILT_FROM="$(sed -nE 's/.*"source": *"([^"]*)".*/\1/p' "$INFO")"
  [ "$(realpath -m -- "$BUILT_FROM")" = "$(realpath -- "$SRC")" ] || rm -rf "$OUT"
fi

mkdir -p "$OUT"
cd "$OUT"
MESON="$OUT/pyvenv/bin/meson"
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
# what tools/lockstep-wasm.mjs matches against the dist's qemu-source.txt;
# by rename, so a reader never sees it half written
echo "$ID" > qemu-source.txt.tmp
mv -f qemu-source.txt.tmp qemu-source.txt

if [ "$MODE" = tci ]; then
  # positive: configured with plugins, and the binary lists the option
  PLUGIN_HELP="$("$OUT/qemu-system-arm" -plugin help 2>&1 || true)"
  if ! grep -qx '#define CONFIG_PLUGIN' config-host.h || [[ "$PLUGIN_HELP" != *"Plugin options"* ]]; then
    echo "!! plugins not enabled in $OUT — inspect meson configuration" >&2
    exit 1
  fi
  echo "=== native TCI qemu ready (plugins on): $OUT/qemu-system-arm (qemu $ID) ==="
else
  echo "=== native qemu ready: $OUT/qemu-system-arm (qemu $ID) ==="
  echo "board configs: bash scripts/sync-bsp.sh (the bsp/ submodule)"
  echo "run: scripts/run-native.sh fullflashes/<device>.bin"
fi
