#!/usr/bin/env bash
# KE970 measurement queue: boot characterization, steady-state baseline,
# and the LG tbstats-RMW ceiling probe (W64_TBSTATS=0).  One thing at a
# time; waits for a quiet host first.  Logs to tools/perf/logs/ke970/.
set -u
cd /workspace
S=/workspace/tools/perf/logs/ke970
mkdir -p "$S"
Q=$S/queue.log
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$Q"; }

q=0
while [ $q -lt 2 ]; do
  l=$(cut -d' ' -f1 /proc/loadavg)
  awk -v l="$l" 'BEGIN{exit !(l <= 28)}' && q=$((q + 1)) || q=0
  sleep 30
done
log "host quiet (load $(cut -d' ' -f1 /proc/loadavg))"

bash tools/perf/hostmon.sh "$S/hostmon.csv" &
HOSTMON=$!

# ---- 1. does it boot, and how far does it get in 150 s?
log "bootcheck ke970"
node tools/bootcheck.mjs --dist dist-jit --secs 150 --flash ke970 \
  > "$S/boot-1.log" 2>&1 || true
log "bootcheck done: $(tail -3 "$S/boot-1.log" | head -1)"

# ---- 2. steady state: idle and menu, three legs alternating on/off so
# no leg's neighbour is its own control
log "uibench ke970 baseline (2 legs)"
for i in 1 2; do
  node tools/uibench.mjs --board ke970 --dist dist-jit --state both \
    > "$S/uib-base-$i.log" 2>&1
  log "uibench base leg $i done: $(grep -oE 'idle: [0-9.]+ MIPS.*' "$S/uib-base-$i.log" | head -1)"
done

# ---- 3. the tbstats RMW ceiling: W64_TBSTATS=0 (MIPS reads 0 there;
# fps and wall rates are the meter)
log "uibench ke970 tbstats=0 (2 legs)"
for i in 1 2; do
  EXTRA_Q="env=W64_TBSTATS=0" node tools/uibench.mjs --board ke970 \
    --dist dist-jit --state both > "$S/uib-notb-$i.log" 2>&1
  log "uibench notb leg $i done: $(grep -oE 'idle: [0-9.]+ MIPS.*' "$S/uib-notb-$i.log" | head -1)"
done
log "one more baseline leg (position control)"
node tools/uibench.mjs --board ke970 --dist dist-jit --state both \
  > "$S/uib-base-3.log" 2>&1

kill $HOSTMON 2>/dev/null
log "KE970-QUEUE-DONE"
