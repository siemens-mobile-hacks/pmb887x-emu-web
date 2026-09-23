#!/usr/bin/env python3
# Resolve a V8 --prof log (one isolate) into self-time buckets: main-module
# wasm functions (named from an emscripten symbol map), TB-module wasm,
# named V8 builtins, the Chrome binary's own C++, and system libraries.
# V8's own signal sampler sees what the DevTools profiler leaves unresolved
# (it charges builtins and runtime C++ to a caller frame).
#
#   CHROME_ARGS="--no-sandbox --js-flags=--prof,--logfile=$D/v8.log" \
#     node tools/videobench.mjs --dist dist-x --hold 150
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
        ticks.append((us, pc, vms, lookup(pc)))

main_mod = mod_fns.most_common(1)[0][0]
tmax = ticks[-1][0]
t0 = ticks[0][0]


def cat_of(pc, nm):
    if nm is None:
        lib = libof(pc) or "?"
        return "chrome C++" if lib.startswith("chrome") else "lib " + lib
    if nm[0] == "W":
        if nm[1] == main_mod:
            return "main-module wasm"
        return "TB-module wasm, " + ("TurboFan" if nm[3] else "Liftoff")
    return nm[0]


# V8T_TIMELINE=<secs>: per-bin tick count and bucket shares over the whole
# log, to find a run's phases (boot / idle / menu) before windowing
if os.environ.get("V8T_TIMELINE"):
    step = float(os.environ["V8T_TIMELINE"]) * 1e6
    bins = {}
    for us, pc, vms, nm in ticks:
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
    for us, pc, vms, nm in win:
        bins[us // 1000000] += 1
        if nm and nm[0] == "W" and nm[1] == main_mod and sym.get(nm[2]) == drop_fn:
            hot[us // 1000000] += 1
    bad = {b for b in bins if hot[b] > drop_share * bins[b]}
    win = [x for x in win if x[0] // 1000000 not in bad]
    print(f"dropped {len(bad)} of {len(bins)} 1 s bins where {drop_fn} > {100 * drop_share:.1f} %")
n = len(win)
bucket, fn, vm = Counter(), Counter(), Counter()
for us, pc, vms, nm in win:
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
for k, v in fn.most_common(45):
    print(f"  {100 * v / n:6.2f} %  {k}")
