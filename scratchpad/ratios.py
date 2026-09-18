import glob, os, re, sys

# The sweep's result, expressed the only way this host permits.
#
# Absolutes are not comparable across rounds here: `base` alone read
# 4.151, 4.209 and 4.543 ms/Mi in three successive rounds, a 9.4 % spread
# on the control, because ~100 GB of anon memory outside this container
# takes intermittent swap bursts.  Ratios inside a round survive it --
# nobc/base held at -26.0/-23.0/-26.2 % across those same rounds.
#
# So: divide every leg by its OWN round's base, then average the ratios.
# The spread across rounds is then an honest error bar on the effect
# rather than a measure of the neighbour's memory habits.
#
# REJECTED LEGS.  A burst is shorter than a round, so it does not hit a
# round evenly and within-round ratios do not save you either -- it hits
# a contiguous *run of legs*.  Round 3 ran ft4 17:50, ft6 17:53, pg12
# 17:56, nobc 17:59, base 18:01, ft1 18:04, and against the same arms in
# round 1 those read +0.0, +2.0, +1.5, +9.3, +9.4, +9.0 %.  The step is
# between pg12 and nobc, and `vmstat` independently showed the host
# swapping 24 k pages/s at 18:00 and flatly idle by 18:05.  The three
# late legs of k3 are the burst; everything else is clean.
REJECT = {("k3", "nobc"), ("k3", "base"), ("k3", "ft1")}

S = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[-1]):
    S = sys.argv[-1]
elif not glob.glob(os.path.join(S, "k[0-9]_*.log")):
    S = os.path.join(S, "round35")          # the archived evidence

legs = {}
for f in sorted(glob.glob(os.path.join(S, "k[0-9]_*.log"))):
    rnd, arm = os.path.basename(f)[:-4].split("_", 1)
    if (rnd, arm) in REJECT:
        continue
    txt = open(f, errors="replace").read()
    ms = re.search(r"ms/Mi=([0-9.]+)", txt)
    m = re.search(r"perMi:(.*)", txt)
    if not ms:
        continue
    d = {k: float(v) for k, v in re.findall(r"([A-Za-z_]\w*)=([0-9.]+)",
                                            m.group(1))} if m else {}
    ic, gen = d.get("tbIcount", 0.0), d.get("tbGen", 0.0)
    legs[(rnd, arm)] = (float(ms.group(1)), (ic / gen) if gen else 0.0)

rounds = sorted({r for r, _ in legs})
arms = sorted({a for _, a in legs}, key=lambda a: (a != "base", a))
if not any((r, "base") in legs for r in rounds):
    sys.exit("no base leg -- nothing to normalise against")

print(f"{'arm':<6} " + " ".join(f"{r:>8}" for r in rounds) +
      f" {'mean':>9} {'sd':>7}   vs base")
for arm in arms:
    cells, rels = [], []
    for r in rounds:
        cur, b = legs.get((r, arm)), legs.get((r, "base"))
        if cur and b and b[0]:
            rels.append(cur[0] / b[0] - 1.0)
            cells.append(f"{cur[0]:8.3f}")
        else:
            cells.append(f"{'-':>8}")
    if not rels:
        continue
    mu = sum(rels) / len(rels)
    sd = (sum((x - mu) ** 2 for x in rels) / len(rels)) ** 0.5 if len(rels) > 1 else 0.0
    flag = "" if len(rels) > 1 and abs(mu) > 2 * sd else "   (not resolved)"
    print(f"{arm:<6} " + " ".join(cells) +
          f" {mu*100:+8.2f}% {sd*100:6.2f}%{flag}")

print(f"\nbase absolutes: " +
      ", ".join(f"{r}={legs[(r,'base')][0]:.3f}" for r in rounds
                if (r, "base") in legs) +
      "  <- spread here is the host, not the code")
print("translated TB length by arm (mean):")
for arm in arms:
    v = [legs[(r, arm)][1] for r in rounds if (r, arm) in legs and legs[(r, arm)][1]]
    if v:
        print(f"  {arm:<6} {sum(v)/len(v):6.3f}")
