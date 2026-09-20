#!/usr/bin/env bash
# Round 34's LG change: prove the counter first, then price the mechanisms.
#
# The trap this script exists to avoid: on a non-icount board the MIPS
# readout *is* wasm_tb_stats[1], which is the counter the patch moves.
# A wrong charge or a missed refund would show up as a MIPS change with
# no engine change behind it -- a false win or a false regression, and
# nothing on the LG side can tell the difference.  So:
#
#   1. acctcheck on cx70 (an icount board) with W64_TBSTATS=1.  There
#      wasm_insns() reports icount and ignores the inline counter, so the
#      two are independent counts of the same instructions.  If the
#      mechanisms move the ratio, stop -- the number is not measuring
#      speed.
#   2. only then, ke800 paired against the pre-patch dist, rotated,
#      because this host drifts ~10 % in fifteen minutes (round 33).
#      Report fps alongside MIPS: fps is framebuffer blits per wall
#      second and shares nothing with the instruction counter, so two
#      metrics agreeing is what makes the verdict a verdict.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"

BASE=dist-jit-r34base
NEW=dist-jit

echo "=== 1. counter exactness (cx70, icount, W64_TBSTATS=1)"
node tools/acctcheck.mjs --board cx70 --dist "$NEW" --from 130 --window 20 \
  2>&1 | tee "$S/acctcheck.log"
if ! grep -q "charges and refunds hold" "$S/acctcheck.log"; then
  echo "!! accounting check did not pass -- not running the LG A/B"
  exit 1
fi

echo
echo "=== 2. ke800 paired, rotated (4 rounds x 2 arms)"
: > "$S/lgab.log"
for r in 1 2 3 4; do
  if [ $((r % 2)) -eq 1 ]; then order="$BASE $NEW"; else order="$NEW $BASE"; fi
  for d in $order; do
    tag="lg${r}_${d}"
    timeout 900 node tools/uibench.mjs --board ke800 --dist "$d" \
      --state menu --settle 60 --measure 20 \
      > "$S/$tag.out" 2>&1
    echo "$tag rc=$? $(date +%H:%M:%S) $(grep -ha 'MIPS=' "$S/$tag.out" | tail -1)" \
      | tee -a "$S/lgab.log"
  done
done

python3 - "$S" <<'PY'
import os, re, sys, statistics as st
S = sys.argv[1]
arms = ["dist-jit-r34base", "dist-jit"]
got = {}
for r in (1, 2, 3, 4):
    for a in arms:
        p = os.path.join(S, f"lg{r}_{a}.out")
        if not os.path.exists(p):
            continue
        t = open(p, errors="replace").read()
        m = re.search(r"MIPS=([0-9.]+)", t)
        f = re.search(r"fps=([0-9.]+)", t)
        if m:
            got[(a, r)] = (float(m.group(1)), float(f.group(1)) if f else 0.0)

for i, name in enumerate(("MIPS", "fps")):
    d = [(got[(arms[1], r)][i] / got[(arms[0], r)][i] - 1) * 100
         for r in (1, 2, 3, 4) if (arms[0], r) in got and (arms[1], r) in got]
    if not d:
        continue
    note = ""
    if len(d) > 1:
        sd = st.stdev(d)
        note = f"  sd {sd:.2f}%" + ("  [consistent]" if abs(st.mean(d)) > 2 * sd
                                    else "  [not resolved]")
    print(f"{name:<5} new vs pre-patch: " + " ".join(f"{x:+6.2f}%" for x in d) +
          f"   mean {st.mean(d):+.2f}%{note}")
print("\nBoth metrics must move together and in the same direction. MIPS alone "
      "is the counter the patch touches; fps alone is a display rate that a "
      "faster engine only moves if the board was CPU-bound.")
PY
