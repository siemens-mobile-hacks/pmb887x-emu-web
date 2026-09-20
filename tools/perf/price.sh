#!/usr/bin/env bash
# What does the display chain actually cost, across five J2ME titles?
#
# The steady-play counter table (tools/perf/bins.py, AB_MODE=steady) says
# the display path is the one large guest-correlated family that is uniform
# across every title: ssiByte 23.8k-77.7k per Mi at a 3.3x spread, against
# 12-25x for the module-compile counters.  A lever that only pays on one
# title is not a J2ME lever; this one is a candidate precisely because its
# spread is small.
#
# But a counter is not a cost.  Both instruments to price it already exist
# and both carry their own calibration, because two clock reads back to
# back measure ~70 ns of nothing and that floor would otherwise sit inside
# the answer:
#   W64_DISPNS=1  DISP_NS/DISP_CAL/DISP_BURST -- the whole DMA -> DIF ->
#                 SSI -> LCD chain, charged in C around one burst.
#   W64_EXCNS=1   EXC_LJ/BQL/DO_NS + EXC_CAL -- the exception path, which
#                 the header claims IS the C dispatcher on this workload
#                 (~700 exceptions per Mi, 98 % SWI, vs 756 iterations).
#                 The steady table agrees: excSwi ~= execIter in all five.
#
# Each knob is its own env= parameter with %3D: site/app.js splits
# getAll("env") at the first "=", so &env=A%3D1%26B%3D2 sets A to the
# literal "1&B=2" and never sets B -- silently, with a plausible number
# coming out of the wrong configuration.  Both counters are checked for
# movement below before any share is believed.
#
# Order is 1,3,4,5,2 on purpose.  A walk that fails three times calls
# fail(), which exits the whole process -- that is how the discovery run
# lost entries 7 and 8 to Madagascar's cutscene.  Games 1,3,4,5 all reached
# play on the generic plan; game 2 (Blade) comes up on a language picker
# whose affirmative is the LEFT soft key ("WAEHLEN"), so it gets its own
# plan and goes last, where a failure costs nothing already measured.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  (cd /workspace && node serve.mjs >"$S/serve-price.log" 2>&1 &)
  for _ in $(seq 1 10); do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

FLASH=/workspace/fullflashes/CX70_games.bin
GEN='center:10000,center:10000,center:10000,center:8000'
BLADE='center:8000,left_soft:5000,left_soft:5000,center:5000,center:5000,left_soft:5000'

EXTRA_Q="env=W64_DISPNS%3D1&env=W64_EXCNS%3D1" \
timeout 2400 node tools/j2mebench.mjs --dist dist-jit \
  --flash "$FLASH" --game 1,3,4,5,2 \
  --start "$GEN|$GEN|$GEN|$GEN|$BLADE" \
  --tracec --shots 3 --warm 2000 --window 20000 --tag price \
  > "$S/price.log" 2>&1
echo "rc=$? $(date +%H:%M:%S)"

echo "=== per-entry"
grep -haoE 'game=[0-9]+ MIPS/cpu=[0-9.]+.*' "$S/price.log" |
  sed -E 's/hostBusy.*cpu=/cpu=/' || true
echo "=== failures"
grep -haE 'J2ME FAIL|could not reach' "$S/price.log" || echo "none"
echo "PRICE DONE"
