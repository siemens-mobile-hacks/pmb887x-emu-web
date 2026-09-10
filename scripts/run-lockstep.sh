#!/bin/bash
# Phase-0b gate runner (doc/wasm-tcg-backend-plan.md §5): build the
# lockstep plugin, then N value-level lockstep comparisons of full S75
# boots between the two native TCG backends (JIT = reference vs TCI).
#
#   scripts/run-lockstep.sh                 # 3 full S75 boots (the gate)
#   RUNS=1 INSNS=300e6 scripts/run-lockstep.sh   # quick smoke
#   SELF=1 scripts/run-lockstep.sh          # harness self-check (JIT vs JIT)
#
# Gate: 0 digest divergences (every epoch line of regs/flow/memory hashes
# identical on both backends) and byte-identical serial logs, over the
# whole boot. Exit 0 = gate green.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$ROOT/tests/lockstep.so"
QEMU_HDR="$ROOT/build/qemu-native/include"

# ---- build the plugin if stale -----------------------------------------
needs_build=0
[ -f "$PLUGIN" ] || needs_build=1
[ "$needs_build" = 0 ] && [ "$ROOT/tests/lockstep.c" -nt "$PLUGIN" ] && needs_build=1
if [ "$needs_build" = 1 ]; then
  [ -d "$QEMU_HDR" ] || { echo "!! $QEMU_HDR missing — scripts/fetch-qemu.sh + build-native.sh first" >&2; exit 2; }
  echo "== building tests/lockstep.so"
  gcc -O2 -Wall -fPIC -shared -I "$QEMU_HDR" $(pkg-config --cflags glib-2.0) \
      "$ROOT/tests/lockstep.c" -o "$PLUGIN"
fi

RUNS="${RUNS:-3}"
INSNS="${INSNS:-2.5e9}"
EXTRA=()
[ -n "${SELF:-}" ] && EXTRA+=(--self)

# the TCI build must have plugins force-enabled (upstream configures them
# off with TCI by default — CI cost, not a hard incompatibility):
#   scripts/build-native-tci.sh
for bin in "$ROOT/build/qemu-native-build/qemu-system-arm" \
           "$ROOT/build/qemu-native-tci-build/qemu-system-arm"; do
  [ -x "$bin" ] || { echo "!! $bin not built — scripts/build-native.sh + scripts/build-native-tci.sh"; exit 2; }
done

node "$ROOT/tools/lockstep.mjs" --runs "$RUNS" --par "$RUNS" \
  --insns "$INSNS" --label "${LABEL:-gate}" "${EXTRA[@]+"${EXTRA[@]}"}"
