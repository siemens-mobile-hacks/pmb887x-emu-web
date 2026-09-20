#!/bin/bash
# Deterministic host-instruction A/B: identical fixed guest work (icount),
# host Ir counted by callgrind. Immune to frequency/contention drift.
# Legs run in parallel on disjoint physical core pairs.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"
B=${1:-cx70}; FROM=${2:-1.0}; TO=${3:-1.15}
: > $S/vg-ab.log
MON_WAIT_LOOPS=3600 CGOUT=/tmp/cg-base.out \
  QEMU_REAL=/workspace/build/qemu-base-build/qemu-system-arm QEMU_BIN=tools/perf/vg.sh \
  taskset -c 4,5,20,21 node tools/perf/bench.mjs tools/perf/vg.sh "$B" --from "$FROM" --to "$TO" \
  > /tmp/vg-base.leg 2>&1 &
MON_WAIT_LOOPS=3600 CGOUT=/tmp/cg-fix.out \
  QEMU_REAL=/workspace/build/qemu-fix-build/qemu-system-arm QEMU_BIN=tools/perf/vg.sh \
  taskset -c 6,7,22,23 node tools/perf/bench.mjs tools/perf/vg.sh "$B" --from "$FROM" --to "$TO" \
  > /tmp/vg-fix.leg 2>&1 &
wait
for k in base fix; do
  ir=$(awk '/^summary:/ {print $2}' /tmp/cg-$k.out)
  echo "$k Ir=$ir" | tee -a $S/vg-ab.log
done
echo "VG-AB-DONE $(date +%T)" | tee -a $S/vg-ab.log
