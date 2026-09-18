#!/usr/bin/env python3
"""Fit ms/Mi against the number of duplicated rounds of guest-register traffic.

The slope is the cost of one whole round of global write-backs and
reloads -- the ceiling for any scheme that removes part of it.  Pinning
globals to TB-lifetime wasm locals would collect the basic-block-end
share, which the GSYNC counters put at ~42 % of sync demands.

Fitting per repeat as well as pooled, because the useful check is not the
pooled r but whether the three repeats agree on a slope -- a host burst
inside one repeat moves that repeat's intercept, not its slope.
"""
import glob
import json
import os
import re
from collections import defaultdict

TAG = re.compile(r"-(gd(\d)-(\d))(?:-|\.)")

rows = []
for f in glob.glob("tests/results/j2me-*-gd[0-9]-[0-9]*.json"):
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
    print("no gdup sweep results yet")
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


print(f"{'rep':>4} {'dups':>5} {'ms/Mi':>8} {'MIPS':>7} {'duty':>6} "
      f"{'wall':>6} {'hostBusy':>9}")
pts = []
by_rep = defaultdict(list)
for d in rows:
    pairs = d["_n"] - 1          # N=1 is the unduplicated build
    print(f"{d['_rep']:>4} {pairs:>5} {d['msPerMi']:>8.3f} {d.get('mips', 0):>7.1f} "
          f"{d['duty']:>6.3f} {d.get('wall', 0):>6.2f} {d.get('hostBusy', 0):>9.3f}")
    pts.append((pairs, d["msPerMi"]))
    by_rep[d["_rep"]].append((pairs, d["msPerMi"]))

print("\nper repeat:")
slopes = []
for rep in sorted(by_rep):
    f = fit(by_rep[rep])
    if f:
        slopes.append(f[0])
        print(f"  r{rep}: {f[0]:+.4f} ms/Mi per round   intercept {f[1]:.3f}  r={f[2]:+.3f}")

f = fit(pts)
if f:
    b, a, r = f
    print(f"\npooled: {b:+.4f} ms/Mi per duplicated round, intercept {a:.3f}, r={r:+.3f}, n={len(pts)}")
    print(f"  whole guest-register row: {100 * b / a:+.2f} % of wall")
if len(slopes) >= 2:
    m = sum(slopes) / len(slopes)
    sd = (sum((x - m) ** 2 for x in slopes) / (len(slopes) - 1)) ** 0.5
    print(f"  per-repeat slopes agree to {m:+.4f} +/- {sd:.4f} ms/Mi per round")
