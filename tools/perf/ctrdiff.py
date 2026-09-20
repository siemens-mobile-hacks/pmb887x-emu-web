#!/usr/bin/env python3
"""Every counter, both arms, sorted by how much it moved.

The paired analysis only inspects a hand-picked five.  When one of those
five moves on a meter whose documented spread is 0.04 %, the hand-picked
list is the wrong instrument: the question is no longer "did this counter
move" but "what else moved with it", and that is answerable only by
diffing the whole set.

Averages over every clean pair, so a single disturbed leg cannot invent a
mechanism.  AB_DROP="3:2" excludes a repeat/game pair by hand.
"""
import glob, json, os, re, statistics as st

RES = "/workspace/tests/results"
A = os.environ.get("AB_A", "dist-jit")
B = os.environ.get("AB_B", "dist-jit-mem32")
TAG = os.environ.get("AB_TAG", "ab")
TAGA = os.environ.get("AB_TAGA", TAG)
TAGB = os.environ.get("AB_TAGB", TAG)
DROP = {tuple(p.split(":")) for p in os.environ.get("AB_DROP", "").split(",") if p}


def legs(dist, tag):
    out = {}
    for f in glob.glob(os.path.join(RES, f"j2me-*-{dist}-{tag}[123]-g*.json")):
        m = re.search(rf"-{re.escape(tag)}([123])-g(\d+)", os.path.basename(f))
        if m and (m.group(1), m.group(2)) not in DROP:
            out[(m.group(1), m.group(2))] = json.load(open(f))
    return out


base, var = legs(A, TAGA), legs(B, TAGB)
if TAGA != TAGB:
    A, B = f"{A}/{TAGA}"[-13:], f"{B}/{TAGB}"[-14:]
keys = sorted(set(base) & set(var))
if not keys:
    raise SystemExit("no paired legs")
print(f"{len(keys)} pairs; dropped {sorted(DROP) or 'none'}\n")

names = sorted(set().union(*(set(base[k]["perMi"]) for k in keys),
                           *(set(var[k]["perMi"]) for k in keys)))
rows = []
for c in names:
    bv = [float(base[k]["perMi"].get(c, 0)) for k in keys]
    mv = [float(var[k]["perMi"].get(c, 0)) for k in keys]
    b, m = st.mean(bv), st.mean(mv)
    if b == 0 and m == 0:
        continue
    # Per-pair deltas, not a ratio of means.  Which code a leg translates
    # depends on which game it played, so the raw counter swings 70-90 %
    # within one arm; that variance is common to both arms of a pair and
    # cancels when the delta is taken inside the pair first.
    per = [(mv[i] - bv[i]) / bv[i] * 100 for i in range(len(keys)) if bv[i]]
    if len(per) < 2:
        continue
    d, se = st.mean(per), st.stdev(per) / len(per) ** 0.5
    sb = (max(bv) - min(bv)) / b * 100 if b else 0
    rows.append((abs(d), c, b, m, d, se, sb))

print(f"{'counter':<22}{A:>13}{B:>14}{'paired':>9}{'se':>8}{'':>3}"
      f"{'raw spread':>11}")
for _, c, b, m, d, se, sb in sorted(rows, reverse=True):
    mark = "  " if abs(d) > 2 * se else " ?"   # ? = not resolved
    if abs(d) < 0.5 and abs(d) <= 2 * se:
        continue
    print(f"{c:<22}{b:13.3f}{m:14.3f}{d:+8.2f}%{se:7.2f}%{mark}{sb:10.1f}%")

flat = [c for _, c, b, m, d, se, sb in rows if abs(d) < 0.5 and abs(d) <= 2 * se]
print(f"\nunmoved: {len(flat)} counters")
print("  " + " ".join(sorted(flat)))
print("\n'?' = the paired delta is within 2 se, i.e. this window cannot "
      "resolve it either way.")
