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
ARMS = {"base": A, "knob": B}
for nm in ("base", "knob"):
    sel = [l for l in legs if l["a"] == nm and l["ms"]]
    d = ARMS[nm]
    d["legs"] = sel
    if sel:
        for k in ("ms", "rt", "busy"):
            xs = [l[k] for l in sel if l[k]]
            d[k + "m"] = sum(xs) / len(xs)

print(f"{'arm':<6}{'n':>3}{'ms/Mi':>9}{'rt':>7}{'busy':>7}   spread")
for nm in ("base", "knob"):
    d = ARMS[nm]
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

# ms/Mi = a + b*hostBusy + d*[knob], least squares (no numpy on this host)
rows = [(1.0, l["busy"], 1.0 if l["a"] == "knob" else 0.0, l["ms"])
        for l in legs if l["ms"] and l["busy"] is not None]
if len(rows) > 3 and A.get("legs") and B.get("legs"):
    def solve(M, y):
        n = len(y)
        M = [M[i][:] + [y[i]] for i in range(n)]
        for i in range(n):
            p = max(range(i, n), key=lambda r: abs(M[r][i]))
            M[i], M[p] = M[p], M[i]
            for r in range(n):
                if r != i:
                    f = M[r][i] / M[i][i]
                    M[r] = [x - f * z for x, z in zip(M[r], M[i])]
        return [M[i][n] / M[i][i] for i in range(n)]
    xtx = [[sum(r[i] * r[j] for r in rows) for j in range(3)] for i in range(3)]
    c = solve(xtx, [sum(r[i] * r[3] for r in rows) for i in range(3)])
    res = [r[3] - sum(c[k] * r[k] for k in range(3)) for r in rows]
    s2 = sum(e * e for e in res) / (len(rows) - 3)
    var = solve(xtx, [0.0, 0.0, 1.0])[2] * s2
    ref = c[0] + c[1] * (sum(r[1] for r in rows) / len(rows))
    print(f"ms/Mi at matched hostBusy: knob-base {c[2] / ref * 100:+.2f}% "
          f"±{var ** .5 / ref * 100:.2f}")
