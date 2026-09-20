#!/usr/bin/env bash
# The memory-op denominator, which the J2ME census has never had.
#
# ~75 % of this workload's wall is inside TB bodies at ~11 host cycles per
# guest ARM instruction, and the only structural thing in a body that has
# been priced is the inline TLB probe (5.07 %, by deletion).  Everything
# else is guessed, because the census counts memory ops *emitted*
# (ldstGen 6.25/Mi -- a translation rate) and never once counted them
# executed.  Without that denominator "the probe costs 5 %" cannot be
# turned into "a probe costs N ns", and LDM/STM -- which move a whole
# register list through one probe each -- cannot be sized at all.
#
# W64_LDSTCOUNT=2 gives ldstExec (every executed guest memory op) and
# W64_LSMCOUNT=1 gives lsmN/lsmExec (LDM/STM instructions, and the
# registers they moved).  Both emit counter bumps into the generated
# code, so this is a measurement build: ms/Mi from this leg is
# meaningless and only the per-Mi rates transfer.  That is also why it
# does not belong in the rotated sweep -- nothing here is being A/B'd.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"

FLASH=/workspace/fullflashes/CX70_FW56_clean.bin
START='center:10000,center:10000,center:10000,center:8000'

EXTRA_Q='env=W64_LDSTCOUNT=2&env=W64_LSMCOUNT=1' \
timeout 3000 node tools/j2mebench.mjs --dist dist-jit \
  --flash "$FLASH" --game 1,2 --start "$START" \
  --tracec --window 45000 --tag census \
  > "$S/census.log" 2>&1
echo "census rc=$? $(date +%H:%M:%S)"

python3 - "$S/census.log" <<'PY'
import re, sys

want = ["ldstExec", "ldstGen", "ldstNoprobe", "ldstGenNoprobe", "ldstMiss",
        "lsmN", "lsmExec", "tbIcount", "tbGen", "slowMiss", "tlbFill"]
rows = []
for m in re.finditer(r"perMi:(.*)", open(sys.argv[1], errors="replace").read()):
    rows.append({k: float(v) for k, v in
                 re.findall(r"([A-Za-z_]\w*)=([0-9.]+)", m.group(1))})
if not rows:
    sys.exit("no perMi lines")

print(f"{'counter':<16}" + "".join(f"{('leg%d' % i):>14}" for i in range(len(rows))))
for k in want:
    print(f"{k:<16}" + "".join(f"{r.get(k, 0.0):>14.3f}" for r in rows))

for i, r in enumerate(rows):
    ex = r.get("ldstExec", 0.0)
    if not ex:
        print(f"\nleg{i}: ldstExec is 0 -- W64_LDSTCOUNT=2 did not reach qemu "
              f"(one assignment per env=)")
        continue
    lsm, lsmex = r.get("lsmN", 0.0), r.get("lsmExec", 0.0)
    print(f"\nleg{i}: {ex:,.0f} guest memory ops per Mi = "
          f"{ex/1e6*100:.1f}% of guest instructions")
    print(f"   inline probe 5.07% of wall over {ex:,.0f} ops "
          f"= {5.07/100*4.36e6/ex:.2f} ns per probe (at 4.36 ms/Mi)")
    if lsm:
        print(f"   LDM/STM: {lsm:,.0f}/Mi moving {lsmex:,.0f} registers "
              f"= {lsmex/lsm:.2f} each, {lsmex/ex*100:.1f}% of all memory ops")
        print(f"   one probe per instruction instead of per register would "
              f"drop {lsmex-lsm:,.0f} probes/Mi = "
              f"{(lsmex-lsm)/ex*5.07:.2f}% of wall")
PY
