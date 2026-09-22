#!/usr/bin/env python3
"""Score a knob-abba log: paired-by-arm pooled means, spread, and a
hostBusy-matched view, from the VIDEO lines (both arms share one dist,
so the JSONs overwrite each other - the log is the record)."""
import re, sys

path = sys.argv[1]
legs, arm = [], None
for line in open(path):
    m = re.match(r"=== leg \d+ round \d+ arm (\w+)", line)
    if m:
        arm = m.group(1)
    v = re.match(r"VIDEO .*", line)
    if v:
        d = dict(a=arm)
        for k, pat in (("ms", r"ms/Mi=([\d.]+)"), ("rt", r"rt=([\d.]+)"),
                       ("busy", r"hostBusy=([\d.]+)"), ("mi", r"Mi=([\d.]+)")):
            mm = re.search(pat, line)
            d[k] = float(mm.group(1)) if mm else None
        legs.append(d)

A, B = {}, {}
for nm in ("base", "knob"):
    sel = [l for l in legs if l["a"] == nm and l["ms"]]
    d = globals()[nm.capitalize()]
    d["legs"] = sel
    if sel:
        for k in ("ms", "rt", "busy"):
            xs = [l[k] for l in sel if l[k]]
            d[k + "m"] = sum(xs) / len(xs)

print(f"{'arm':<6}{'n':>3}{'ms/Mi':>9}{'rt':>7}{'busy':>7}   spread")
for nm in ("base", "knob"):
    d = globals()[nm.capitalize()]
    if not d.get("legs"):
        print(f"{nm:<6}{0:>3}")
        continue
    xs = [l["ms"] for l in d["legs"]]
    sp = (max(xs) - min(xs)) / (sum(xs) / len(xs)) * 100
    print(f"{nm:<6}{len(d['legs']):>3}{d['msm']:>9.3f}{d['rtm']:>7.3f}"
          f"{d['busym']:>7.3f}   ±{sp:.1f}%")

for k, lab in (("ms", "ms/Mi"), ("rt", "rt")):
    if A.get(k + "m") and B.get(k + "m"):
        diff = (B[k + "m"] - A[k + "m"]) / A[k + "m"] * 100
        # paired SE over pooled legs (arms interleaved, one host)
        n = min(len(A["legs"]), len(B["legs"]))
        sa = len(A["legs"]) and (sum((l[k] - A[k + 'm']) ** 2 for l in A['legs'] if l[k]) /
                                 max(1, len(A['legs']) - 1)) ** .5
        sb = len(B["legs"]) and (sum((l[k] - B[k + 'm']) ** 2 for l in B['legs'] if l[k]) /
                                 max(1, len(B['legs']) - 1)) ** .5
        se = ((sa ** 2 / len(A['legs']) + sb ** 2 / len(B['legs'])) ** .5 / A[k + 'm'] * 100) if n else 0
        print(f"{lab}: knob-base {diff:+.2f}% ±{se:.2f}")
