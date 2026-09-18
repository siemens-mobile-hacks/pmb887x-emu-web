#!/usr/bin/env python3
"""Split GSYNC_BBEND into the fold's share and the rest, from an FTMAX A/B.

Per guest instruction, never per TB: FTMAX=0 shortens TBs, so a per-TB
rate moves for a reason unrelated to the mechanism (doc/lessons.md,
"Per-TB is not per-instruction").
"""
import glob, json, os, re

RES = "/workspace/tests/results"

legs = {}
for f in glob.glob(os.path.join(RES, "j2me-*-dist-jit-ft[03]-g*.json")):
    m = re.search(r"-(ft[03])-g(\d+)", os.path.basename(f))
    if m:
        legs[(m.group(1), m.group(2))] = json.load(open(f))
if not legs:
    raise SystemExit("no ft0/ft3 legs found")

for g in sorted({k[1] for k in legs}):
    a, b = legs.get(("ft3", g)), legs.get(("ft0", g))
    if not (a and b):
        print(f"game {g}: missing a leg")
        continue
    per = {}
    for nm, d in (("ft3", a), ("ft0", b)):
        p = d["perMi"]
        ic = p.get("tbIcount", 0.0)
        per[nm] = {k: (v / ic * 1000 if ic else 0.0) for k, v in p.items()}

    print(f"\ngame {g}: per 1000 guest instructions (tbIcount), not per TB")
    print(f"{'counter':<12}{'ft3':>10}{'ft0':>10}{'delta':>10}")
    for c in ("gsyncBbend", "gsyncExit", "gsyncCbr", "gsyncSe",
              "tcgGst", "tbGen"):
        x, y = per["ft3"].get(c, 0.0), per["ft0"].get(c, 0.0)
        print(f"{c:<12}{x:10.2f}{y:10.2f}{y - x:+10.2f}")

    bb3, bb0 = per["ft3"].get("gsyncBbend", 0.0), per["ft0"].get("gsyncBbend", 0.0)
    ex3, ex0 = per["ft3"].get("gsyncExit", 0.0), per["ft0"].get("gsyncExit", 0.0)
    if not bb3:
        continue
    print(f"   fold's share of BBEND: {(bb3 - bb0) / bb3 * 100:.1f}%; "
          f"surviving BBEND is {bb0 / bb3 * 100:.1f}% of it")
    # A branch that is no longer folded ends the TB instead, so its demand
    # should move from the label to the function end rather than vanish.
    # If BBEND's fall and EXIT's rise do not roughly trade, the model
    # behind the bracket in the handoff is wrong, and that is the finding.
    fell, rose = bb3 - bb0, ex0 - ex3
    trade = "trade" if abs(fell - rose) < 0.3 * abs(fell) else "NOT a clean trade"
    print(f"   BBEND fell {fell:+.2f}, EXIT rose {rose:+.2f} -- {trade}")
    # Predication's condlabels are inside the surviving BBEND, together
    # with gen_store_exclusive's two labels, gen_goto_ptr's slow label,
    # w64_try_join's cont and emit_delayed_exceptions.  So bb0 is the
    # ceiling on what if-conversion could reach, not its value.
    print(f"   => predication's ceiling is at most {bb0:.2f} per 1000 insns, "
          f"down from the {bb3:.2f} the open bracket assumed")
