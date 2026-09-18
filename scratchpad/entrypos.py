import glob, math, os, re, sys

# entryfit.py, with the sweep's position effect in the model.
#
# entryfit fits ms/Mi = a_round + b/len and reads the entry cost off b.
# Its per-round intercept holds out drift *between* rounds and nothing
# within one.  square.py found a within-round gradient of +0.87 % +- 0.32
# per position, and position is not independent of the regressor here:
# the arms sit at different mean positions (ft6 2.5, base 4.0) and the
# arms are what move `len`, so an unmodelled position trend leaks
# straight into the slope that prices an entry.
#
# Same data, same functional form, one more column.  If b survives, the
# 15.8 % budget row survives with it.
S = os.path.dirname(os.path.abspath(__file__))
if not glob.glob(os.path.join(S, "k[0-9]_*.log")):
    S = os.path.join(S, "round35")
REJECT = {("k3", "nobc"), ("k3", "base"), ("k3", "ft1")}
ARMS = ("ft1", "base", "ft4", "ft6")

rows = []
for f in glob.glob(os.path.join(S, "k[0-9]_*.log")):
    rnd, arm = os.path.basename(f)[:-4].split("_", 1)
    txt = open(f, errors="replace").read()
    pm, ms = re.search(r"perMi:(.*)", txt), re.search(r"ms/Mi=([0-9.]+)", txt)
    if not pm or not ms:
        continue
    d = {k: float(v) for k, v in
         re.findall(r"([A-Za-z_]\w*)=([0-9.]+)", pm.group(1))}
    if d.get("tbGen"):
        rows.append([os.path.getmtime(f), rnd, arm,
                     d["tbIcount"] / d["tbGen"], float(ms.group(1)), 0])
rows.sort()
seen = {}
for r in rows:                                   # position within its round
    seen[r[1]] = seen.get(r[1], 0) + 1
    r[5] = seen[r[1]]

legs = [r for r in rows if r[2] in ARMS and (r[1], r[2]) not in REJECT]
RNDS = sorted({r[1] for r in legs})


def lstsq(X, y):
    k = len(X[0])
    A = [[sum(X[i][a] * X[i][b] for i in range(len(X))) for b in range(k)]
         + [1.0 if a == b else 0.0 for b in range(k)]
         + [sum(X[i][a] * y[i] for i in range(len(X)))] for a in range(k)]
    for c in range(k):
        p = max(range(c, k), key=lambda r: abs(A[r][c]))
        if abs(A[p][c]) < 1e-12:
            sys.exit("singular")
        A[c], A[p] = A[p], A[c]
        d = A[c][c]
        A[c] = [v / d for v in A[c]]
        for r in range(k):
            if r != c and A[r][c]:
                f = A[r][c]
                A[r] = [v - f * w for v, w in zip(A[r], A[c])]
    beta = [A[a][-1] for a in range(k)]
    res = [y[i] - sum(X[i][a] * beta[a] for a in range(k)) for i in range(len(X))]
    df = len(X) - k
    s2 = sum(v * v for v in res) / df
    se = [math.sqrt(s2 * A[a][k + a]) for a in range(k)]
    my = sum(y) / len(y)
    r2 = 1 - sum(v * v for v in res) / sum((v - my) ** 2 for v in y)
    return beta, se, df, r2


def run(label, with_pos):
    X, y = [], []
    for _, rnd, _, L, ms, p in legs:
        row = [1.0 if rnd == r else 0.0 for r in RNDS] + [1.0 / L]
        if with_pos:
            row.append(float(p - 1))
        X.append(row)
        y.append(ms)
    beta, se, df, r2 = lstsq(X, y)
    b, sb = beta[len(RNDS)], se[len(RNDS)]
    lvl = sum(beta[:len(RNDS)]) / len(RNDS)
    bl = sum(L for _, _, a, L, _, _ in legs if a == "base") / \
        sum(1 for _, _, a, _, _, _ in legs if a == "base")
    share = lambda v: v / bl / (lvl + v / bl) * 100
    print(f"\n{label}   (n {len(legs)}, df {df}, R2 {r2:.3f})")
    print(f"  slope {b:.3f} +- {sb:.3f}   entry = {share(b):.1f} % of wall"
          f"   95 % band {share(b-2*sb):.1f} .. {share(b+2*sb):.1f} %")
    if with_pos:
        print(f"  position {beta[-1]:+.4f} +- {se[-1]:.4f} ms/Mi per slot "
              f"({beta[-1]/lvl*100:+.2f} %/slot)"
              f"{'' if beta[-1]-2*se[-1] < 0 < beta[-1]+2*se[-1] else '  *'}")
    print(f"  entries/Mi at executed len 18.05 -> "
          f"{b/bl*1e6/(1e6/18.05):.1f} ns per entry")


run("per-round intercept only (what entryfit.py fits)", False)
run("per-round intercept + linear position", True)
