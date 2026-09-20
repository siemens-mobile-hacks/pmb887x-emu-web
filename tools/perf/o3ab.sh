#!/usr/bin/env bash
# -O2 (what every build in this tree has actually used) vs -O3 (what the
# build script has been asking for since it was written).
#
# See doc/lessons.md, "A second --cross-file replaces the first one's
# built-in options": --extra-cflags reaches config-meson.cross and is then
# replaced wholesale by configs/meson/emscripten.txt's c_args=['-pthread'],
# so build/qemu-wasm64/build.ninja carries 2240 -O2 and 0 -O3.
#
# The -O2 does not come from a stray flag: `meson configure build/qemu-wasm64`
# reports optimization=2, pinned by qemu's own configure through meson's
# built-in option.  So W64_O3=1 sets -Doptimization=3 on the meson configure
# line the script already uses for -Dc_link_args.  That REPLACES the flag
# rather than appending a second -O, so the result does not depend on which
# -O meson emits last; and a command-line -D is the one route a cross file
# loaded later cannot override.
#
# Expect either sign.  -O3 inlines harder; on a 28 MB module that can cost
# more in engine compile time and code locality than it returns, and this
# backend's hot path is JIT-emitted code that -O3 never sees.  What it does
# reach is every C helper, cputlb, the softmmu path and the translator.
#
# Both arms are mem32 (round thirty-six made -sMEMORY64=2 the default), so
# this prices -O3 on top of the memory model that is actually shipping
# rather than against one nobody intends to ship.
#
# Same pairing discipline as the mem32 A/B: interleaved within a repeat,
# never blocked, because this host drifts across a two-hour block.  Screen
# the pairs on hostBusy afterwards -- that A/B lost one leg to a host burst.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"

echo "=== building -O3 variant $(date +%H:%M:%S)"
W64_O3=1 bash scripts/build-qemu-wasm64.sh > "$S/o3build.log" 2>&1
rc=$?
echo "== exit $rc at $(date +%H:%M:%S)" >> "$S/o3build.log"
if [ $rc -ne 0 ]; then
  echo "!!! -O3 build failed:"; tail -25 "$S/o3build.log"; exit 1
fi

# The check the mem32 round had to learn: prove the flag reached a compile
# line before spending browser time on it.
# grep -c prints "0" AND exits 1 when nothing matches, so `|| echo 0` appends
# a SECOND line and n becomes the two-line string "0\n0" -- which is != 0 and
# fired a false "-O2 is still present" alarm on a build that had 2240 -O3 and
# 0 -O2.  Take the exit status separately and let ${:-0} cover an empty read.
n3=$(grep -c -- '-O3' build/qemu-wasm64-o3/build.ninja 2>/dev/null); true
n2=$(grep -c -- '-O2' build/qemu-wasm64-o3/build.ninja 2>/dev/null); true
n3=${n3:-0}; n2=${n2:-0}
echo "=== -O3 occurrences: $n3   -O2 occurrences: $n2"
if [ "$n3" = 0 ]; then
  echo "!!! -O3 never reached a compile line -- not benchmarking."; exit 1
fi
if [ "$n2" != 0 ]; then
  echo "!!! -O2 is still present even though -Doptimization=3 replaces it:"
  echo "!!! something other than the built-in option is injecting it, so"
  echo "!!! this arm is not purely -O3.  Check build.ninja before trusting it."
fi
echo "=== flags landed $(date +%H:%M:%S)"

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  (cd /workspace && node serve.mjs >"$S/serve-o3ab.log" 2>&1 &)
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

FLASH=/workspace/fullflashes/CX70_FW56_clean.bin
START='center:10000,center:10000,center:10000,center:8000'

run() {
  timeout "$3" node tools/j2mebench.mjs --dist "$1" \
    --flash "$FLASH" --game "$4" --start "$START" \
    --tracec --window 30000 --tag "$2" \
    > "$S/$2-$1.log" 2>&1
  echo "rc=$?"
}

rm -f tests/results/j2me-*-dist-jit-o3-smoke*.json
echo "=== smoke dist-jit-o3 $(date +%H:%M:%S)"
echo "smoke $(run dist-jit-o3 smoke 900 1)"
if ! ls tests/results/j2me-*-dist-jit-o3-smoke*.json >/dev/null 2>&1; then
  echo "!!! -O3 smoke leg produced no result:"; tail -30 "$S/smoke-dist-jit-o3.log"
  exit 1
fi

for r in 1 2 3; do
  for d in dist-jit dist-jit-o3; do
    echo "=== r$r $d $(date +%H:%M:%S)"
    echo "r$r $d $(run "$d" "oo$r" 1500 1,2) $(grep -haoE 'MIPS/cpu=[0-9.]+' "$S/oo$r-$d.log" | tr '\n' ' ')"
  done
done

echo "=== -O3 A/B done $(date +%H:%M:%S)"
AB_A=dist-jit AB_B=dist-jit-o3 AB_TAG=oo python3 tools/perf/mem32an.py
