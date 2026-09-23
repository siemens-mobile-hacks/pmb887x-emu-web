#!/usr/bin/env python3
"""Common-slope hostBusy fit over videobench ABBA legs of one or more tags:
ms/Mi = c + d*isB + s*hostBusy, least squares, with the standard error of d.
Host load slows both binaries alike, so one slope is the sounder model than
vgan.py's slope per arm (which four legs an arm cannot pin down).

Usage: vgfit.py <distA> <distB> <tag> [<tag> ...]
VGFIT_KIND=j2me fits j2mebench legs (single game) instead.  A leg whose Mi
is more than 5 % off the median of all legs is not the workload (a clip that
was not playing reads Mi ~50 against ~1500) and is dropped, loudly.
"""
import glob, json, os, sys

da, db, tags = sys.argv[1], sys.argv[2], sys.argv[3:]
kind = os.environ.get("VGFIT_KIND", "video")
rows = []
for tag in tags:
    for dist, isb in ((da, 0), (db, 1)):
        for f in glob.glob(f"/workspace/tests/results/{kind}-*-{dist}-{tag}.json"):
            j = json.load(open(f))
            if j.get("msPerMi") and j.get("hostBusy") is not None:
                rows.append((isb, j["hostBusy"], j["msPerMi"], j.get("mi")))
mis = sorted(r[3] for r in rows if r[3])
if mis:
    med = mis[len(mis) // 2]
    bad = [r for r in rows if not r[3] or abs(r[3] / med - 1) > 0.05]
    for r in bad:
        print(f"dropped leg isB={r[0]} Mi={r[3]} (median {med})")
    rows = [r for r in rows if r not in bad]
n = len(rows)
if n < 4:
    sys.exit("not enough legs")

# normal equations for y = c + d*x1 + s*x2
X = [(1.0, r[0], r[1]) for r in rows]
Y = [r[2] for r in rows]
A = [[sum(x[i] * x[j] for x in X) for j in range(3)] for i in range(3)]
b = [sum(x[i] * y for x, y in zip(X, Y)) for i in range(3)]


def inv3(m):
    a, b_, c = m[0]; d, e, f = m[1]; g, h, i = m[2]
    det = a * (e * i - f * h) - b_ * (d * i - f * g) + c * (d * h - e * g)
    return [[(e * i - f * h) / det, (c * h - b_ * i) / det, (b_ * f - c * e) / det],
            [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
            [(d * h - e * g) / det, (b_ * g - a * h) / det, (a * e - b_ * d) / det]]


Ai = inv3(A)
beta = [sum(Ai[i][j] * b[j] for j in range(3)) for i in range(3)]
res = [y - sum(bb * xx for bb, xx in zip(beta, x)) for x, y in zip(X, Y)]
s2 = sum(r * r for r in res) / (n - 3)
se_d = (s2 * Ai[1][1]) ** 0.5
mb = sum(r[1] for r in rows) / n
base = beta[0] + beta[2] * mb
mis = sorted({r[3] for r in rows if r[3]})
print(f"legs {n} ({sum(1 - r[0] for r in rows)} A / {sum(r[0] for r in rows)} B), "
      f"Mi {mis[0]}..{mis[-1]}, busy {min(r[1] for r in rows):.3f}..{max(r[1] for r in rows):.3f}")
print(f"slope {beta[2]:.3f} ms/Mi per unit busy, residual sd {s2 ** .5:.3f}")
print(f"B - A = {beta[1]:+.4f} ms/Mi +- {se_d:.4f}  ->  {beta[1] / base * 100:+.2f} % +- "
      f"{se_d / base * 100:.2f} at mean busy {mb:.3f} (A {base:.3f})")
