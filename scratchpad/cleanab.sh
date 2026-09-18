#!/usr/bin/env bash
# Price reusing the CODE dirty flag instead of re-deriving it with is_clean().
#
# notdirty_write() reads DIRTY_MEMORY_CODE, then sets VGA+MIGRATION, then
# asks physical_memory_is_clean(), which is !(vga && code && migration) --
# so after that set its answer is just the CODE bit it already read.  The
# scan in between can only disturb that bit when it reports going the long
# way, which on a J2ME title is 1 store in 5500.
#
# is_clean() is out of line in system/physmem.c and calls
# physical_memory_get_dirty_flag() three times; each of those is an RCU
# read-guard, an RCU-read of the block table and an out-of-line
# find_next_bit() for a single bit.  Three of them, ~480 times per Mi.
#
# Same binary both legs; W64_NOCLEANREUSE=1 restores the is_clean() call.
# ABBA order, for the reason round 1 of the mask A/B had to be thrown away.
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad
OFFQ='env=W64_NOCLEANREUSE%3D1'
FLASH=/workspace/fullflashes/CX70_games.bin
START='center:10000,center:10000,center:10000,center:8000'

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  (cd /workspace && node serve.mjs >"$S/serve-cleanab.log" 2>&1 &)
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
    t="sc$r$leg"
    echo "=== r$r $leg $(date +%H:%M:%S)"
    echo "r$r $leg $(run "$t" "$q")  $(say "$S/$t.log")"
  done
done

echo "=== is_clean reuse A/B done $(date +%H:%M:%S)"
python3 scratchpad/smcan.py sc
echo "CLEANAB DONE"
