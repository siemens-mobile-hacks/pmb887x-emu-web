#!/usr/bin/env bash
# dist-jit (wasm64 memory) vs dist-jit-mem32 (Binaryen-lowered wasm32
# memory) on two J2ME games.
#
# What to expect, from bcprobe (bc-on.log / bc-off.log), which already
# measured the two access shapes with checks on and off:
#   kernel 2, a loaded base -- the inline TLB probe and guest ld/st:
#     i64 0.146 -> i32 0.118 ns, and the checks-off control drops i64 to
#     0.121, so that gap IS a bound check and wasm32 removes it.
#   kernel 1, constant offsets off one base -- env register traffic:
#     i64 0.219 vs i32 0.220, nothing to collect; V8 already shares one
#     check across the group.
# So this is NOT a uniform win: it should land on the memory path and not
# on env traffic.  The doc forecasts 15-19 % of wall, and says to plan
# against the 59 % end.  Note the variant also ADDS an i32.wrap_i64 at
# every address push (w64_wrap_addr), so a null result is a real outcome.
#
# The deployed site/dist-jit was built at 18:38 and the tree moved at
# 18:41-18:58, so it is a DIFFERENT TREE from the mem32 artifact.  Reading
# the five diffs says every one of them is codegen-neutral for the default
# build (comment-only; the W64_MEM_LIMITS macro's default branch is the
# value that was hardcoded; the EM_JS table probe is behaviour-identical
# under MEMORY64=1; the w64_*_addr wrappers reduce to the exact prior calls
# when W64_MEM32 is undefined; the W64_TBSTATS parse is unchanged when the
# variable is unset, which it is here).  That argument is only as good as
# my reading of it, so rebuild the baseline from the current tree instead
# of trusting it: then the A/B is same-tree by construction, and the byte
# comparison below says whether the audit was right as a side effect.
#
# Interleaved base/mem32 within each repeat, not blocked: the previous A/B
# on this host came back "not resolved" at sd 5-6 % on a mean of -1.8 %,
# and drift across a two-hour block is the cheapest explanation to rule
# out.  Pairing within a repeat differences that drift away.
#
# No pgrep anywhere.  Waiting on `pgrep -f '[a]fter.sh'` deadlocked this
# machine once already: another waiter's own command line carried the text
# being matched, so each waited for the other.  Poll the log file instead
# -- a file cannot match itself.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"

for f in site/dist-jit-mem32/qemu-system-arm.js site/dist-jit-mem32/qemu-system-arm.wasm; do
  [ -s "$f" ] || { echo "!!! missing $f"; exit 1; }
done

OLD=$(sha256sum site/dist-jit/qemu-system-arm.wasm | cut -c1-16)
echo "=== baseline rebuild from the current tree $(date +%H:%M:%S) (was $OLD)"
bash scripts/build-qemu-wasm64.sh > "$S/basebuild.log" 2>&1
rc=$?
echo "== baseline build exit $rc at $(date +%H:%M:%S)" >> "$S/basebuild.log"
if [ $rc -ne 0 ]; then
  echo "!!! baseline rebuild failed, not benchmarking:"; tail -25 "$S/basebuild.log"
  exit 1
fi
NEW=$(sha256sum site/dist-jit/qemu-system-arm.wasm | cut -c1-16)
if [ "$OLD" = "$NEW" ]; then
  echo "=== baseline unchanged ($NEW): the neutrality audit was right"
else
  echo "=== baseline CHANGED $OLD -> $NEW"
  echo "=== (either a diff was not neutral, or the build is not"
  echo "===  byte-reproducible; either way the A/B is now same-tree)"
fi
ls -la site/dist-jit-mem32/qemu-system-arm.wasm site/dist-jit/qemu-system-arm.wasm

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

# Smoke leg first.  A freshly migrated memory mode fails at the module
# boundary if anything about the memory or table type is out of step, and
# that failure looks like a hang from here: without this the run would
# spend 75 minutes producing six empty legs.  One game, and it is thrown
# away rather than pooled -- a first-run leg carries cold caches.
echo "=== smoke dist-jit-mem32 $(date +%H:%M:%S)"
echo "smoke $(run dist-jit-mem32 smoke 900 1)"
if ! ls tests/results/j2me-*-dist-jit-mem32-smoke*.json >/dev/null 2>&1; then
  echo "!!! mem32 smoke leg produced no result -- the variant does not run."
  echo "!!! last 30 lines:"
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
python3 tools/perf/mem32an.py
