import os, re, sys

# Split env traffic into a fixed per-TB part and a per-guest-instruction
# part by regressing per-TB counts on TB length.
#
# Units, from wasm-diag.h:112 and j2mebench.mjs:776.  Every perMi value is
# `counter delta / (executed guest instructions / 1e6)`.  TB_ICOUNT is the
# *sum of tb->icount over translated TBs*, not a mean, so:
#
#   mean TB length          = tbIcount / tbGen
#   per translated TB       = x / tbGen
#   per translated insn     = x / tbIcount        (NOT x/tbGen/tbIcount)
#
# A pure TB-boundary cost is all intercept; a pure per-instruction cost is
# all slope.  "Per TB" alone cannot tell them apart.
S = os.path.dirname(os.path.abspath(__file__))


def fit(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx
    a = my - b * mx
    my_ = my
    ss_tot = sum((y - my_) ** 2 for y in ys)
    ss_res = sum((y - (a + b * x)) ** 2 for x, y in zip(xs, ys))
    return a, b, (1 - ss_res / ss_tot) if ss_tot else float("nan")


rows = []
for name in sys.argv[1:]:
    try:
        txt = open(os.path.join(S, name + ".log"), errors="replace").read()
    except OSError:
        continue
    m = re.search(r"perMi:(.*)", txt)
    if not m:
        continue
    d = {k: float(v) for k, v in re.findall(r"([A-Za-z_]\w*)=([0-9.]+)", m.group(1))}
    gen, ic = d.get("tbGen"), d.get("tbIcount")
    if not gen or not ic:
        continue
    rows.append((name, ic / gen, d, gen, ic))

print(f"{'leg':<9}{'len':>7}{'gld/TB':>8}{'gst/TB':>8}{'ldst/TB':>9}"
      f"{'gld/in':>8}{'gst/in':>8}{'ldst/in':>9}")
for name, ln, d, gen, ic in rows:
    print(f"{name:<9}{ln:>7.3f}"
          f"{d.get('tcgGld',0)/gen:>8.2f}{d.get('tcgGst',0)/gen:>8.2f}"
          f"{d.get('ldstGen',0)/gen:>9.2f}"
          f"{d.get('tcgGld',0)/ic:>8.3f}{d.get('tcgGst',0)/ic:>8.3f}"
          f"{d.get('ldstGen',0)/ic:>9.3f}")

if len(rows) < 3:
    sys.exit("\nneed at least three TB-length points to fit")

xs = [r[1] for r in rows]
base = next((r for r in rows if r[0].endswith("base")), rows[0])
bl = base[1]
print(f"\nfit over {len(rows)} legs, TB length {min(xs):.2f}..{max(xs):.2f}")
print(f"{'counter':<12}{'fixed/TB':>10}{'per insn':>10}{'R^2':>8}"
      f"{'fixed share at base':>22}")
for key, what in (("tcgGld", "env loads"), ("tcgGst", "env stores"),
                  ("ldstGen", "guest ldst")):
    a, b, r2 = fit(xs, [r[2].get(key, 0.0) / r[3] for r in rows])
    print(f"{what:<12}{a:>10.2f}{b:>10.3f}{r2:>8.3f}"
          f"{a/(a+b*bl)*100:>21.0f} %")
print(f"\nbase TB length {bl:.3f} insns -> {1e6/bl:,.0f} TB entries/Mi "
      f"(if executed length == translated length)")
