#!/usr/bin/env bash
# Where does the 3.1 ns per guest instruction actually go?
#
# The five-title regression (wall per virtual second against Mi per virtual
# second) put ~3.1 ns/insn of marginal cost against ~39 ms/vsec of fixed
# per-frame overhead.  Display (1.5 %) and the whole exception path (0.9 %,
# of which the longjmp unwind is exactly 0.0 -- there are no longjmps on
# this workload) are both already priced and both small, so the marginal
# term is the target and nothing yet says how it splits.
#
# A timer around cpu_tb_exec cannot answer it: TBs run ~66k times per Mi and
# two clock reads cost ~140 ns, which is more than the whole 3.1 ns/insn
# budget for a 15-instruction TB.  A sampling profile costs nothing per TB
# and wprof2 already groups frames BY MODULE -- the JIT emits each TB as its
# own WebAssembly.Module, so "emitted code" and "the main C module" land in
# different buckets by construction.  That is the split.
#
# Game 5 (LOTR Trilogy) because it is the most CPU-bound title in the image:
# duty 0.34 and 42.5 Mi per virtual second, both the highest measured, so the
# profile is dominated by steady play rather than by frame-pacing idle.
#
# --hold keeps PLAYING rather than parking on a live canvas: a profile of a
# paused J2ME app is a profile of an idle guest.  The profiler slows the
# guest ~3x, which is why the hold is wall-clock seconds and not an
# instruction budget.
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  (cd /workspace && node serve.mjs >"$S/serve-jitprof.log" 2>&1 &)
  for _ in $(seq 1 10); do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

PORT=9333
rm -f "$S/jitprof-bench.log" "$S/jitprof-prof.log"

timeout 900 node tools/j2mebench.mjs --dist dist-jit \
  --flash /workspace/fullflashes/CX70_games.bin --game 5 \
  --start 'center:10000,center:10000,center:10000,center:8000' \
  --tracec --warm 2000 --window 12000 --tag jitprof \
  --devtools $PORT --hold 200 \
  > "$S/jitprof-bench.log" 2>&1 &
BENCH=$!

# Wait for the bench to reach PLAYHOLD -- that line is printed immediately
# before it starts replaying the key plan for the hold, so attaching on it
# profiles a game that is being played, not one mid-navigation.
for i in $(seq 1 180); do
  grep -q PLAYHOLD "$S/jitprof-bench.log" 2>/dev/null && break
  kill -0 $BENCH 2>/dev/null || { echo "!!! bench exited early"; tail -20 "$S/jitprof-bench.log"; exit 1; }
  sleep 5
done
if ! grep -q PLAYHOLD "$S/jitprof-bench.log" 2>/dev/null; then
  echo "!!! never reached PLAYHOLD"; tail -25 "$S/jitprof-bench.log"; kill $BENCH 2>/dev/null; exit 1
fi
echo "=== PLAYHOLD reached $(date +%H:%M:%S), attaching profiler"

PROF_ATTACH=$PORT PROF_DIST=dist-jit PROF_TOP=45 \
  timeout 400 node tools/wprof2.mjs 60 "dist=dist-jit" 100 > "$S/jitprof-prof.log" 2>&1
echo "prof rc=$? $(date +%H:%M:%S)"

wait $BENCH 2>/dev/null
echo "=== by module ==="
grep -A12 'by module' "$S/jitprof-prof.log" || tail -30 "$S/jitprof-prof.log"
echo "JITPROF DONE"
