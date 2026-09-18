import glob, math, os, re, sys

# The sweep is a Latin square.  Fit it like one.
#
# ftsweep2.sh rotates the arm order by one each round, so round k1 ran
# base,ft1,ft4,ft6,pg12,nobc and k4 ran ft6,pg12,nobc,base,ft1,ft4: four
# rows of a cyclic 6x6 Latin square.  Every arm therefore appears exactly
# once per round and in four *different* positions -- which means arm,
# round and position main effects are all estimable, and none of them is
# confounded with the others.
#
# ratios.py does not use that.  It divides each leg by its own round's
# base and averages, which removes the round effect and nothing else.  It
# is blind to position, and position is not nothing here: averaged over
# all four rounds, legs run first in a round read -1.7 % against their
# arm's mean and legs run last read +1.8 %.  With only four of six rows,
# the arms do not visit the positions evenly -- ft6 averages position
# 2.5 and base 4.0 -- so a position trend lands on the arm and imitates
# an effect, which is the same failure ratios.py was written to fix one
# level up.
#
# Fit log(ms/Mi), so coefficients read as percentages and the round
# effect is multiplicative -- which is what a host that is uniformly
# n % slower for ten minutes actually does.
#
# Reference coding: arm=base, round=k1, position=1.  14 parameters
# against 24 legs leaves 10 residual degrees of freedom, which is what
# makes the standard errors worth printing.
S = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[-1]):
    S = sys.argv[-1]
elif not glob.glob(os.path.join(S, "k[0-9]_*.log")):
    S = os.path.join(S, "round35")          # the archived evidence
REJECT = {("k3", "nobc"), ("k3", "base"), ("k3", "ft1")}

legs = []
for f in glob.glob(os.path.join(S, "k[0-9]_*.log")):
    rnd, arm = os.path.basename(f)[:-4].split("_", 1)
    m = re.search(r"ms/Mi=([0-9.]+)", open(f, errors="replace").read())
    if m:
        legs.append([os.path.getmtime(f), rnd, arm, float(m.group(1)), 0])
legs.sort()

pos = {}
for L in legs:
    pos[L[1]] = pos.get(L[1], 0) + 1
    L[4] = pos[L[1]]

ARMS = ["ft1", "ft4", "ft6", "pg12", "nobc"]       # base is the reference
RNDS = ["k2", "k3", "k4"]
POSS = [2, 3, 4, 5, 6]


def design(rows, arm=True, rnd=True, pos="dummy"):
    names, cols = ["mu"], [lambda r: 1.0]
    if arm:
        for a in ARMS:
            names.append(f"arm:{a}")
            cols.append(lambda r, a=a: 1.0 if r[2] == a else 0.0)
    if rnd:
        for k in RNDS:
            names.append(f"rnd:{k}")
            cols.append(lambda r, k=k: 1.0 if r[1] == k else 0.0)
    if pos == "dummy":
        for p in POSS:
            names.append(f"pos:{p}")
            cols.append(lambda r, p=p: 1.0 if r[4] == p else 0.0)
    elif pos == "linear":
        names.append("pos:slope")
        cols.append(lambda r: float(r[4] - 1))
    X = [[c(r) for c in cols] for r in rows]
    y = [math.log(r[3]) for r in rows]
    return names, X, y


def solve(names, X, y):
    k = len(names)
    # normal equations, augmented with the identity so one elimination
    # yields both the solution and (X'X)^-1 for the standard errors
    A = [[sum(X[i][a] * X[i][b] for i in range(len(X))) for b in range(k)]
         + [1.0 if a == b else 0.0 for b in range(k)]
         + [sum(X[i][a] * y[i] for i in range(len(X)))] for a in range(k)]
    for c in range(k):
        piv = max(range(c, k), key=lambda r: abs(A[r][c]))
        if abs(A[piv][c]) < 1e-9:
            sys.exit(f"singular at {names[c]} -- the design is not balanced "
                     f"enough to separate these effects")
        A[c], A[piv] = A[piv], A[c]
        d = A[c][c]
        A[c] = [v / d for v in A[c]]
        for r in range(k):
            if r != c and A[r][c]:
                f = A[r][c]
                A[r] = [v - f * w for v, w in zip(A[r], A[c])]
    beta = [A[a][-1] for a in range(k)]
    inv = [[A[a][k + b] for b in range(k)] for a in range(k)]
    ssr = sum((y[i] - sum(X[i][a] * beta[a] for a in range(k))) ** 2
              for i in range(len(X)))
    return beta, inv, ssr


