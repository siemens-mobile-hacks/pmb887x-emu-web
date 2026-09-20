import glob, os, re, sys

# What a TB entry costs, fitted with the host's drift held out.
#
# Entries per Mi go as 1/L, so if entry cost is the mechanism the fold
# lever moves, wall should be linear in 1/L with a positive slope.  Fit
# ms/Mi = a + b/len; the entry term at any length is b/len and the
# intercept is the wall an infinitely long TB would still pay.
#
# Why a fit and not a two-leg slope.  The single pair base->ft4 changes
# translated length by ~5 %, and the round-to-round spread of that same
# quantity *within one arm* is ~11 % (ft4 reads 9.449, 9.927, 10.481).
# Dividing a 2 % wall delta by 1-1/r where r's own error bar spans zero
# is how round 35 briefly priced the entry at 43 % of wall.  ft1 is the
# only leg with a length change that dominates its noise, so every
# estimate must include it and the fit must be over all legs at once.
#
# Why a per-round intercept.  This host is shared: our whole process
# table is ~1.5 GB RSS against AnonPages 70.8 GB, so ~100 GB of anon
# memory lives in another namespace, and it swaps while we benchmark.
# Wall drifts upward across a sweep -- base read 4.151, 4.209, 4.543 in
# three successive rounds -- and with six arms rotating through only
# three or four rounds, each arm keeps a distinct mean position, so that
# drift lands on the arm and imitates an effect.
#
# The first attempt at a fix estimated a drift *rate* from within-arm
# residuals and divided it out.  That rate is not stable enough to use:
# it read +0.111 %/min over 17 legs and +0.156 %/min over 18, a 40 %
# swing from one leg, and applying it dropped R^2 from 0.89 to 0.63.
# A per-round intercept needs no rate.  It lets each round find its own
# level and fits one shared slope to the within-round spread only, which
# is the same discipline as "compare ratios inside a round, never
# absolutes across them" -- expressed as a regression.
#
# len here is *translated* (tbIcount/tbGen), used as a proxy for executed
# length.  That is sound for the ms/Mi term and only for it: if executed
# = k x translated, then b absorbs k and b/len is unchanged, but the
# ns-per-entry conversion needs the executed entry count and so needs k.
S = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[-1]):
    S = sys.argv[-1]
elif not glob.glob(os.path.join(S, "k[0-9]_*.log")):
    S = os.path.join(S, "round35")          # the archived evidence
ARMS = ("ft1", "base", "ft4", "ft6")

# See ratios.py for the derivation: a host burst between 17:57 and 18:05
# inflated the last three legs of round 3 by ~9 % each, confirmed against
# a live vmstat sample.  Reject them rather than model them.
REJECT = {("k3", "nobc"), ("k3", "base"), ("k3", "ft1")}

legs = []
for f in sorted(glob.glob(os.path.join(S, "k[0-9]_*.log"))):
    stem = os.path.basename(f)[:-4]
    rnd, arm = stem.split("_", 1)
    if (rnd, arm) in REJECT:
        continue
    txt = open(f, errors="replace").read()
    m, ms = re.search(r"perMi:(.*)", txt), re.search(r"ms/Mi=([0-9.]+)", txt)
    if not m or not ms:
        continue
    d = {k: float(v) for k, v in re.findall(r"([A-Za-z_]\w*)=([0-9.]+)", m.group(1))}
    ic, gen = d.get("tbIcount", 0.0), d.get("tbGen", 0.0)
    if arm in ARMS and gen:
        legs.append((rnd, arm, ic / gen, float(ms.group(1))))

if len(legs) < 4:
    sys.exit(f"only {len(legs)} legs -- nothing to fit")

for arm in ARMS:
    v = [(l, m) for _, a, l, m in legs if a == arm]
    if v:
        print(f"{arm:<5} n={len(v)} len={sum(l for l, _ in v)/len(v):7.3f} "
              f"ms/Mi={sum(m for _, m in v)/len(v):6.3f}  "
              f"len spread {min(l for l, _ in v):.3f}..{max(l for l, _ in v):.3f}")

rounds = sorted({r for r, _, _, _ in legs})
print(f"\nper-round level (base leg, the control):")
for r in rounds:
    v = [m for rr, a, _, m in legs if rr == r and a == "base"]
    if v:
        print(f"  {r} base = {v[0]:.3f} ms/Mi")


def fit(pts, grouped):
    """ms = a + b/len.  grouped: one intercept per round, one shared slope."""
    xs = [(r, 1 / l, m) for r, _, l, m in pts]
    if grouped:
        keys = {r for r, _, _ in xs}
        gx = {k: [x for r, x, _ in xs if r == k] for k in keys}
        gy = {k: [y for r, _, y in xs if r == k] for k in keys}
        mx = {k: sum(v) / len(v) for k, v in gx.items()}
        my = {k: sum(v) / len(v) for k, v in gy.items()}
        num = sum((x - mx[r]) * (y - my[r]) for r, x, y in xs)
        den = sum((x - mx[r]) ** 2 for r, x, _ in xs)
        b = num / den if den else 0.0
        a = {k: my[k] - b * mx[k] for k in keys}
        pred = lambda r, x: a[r] + b * x
        # R^2 against the grouped model's own null: each round's mean.
        ss_tot = sum((y - my[r]) ** 2 for r, _, y in xs)
    else:
        n = len(xs)
        mx = sum(x for _, x, _ in xs) / n
        my = sum(y for _, _, y in xs) / n
        den = sum((x - mx) ** 2 for _, x, _ in xs)
        b = sum((x - mx) * (y - my) for _, x, y in xs) / den if den else 0.0
        a = {None: my - b * mx}
        pred = lambda r, x: a[None] + b * x
        ss_tot = sum((y - my) ** 2 for _, _, y in xs)
    ss_res = sum((y - pred(r, x)) ** 2 for r, x, y in xs)
    # Standard error of the slope.  With R^2 this low the point estimate
    # alone is misleading -- the question is whether b clears zero.
    df = len(xs) - (len(a) + 1)
    se = ((ss_res / df) / den) ** 0.5 if df > 0 and den else float("nan")
    return b, a, (1 - ss_res / ss_tot if ss_tot else 0.0), se


bl = sum(l for _, a, l, _ in legs if a == "base") / max(
    1, sum(1 for _, a, _, _ in legs if a == "base"))

for label, grouped in (("pooled (drift left in)", False),
                       ("per-round intercept (drift held out)", True)):
    b, a, r2, se = fit(legs, grouped)
    lvl = (sum(a.values()) / len(a))
    entry = b / bl
    print(f"\n{label}")
    print(f"  ms/Mi = {lvl:.4f} + {b:.4f}/len over {len(legs)} legs, "
          f"R^2 = {r2:.3f}"
          + (f"  intercepts {', '.join(f'{k}:{v:.3f}' for k, v in sorted(a.items()))}"
             if grouped else ""))
    lo, hi = (b - 2 * se) / bl, (b + 2 * se) / bl
    print(f"  slope {b:.3f} +- {se:.3f} (1 s.e.);  95 % band on the entry term "
          f"{lo/(lvl+lo)*100:.1f} .. {hi/(lvl+hi)*100:.1f} % of wall")
    print(f"  at base len {bl:.3f}: entry = {entry:.4f} ms/Mi = "
          f"{entry/(lvl + entry)*100:.1f} % of wall")
    for L in (bl, 18.05):
        print(f"    if executed len is {L:5.2f}: {1e6/L:>9,.0f} entries/Mi -> "
              f"{entry*1e6/(1e6/L):5.1f} ns per entry")
