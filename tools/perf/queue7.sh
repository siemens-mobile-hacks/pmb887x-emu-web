#!/usr/bin/env bash
# Post-battery: patch the runner, rebuild, and price the merged-module
# emitter.  Everything here needs a rebuild, so none of it can overlap a
# measurement -- hence the drain wait, which is the whole reason this is
# a separate driver rather than a tail on queue5.
#
# Two ways this wait has gone wrong, both of them live here:
#
#   * queue6 was launched as `bash queue6.sh` from inside the scratchpad,
#     so a pattern anchored on "tools/perf/" misses it and this rebuilds
#     underneath its legs.  So the patterns carry no directory.
#   * which then exposes the reason the directory was there: PID 1 in
#     this container is `sleep infinity`, it never reaps, and `pgrep -f`
#     matches a zombie by its comm.  Three [ab.sh] <defunct> from two
#     days ago match "ab\.sh" forever, and a bare-name wait never exits.
#
# So match by name and then drop anything that is not a live process.
# queue[3-6] also excludes queue7 itself, which is the third way.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"
log() { echo "$(date +%H:%M:%S) $*"; }

busy() {
  local p st mine
  # self, parent and grandparent: a launcher that carries this script's
  # text on its own command line matches every pattern in it
  mine=" $$ $PPID $(awk '{print $4}' /proc/$PPID/stat 2>/dev/null) "
  for p in $(pgrep -f "$1" 2>/dev/null); do
    case "$mine" in *" $p "*) continue ;; esac
    st=$(ps -o stat= -p "$p" 2>/dev/null)
    case "$st" in
      "" | Z*) ;;
      *) return 0 ;;
    esac
  done
  return 1
}

while busy "j2mebench.mjs" || busy "wprof2.mjs" \
   || busy "(ab|ab4)\.sh"  || busy "queue[3-6]\.sh"; do
  sleep 20
done
log "battery drained"

# ---- 1. the runner's own workload guard -------------------------------
# Analysis-side guarding (verdict.py) already drops a contaminated leg
# from the verdict; this stops one being *spent*.  A light leg costs a
# full slot, and this round lost three verdicts to them.
DUTY=""
cp tools/j2mebench.mjs "$S/j2mebench.mjs.bak"
if python3 "$S/runner-duty.py" && node --check tools/j2mebench.mjs; then
  DUTY="0.348,0.150"
  log "runner guard applied, duty=$DUTY"
else
  log "WARN: runner guard did not apply -- restoring, legs run unguarded"
  cp "$S/j2mebench.mjs.bak" tools/j2mebench.mjs
fi

# ---- 2. the rebuild ---------------------------------------------------
log "rebuilding"
if ! timeout 2400 bash scripts/ninja-fast.sh > "$S/build7.log" 2>&1; then
  log "BUILD FAILED -- stopping, nothing below is meaningful"
  tail -40 "$S/build7.log"
  exit 1
fi
log "build ok"

# ---- 3. does the merged emitter run at all, and did it fire? ----------
# The counters come first: a leg that merged nothing would still produce
# a perfectly ordinary rate, and A/Bing that is how a mechanism gets
# credited with someone else's noise.  mergeSkip must be 0 -- there is no
# legitimate reason to decline a batch.
smoke() {
  local m=$1
  EXTRA_Q="env=W64_MERGE=$m" timeout 900 node tools/j2mebench.mjs --dist dist-jit \
    --game 1 --tag mergesmoke$m --window 20000 ${DUTY:+--duty 0.348} \
    > "$S/mergesmoke$m.log" 2>&1
  local js
  js=$(grep -o 'results: [^ ]*\.json' "$S/mergesmoke$m.log" | head -1 | cut -d' ' -f2)
  if [ -z "$js" ] || [ ! -f "$js" ]; then
    log "smoke W64_MERGE=$m: NO RESULT"
    tail -15 "$S/mergesmoke$m.log"
    return 1
  fi
  python3 - "$js" "$m" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
c = {k: v for k, v in r["counters"].items() if "merge" in k.lower()}
print(f"smoke W64_MERGE={sys.argv[2]}: MIPS/cpu={r['mipsCpu']} duty={r['duty']} "
      f"mi={r['mi']} fps={r['fps']} {c}")
sys.exit(0 if c.get("mergeMod", 0) > 0 and c.get("mergeSkip", 0) == 0 else 1)
PY
}

M1=0; M2=0
smoke 1 && M1=1 || log "smoke mode 1 FAILED (see $S/mergesmoke1.log)"
smoke 2 && M2=1 || log "smoke mode 2 FAILED (see $S/mergesmoke2.log)"

# ---- 4. price it ------------------------------------------------------
# Mode 1 merges the batch into one function; mode 2 changes nothing but
# adds the same entry stub to every member.  Mode 2 is the control: it
# prices the hop alone, so (mode 1 - mode 2) is the tier-up half, which
# is the number the --no-liftoff ceiling cannot give.
#
# W64_MERGE is an *enabling* knob, so in both A/Bs below the leg printed
# "off" is the leg with merging ON.  Read on/off inverted.
if [ $M1 = 1 ]; then
  DUTY="$DUTY" bash "$S/ab4d.sh" merge1 1,2 'env=W64_MERGE=1' > "$S/merge1-ab.log" 2>&1
  log "merge1 done"
else
  log "merge1 A/B skipped: the mechanism did not fire"
fi
if [ $M2 = 1 ]; then
  DUTY="$DUTY" bash "$S/ab4d.sh" merge2 1,2 'env=W64_MERGE=2' > "$S/merge2-ab.log" 2>&1
  log "merge2 done"
else
  log "merge2 A/B skipped: the mechanism did not fire"
fi

# ---- 5. the gate on the tree that will be committed -------------------
timeout 2400 bash scripts/gate.sh keep > "$S/gate-keep7.log" 2>&1
log "gate keep rc=$?"
tail -30 "$S/gate-keep7.log"
log "queue7 done"
