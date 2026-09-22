#!/usr/bin/env bash
# KE970 phase 2: quiet-host boot trace + ke800/ke970 steady-state pair.
set -u
cd /workspace
S=/workspace/tools/perf/logs/ke970
Q=$S/queue2.log
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$Q"; }
q=0
while [ $q -lt 2 ]; do
  l=$(cut -d' ' -f1 /proc/loadavg)
  awk -v l="$l" 'BEGIN{exit !(l <= 12)}' && q=$((q + 1)) || q=0
  sleep 30
done
log "host quiet (load $(cut -d' ' -f1 /proc/loadavg))"

# 1. definitive boot trace (phase structure is load-immune; wall isn't)
node tools/bootcheck.mjs --dist dist-jit --secs 120 --flash ke970 \
  > "$S/boot-quiet.log" 2>&1
log "boot trace done"

# 2. ke800 steady state on the same build (2 legs)
for i in 1 2; do
  node tools/uibench.mjs --board ke800 --dist dist-jit --state both \
    > "$S/uib-ke800-$i.log" 2>&1
  log "ke800 leg $i done"
done

# 3. ke970 re-baseline (2 legs; earlier legs at mixed load)
for i in 1 2; do
  node tools/uibench.mjs --board ke970 --dist dist-jit --state both \
    > "$S/uib-ke970-$i.log" 2>&1
  log "ke970 leg $i done"
done
log "KE970-PHASE2-DONE"
