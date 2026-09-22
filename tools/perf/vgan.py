#!/usr/bin/env python3
"""Score videobench ABBA legs (vgabba.sh): score B against A within each
round, pooled mean, and a hostBusy-matched view.  Reads the video-*.json
files of a tag in mtime order and pairs legs by position.

Usage: vgan.py <tag> <distA> <distB>
"""
import json, sys, glob, os
from datetime import datetime

tag, da, db = sys.argv[1], sys.argv[2], sys.argv[3]
files = sorted(glob.glob(f"/workspace/tests/results/video-*-{da}-{tag}.json")
               + glob.glob(f"/workspace/tests/results/video-*-{db}-{tag}.json"),
               key=os.path.getmtime)
legs = []
for f in files:
    try:
        j = json.load(open(f))
    except Exception:
        continue
    b = os.path.basename(f)
    if b.endswith(f"-{da}-{tag}.json"):
        dist = da
    elif b.endswith(f"-{db}-{tag}.json"):
        dist = db
    else:
        continue  # some other dist caught by the glob
    legs.append(dict(dist=dist, ms=j.get("msPerMi") or j.get("ms/Mi"),
                     rt=j.get("rt"), busy=j.get("hostBusy"),
                     mi=j.get("Mi"), f=os.path.basename(f)))
if not legs:
    sys.exit(f"no legs for tag {tag}")

print(f"{'#':>2} {'dist':<14} {'ms/Mi':>7} {'rt':>6} {'busy':>5} {'Mi':>8}")
for i, l in enumerate(legs):
    ms = l["ms"]
    print(f"{i:>2} {l['dist']:<14} {ms:>7.3f} {l['rt'] or 0:>6.3f} "
          f"{l['busy'] or 0:>5.2f} {l['mi'] or 0:>8.1f}")

# pooled: mean of B legs / mean of A legs
import statistics as st
for name, key in (("ms/Mi", "ms"), ("rt", "rt")):
    a = [l[key] for l in legs if l["dist"] == da and l[key]]
    b = [l[key] for l in legs if l["dist"] == db and l[key]]
    if len(a) > 1 and len(b) > 1:
        ra, rb = st.mean(a), st.mean(b)
        # ratio B/A on ms (lower better), A/B on rt (higher better)
        if name == "ms/Mi":
            pooled = (ra - rb) / ra * 100
            se = (st.stdev(a) / len(a) ** .5 + st.stdev(b) / len(b) ** .5) / ra * 100
        else:
            pooled = (rb - ra) / ra * 100
            se = 0
        print(f"pooled {name}: A={ra:.3f} B={rb:.3f}  B-vs-A {pooled:+.2f}% (±{se:.2f})")

# hostBusy fit: y = c + s*busy per arm, difference at mean busy (pure
# python 2-param least squares - numpy is not installed on this host)
def _fit(pts):
    n = len(pts)
    mb = sum(b for b, _ in pts) / n
    my = sum(y for _, y in pts) / n
    vb = sum((b - mb) ** 2 for b, _ in pts)
    s = (sum((b - mb) * (y - my) for b, y in pts) / vb) if vb else 0.0
    return my - s * mb, s

for name, key in (("ms/Mi", "ms"),):
    A = [(l["busy"], l[key]) for l in legs
         if l["dist"] == da and l[key] and l["busy"] is not None]
    B = [(l["busy"], l[key]) for l in legs
         if l["dist"] == db and l[key] and l["busy"] is not None]
    if len(A) >= 3 and len(B) >= 3:
        cA, sA = _fit(A)
        cB, sB = _fit(B)
        mb = sum(b for b, _ in A + B) / len(A + B)
        print(f"hostBusy fit: A ms={cA:.3f}+{sA:.2f}*busy  B ms={cB:.3f}+{sB:.2f}*busy")
        print(f"  at mean busy {mb:.3f}: A {cA + sA * mb:.3f} B {cB + sB * mb:.3f} "
              f"-> {(cA + sA * mb - cB - sB * mb) / (cA + sA * mb) * 100:+.2f}%")
