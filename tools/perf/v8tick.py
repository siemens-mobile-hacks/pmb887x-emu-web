#!/usr/bin/env python3
# Resolve a V8 --prof log (one isolate) into self-time buckets: main-module
# wasm functions (named from an emscripten symbol map), TB-module wasm,
# named V8 builtins, the Chrome binary's own C++, and system libraries.
# V8's own signal sampler sees what the DevTools profiler leaves unresolved
# (it charges builtins and runtime C++ to a caller frame).
#
#   SCENEBENCH_CHROME_ARGS="--js-flags=--prof,--logfile=$D/v8.log" \
#     node tools/scenebench.mjs video dist-x --runs 1
#   tools/perf/v8tick.py $D/isolate-<vcpu>-v8.log site/dist-x/qemu-system-arm.js.symbols [last-secs]
#
# The vCPU isolate is the log with the most code-creation records (TB
# modules are only ever created there).  last-secs keeps the final window,
# i.e. the --hold playback, and drops the boot.
import bisect
import os
import sys
from collections import Counter

log, symf = sys.argv[1], sys.argv[2]
last = float(sys.argv[3]) if len(sys.argv) > 3 else 140.0
# drop every 1 s bin in which this main-module function holds more than
# the given share of ticks (on SL65 video, do_ld4_mmu marks the player's
# idle SCCU poll between clips, which the meter's window never sees)
drop_fn = sys.argv[4] if len(sys.argv) > 4 else None
drop_share = float(sys.argv[5]) if len(sys.argv) > 5 else 0.01

sym = {}
for line in open(symf):
    k, _, v = line.rstrip("\n").partition(":")
    sym[k] = v

starts, ends, names = [], [], []
libs = []
ticks = []
mod_fns = Counter()


def add(start, size, name):
    # new code evicts every older range it overlaps (freed code space is
    # reused, and a stale range would keep claiming the new code's ticks)
    end = start + size
    i = bisect.bisect_left(starts, start)
    if i > 0 and ends[i - 1] > start:
        i -= 1
    j = i
    while j < len(starts) and starts[j] < end:
        j += 1
    del starts[i:j], ends[i:j], names[i:j]
    starts.insert(i, start)
    ends.insert(i, start + size)
    names.insert(i, name)


def lookup(pc):
    i = bisect.bisect_right(starts, pc) - 1
    if i >= 0 and pc < ends[i]:
        return names[i]
    return None


def libof(pc):
    for n, a, b in libs:
        if a <= pc < b:
            return n
    return None


for line in open(log, errors="replace"):
    p = line.rstrip("\n").split(",")
    t = p[0]
    if t == "code-creation":
        kind, addr, size, name = p[1], int(p[4], 16), int(p[5]), p[6]
        if name.startswith("wasm-function[") and len(p) > 7:
            idx = name[14:-1]
            mod = int(p[7], 16) - int(idx)    # logged as module base + index
            mod_fns[mod] += 1
            name = ("W", mod, idx, p[8] == "*")    # "*" = TurboFan
        elif name.startswith("tb_") and len(p) > 8:
            # a W64_NAME_TBS build: tb_<pc>_<icount>_<flags>
            name = ("W", 0, name, p[8] == "*")
        else:
            name = (kind, name)
        add(addr, size, name)
    elif t == "code-move":
        a, b = int(p[1], 16), int(p[2], 16)
        i = bisect.bisect_left(starts, a)
        if i < len(starts) and starts[i] == a:
            sz, nm = ends[i] - a, names[i]
            del starts[i], ends[i], names[i]
            add(b, sz, nm)
    elif t == "shared-library":
        libs.append((p[1].rsplit("/", 1)[-1], int(p[2], 16), int(p[3], 16)))
    elif t == "tick":
        pc, us, vms = int(p[1], 16), int(p[2]), p[5]
        caller = None
        if os.environ.get("V8T_CXXCALLER") and lookup(pc) is None:
            for a in p[6:]:
                try:
                    caller = lookup(int(a, 16))
                except ValueError:
                    continue
                if caller is not None:
                    break
        chain = None
        if os.environ.get("V8T_CHAIN"):
            chain = []
            for a in p[6:]:
                try:
                    c = lookup(int(a, 16))
                except ValueError:
                    continue
                if c is not None:
                    chain.append(c)
                if len(chain) >= 12:
                    break
        ticks.append((us, pc, vms, lookup(pc), caller, chain))

main_mod = mod_fns.most_common(1)[0][0]
tmax = ticks[-1][0]
t0 = ticks[0][0]


def cat_of(pc, nm):
    if nm is None:
        lib = libof(pc) or "?"
        return "chrome C++" if lib.startswith("chrome") else "lib " + lib
    if nm[0] == "W":
        if nm[1] == main_mod:
            if os.environ.get("V8T_MAINTIER"):
                return "main-module wasm, " + ("TurboFan" if nm[3] else "Liftoff")
            return "main-module wasm"
        return "TB-module wasm, " + ("TurboFan" if nm[3] else "Liftoff")
    return nm[0]


