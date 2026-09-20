#!/usr/bin/env python3
"""Read a code-granule-mask A/B out of tests/results/.

Both legs are the same dist, so the leg is keyed off the tag suffix rather
than the folder name.  Pairs are matched by repeat index.

Two estimators are printed, because on this host the paired mean alone was
not enough.  The paired ratio is the honest headline but its sd (+/- 4.6 %
in round 1) is larger than the effect.  The regression of ms/Mi on smcWalk
is much tighter: every run, either leg, contributes a point, and the natural
run-to-run variation in how much walking the guest does is itself signal.
Its slope is ns per list step, which prices the whole mechanism rather than
just the fraction this mask happens to remove.

Usage: smcan.py [tagprefix]      (default sm; e.g. sq for round 2)
       smcan.py --one <tag>
"""
import glob
import json
import os
import sys

RES = "tests/results"


def load(pat):
    out = []
    for f in glob.glob(os.path.join(RES, pat)):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        d["_f"] = f
        d["_mt"] = os.path.getmtime(f)
        out.append(d)
    return sorted(out, key=lambda r: r["_mt"])


def cnt(r, k):
    return (r.get("perMi") or {}).get(k, 0.0)


def line(r):
    walked = cnt(r, "smcMiss") - cnt(r, "smcMask")
    chain = cnt(r, "smcWalk") / walked if walked > 0.01 else float("nan")
    miss = cnt(r, "smcMiss")
    hit = 100 * cnt(r, "smcMask") / miss if miss > 0.01 else float("nan")
    return (
        f"{r['tag']:>9} g{r['game']} ms/Mi={r['msPerMi']:7.3f} "
        f"MIPS={r['mips']:7.2f} duty={r['duty']:.3f} busy={r.get('hostBusy', 0):5.2f} "
        f"| miss={miss:8.1f} mask={cnt(r, 'smcMask'):8.1f} ({hit:5.1f}%) "
        f"walk={cnt(r, 'smcWalk'):9.1f} chain={chain:6.2f}"
    )


def fit(pts):
    """least squares y = a + b x, returns (b, r, n)"""
    n = len(pts)
    if n < 3:
        return None
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    sxy = sum((x - mx) * (y - my) for x, y in pts)
    sxx = sum((x - mx) ** 2 for x, _ in pts)
    syy = sum((y - my) ** 2 for _, y in pts)
    if sxx <= 0 or syy <= 0:
        return None
    return sxy / sxx, sxy / (sxx * syy) ** 0.5, n


if len(sys.argv) > 2 and sys.argv[1] == "--one":
    for r in load(f"j2me-*-{sys.argv[2]}.json"):
        print(line(r))
    raise SystemExit(0)

pre = sys.argv[1] if len(sys.argv) > 1 else "sm"
rows = load(f"j2me-*-{pre}[0-9]*.json")
if not rows:
    print(f"no {pre}* A/B results yet")
    raise SystemExit(0)

for r in rows:
    print(line(r))

pairs = {}
for r in rows:
    tag = r["tag"]
    leg = "off" if tag.endswith("off") else "on"
    pairs.setdefault(tag[len(pre)], {})[leg] = r

print()
print("paired (off = unconditional walk, on = mask):")
ratios = []
for rep in sorted(pairs):
    p = pairs[rep]
    if "on" not in p or "off" not in p:
        continue
    a, b = p["off"]["msPerMi"], p["on"]["msPerMi"]
    ratios.append(a / b)
    print(
        f"  r{rep}: off={a:7.3f}  on={b:7.3f}  speedup={a / b:6.4f}x "
        f"({100 * (a - b) / a:+6.2f}% ms/Mi)  busy off/on="
        f"{p['off'].get('hostBusy', 0):.2f}/{p['on'].get('hostBusy', 0):.2f}"
    )

if ratios:
    m = sum(ratios) / len(ratios)
    sd = (sum((x - m) ** 2 for x in ratios) / max(1, len(ratios) - 1)) ** 0.5
    se = sd / len(ratios) ** 0.5
    print(f"\n  mean speedup {m:.4f}x +/- {sd:.4f} (se {se:.4f}) over n={len(ratios)}"
          f"   ({100 * (m - 1):+.2f}% MIPS)")

print("\nms/Mi vs smcWalk (slope = cost of one TB-list step):")
for label, sel in (("all runs", lambda r: True),
                   ("off legs only", lambda r: r["tag"].endswith("off"))):
    f = fit([(cnt(r, "smcWalk") / 1000.0, r["msPerMi"]) for r in rows if sel(r)])
    if not f:
        print(f"  {label:>14}: too few points")
        continue
    b, rr, n = f
    mean_off = [cnt(r, "smcWalk") for r in rows if r["tag"].endswith("off")]
    w = sum(mean_off) / len(mean_off) if mean_off else 0
    my = sum(r["msPerMi"] for r in rows) / len(rows)
    print(f"  {label:>14}: {b * 1000:6.2f} ns/step  r={rr:+.3f}  n={n}"
          f"   -> whole walk = {b * w / 1000:.3f} ms/Mi = {100 * b * w / 1000 / my:4.1f}% of wall")
