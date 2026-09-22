#!/usr/bin/env bash
# Env-knob ABBA screen: same dist both arms, one arm carries an env knob
# via EXTRA_Q.  Palindrome inside the round, round order alternates.
# Usage: nopcc.sh <rounds> [dist] [envexpr] [tag]
set -u
cd /workspace
R=${1:?rounds}; D=${2:-dist-jit}; ENVX=${3:-env=W64_NOPCC=1}; TAG=${4:-nopcc}
S=/workspace/tools/perf/logs
LOG="$S/vgabba-$TAG.log"
: > "$LOG"
bash tools/perf/hostmon.sh "$S/vgabba-$TAG-hostmon.csv" &
HOSTMON=$!
trap 'kill $HOSTMON 2>/dev/null' EXIT

n=0
for r in $(seq 1 "$R"); do
  if [ $((r % 2)) -eq 1 ]; then order="base knob knob base"; else order="knob base base knob"; fi
  for arm in $order; do
    n=$((n + 1))
    eq=""
    [ "$arm" = knob ] && eq="$ENVX"
    echo "=== leg $n round $r arm $arm $eq $(date +%H:%M:%S)" | tee -a "$LOG"
    EXTRA_Q="$eq" node tools/videobench.mjs --dist "$D" --tag "$TAG" \
      2>&1 | grep -E "^VIDEO|^perMi:" | tee -a "$LOG"
  done
done
kill $HOSTMON 2>/dev/null
echo "NOPCC-SCREEN-DONE $(date +%H:%M:%S)" | tee -a "$LOG"
