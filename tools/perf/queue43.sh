#!/usr/bin/env bash
# Round-43 measurement queue: waits for a quiet host, then runs one thing
# at a time (measurements never overlap).  Logs to tools/perf/logs/.
set -u
cd /workspace
S=/workspace/tools/perf/logs
mkdir -p "$S"
Q=$S/queue43.log
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$Q"; }

# ---- wait for quiet: 1-min load <= 28 for two consecutive samples
log "waiting for quiet host (load $(cut -d' ' -f1 /proc/loadavg))"
q=0
while [ $q -lt 2 ]; do
  l=$(cut -d' ' -f1 /proc/loadavg)
  awk -v l="$l" 'BEGIN{exit !(l <= 28)}' && q=$((q + 1)) || q=0
  sleep 30
done
log "host quiet (load $(cut -d' ' -f1 /proc/loadavg))"

bash tools/perf/hostmon.sh "$S/queue43-hostmon.csv" &
HOSTMON=$!

# ---- 1. chain-lever census pair (load-immune counters, boot must succeed)
for d in dist-jit-base dist-jit; do
  log "census leg $d"
  EXTRA_Q="env=W64_XCOUNT=1&env=W64_XWHY=1" node tools/videobench.mjs \
    --dist "$d" --tag cen3 > "$S/cen3-$d.log" 2>&1
  log "census $d done: $(grep -oE 'FAIL [a-z-]+|rt=[0-9.]+' "$S/cen3-$d.log" | head -1)"
done

# ---- 2. chain-lever clock: 8-leg ABBA
log "ABBA start"
bash tools/perf/vgabba.sh 2 dist-jit-base dist-jit chain > "$S/vgabba-chain-driver.log" 2>&1
log "ABBA done"

kill $HOSTMON 2>/dev/null
log "QUEUE43-DONE"
