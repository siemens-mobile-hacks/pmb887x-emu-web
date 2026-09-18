#!/usr/bin/env bash
# Is there a bound check left after the memory model fixed the memory?
#
# Round 35 priced --no-wasm-bounds-checks at -24.51 % +/- 1.53 of wall.
# Round 36's mem32 collected -15.92 % +/- 1.78.  The intervals do not
# overlap, so ~8.6 % of wall is spent on something the V8 flag removes and
# a wasm32 memory does not.  The obvious suspect is the *table* check on
# the indirect call every TB exit makes -- goto_ptr is 67.7 % of exits at
# 55,385 exits/Mi, and a guard page bounds a memory, never a table.
#
# This re-runs the flag arm on top of mem32 rather than against the old
# baseline, which is the only comparison that answers the question.  It is
# a browser flag, so both arms are the same binary: nothing can differ
# except what the engine does with it.
#
#   large residue  -> the table check is real and worth a round
#   ~zero residue  -> mem32 is at its ceiling and the round-35 gap was
#                     mem32's own address-wrapping cost, not residue
#
# NOT shippable either way.  A V8 flag is a ceiling probe, not a change.
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad

# The arms are the same dist, so the tag is the only thing separating them
# in tests/results; mem32an.py takes AB_TAGA/AB_TAGB for exactly this.
DIST=dist-jit
FLASH=/workspace/fullflashes/CX70_FW56_clean.bin
START='center:10000,center:10000,center:10000,center:8000'

if [ ! -f "site/$DIST/qemu-system-arm.wasm" ]; then
  echo "!!! site/$DIST not built"; exit 1
fi
# Guard against measuring the pre-flip artifact: the default is only the
# mem32 build after scripts/build-qemu-wasm64.sh has re-run.
if cmp -s "site/$DIST/qemu-system-arm.wasm" site/dist-jit-mem64/qemu-system-arm.wasm; then
  echo "!!! site/$DIST is still byte-identical to the mem64 artifact --"
  echo "!!! the default flip has not been built.  Refusing to measure."
  exit 1
fi

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  (cd /workspace && node serve.mjs >"$S/serve-nobc.log" 2>&1 &)
  for _ in $(seq 1 10); do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

run() { # <tag> <chrome args> <timeout>
  CHROME_ARGS="$2" timeout "$3" node tools/j2mebench.mjs --dist "$DIST" \
    --flash "$FLASH" --game 1,2 --start "$START" \
    --tracec --window 30000 --tag "$1" \
    > "$S/$1.log" 2>&1
  echo "rc=$?"
}

NOBC='--js-flags=--no-wasm-bounds-checks'

for r in 1 2 3; do
  echo "=== r$r plain $(date +%H:%M:%S)"
  echo "r$r plain $(run "nbp$r" "" 1500) $(grep -haoE 'MIPS/cpu=[0-9.]+' "$S/nbp$r.log" | tr '\n' ' ')"
  echo "=== r$r nobc  $(date +%H:%M:%S)"
  echo "r$r nobc  $(run "nbn$r" "$NOBC" 1500) $(grep -haoE 'MIPS/cpu=[0-9.]+' "$S/nbn$r.log" | tr '\n' ' ')"
done

echo "=== nobc probe done $(date +%H:%M:%S)"
AB_A=$DIST AB_TAGA=nbp AB_B=$DIST AB_TAGB=nbn python3 scratchpad/mem32an.py
