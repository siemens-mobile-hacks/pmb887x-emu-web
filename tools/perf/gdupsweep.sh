#!/usr/bin/env bash
# Price the guest-register traffic row, which the budget table has carried
# as "unpriced" since it was found.
#
# Every global TCG holds in a register has a canonical home in env, and
# TCG writes it back at every basic-block end, before every op that can
# fault, before every helper that touches env, and at the TB's exit --
# then re-loads it on the next use.  On game 5 that is tcgGst 10.573 +
# tcgGld 8.437 per Mi against tbIcount 9.531, i.e. ~2.0 memory operations
# per translated guest instruction, and nothing has ever measured what
# they cost.
#
# W64_GDUP=N emits N-1 extra copies of each of those loads and stores, to
# the same address with the same value.  The slope of ms/Mi over N is the
# cost of one whole round of guest-register traffic.  That is the ceiling
# for any scheme that removes some of it -- pinning globals to TB-lifetime
# wasm locals, say, which this backend could do and a register-poor native
# backend could not, and which would collect the BB-end share of it.
#
# The probe is self-checking.  It relies on V8's baseline tier not doing
# store-to-store or load-to-load elimination on the duplicates; if that
# assumption is wrong the copies vanish and the slope reads zero.  A zero
# slope here therefore means "the probe is inert", not "the traffic is
# free", and the two are told apart by whether the wasm actually grew --
# so check the module size, not just the wall clock.
#
# Same Latin square as the hoist sweep: four levels, four repeats, each
# level in each position exactly once.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"
FLASH=/workspace/fullflashes/CX70_games.bin
START='center:10000,center:10000,center:10000,center:8000'

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  (cd /workspace && node serve.mjs >"$S/serve-gdup.log" 2>&1 &)
  for _ in $(seq 1 10); do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

run() { # $1 tag  $2 N
  EXTRA_Q="env=W64_GDUP%3D$2" timeout 900 node tools/j2mebench.mjs \
    --dist dist-jit --flash "$FLASH" --game 5 --start "$START" \
    --tracec --warm 2000 --window 20000 --tag "$1" \
    > "$S/$1.log" 2>&1
  echo "rc=$?"
}

say() { grep -haoE 'MIPS/cpu=[0-9.]+|duty=[0-9.]+|ms/Mi=[0-9.]+|tbBytes/Mi=[0-9.]+' "$1" | tr '\n' ' '; }

for r in 1 2 3 4; do
  case $r in
    1) order="1 2 3 4" ;;
    2) order="2 3 4 1" ;;
    3) order="3 4 1 2" ;;
    4) order="4 1 2 3" ;;
  esac
  for n in $order; do
    t="gd$r-$n"
    echo "=== r$r N=$n $(date +%H:%M:%S)"
    echo "r$r N=$n $(run "$t" "$n")  $(say "$S/$t.log")"
  done
done

echo "=== guest-register traffic sweep done $(date +%H:%M:%S)"
python3 tools/perf/gdupan.py
echo "GDUPSWEEP DONE"
