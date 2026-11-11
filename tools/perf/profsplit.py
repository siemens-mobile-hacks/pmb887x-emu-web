#!/usr/bin/env python3
# profsplit.py <cpuprofile> <qemu-system-arm.js.symbols>
# Splits the vCPU thread of a profile that tools/wprof2.mjs saved (PROF_SAVE)
# by what a sample runs, TB code or the main module, and by whether a DSP
# function is on the stack above it: the DSP's whole share of the thread.
# The symbols must be those of the dist that was profiled.
import json, re, sys, collections
prof = max(json.load(open(sys.argv[1])), key=lambda p: len(p["nodes"]))
sym = {}
for l in open(sys.argv[2]):
    i, _, n = l.rstrip("\n").partition(":")
    sym[int(i)] = n
def name(cf):
    m = re.match(r"wasm-function\[(\d+)\]", cf["functionName"] or "")
    if m and "qemu-system-arm.wasm" in (cf.get("url") or ""): return sym.get(int(m.group(1)), cf["functionName"])
    return cf["functionName"]
byid = {n["id"]: n for n in prof["nodes"]}
parent = {c: n["id"] for n in prof["nodes"] for c in n.get("children", [])}
DSP = re.compile(r"^(dsp_|teak_|helper_teak|tcg_fast_|tcg_execute_prepared|tcg_run_)")
memo = {}
def cls(i):
    if i in memo: return memo[i]
    n = byid[i]; cf = n["callFrame"]; url = cf.get("url") or ""
    dsp = False; j = i
    while j is not None:
        f = byid[j]["callFrame"]
        if "qemu-system-arm.wasm" in (f.get("url") or "") and DSP.match(name(f) or ""): dsp = True; break
        j = parent.get(j)
    if url.startswith("wasm://"): k = "tb"
    elif "qemu-system-arm.wasm" in url: k = "c"
    elif cf["functionName"] in ("(idle)",): k = "idle"
    else: k = "other"
    memo[i] = (k, dsp); return memo[i]
t = collections.Counter(); fn = collections.Counter()
for s, d in zip(prof["samples"], prof["timeDeltas"]):
    k, dsp = cls(s); t[(k, dsp)] += d
    if k == "c": fn[(name(byid[s]["callFrame"]), dsp)] += d
tot = sum(t.values()); busy = tot - t[("idle", False)]
print(f"thread {tot/1e3:.0f} ms, busy {100*busy/tot:.1f} %")
for (k, dsp), v in sorted(t.items(), key=lambda x: -x[1]): print(f"{100*v/busy:6.1f} % of busy  {k}{' under DSP' if dsp else ''}")
for (n, dsp), v in fn.most_common(14): print(f"   {100*v/busy:5.2f} %  {n}{' (DSP)' if dsp else ''}")
