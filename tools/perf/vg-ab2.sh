#!/bin/bash
# like vg-ab.sh but B leg uses $BINB (default fix)
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"
B=${1:-s75}; FROM=${2:-2.2}; TO=${3:-2.32}
BB=${BINB:-/workspace/build/qemu-fix-build/qemu-system-arm}
: > $S/vg-ab2.log
MAX_WAIT_S=3000 MON_WAIT_LOOPS=3600 CGOUT=/tmp/cg-base.out \
  QEMU_REAL=/workspace/build/qemu-base-build/qemu-system-arm QEMU_BIN=tools/perf/vg.sh \
  taskset -c 4,5,20,21 node tools/perf/bench.mjs tools/perf/vg.sh "$B" --from "$FROM" --to "$TO" \
  > /tmp/vg-base.leg 2>&1 &
MAX_WAIT_S=3000 MON_WAIT_LOOPS=3600 CGOUT=/tmp/cg-b.out \
  QEMU_REAL="$BB" QEMU_BIN=tools/perf/vg.sh \
  taskset -c 6,7,22,23 node tools/perf/bench.mjs tools/perf/vg.sh "$B" --from "$FROM" --to "$TO" \
  > /tmp/vg-b.leg 2>&1 &
wait
echo "base $(awk '/^summary:/{print $2}' /tmp/cg-base.out) b $(awk '/^summary:/{print $2}' /tmp/cg-b.out) bbin=$BB" | tee -a $S/vg-ab2.log
echo "VG-AB-DONE $(date +%T)" | tee -a $S/vg-ab2.log
