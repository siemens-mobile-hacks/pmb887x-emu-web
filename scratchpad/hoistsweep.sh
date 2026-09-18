#!/usr/bin/env bash
# Price the TLB mask/table hoist before building it.
#
# Every guest memop re-loads fast->mask and fast->table from env to reach
# the TLB table, then indexes it and loads the entry.  The first two loads
# are invariant between TLB flushes, so a TB could keep them in two locals
# and every memop after the first in a straight-line run would skip them.
# Building that is not cheap -- tlb_mmu_resize_locked g_free()s the table
# under a TB that is holding it, so the cache has to be invalidated at
# every call, label and slow-path return -- so price the ceiling first.
#
# W64_TLBHOIST=N duplicates exactly the two loads the hoist would delete,
# N-1 times per memop, against mmu index ^ 1 so nothing is CSE'd with the
# real probe, result folded into a per-site sink.  The slope of ms/Mi over
# N is the cost of one mask/table pair per executed memop -- which is the
# hoist's ceiling, since a real hoist still pays for the first memop of
# every run.  If the ceiling is small the hoist is dead without writing it.
#
# Why re-measure instead of scaling the standing 4.9 % projection: that
# number was mostly the *bound checks* on these two loads, and round
# thirty-six moved the linear memory to wasm32, which handed those checks
# to the engine's guard pages.  What remains is load traffic alone.
#
# Four levels rather than a pair, because a slope over four points
# survives one bad leg and a difference of two does not.  N=1 emits only
# the sink store of a constant, so it is the zero-pair point and the whole
# fit is within-mechanism: the sink, the extra local traffic and the
# translation-time cost are common to all four legs and drop out.
#
# Order rotates by repeat (1234 / 2341 / 3412 / 4123), a full Latin square
# over four repeats, so every level occupies every position exactly once
# and a within-repeat warm-up cannot masquerade as a slope.
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad
FLASH=/workspace/fullflashes/CX70_games.bin
START='center:10000,center:10000,center:10000,center:8000'

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  (cd /workspace && node serve.mjs >"$S/serve-hoist.log" 2>&1 &)
  for _ in $(seq 1 10); do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

run() { # $1 tag  $2 N
  EXTRA_Q="env=W64_TLBHOIST%3D$2" timeout 900 node tools/j2mebench.mjs \
    --dist dist-jit --flash "$FLASH" --game 5 --start "$START" \
    --tracec --warm 2000 --window 20000 --tag "$1" \
    > "$S/$1.log" 2>&1
  echo "rc=$?"
}

say() { grep -haoE 'MIPS/cpu=[0-9.]+|duty=[0-9.]+|ms/Mi=[0-9.]+|ldstGen/Mi=[0-9.]+' "$1" | tr '\n' ' '; }

for r in 1 2 3 4; do
  case $r in
    1) order="1 2 3 4" ;;
    2) order="2 3 4 1" ;;
    3) order="3 4 1 2" ;;
    4) order="4 1 2 3" ;;
  esac
  for n in $order; do
    t="hs$r-$n"
    echo "=== r$r N=$n $(date +%H:%M:%S)"
    echo "r$r N=$n $(run "$t" "$n")  $(say "$S/$t.log")"
  done
done

echo "=== hoist ceiling sweep done $(date +%H:%M:%S)"
python3 scratchpad/hoistan.py
echo "HOISTSWEEP DONE"
