#!/usr/bin/env bash
# Rebuild the mem32 variant with the define that never landed, prove it
# landed this time, then run the A/B.
#
# Round one failed at the module boundary, exactly as tcg/wasm64/wasm64.h
# warns it would: "cannot import i32 memory as i64".  Binaryen had lowered
# the main module's memory to 32-bit, but the modules the JIT emits still
# declared the import as i64, because -DW64_MEM32 never reached a compile
# line.  It was in --extra-cflags, which configure writes into the meson
# cross file's [built-in options] c_args -- and meson does not apply that
# block to compile commands.  -O3 and -DWASM_BIGINT are silently dropped
# the same way, which is a separate finding and a separate experiment.
#
# The fix routes the define through CPU_CFLAGS, which becomes the
# compiler's own argv in [binaries], keyed off the same
# --wasm64-32bit-address-limit that selects -sMEMORY64=2, so the two can
# no longer drift apart.
#
# The build dir must go: the configure guard skips an existing one, and
# the compiler argv is fixed at configure time.
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad

rm -rf build/qemu-wasm64-mem32
echo "=== rebuilding mem32 from scratch $(date +%H:%M:%S)"
W64_MEM32=1 bash scripts/build-qemu-wasm64.sh > "$S/mem32build2.log" 2>&1
rc=$?
echo "== exit $rc at $(date +%H:%M:%S)" >> "$S/mem32build2.log"
if [ $rc -ne 0 ]; then
  echo "!!! mem32 rebuild failed:"; tail -25 "$S/mem32build2.log"; exit 1
fi

# Prove the define reached a compile line before spending an hour of
# browser time on it.  This is the check whose absence cost round one:
# the build succeeded and deployed, and only the smoke leg found out.
n=$(grep -c -- '-DW64_MEM32' build/qemu-wasm64-mem32/build.ninja 2>/dev/null || echo 0)
echo "=== -DW64_MEM32 occurrences in build.ninja: $n"
if [ "$n" = 0 ]; then
  echo "!!! the define STILL does not reach a compile line -- not benchmarking."
  grep -a '^c = ' build/qemu-wasm64-mem32/config-meson.cross
  exit 1
fi
echo "=== define landed $(date +%H:%M:%S)"

if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  echo "!!! no cross-origin-isolated server on 8080; starting one"
  (cd /workspace && node serve.mjs >"$S/serve-mem32ab.log" 2>&1 &)
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

FLASH=/workspace/fullflashes/CX70_FW56_clean.bin
START='center:10000,center:10000,center:10000,center:8000'

run() {   # run <dist> <tag> <timeout> <games>
  timeout "$3" node tools/j2mebench.mjs --dist "$1" \
    --flash "$FLASH" --game "$4" --start "$START" \
    --tracec --window 30000 --tag "$2" \
    > "$S/$2-$1.log" 2>&1
  echo "rc=$?"
}

rm -f tests/results/j2me-*-dist-jit-mem32-smoke*.json
echo "=== smoke dist-jit-mem32 $(date +%H:%M:%S)"
echo "smoke $(run dist-jit-mem32 smoke 900 1)"
if ! ls tests/results/j2me-*-dist-jit-mem32-smoke*.json >/dev/null 2>&1; then
  echo "!!! mem32 smoke leg produced no result -- the variant still does not run."
  tail -30 "$S/smoke-dist-jit-mem32.log"
  exit 1
fi
echo "=== smoke ok, mem32 runs $(date +%H:%M:%S)"

for r in 1 2 3; do
  for d in dist-jit dist-jit-mem32; do
    echo "=== r$r $d $(date +%H:%M:%S)"
    echo "r$r $d $(run "$d" "ab$r" 1500 1,2) $(grep -haoE 'MIPS/cpu=[0-9.]+' "$S/ab$r-$d.log" | tr '\n' ' ')"
  done
done

echo "=== A/B done $(date +%H:%M:%S)"
python3 scratchpad/mem32an.py
