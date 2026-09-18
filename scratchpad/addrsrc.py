import re

# Which expression pushes the ADDRESS at each w64_memarg site.
#
# A load is (addr, opc, memarg): the address is the last push before the
# opcode.  A store is (addr, value, opc, memarg): the last push is the
# value and the address is the one before it.  Getting this wrong is not
# a cosmetic error -- it is what puts an i32.wrap_i64 on the stored value
# instead of the address, and the resulting validation error reads like a
# backend type bug rather than a missed wrap.
SRC = "/workspace/qemu/tcg/wasm64/tcg-target.c.inc"
lines = open(SRC).read().split("\n")

DOC_LD = {1071,1075,1524,1532,1592,1720,1863,1890,1949,2029,2036,2043,2098,
          2102,2136,2177,2236,2263,3452,3461,3481,3494,3513}
DOC_ST = {1091,1096,1203,1208,1613,1711,1867,1894,1957,2145,2227,2280,3458,
          3467,3488}
kind = {**{n: "load" for n in DOC_LD}, **{n: "store" for n in DOC_ST}}

# Known exception, left uncorrected so the scan stays honest about its
# own reach: w64_st_fast pushes its value through a two-branch ternary
# (:2275 / :2277), so skipping one push lands on the other branch and
# :2280 reports w64_get_i64.  Its real address source is w64_tlb_haddr
# at :2273, same as :2263.  :2227 pushes its address outside the window.
PUSH = re.compile(r"\b(w64_get_i64|w64_get_i32|w64_get|w64_const_i64|"
                  r"w64_const|w64_local_get|w64_addr|w64_tlb_haddr)\s*\(")


def label(j):
    m = PUSH.search(lines[j])
    nm = m.group(1)
    if nm == "w64_local_get":
        v = re.search(r"w64_local_get\(s,\s*(\w+)", lines[j])
        return f"local {v.group(1)}" if v else nm
    return nm


by = {}
for n in sorted(kind):
    pushes = []
    for j in range(n - 2, max(-1, n - 22), -1):
        if PUSH.search(lines[j]):
            pushes.append(j)
        if len(pushes) >= 3:
            break
    want = 0 if kind[n] == "load" else 1        # skip the value for a store
    src, at = ("?", None)
    if len(pushes) > want:
        j = pushes[want]
        src, at = label(j), j + 1
    by.setdefault(src, []).append((n, kind[n], at))

tot = sum(len(v) for v in by.values())
print(f"{tot} sites, address source resolved for "
      f"{tot - len(by.get('?', []))}\n")
for src in sorted(by, key=lambda k: -len(by[k])):
    rows = by[src]
    ns = sum(1 for _, k, _ in rows if k == "store")
    print(f"  {src:<18} {len(rows):>2} sites ({ns} st)")
    print(f"     {' '.join(f'{n}{"s" if k=="store" else ""}' for n, k, _ in rows)}")
