#!/usr/bin/env python3
"""Price ARM predication exactly, from the BBEND split.

Rounds 32-35 could only bracket this lever (0.17-11.5 % of write-backs)
because one counter, GSYNC_BBEND, carried three unrelated populations: the
condlabel every predicated A32 instruction emits, the `br` a folded branch
defers, and every other label in the backend.  The split gives each its
own counter, so the bracket collapses to a number.

Shares are of sync DEMANDS, not of emitted stores.  la_charge fires once
per global output arg whose liveness marks SYNC_ARG; temp_sync emits
nothing when the global is already coherent, so demands run ~1.33x stores.
The five causes partition the demand total exactly, which is the check
that the denominator is right -- see doc/lessons.md, "A share's
denominator must be the population its numerator came from".
"""
import glob, json, os, re

RES = "/workspace/tests/results"
TAG = os.environ.get("BBS_TAG", "bbs")

# Order matters only for reading; the partition test sums all of them.
CAUSE = [("gsyncSe",    "guest memory op / faulting op   (semantics, floor)"),
         ("gsyncCall",  "helper reading or writing env   (semantics, floor)"),
         ("gsyncExit",  "end of TB                       (shape, TB must end)"),
         ("gsyncCbr",   "brcond -- globals dirtied BEFORE a predicated insn"),
         ("gsyncPred",  "condlabel -- a predicated insn's OWN outputs"),
         ("gsyncBr",    "br -- a folded/deferred branch"),
         ("gsyncLbl",   "every other label (excl, goto_ptr, join, exc)")]

legs = {}
for f in glob.glob(os.path.join(RES, f"j2me-*-{TAG}-g*.json")):
    m = re.search(r"-g(\d+)", os.path.basename(f))
    if m:
        legs[m.group(1)] = json.load(open(f))
if not legs:
    raise SystemExit(f"no legs matching tag {TAG!r} in {RES}")

for g, d in sorted(legs.items()):
    p = d["perMi"]
    icnt = p.get("tbIcount", 0.0)
    gst = p.get("tcgGst", 0.0)
    tot = sum(p.get(k, 0.0) for k, _ in CAUSE)
    if not (tot and icnt):
        print(f"\ngame {g}: no demands recorded -- is this a WASM_DIAG build?")
        continue

    print(f"\n=== game {g}")
    print(f"   {tot:.3f} demands per Mi against {gst:.3f} emitted stores "
          f"({tot / gst:.2f} demands per store)")
    for k, what in CAUSE:
        v = p.get(k, 0.0)
        print(f"   {k:<11}{v / tot * 100:6.2f}%  {v / icnt * 1000:7.2f}/1000 insns  {what}")

    # Against gsyncTot, which la_charge counts without consulting the blame.
    # Summing the causes against their own sum would print 100.0 whatever
    # happened; this is the version that can fail.  A shortfall means some
    # demand carried a `why` outside the seven -- most likely index 0, from
    # a temp charged before anything blamed it.
    ref = p.get("gsyncTot", 0.0)
    if ref:
        print(f"   partition check: {tot / ref * 100:.2f}% of gsyncTot "
              f"(must be 100.00; a shortfall is charged to counter 0)")
    else:
        print("   partition check: gsyncTot absent -- pre-split binary, "
              "the causes cannot be verified against anything")

    # The bracket the split replaces.  Its roof assumed all of BBEND could
    # be condlabels; its floor assumed none were.
    bbend = p.get("gsyncPred", 0.0) + p.get("gsyncBr", 0.0) + p.get("gsyncLbl", 0.0)
    if bbend:
        print(f"   old BBEND would have read {bbend / tot * 100:.1f}%, of which "
              f"predication is {p.get('gsyncPred', 0.0) / bbend * 100:.1f}% "
              f"-- the bracket assumed 0-100 %")

    # Predication's full demand: the brcond before it and its own condlabel.
    pred = p.get("gsyncCbr", 0.0) + p.get("gsyncPred", 0.0)
    a32, sel = p.get("predA32", 0.0), p.get("predSel", 0.0)
    print(f"   predication's whole demand (CBR+PRED): {pred / tot * 100:.2f}% "
          f"of write-backs")
    if a32:
        share = sel / a32
        print(f"   of which movcond-eligible: {sel:.0f}/{a32:.0f} = {share * 100:.1f}%")
        print(f"   => if-conversion's ceiling is {pred * share / tot * 100:.2f}% "
              f"of write-backs")
        # The handoff prices the whole register-traffic row at ~9 % of wall
        # on kernel 1's 0.219 ns; scale the ceiling by that to get wall.
        print(f"      at the row's ~9 % of wall that is "
              f"~{pred * share / tot * 9:.2f} % of wall -- compare against the "
              f"cost of emitting a movcond, which is not zero")
    else:
        print("   predA32 is 0: this build does not count predication "
              "(WASM_DIAG_PRED_A32 never incremented)")