# V8T_TIMELINE=<secs>: per-bin tick count and bucket shares over the whole
# log, to find a run's phases (boot / idle / menu) before windowing
if os.environ.get("V8T_TIMELINE"):
    step = float(os.environ["V8T_TIMELINE"]) * 1e6
    bins = {}
    for us, pc, vms, nm, *_ in ticks:
        bins.setdefault(int((us - t0) // step), Counter())[cat_of(pc, nm)] += 1
    for b in sorted(bins):
        c = bins[b]
        n = sum(c.values())
        tb = sum(v for k, v in c.items() if k.startswith("TB-"))
        lw = sum(v for k, v in c.items() if k.startswith("lib "))
        print(f"t={b * step / 1e6:6.0f}s ticks={n:6d} TB {100 * tb / n:5.1f} "
              f"C {100 * c['main-module wasm'] / n:5.1f} libs {100 * lw / n:5.1f} "
              f"chrome {100 * c['chrome C++'] / n:5.1f}")
# V8T_WIN=<from>,<to>: seconds since the first tick; replaces last-secs
if os.environ.get("V8T_WIN"):
    a, b = (float(x) * 1e6 + t0 for x in os.environ["V8T_WIN"].split(","))
    win = [x for x in ticks if a <= x[0] < b]
    last = (b - a) / 1e6
else:
    win = [x for x in ticks if x[0] >= tmax - last * 1e6]
if drop_fn:
    bins, hot = Counter(), Counter()
    for us, pc, vms, nm, *_ in win:
        bins[us // 1000000] += 1
        if nm and nm[0] == "W" and nm[1] == main_mod and sym.get(nm[2]) == drop_fn:
            hot[us // 1000000] += 1
    bad = {b for b in bins if hot[b] > drop_share * bins[b]}
    win = [x for x in win if x[0] // 1000000 not in bad]
    print(f"dropped {len(bad)} of {len(bins)} 1 s bins where {drop_fn} > {100 * drop_share:.1f} %")
n = len(win)
bucket, fn, vm = Counter(), Counter(), Counter()
for us, pc, vms, nm, *_ in win:
    vm[vms] += 1
    cat = cat_of(pc, nm)
    bucket[cat] += 1
    if nm is None:
        fn[cat] += 1
    elif cat == "main-module wasm":
        fn["C " + sym.get(nm[2], "wasm-function[" + nm[2] + "]")] += 1
    elif nm[0] != "W":
        fn[nm[0] + " " + nm[1]] += 1

print(f"window {last:.0f}s: {n} ticks of {len(ticks)}; vmstate {dict(vm)}")
for k, v in bucket.most_common():
    print(f"  {100 * v / n:6.2f} %  {k}")
print("top entries outside TB modules:")
for k, v in fn.most_common(int(os.environ.get("V8T_N", 45))):
    print(f"  {100 * v / n:6.2f} %  {k}")
# V8T_CXXCALLER=1: who calls into the C++/library code (first resolvable stack frame)
if os.environ.get("V8T_CXXCALLER"):
    cc = Counter()
    for us, pc, vms, nm, caller, *_ in win:
        if nm is None:
            c = caller
            if c is None:
                key = "?"
            elif c[0] == "W":
                key = ("C " + sym.get(c[2], c[2])) if c[1] == main_mod else "TB code"
            else:
                key = c[0] + " " + c[1]
            cc[(cat_of(pc, nm), key)] += 1
    print("C++/lib ticks by first known caller:")
    for k, v in cc.most_common(40):
        print(f"  {100 * v / n:6.2f} %  {k[0]} <- {k[1]}")
# V8T_CHAIN=<substring>: main-module call chains of the ticks whose stack holds a frame named so
if os.environ.get("V8T_CHAIN"):
    want = os.environ["V8T_CHAIN"]
    ch = Counter()
    def nmof(c):
        if c[0] == "W":
            return sym.get(c[2], c[2]) if c[1] == main_mod else "TB"
        return c[1].split(" ")[0]
    for us, pc, vms, nm, caller, chain in win:
        names = [nmof(c) for c in chain or []]
        if nm is not None:
            names.insert(0, nmof(nm))
        if any(want in x for x in names):
            i = next(i for i, x in enumerate(names) if want in x)
            if os.environ.get("V8T_LEAF"):
                ch[" < ".join(names[:min(i, 3)]) or names[0]] += 1
            else:
                ch[" < ".join(names[i:i + 6])] += 1
    print(f"chains through {want}:")
    for k, v in ch.most_common(25):
        print(f"  {100 * v / n:6.2f} %  {k}")
# V8T_TBTOP=<n>: the hottest TB-module functions (module base, index, tier)
if os.environ.get("V8T_TBTOP"):
    tbf = Counter()
    for us, pc, vms, nm, *_ in win:
        if nm and nm[0] == "W" and nm[1] != main_mod:
            tbf[(nm[1], nm[2], "T" if nm[3] else "L")] += 1
    tot = sum(tbf.values())
    acc = 0
    print(f"TB functions with ticks: {len(tbf)}")
    for k, v in tbf.most_common(int(os.environ["V8T_TBTOP"])):
        acc += v
        print(f"  {100 * v / n:6.2f} %  (cum {100 * acc / tot:5.1f} % of TB)  mod {k[0]:#x} fn {k[1]} {k[2]}")
