#!/usr/bin/env bash
# Price the page code-granule mask (tb_page_covers' early out).
#
# The JIT-vs-C profile of game 5 put 70.9 % of the vCPU in emitted TB code
# and 28.7 % in the main module -- and tb_invalidate_phys_range_fast alone
# was 14.7 %, half of all C time and the largest single frame anywhere
# outside emitted code.  It is reached 485.7 times per Mi (slowNotdirty)
# and answers "no TB covers this store" 485.6 of those times (smcMiss),
# after walking the page's whole TB list to find out.
#
# The mask caches that answer per page at 1/64th-page granularity.  Both
# legs are the SAME binary -- W64_NOSMCMASK=1 restores the unconditional
# walk -- so nothing but the early out differs, and the counters are
# instrumented identically in both.
#
# The OFF leg is also the measurement: smcWalk / (smcMiss - smcMask) is the
# chain length a store used to pay, which is what decides whether 14.7 % is
# a list walk or the page_find in front of it.  Run it first and read that
# before spending the rest of the block.
#
# Interleaved within a repeat, never blocked: this host drifts across a
# long block and hostBusy screens the pairs afterwards.
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad
OFFQ='env=W64_NOSMCMASK%3D1'
FLASH=/workspace/fullflashes/CX70_games.bin
START='center:10000,center:10000,center:10000,center:8000'

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  (cd /workspace && node serve.mjs >"$S/serve-smcab.log" 2>&1 &)
  for _ in $(seq 1 10); do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

run() { # $1 tag  $2 extraQ  $3 game  $4 timeout
  EXTRA_Q="$2" timeout "$4" node tools/j2mebench.mjs --dist dist-jit \
    --flash "$FLASH" --game "$3" --start "$START" \
    --tracec --warm 2000 --window 20000 --tag "$1" \
    > "$S/$1.log" 2>&1
  echo "rc=$?"
}

say() { grep -haoE 'MIPS/cpu=[0-9.]+|duty=[0-9.]+|ms/Mi=[0-9.]+|smcMiss=[0-9.]+|smcMask=[0-9.]+|smcWalk=[0-9.]+' "$1" | tr '\n' ' '; }

# The smoke leg already ran by hand: mask=0.0 (the knob bites), 480.5 calls
# per Mi, 24453 list steps per Mi -- a chain of 50.89 TBs per store.  That
# is the 14.7 %, so the block below is worth its wall time.
for r in 1 2 3 4; do
  for leg in on off; do
    q=""; [ "$leg" = off ] && q="$OFFQ"
    t="sm$r$leg"
    echo "=== r$r $leg $(date +%H:%M:%S)"
    echo "r$r $leg $(run "$t" "$q" 5 900)  $(say "$S/$t.log")"
  done
done

echo "=== smc A/B done $(date +%H:%M:%S)"
python3 scratchpad/smcan.py
echo "SMCAB DONE"
