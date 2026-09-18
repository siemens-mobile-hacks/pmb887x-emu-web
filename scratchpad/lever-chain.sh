#!/usr/bin/env bash
# Price the TB boundary before profiling anything else.
#
# Two independent methods already agree that a TB->TB transition costs
# ~27.9 ns on this engine: the four-point W64_FTMAX regression on this
# game (ns/insn = 9.83 + 27.87 x exits/insn, fit to 1.2 %) and
# dispatchbench's synthetic unpredictable `return_call_indirect`
# (~27 ns).  What is NOT current is the denominator.  That sweep ran at
# 11.30 ns/guest-insn and called the boundary 27 % of wall; today's
# build runs at 5.686 ns/insn, and nothing in 0104-0118 touched the
# boundary -- so the same absolute cost is now a far larger share.
#
# It needs today's exits/Mi to say how much larger, and that is one leg,
# not a re-sweep: W64_XCOUNT=1 puts the exit counters in the generated
# code, so its own wall is not comparable but its per-Mi rates are
# exact.  W64_COLOC=1 rides along free -- it splits transitions into
# same-module / cross-module, which is the locality input the merged
# module's whole case rests on and which the handoff records as assumed
# at ~60 % and never once measured.  (Read it against lcCall: the
# counter sits in the lookup helper, so it sees only transitions that
# missed the inline cache, never the ~98 % that are direct-chained.)
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad
log() { echo "$(date +%H:%M:%S) $*"; }

busy() {
  local p st mine
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

while busy "chain-ab\.sh" || busy "capchar-ab\.sh" || busy "j2mebench\.mjs" \
   || busy "wprof2\.mjs"; do
  sleep 5
done
log "slot taken (host load $(cut -d' ' -f1 /proc/loadavg))"

# ---------------------------------------------------------------- 1
# The dispatch sweep: does `merged` (one function, NFUNC arms, br_table,
# the transition a plain `br`) still beat `xtail` at the ~277 TBs a real
# module holds, or does TurboFan's register allocator fall over on a
# 263 KB function first?  The sweep is the point -- one NFUNC cannot
# tell "the mechanism is cheaper" from "the working set fits in L1i",
# and the handoff's one-rep DB_NFUNC=64 look was taken on a loaded host
# and is explicitly not a number.
for n in 32 128 277 1024; do
  log "dispatchbench NFUNC=$n"
  DB_NFUNC=$n timeout 900 node tests/wasm/dispatchbench.mjs 2>&1 \
    | sed "s/^/  [$n] /"
done > "$S/dbsweep.log" 2>&1
log "dbsweep rc=$? (host load $(cut -d' ' -f1 /proc/loadavg))"
sed -n '1,200p' "$S/dbsweep.log"

# ---------------------------------------------------------------- 2
log "exit census (XCOUNT + COLOC)"
EXTRA_Q="env=W64_XCOUNT=1&env=W64_COLOC=1" timeout 1800 \
  node tools/j2mebench.mjs --dist dist-jit --game 1 --tag exits \
  > "$S/exits.log" 2>&1
log "exits rc=$?"
grep -E "^J2ME " "$S/exits.log" | tail -1
j=$(ls -t /workspace/tests/results/*exits.json 2>/dev/null | head -1)
log "json=$j"
[ -n "$j" ] && python3 "$S/exitread.py" "$j" 2>&1 | head -40

# ---------------------------------------------------------------- 3
log "tracec starting"
bash "$S/tracec-ab.sh" > "$S/tracec-driver.log" 2>&1
log "tracec rc=$?"

# ---------------------------------------------------------------- 4
log "g2probe starting"
bash "$S/g2probe-ab.sh" > "$S/g2probe-driver.log" 2>&1
log "g2probe rc=$?"
log "lever chain done"
