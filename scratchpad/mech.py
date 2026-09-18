import glob, math, os, re, sys

# Wall cannot resolve the fold-through knob, so ask the counters instead.
#
# square.py puts ft4 at -2.09 +- 1.81 % over 24 legs: a point estimate
# that would be worth landing sitting inside a band that contains zero.
# Per-leg rmse is 2.8 %, so closing that band by wall alone needs on the
# order of 13x the rounds -- about forty hours of this host -- to price a
# lever that may not exist.
#
# But fold-through does not act on wall directly.  It acts by making TBs
# longer, which makes entries rarer, and *entries are counted*.  The
# counters come out of the guest, not the host: a counter ratio has no
# host drift in it at all, so the same four rounds that give wall a
# +-1.8 % band give the mechanism a far tighter one.  If the mechanism
# does not move, the wall effect has nowhere to come from and the size of
# the wall band stops mattering.
#
# So: for each counter, report the arm's mean against its own round's
# base -- ratios.py's discipline, applied to mechanism instead of time --
# and print the round-to-round spread next to it, which is the honest
# error bar on a quantity whose only noise is guest nondeterminism.
S = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[-1]):
    S = sys.argv[-1]
elif not glob.glob(os.path.join(S, "k[0-9]_*.log")):
    S = os.path.join(S, "round35")          # the archived evidence
REJECT = {("k3", "nobc"), ("k3", "base"), ("k3", "ft1")}

# Entries, exits, and the work a longer TB is supposed to save.
KEYS = ["tbGen", "tbIcount", "execIter", "lookup", "lookupQht", "lookupJc",
        "lookupConfl", "xGotoptr", "xGototb", "xGototb1", "execSjmp",
        "tcgGst", "tcgGld", "tbBytes", "modNs", "hflagsCalls"]

legs = {}
for f in glob.glob(os.path.join(S, "k[0-9]_*.log")):
    rnd, arm = os.path.basename(f)[:-4].split("_", 1)
    txt = open(f, errors="replace").read()
    pm, ms = re.search(r"perMi:(.*)", txt), re.search(r"ms/Mi=([0-9.]+)", txt)
    if not pm or not ms:
        continue
    d = {k: float(v) for k, v in
         re.findall(r"([A-Za-z_]\w*)=([0-9.]+)", pm.group(1))}
    d["msMi"] = float(ms.group(1))
    legs[(rnd, arm)] = d

rounds = sorted({r for r, _ in legs})
arms = ["base", "ft1", "ft4", "ft6", "pg12", "nobc"]
drop = "--all" not in sys.argv
if drop:
    legs = {k: v for k, v in legs.items() if k not in REJECT}
    print("k3 burst legs held out (pass --all to keep them)")

print(f"\n{'counter':<12} " + " ".join(f"{a:>9}" for a in arms))
print(f"{'':12} " + " ".join(f"{'(abs)' if a == 'base' else '(vs base)':>9}"
                              for a in arms))
for key in ["msMi"] + KEYS:
    if not any(key in d for d in legs.values()):
        continue
    cells = []
    for arm in arms:
        rs = [(legs[(r, arm)][key], legs[(r, "base")][key]) for r in rounds
              if (r, arm) in legs and (r, "base") in legs
              and key in legs[(r, arm)] and key in legs[(r, "base")]
              and legs[(r, "base")][key]]
        if not rs:
            cells.append(f"{'-':>9}")
        elif arm == "base":
            cells.append(f"{sum(v for v, _ in rs)/len(rs):9.4g}")
        else:
            v = [a / b for a, b in rs]
            m = sum(v) / len(v)
            sd = (math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))
                  if len(v) > 1 else 0.0)
            cells.append(f"{(m-1)*100:+6.2f}{'!' if sd*100 > 1.0 else ' '}{len(v)}")
    print(f"{key:<12} " + " ".join(cells))

print("\n'!' marks a counter whose round-to-round sd exceeds 1 % -- guest\n"
      "nondeterminism, not a stable mechanism.  Trailing digit is n rounds.")

# The fold-through curve, cost side against wall side.
#
# The benefit fold-through is supposed to deliver -- fewer TB entries --
# is not in these logs: chained exits are only counted under W64_XCOUNT,
# and `lookup` sees just the slow lookups a chained exit never reaches.
# So this cannot show the benefit.  What it can show is the price, which
# is counted exactly, and whether the wall ever repays it.
print("\nfold-through: the price, and what the wall paid back")
print(f"  {'arm':<6} {'transl. len':>11} {'tbIcount/Mi':>12} {'tbBytes/Mi':>11} "
      f"{'tbGen/Mi':>9} {'wall':>8}")
for arm in ["ft1", "base", "ft4", "ft6"]:
    rs = [r for r in rounds if (r, arm) in legs and (r, "base") in legs]
    if not rs:
        continue
    mean = lambda fn, a: sum(fn(legs[(r, a)]) for r in rs) / len(rs)
    w, wb = mean(lambda d: d["msMi"], arm), mean(lambda d: d["msMi"], "base")
    print(f"  {arm:<6} {mean(lambda d: d['tbIcount']/d['tbGen'], arm):>11.3f} "
          f"{mean(lambda d: d['tbIcount'], arm):>12,.1f} "
          f"{mean(lambda d: d['tbBytes'], arm):>11,.0f} "
          f"{mean(lambda d: d['tbGen'], arm):>9.3f} "
          f"{(w/wb-1)*100:>+7.2f}%")
