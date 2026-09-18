#!/usr/bin/env bash
# Self-time profile of a *running* J2ME game: hold the played game on
# screen with devtools open, then attach the sampling profiler to the
# vCPU worker.  The hold keeps playing, so this is the game's steady
# state and not an idle canvas.
#   bash prof.sh [game] [profile-seconds]
set -u
cd /workspace
game=${1:-1}
secs=${2:-60}
log=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad/prof-bench.log
: > "$log"
node tools/j2mebench.mjs --dist dist-jit --game "$game" --devtools 9600 \
  --hold $((secs + 90)) --tag prof > "$log" 2>&1 &
bench=$!
echo "bench pid $bench, waiting for PLAYHOLD..."
for i in $(seq 1 60); do
  grep -q PLAYHOLD "$log" && break
  kill -0 $bench 2>/dev/null || { echo "bench died:"; tail -5 "$log"; exit 1; }
  sleep 10
done
grep -q PLAYHOLD "$log" || { echo "no PLAYHOLD in 600s"; tail -5 "$log"; kill $bench; exit 1; }
grep PLAYHOLD "$log"
sleep 5
out=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad/prof-$game.txt
PROF_SAVE=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad/prof-$game.json \
PROF_ATTACH=9600 PROF_DIST=dist-jit node tools/wprof2.mjs "$secs" "" 100 > "$out" 2>&1
echo "profile -> $out"
kill $bench 2>/dev/null
wait $bench 2>/dev/null
echo "=== bench tail ==="
grep -E "^J2ME|^perMi" "$log" | cut -c1-200
