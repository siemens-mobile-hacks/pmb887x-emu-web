#!/usr/bin/env bash
# Round 2 of the code-granule mask A/B, at 256 granules and counterbalanced.
#
# Round 1 gave +0.97 % +/- 4.61 % over four pairs -- useless, for two
# reasons that are both design, not sample size:
#
#   1. `for leg in on off` put ON at position 1 of every repeat and OFF at
#      position 2.  Leg was perfectly confounded with position, so any
#      warm-up or drift inside a repeat reads as a leg effect.  Here the
#      order alternates (ABBA), so ON and OFF each occupy each position an
#      equal number of times.
#
#   2. At 64 granules (16 bytes on a 1 KB page) the mask hit only 45.8-57.4 %
#      of stores, so it could claim at most half of the walk.  Regressing
#      ms/Mi on smcWalk over all eight round-1 runs gives 8.43 ns per list
#      step and puts the WHOLE walk at 5.0 % of wall -- so half of it is
#      ~2.5 %, well under the +/- 4.6 % this host resolves.  At 256 granules
#      a granule is 4 bytes, one ARM instruction, and only a store landing
#      in the same word as real code can false-hit.
#
# Same binary both legs; W64_NOSMCMASK=1 restores the unconditional walk.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"
OFFQ='env=W64_NOSMCMASK%3D1'
FLASH=/workspace/fullflashes/CX70_games.bin
START='center:10000,center:10000,center:10000,center:8000'

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  (cd /workspace && node serve.mjs >"$S/serve-smcab2.log" 2>&1 &)
  for _ in $(seq 1 10); do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

run() { # $1 tag  $2 extraQ
  EXTRA_Q="$2" timeout 900 node tools/j2mebench.mjs --dist dist-jit \
    --flash "$FLASH" --game 5 --start "$START" \
    --tracec --warm 2000 --window 20000 --tag "$1" \
    > "$S/$1.log" 2>&1
  echo "rc=$?"
}

say() { grep -haoE 'MIPS/cpu=[0-9.]+|duty=[0-9.]+|ms/Mi=[0-9.]+|smcMiss=[0-9.]+|smcMask=[0-9.]+|smcWalk=[0-9.]+' "$1" | tr '\n' ' '; }

for r in 1 2 3 4 5 6; do
  # ABBA: odd repeats run on-then-off, even repeats off-then-on
  if [ $((r % 2)) -eq 1 ]; then order="on off"; else order="off on"; fi
  for leg in $order; do
    q=""; [ "$leg" = off ] && q="$OFFQ"
    t="sq$r$leg"
    echo "=== r$r $leg $(date +%H:%M:%S)"
    echo "r$r $leg $(run "$t" "$q")  $(say "$S/$t.log")"
  done
done

echo "=== smc A/B round 2 done $(date +%H:%M:%S)"
python3 tools/perf/smcan.py sq
echo "SMCAB2 DONE"
