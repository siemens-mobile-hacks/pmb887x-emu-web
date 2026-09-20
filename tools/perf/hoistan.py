#!/usr/bin/env python3
"""Fit ms/Mi against the number of duplicated mask/table pairs per memop.

The slope is the ceiling for hoisting the pair into TB locals: one pair
per executed memop.  A real hoist keeps the pair for the first memop of
every straight-line run, so it collects strictly less than this.

Fitting per repeat as well as pooled, because the useful check is not the
pooled r but whether the three repeats agree on a slope -- a host burst
inside one repeat moves that repeat's intercept, not its slope.
"""
import glob
import json
import os
import re
from collections import defaultdict

TAG = re.compile(r"-(hs(\d)-(\d))(?:-|\.)")

rows = []
for f in glob.glob("tests/results/j2me-*-hs[0-9]-[0-9]*.json"):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    if not isinstance(d, dict):
        continue
    m = TAG.search(os.path.basename(f))
    if not m:
        continue
    d["_rep"], d["_n"] = int(m.group(2)), int(m.group(3))
    d["_mt"] = os.path.getmtime(f)
    rows.append(d)
rows.sort(key=lambda r: r["_mt"])

if not rows:
    print("no hoist sweep results yet")
    raise SystemExit(0)


def fit(pts):
    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
    sxx = sum((p[0] - mx) ** 2 for p in pts)
    syy = sum((p[1] - my) ** 2 for p in pts)
    if sxx <= 0:
        return None
    b = sxy / sxx
    r = sxy / (sxx * syy) ** 0.5 if syy > 0 else float("nan")
    return b, my - b * mx, r


print(f"{'rep':>4} {'pairs':>6} {'ms/Mi':>8} {'MIPS':>7} {'duty':>6} "
      f"{'wall':>6} {'hostBusy':>9}")
pts = []
by_rep = defaultdict(list)
for d in rows:
    pairs = d["_n"] - 1          # N=1 emits the sink store only
    print(f"{d['_rep']:>4} {pairs:>6} {d['msPerMi']:>8.3f} {d.get('mips', 0):>7.1f} "
          f"{d['duty']:>6.3f} {d.get('wall', 0):>6.2f} {d.get('hostBusy', 0):>9.3f}")
    pts.append((pairs, d["msPerMi"]))
    by_rep[d["_rep"]].append((pairs, d["msPerMi"]))

print("\nper repeat:")
slopes = []
for rep in sorted(by_rep):
    f = fit(by_rep[rep])
    if f:
        slopes.append(f[0])
        print(f"  r{rep}: {f[0]:+.4f} ms/Mi per pair   intercept {f[1]:.3f}  r={f[2]:+.3f}")

f = fit(pts)
if f:
    b, a, r = f
    print(f"\npooled: {b:+.4f} ms/Mi per duplicated pair, intercept {a:.3f}, r={r:+.3f}, n={len(pts)}")
    print(f"  ceiling for the hoist: {100 * b / a:+.2f} % of wall")

# A linear fit hides shape, and shape is the finding here: a real hoist
# removes one pair per memop, so what it can collect is the *first* step,
# not the average one.  If the later steps are flat the cost is per-probe
# overhead rather than per-load, and removing loads buys little.
lvl = defaultdict(list)
for p, y in pts:
    lvl[p].append(y)
print("\nby level:")
base = None
for p in sorted(lvl):
    m = sum(lvl[p]) / len(lvl[p])
    if base is None:
        base = m
    step = ""
    if p - 1 in lvl:
        prev = sum(lvl[p - 1]) / len(lvl[p - 1])
        step = f"   step {m - prev:+.4f}  ({100 * (m - prev) / base:+.2f} % of wall)"
    print(f"  {p} pairs  n={len(lvl[p])}  {m:8.4f} ms/Mi{step}")
if len(slopes) >= 2:
    m = sum(slopes) / len(slopes)
    sd = (sum((x - m) ** 2 for x in slopes) / (len(slopes) - 1)) ** 0.5
    print(f"  per-repeat slopes agree to {m:+.4f} +/- {sd:.4f} ms/Mi per pair")
