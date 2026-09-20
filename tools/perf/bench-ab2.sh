#!/bin/bash
# ABBA-ordered, CPU-pinned fixed-guest-work A/B (powersave governor makes
# unpinned runs drift; pinning + alternating order cancels position bias).
# 2 rounds of [B,A,A,B] per board. Results -> tools/perf/logs/bench-ab2.log
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"
BASE=/workspace/build/qemu-base-build/qemu-system-arm
FIX=/workspace/build/qemu-fix-build/qemu-system-arm
OUT=$S/bench-ab2.log
: > $OUT
PIN="taskset -c 8,9,24,25"
for round in 1 2; do
  for order in B A A B; do
    for b in cx70 s75; do
      case $b in
        cx70) F=6; T=14 ;;
        s75)  F=6; T=11 ;;
      esac
      if [ "$order" = B ]; then BIN=$BASE; TAG=BASE; else BIN=$FIX; TAG=FIX; fi
      echo "=== r$round $order board $b $TAG $(date +%T)" | tee -a $OUT
      $PIN node tools/perf/bench.mjs $BIN $b --from $F --to $T | tee -a $OUT
    done
  done
done
echo "DONE $(date +%T)" | tee -a $OUT
