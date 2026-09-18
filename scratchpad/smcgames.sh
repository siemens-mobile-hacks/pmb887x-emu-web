#!/usr/bin/env bash
# The mask across the whole catalogue, not just the title it was found on.
#
# game 5 (LOTR) is where the 14.7 % frame was profiled, so it is the title
# most likely to flatter the change.  A lever that only pays on its own
# discovery title is a tuning for that title; the user asked for overall
# J2ME performance.  Same binary both legs, W64_NOSMCMASK=1 for the
# baseline, interleaved per repeat so host drift hits both arms.
#
# Order 1,3,4,5,2 for the same reason price.sh uses it: a walk that fails
# three times exits the whole process, and Blade (game 2) needs the German
# language picker's LEFT soft key, so it goes last where a failure costs
# nothing already measured.
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad
FLASH=/workspace/fullflashes/CX70_games.bin
GEN='center:10000,center:10000,center:10000,center:8000'
BLADE='center:8000,left_soft:5000,left_soft:5000,center:5000,center:5000,left_soft:5000'
OFFQ='env=W64_NOSMCMASK%3D1'

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  (cd /workspace && node serve.mjs >"$S/serve-smcgames.log" 2>&1 &)
  for _ in $(seq 1 10); do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

run() { # $1 tag  $2 extraQ
  EXTRA_Q="$2" timeout 2400 node tools/j2mebench.mjs --dist dist-jit \
    --flash "$FLASH" --game 1,3,4,5,2 \
    --start "$GEN|$GEN|$GEN|$GEN|$BLADE" \
    --tracec --warm 2000 --window 20000 --tag "$1" \
    > "$S/$1.log" 2>&1
  echo "rc=$?"
}

for r in 1 2; do
  # ABBA: leg must not be tied to position within a repeat (round 1's flaw)
  if [ $((r % 2)) -eq 1 ]; then order="on off"; else order="off on"; fi
  for leg in $order; do
    q=""; [ "$leg" = off ] && q="$OFFQ"
    echo "=== r$r $leg $(date +%H:%M:%S)"
    echo "r$r $leg $(run "sg$r$leg" "$q")"
    grep -haoE 'game=[0-9]+ MIPS/cpu=[0-9.]+.*' "$S/sg$r$leg.log" |
      sed -E 's/hostBusy.*cpu=/cpu=/' || true
  done
done

echo "=== smc catalogue A/B done $(date +%H:%M:%S)"
python3 scratchpad/smcgan.py
echo "SMCGAMES DONE"