def betai(a, b, x):
    """Regularized incomplete beta, for F-test p-values without scipy."""
    if x <= 0 or x >= 1:
        return 0.0 if x <= 0 else 1.0
    lbeta = (math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
             + a * math.log(x) + b * math.log(1 - x))
    if x >= (a + 1) / (a + b + 2):
        return 1.0 - betai(b, a, 1 - x)
    # Lentz's continued fraction
    tiny, c, d = 1e-30, 1.0, 1.0 - (a + b) * x / (a + 1)
    d = tiny if abs(d) < tiny else d
    d, h = 1 / d, 1 / d
    for m in range(1, 300):
        m2 = 2 * m
        for num in (m * (b - m) * x / ((a + m2 - 1) * (a + m2)),
                    -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1))):
            d = 1 + num * d
            d = tiny if abs(d) < tiny else d
            c = 1 + num / c
            c = tiny if abs(c) < tiny else c
            d = 1 / d
            h *= d * c
        if abs(d * c - 1) < 1e-12:
            break
    return math.exp(lbeta) * h / a


def pf(F, d1, d2):
    """P(F_{d1,d2} > F)."""
    return betai(d2 / 2, d1 / 2, d2 / (d2 + d1 * F)) if F > 0 else 1.0


def report(label, rows):
    names, X, y = design(rows)
    beta, inv, ssr = solve(names, X, y)
    df = len(rows) - len(names)
    s2 = ssr / df
    print(f"\n=== {label}   (n {len(rows)}, residual df {df}, "
          f"rmse {math.sqrt(s2)*100:.2f} %)")
    for i, n in enumerate(names):
        s = math.sqrt(s2 * inv[i][i])
        if n == "mu":
            print(f"  {n:<10} {math.exp(beta[i]):8.3f} ms/Mi  "
                  f"(base, round 1, position 1)")
            continue
        lo, hi = beta[i] - 2 * s, beta[i] + 2 * s
        print(f"  {n:<10} {(math.exp(beta[i])-1)*100:+8.2f}%  +-{s*100:5.2f}  "
              f"95% [{(math.exp(lo)-1)*100:+6.2f},{(math.exp(hi)-1)*100:+6.2f}]"
              f"{'' if lo < 0 < hi else '  *'}")

    # Does each factor earn its parameters?  Drop it, refit, compare.
    print(f"  {'factor':<22} {'params':>6} {'F':>7} {'p':>8}")
    for what, kw in (("arm (all 5)", dict(arm=False)),
                     ("round (all 3)", dict(rnd=False)),
                     ("position (all 5)", dict(pos=None)),
                     ("position curvature", dict(pos="linear"))):
        n2, X2, y2 = design(rows, **kw)
        _, _, ssr2 = solve(n2, X2, y2)
        d1 = len(names) - len(n2)
        F = ((ssr2 - ssr) / d1) / s2
        print(f"  {what:<22} {d1:>6} {F:>7.2f} {pf(F, d1, df):>8.4f}")

    # If position is really a monotone drift, one slope says it with four
    # fewer parameters -- and four more degrees of freedom on every arm.
    n2, X2, y2 = design(rows, pos="linear")
    b2, inv2, ssr2 = solve(n2, X2, y2)
    df2 = len(rows) - len(n2)
    s22 = ssr2 / df2
    print(f"\n  -- same data, position as one linear trend (df {df2}) --")
    for i, n in enumerate(n2):
        if n == "mu":
            continue
        s = math.sqrt(s22 * inv2[i][i])
        lo, hi = b2[i] - 2 * s, b2[i] + 2 * s
        tag = "%/position" if n == "pos:slope" else ""
        print(f"  {n:<10} {(math.exp(b2[i])-1)*100:+8.2f}%  +-{s*100:5.2f}  "
              f"95% [{(math.exp(lo)-1)*100:+6.2f},{(math.exp(hi)-1)*100:+6.2f}]"
              f"{'' if lo < 0 < hi else '  *'} {tag}")


report("all 24 legs", legs)
report("21 legs, the k3 burst held out",
       [L for L in legs if (L[1], L[2]) not in REJECT])
