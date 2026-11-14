#!/bin/bash
# Phase-0b gate runner: build the
# lockstep plugin, then N value-level lockstep comparisons of full S75
# boots between the two native TCG backends (JIT = reference vs TCI).
#
#   scripts/run-lockstep.sh                 # 3 full S75 boots (the gate)
#   RUNS=1 INSNS=300e6 scripts/run-lockstep.sh   # quick smoke
#   SELF=1 scripts/run-lockstep.sh          # harness self-check (JIT vs JIT)
#
# Gate: 0 digest divergences (every E-line register hash and M-line
# memory digest identical on both backends) and byte-identical serial
# logs, over the whole boot. Exit 0 = gate green.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT"
source "$ROOT/scripts/build-dirs.sh"

# rebuilds a stale plugin into a temp file and renames it, so a lockstep
# job of a parallel gate that is loading it never reads a partial file
bash "$ROOT/scripts/build-plugins.sh"

RUNS="${RUNS:-3}"
INSNS="${INSNS:-2.5e9}"
EXTRA=()
[ -n "${SELF:-}" ] && EXTRA+=(--self)

# the TCI build must have plugins force-enabled (upstream configures them
# off with TCI by default — CI cost, not a hard incompatibility):
#   scripts/build-native-tci.sh
for bin in "$NATIVE_BUILD/qemu-system-arm" "$NATIVE_TCI_BUILD/qemu-system-arm"; do
  [ -x "$bin" ] || { echo "!! $bin not built — scripts/build-native.sh + scripts/build-native-tci.sh"; exit 2; }
done

node "$ROOT/tools/lockstep.mjs" --runs "$RUNS" --par "$RUNS" \
  --insns "$INSNS" --label "${LABEL:-gate}" "${EXTRA[@]+"${EXTRA[@]}"}"
