import re
import sys

# Audits the wasm32 migration: for every w64_memarg site, which expression
# pushed the ADDRESS, and is it one that narrows under W64_MEM32?
#
# Unlike addrsrc.py this does not carry a hand-kept line list -- the store
# shape is derived from the opcode byte at the site, so it survives edits.
# A load is (addr, opc, memarg) and a store is (addr, value, opc, memarg),
# so for a store the address is the *second*-to-last push.
SRC = "/workspace/qemu/tcg/wasm64/tcg-target.c.inc"
lines = open(SRC).read().split("\n")

# Opcode bytes that are stores.  0x36-0x3e are i32/i64/f32/f64 store forms;
# 0x17-0x19 behind a 0xfe prefix are the atomic stores.
ST = {0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e}
ST_ATOMIC = {0x17, 0x18, 0x19}

# Sites the push-counting heuristic cannot resolve, each read and checked by
# hand.  Keyed by enclosing function, which survives the line shifts that
# editing this file causes; the value says what actually pushes the address.
KNOWN = {
    "w64_load":      "w64_get_addr / w64_addr, both narrowed",
    "w64_store":     "w64_get_addr / w64_addr; the nearer push is the value",
    "tcg_out_sti":   "w64_get_addr / w64_addr; the nearer push is the value",
    "w64_emit_pad":  "the first w64_const_addr; the pad loop's constants "
                     "sit between it and the store",
    "w64_st_fast":   "w64_tlb_haddr; the nearer push is the value",
    "w64_tb_prologue": "w64_const_addr(w64_acct_addr[..]) on the line above",
}

NARROW = ("w64_const_addr", "w64_get_addr", "w64_addr", "w64_tlb_haddr",
          "w64_wrap_addr")
RAW = ("w64_get_i64", "w64_const_i64")
PUSH = re.compile(r"\b(w64_wrap_addr|w64_get_i64|w64_get_i32|w64_get|"
                  r"w64_const_i64|w64_const_i32|w64_const_addr|w64_get_addr|"
                  r"w64_const|w64_local_get|w64_local_tee|w64_addr|"
                  r"w64_tlb_haddr)\s*\(")
OPC = re.compile(r"0x([0-9a-fA-F]{2})")


def opcode_before(n):
    """The opcode byte emitted for the site at line n (1-based)."""
    for j in range(n - 1, max(-1, n - 5), -1):
        if "w64_u8" in lines[j] or "wb_u8" in lines[j]:
            m = OPC.findall(lines[j])
            if m:
                return [int(x, 16) for x in m]
    return []


def enclosing(n):
    for j in range(n - 1, -1, -1):
        m = re.match(r"(?:static\s+)?[\w *]+?\**(\w+)\(", lines[j])
        if m and not lines[j].startswith((" ", "\t", "#", "*", "/")):
            return m.group(1)
    return "?"


def label(j):
    m = PUSH.search(lines[j])
    nm = m.group(1)
    if nm == "w64_local_get":
        v = re.search(r"w64_local_get\(s,\s*(\w+)", lines[j])
        return "local %s" % (v.group(1) if v else "?")
    return nm


bad, rows = [], []
for n, ln in enumerate(lines, 1):
    if "w64_memarg(" not in ln or "static void" in ln:
        continue
    if ln.lstrip().startswith(("*", "/*", "//")):
        continue
    ops = opcode_before(n)
    is_store = any(o in ST for o in ops) or (
        0xfe in ops and any(o in ST_ATOMIC for o in ops))
    pushes = []
    for j in range(n - 2, max(-1, n - 24), -1):
        if PUSH.search(lines[j]):
            pushes.append(j)
        if len(pushes) >= 3:
            break
    want = 1 if is_store else 0
    src = label(pushes[want]) if len(pushes) > want else "?"
    fn = enclosing(n)
    rows.append((n, "st" if is_store else "ld", src))
    if (src in RAW or src == "?") and fn not in KNOWN:
        bad.append((n, "st" if is_store else "ld", src, fn))

print("%d sites" % len(rows))
by = {}
for n, k, src in rows:
    by.setdefault(src, []).append((n, k))
for src in sorted(by, key=lambda k: -len(by[k])):
    mark = "OK  " if src in NARROW else ("**  " if src in RAW or src == "?"
                                         else "?   ")
    print("  %s%-16s %2d  %s" % (mark, src, len(by[src]),
                                 " ".join("%d%s" % (n, "s" if k == "st" else "")
                                          for n, k in by[src])))
print("\nheuristic could not resolve these; each read and checked by hand:")
for fn, why in sorted(KNOWN.items()):
    print("  %-18s %s" % (fn, why))
if bad:
    print("\nSTILL 64-BIT -- these would fail validation under W64_MEM32:")
    for n, k, src, fn in bad:
        print("  line %-5d %-3s %-16s in %s" % (n, k, src, fn))
sys.exit(1 if bad else 0)
