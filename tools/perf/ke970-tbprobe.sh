#!/usr/bin/env bash
# KE970 steady-state: the LG tbstats-RMW ceiling probe (W64_TBSTATS=0).
# ABAB, one leg at a time, uniform --settle 75 on BOTH arms (the notb
# arm has no insn counter, so the rate-based quiet detector cannot run;
# same protocol on both sides keeps the pair comparable).  The live
# meters in notb legs are fps and haltsPerS; mips reads 0 there.
# Logs to tools/perf/logs/ke970/.
set -u
cd /workspace
S=/workspace/tools/perf/logs/ke970
mkdir -p "$S"
Q=$S/queue2.log
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$Q"; }

q=0
while [ $q -lt 2 ]; do
  l=$(cut -d' ' -f1 /proc/loadavg)
  awk -v l="$l" 'BEGIN{exit !(l <= 28)}' && q=$((q + 1)) || q=0
  sleep 30
done
log "host quiet (load $(cut -d' ' -f1 /proc/loadavg))"

bash tools/perf/hostmon.sh "$S/hostmon2.csv" &
HOSTMON=$!

leg() {  # leg <tag> <extraq>
  local tag=$1 extraq=$2
  EXTRA_Q="$extraq" node tools/uibench.mjs --board ke970 --dist dist-jit \
    --state both --settle 75 > "$S/uib2-$tag.log" 2>&1
  log "$tag: $(grep -oE 'quiet at ~[0-9]+s' "$S/uib2-$tag.log" | head -1) | $(grep -oE '(idle|menu): mips=[0-9.]+ fps=[0-9.]+' "$S/uib2-$tag.log" | tr '\n' ' ')"
}

leg base1 ""
leg notb1 "env=W64_TBSTATS=0"
leg base2 ""
leg notb2 "env=W64_TBSTATS=0"

kill $HOSTMON 2>/dev/null
log "KE970-TBSTATS-PROBE-DONE"
