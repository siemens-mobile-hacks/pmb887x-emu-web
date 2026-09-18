#!/usr/bin/env python3
"""Per-title verdict for the code-granule mask, paired within (repeat, game).

Pairing inside a title matters more than pooling across titles: the five
entries differ by 3x in ms/Mi and by 4x in duty, so a pooled mean is
dominated by whichever title happened to run more.
"""
import glob
import json
import os
from collections import defaultdict

rows = []
for f in glob.glob("tests/results/j2me-*-sg[0-9]*.json"):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    if not isinstance(d, dict):
        continue                # the per-run -sweep.json summary is a list
    d["_mt"] = os.path.getmtime(f)
    rows.append(d)
rows.sort(key=lambda r: r["_mt"])

if not rows:
    print("no catalogue A/B results yet")
    raise SystemExit(0)


def cnt(r, k):
    return (r.get("perMi") or {}).get(k, 0.0)


by = defaultdict(dict)
for r in rows:
    tag = r["tag"]              # sg<rep><leg>
    rep = tag[2]
    leg = "off" if tag.endswith("off") else "on"
    by[(rep, r["game"])][leg] = r

print(f"{'game':>5} {'rep':>4} {'off ms/Mi':>10} {'on ms/Mi':>9} {'speedup':>8} "
      f"{'duty':>6} {'maskHit':>8} {'chain(off)':>11}")
per_game = defaultdict(list)
for (rep, g), p in sorted(by.items()):
    if "on" not in p or "off" not in p:
        continue
    a, b = p["off"]["msPerMi"], p["on"]["msPerMi"]
    sp = a / b
    per_game[g].append(sp)
    miss_on = cnt(p["on"], "smcMiss")
    hit = cnt(p["on"], "smcMask") / miss_on if miss_on > 0.01 else float("nan")
    walked_off = cnt(p["off"], "smcMiss") - cnt(p["off"], "smcMask")
    chain = cnt(p["off"], "smcWalk") / walked_off if walked_off > 0.01 else float("nan")
    print(f"{g:>5} {rep:>4} {a:>10.3f} {b:>9.3f} {sp:>7.4f}x "
          f"{p['on']['duty']:>6.3f} {100 * hit:>7.1f}% {chain:>11.2f}")

print("\ndose-response: does the gain track the walk steps actually removed?")
dose = []
for (rep, g), p in sorted(by.items()):
    if "on" not in p or "off" not in p:
        continue
    removed = cnt(p["off"], "smcWalk") - cnt(p["on"], "smcWalk")
    gain = p["off"]["msPerMi"] - p["on"]["msPerMi"]
    dose.append((removed / 1000.0, gain, g, rep))
if len(dose) >= 3:
    n = len(dose)
    mx = sum(d[0] for d in dose) / n
    my = sum(d[1] for d in dose) / n
    sxy = sum((d[0] - mx) * (d[1] - my) for d in dose)
    sxx = sum((d[0] - mx) ** 2 for d in dose)
    syy = sum((d[1] - my) ** 2 for d in dose)
    if sxx > 0 and syy > 0:
        b = sxy / sxx
        r = sxy / (sxx * syy) ** 0.5
        print(f"  {b * 1000:.2f} ns per removed list step   r={r:+.3f}  n={n}")
for x, y, g, rep in sorted(dose):
    print(f"    g{g} r{rep}: removed {x * 1000:8.0f} steps/Mi -> {y:+.3f} ms/Mi")

print("\nper title:")
alls = []
for g in sorted(per_game):
    v = per_game[g]
    m = sum(v) / len(v)
    alls.extend(v)
    print(f"  game {g}: {m:.4f}x  ({100 * (m - 1):+.2f}%)  n={len(v)}")
if alls:
    m = sum(alls) / len(alls)
    sd = (sum((x - m) ** 2 for x in alls) / max(1, len(alls) - 1)) ** 0.5
    print(f"\n  all titles: {m:.4f}x +/- {sd:.4f}  ({100 * (m - 1):+.2f}%)  n={len(alls)}")
