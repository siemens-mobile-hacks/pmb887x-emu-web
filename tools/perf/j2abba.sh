#!/usr/bin/env bash
# J2ME ABBA driver, the j2mebench twin of vgabba.sh: CX70_FW56_clean game 1
# (duty 1, 45 virtual seconds, Mi ~5625 in every leg), two dists rotated
# A B B A / B A A B, one browser boot per leg, hostmon alongside.  Usage:
#   tools/perf/j2abba.sh <rounds> <distA> <distB> [tag]
# Score with VGFIT_KIND=j2me tools/perf/vgfit.py <distA> <distB> <tag>.
set -u
cd /workspace
R=${1:?rounds}; A=${2:?distA}; B=${3:?distB}; TAG=${4:-j2ab}
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"
LOG="$S/j2abba-$TAG.log"
: > "$LOG"

bash tools/perf/hostmon.sh "$S/j2abba-$TAG-hostmon.csv" &
HOSTMON=$!
trap 'kill $HOSTMON 2>/dev/null' EXIT

n=0
for r in $(seq 1 "$R"); do
  if [ $((r % 2)) -eq 1 ]; then order="$A $B $B $A"; else order="$B $A $A $B"; fi
  for d in $order; do
    n=$((n + 1))
    echo "=== leg $n round $r dist $d $(date +%H:%M:%S)" | tee -a "$LOG"
    PORT=8080 node tools/j2mebench.mjs --dist "$d" --tag "$TAG" \
      --flash fullflashes/CX70_FW56_clean.bin --game 1 2>&1 \
      | grep -E "^J2ME|^perMi:|\[j2me\]" | tee -a "$LOG"
  done
done
echo "J2ABBA-DONE legs=$n $(date +%T)" | tee -a "$LOG"
