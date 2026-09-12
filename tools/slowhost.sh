#!/bin/bash
# Run a command on a "phone-sized" slice of this host: pin it (and every
# child, i.e. the chromium it launches) to CORES and share each of those
# cores with SPIN busy-loop spinners at the same priority, so CFS gives the
# command ~1/(SPIN+1) of each core.  Single-thread speed is what a phone
# lacks (a 2024 flagship is ~1/3..1/2 of this host's single core; a 2019
# mid-range ~1/4), so this throttles per-core speed instead of only core
# count.  cgroup cpu.max would be cleaner but /sys/fs/cgroup is read-only
# in this container.
#
#   CORES=0-3 SPIN=1 tools/slowhost.sh node tools/idlebench.mjs dist-jit --quick
#
# Env: CORES (default 0-3), SPIN spinners per core (default 1 = 50 %).
set -euo pipefail
CORES="${CORES:-0-3}"
SPIN="${SPIN:-1}"
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
# expand "a-b,c" into a core list
for range in ${CORES//,/ }; do
  lo="${range%-*}"; hi="${range#*-}"
  for ((c = lo; c <= hi; c++)); do
    for ((k = 0; k < SPIN; k++)); do
      taskset -c "$c" bash -c 'while :; do :; done' &
      pids+=($!)
    done
  done
done
echo "slowhost: cores=$CORES spinners/core=$SPIN (~$((100 / (SPIN + 1))) % of each core)" >&2
exec taskset -c "$CORES" "$@"
