#!/usr/bin/env bash
# Videobench ABBA driver: rotate two (or more) dists, N rounds, one leg at a
# time on the host, hostmon alongside.  Usage:
#   tools/perf/vgabba.sh <rounds> <distA> <distB> [tag]
# Legs run A B B A per round (palindrome inside the round, rounds in both
# orders), each an own browser boot; results land in the usual
# tests/results/video-*.json and a summary per leg is appended to
# $S/vgabba-<tag>.log.  Score with tools/perf/vgan.py afterwards.
set -u
cd /workspace
R=${1:?rounds}; A=${2:?distA}; B=${3:?distB}; TAG=${4:-ab}
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"
LOG="$S/vgabba-$TAG.log"
: > "$LOG"

bash tools/perf/hostmon.sh "$S/vgabba-$TAG-hostmon.csv" &
HOSTMON=$!
trap 'kill $HOSTMON 2>/dev/null' EXIT

n=0
for r in $(seq 1 "$R"); do
  if [ $((r % 2)) -eq 1 ]; then order="$A $B $B $A"; else order="$B $A $A $B"; fi
  for d in $order; do
    n=$((n + 1))
    echo "=== leg $n round $r dist $d $(date +%H:%M:%S)" | tee -a "$LOG"
    EXTRA_Q="${VG_EXTRA_Q:-}" node tools/videobench.mjs --dist "$d" \
      --tag "$TAG" 2>&1 | grep -E "^VIDEO|^perMi:|\[video\]" | tee -a "$LOG"
    # keep only the newest JSON per dist for this tag: analysis globs by tag
  done
done
echo "VGABBA-DONE legs=$n $(date +%T)" | tee -a "$LOG"
