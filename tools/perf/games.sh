#!/usr/bin/env bash
# What is actually in CX70_games.bin, and which entries can be benchmarked?
#
# Every performance number this session rests on ONE title: entries 1 and 2
# of CX70_FW56_clean.bin are both AMF Bowling (that image has a single game
# in its list, so scrolling down one entry stays put), which makes the
# "two games" of the A/Bs two independent windows on the same workload.
# A J2ME lever proven on one game is not proven.
#
# This is discovery, not measurement: one boot, short windows, and the
# -game.png of each entry is the deliverable.  A game that never started
# reads as enormous headroom at duty ~0.09, and frame counts cannot tell an
# animated title screen from play -- the panel can, which is why --shots is
# on and why every entry gets looked at by eye before it is trusted.
#
# Entries that need their own key plan (a language picker, a "press any
# key" splash) will show up here as a title screen in the shot; --start
# takes one plan per --game entry separated by "|", so the real sweep can
# carry per-game plans once this run says which entries need them.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  (cd /workspace && node serve.mjs >"$S/serve-games.log" 2>&1 &)
  for _ in $(seq 1 10); do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

FLASH=/workspace/fullflashes/CX70_games.bin
START='center:10000,center:10000,center:10000,center:8000'

# One boot, eight entries.  A boot is ~150 s and a short window is seconds,
# so the sweep form is the only affordable way to see eight games.
timeout 2400 node tools/j2mebench.mjs --dist dist-jit \
  --flash "$FLASH" --game 1,2,3,4,5,6,7,8 --start "$START" \
  --tracec --shots 2 --warm 2000 --window 12000 --tag disc \
  > "$S/games-disc.log" 2>&1
echo "rc=$? $(date +%H:%M:%S)"

echo "=== entries that produced a result"
grep -haoE 'game=[0-9]+ MIPS/cpu=[0-9.]+ .*duty=[0-9.]+' "$S/games-disc.log" |
  sed -E 's/ hostBusy.*cpu=/ cpu=/' || true
echo "=== failures"
grep -haE 'J2ME FAIL|could not reach' "$S/games-disc.log" || echo "none"
echo "=== shots"
ls -1 tests/results/*-disc-g*-game.png 2>/dev/null || echo "none"
