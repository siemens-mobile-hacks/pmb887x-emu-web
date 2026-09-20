#!/usr/bin/env python3
"""Report what a branchless A32 predication form could reach.

Two questions the budget table cannot currently answer:

  1. How much of GSYNC_BBEND is predication?  BBEND is charged at every
     label and every br; GSYNC_BBCOND is the part charged at a label
     arm_gen_condlabel made, so BBCOND/BBEND is the predication share and
     BBEND - BBCOND is everything else.

  2. How much of the predicated stream can a select actually replace?
     PRED_SEL is the narrowest filter (data processing, S clear, Rd not
     PC, immediate or immediate-shifted register).  The class buckets say
     what widening it would have to cover, and which part is out of reach
     for good: a load, a store and a branch cannot be selected.

The store ceiling for the narrow form is BBCOND * PRED_SEL / PRED_A32
plus the same share of GSYNC_CBR, since if-conversion removes the brcond
and the label together.
"""
import glob
import json
import os
import sys

pat = sys.argv[1] if len(sys.argv) > 1 else "tests/results/j2me-*.json"
files = sorted(glob.glob(pat), key=os.path.getmtime)
rows = []
for f in files:
    try:
        d = json.load(open(f))
    except Exception:
        continue
    if isinstance(d, dict) and "gsyncBbcond" in d.get("perMi", {}):
        rows.append((f, d))

if not rows:
    print("no result carries gsyncBbcond yet -- needs a build with the split")
    raise SystemExit(0)

f, d = rows[-1]
p = d["perMi"]
print(f"{os.path.basename(f)}  tag={d.get('tag')}  game={d.get('game')}")


def g(k):
    return p.get(k, 0.0)


a32 = g("predA32")
bbend = g("gsyncBbend")
bbcond = g("gsyncBbcond")
cbr = g("gsyncCbr")
gst = g("tcgGst")
gld = g("tcgGld")
icount = g("tbIcount")

print(f"\nglobal traffic per Mi: stores {gst:.3f}  loads {gld:.3f}  "
      f"translated insns {icount:.3f}"
      f"  ({(gst + gld) / icount:.2f} memory ops per guest insn)" if icount else "")

print("\nsync demand by site, per Mi:")
tot = sum(g(k) for k in ("gsyncBbend", "gsyncBbcond", "gsyncExit",
                         "gsyncSe", "gsyncCbr", "gsyncCall"))
for k in ("gsyncBbcond", "gsyncBbend", "gsyncExit", "gsyncSe",
          "gsyncCbr", "gsyncCall"):
    v = g(k)
    print(f"  {k:14} {v:9.3f}  {100 * v / tot if tot else 0:5.1f} %")
if bbend + bbcond:
    print(f"  predication is {100 * bbcond / (bbend + bbcond):.1f} % of all "
          f"label/br blame")

print("\npredicated A32 by class, per Mi:")
buckets = ("predDpNos", "predDpS", "predLdst", "predLsm", "predBr", "predOther")
acc = 0.0
for k in buckets:
    v = g(k)
    acc += v
    print(f"  {k:14} {v:9.3f}  {100 * v / a32 if a32 else 0:5.1f} %")
# Buckets and the total are separate rates rounded independently, so they
# agree only to rounding; flag a real bucketing error, not that.
print(f"  {'sum':14} {acc:9.3f}   vs predA32 {a32:.3f}"
      f"{'  MISMATCH' if a32 and abs(acc - a32) > 0.005 * a32 else ''}")
print(f"  {'predSel':14} {g('predSel'):9.3f}  "
      f"{100 * g('predSel') / a32 if a32 else 0:5.1f} % (narrow filter)")
if icount:
    print(f"  predicated share of translated stream: "
          f"{100 * a32 / icount:.1f} %")

if a32:
    for name, share in (("narrow (PRED_SEL)", g("predSel") / a32),
                        ("+ DP with S", (g("predSel") + g("predDpS")) / a32)):
        print(f"\nceiling, {name}: removes {share * 100:.1f} % of "
              f"predication blame")
        print(f"  {share * (bbcond + cbr):.3f} sync demands per Mi, "
              f"{100 * share * (bbcond + cbr) / (gst + gld) if gst + gld else 0:.1f} %"
              f" of the global-traffic row")
