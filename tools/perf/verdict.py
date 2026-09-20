#!/usr/bin/env python3
"""
The A/B verdict, two ways.

  verdict.py tests/results/j2me-<tag>-<stamp>.log     (how ab.sh calls it)
  verdict.py <tag> [...]                              (any tag, from the JSONs)

Given a log it prints the palindrome block it always printed -- pooled
mean, both halves, and every leg -- and then the same legs re-read with the
two guards below.  Given tags it prints only the guarded form, over every
leg ever recorded for those tags.

GUARD ONE, the workload.  The window is a fixed 45 *guest*-seconds, which
makes the rate comparable across legs of different wall length but does not
make the workload the same.  Game 2 lands in three modes -- played (duty
0.150), its title screen (0.087, the start keys missed) and a leg whose
shape is game 1's (0.282, the walk went to another game).  A rate measured
in one is not comparable with a rate measured in another, so a leg outside
+/-BAND of its game's median duty is dropped and said so.  Two-sided on
purpose: a floor passes the wrong-game leg, and that one is the more
dangerous, because its rate looks perfectly ordinary.

GUARD TWO, the host, and it is the bigger of the two.  j2mebench's own
comment says MIPS/cpu "does not fall when another tenant takes a core away
-- it only falls when the thread is actually made to do more work".  Fitted
within identical configurations that is false: log(MIPS/cpu) on log(host
load) has slope about -0.29 with r -0.73, so over a load range of 4 to 42
the confound alone spans 1.96x, against A/B effects of 2 to 16 %.  CPU time
divides out how many SECONDS the host gave the vCPU; it cannot divide out
how much work a second contains, and under SMT and memory-bandwidth
contention that is most of what varies.

Two legs of lcdrow-on game 2 -- same binary, same query, every guest-side
counter equal to within 0.4 % -- read 82.25 and 144.35 because the host
went quiet between them.  A palindrome cancels LINEAR drift; that was a
step on the last leg, the one shape it cannot cancel, and the raw verdict
came out -34.7 %.  Corrected it is -10.7 %, and the arms sat at mean load
27.9 against 13.1, which is what LOAD-SKEWED prints.

The exponent is fitted WITHIN identical configurations -- every (tag, arm,
game) group mean-centred first -- so a build that happened to run in a
quiet hour cannot set its own correction.  A pooled fit would let the thing
being measured decide how much to correct it by.

Read the corrected column, and read n= and dropped= with it: off/on/on/off
cancels linear drift only while all four legs are there.
"""
import glob
import json
import math
import os
import re
import statistics as st
import sys
from collections import defaultdict

RES = "/workspace/tests/results"
BAND = 0.25
# hostBusy is the host's non-idle fraction over exactly the window and is
# the better covariate; hostLoad is a 60 s average over a 6-11 s window.
# Prefer hostBusy once enough legs carry it to fit an exponent on.
MINFIT = 12


def ms(xs):
    if not xs:
        return None, None
    return st.mean(xs), (st.stdev(xs) if len(xs) > 1 else 0.0)


def band(recs):
    """duty band per game, from every leg of every tag on disk"""
    duty = {}
    for r in recs:
        duty.setdefault(r["game"], []).append(r["duty"])
    return {g: (0.75 * st.median(d), 1.25 * st.median(d))
            for g, d in duty.items()}


ALL = []
for p in sorted(glob.glob(os.path.join(RES, "j2me-*-sweep.json"))):
    try:
        for r in json.load(open(p)):
            r["_file"] = p
            ALL.append(r)
    except Exception:
        pass
BAND_G = band(ALL)


def fit(key):
    """within-config log-log slope of mipsCpu on `key`, plus r and n"""
    grp = defaultdict(list)
    for r in ALL:
        v, m = r.get(key), r.get("mipsCpu")
        if v and m and v > 0:
            grp[(r.get("tag"), r["game"])].append((math.log(v), math.log(m)))
    xs, ys = [], []
    for v in grp.values():
        if len(v) < 2:
            continue
        mx, my = st.mean(x for x, _ in v), st.mean(y for _, y in v)
        xs += [x - mx for x, _ in v]
        ys += [y - my for _, y in v]
    sxx = sum(x * x for x in xs)
    if len(xs) < MINFIT or sxx <= 0:
        return None, None, len(xs)
    sl = sum(x * y for x, y in zip(xs, ys)) / sxx
    syy = sum(y * y for y in ys)
    r = sum(x * y for x, y in zip(xs, ys)) / math.sqrt(sxx * syy) if syy else 0.0
    return sl, r, len(xs)


KEY, SLOPE, RFIT, NFIT = None, None, None, 0
for k in ("hostBusy", "hostLoad"):
    s, r, n = fit(k)
    if s is not None and s < 0:
        KEY, SLOPE, RFIT, NFIT = k, s, r, n
        break
REF = st.median([r[KEY] for r in ALL if r.get(KEY)]) if KEY else None


def adj(r):
    """mipsCpu as it would have read at the reference host occupancy"""
    v = r.get(KEY) if KEY else None
    if not v or not r.get("mipsCpu"):
        return r.get("mipsCpu")
    return r["mipsCpu"] * (v / REF) ** (-SLOPE)


def header():
    if KEY:
        print(f"    [host correction: {KEY}**{-SLOPE:.3f} about {REF:.2f}, "
              f"fitted within-config r {RFIT:+.2f} on {NFIT} legs]")
    else:
        print("    [host correction: not enough paired legs to fit -- raw only]")


def guarded(legs, label):
    """legs: list of (arm, [records]) in run order"""
    arms = {}
    for arm, recs in legs:
        for r in recs:
            arms.setdefault((arm, r["game"]), []).append(r)
    print(f"--- {label}: workload guard (+/-{int(BAND * 100)} % of each "
          f"game's median duty) + host correction")
    header()
    for g in sorted({k[1] for k in arms}):
        cell = {}
        for arm in ("on", "off"):
            recs = arms.get((arm, g), [])
            lo, hi = BAND_G.get(g, (0, 1e9))
            keep = [r for r in recs if lo <= r["duty"] <= hi]
            cell[arm] = (ms([r["mipsCpu"] for r in keep]),
                         ms([adj(r) for r in keep if adj(r)]),
                         len(keep), len(recs) - len(keep),
                         ms([r["mipsCpu"] for r in recs])[0],
                         ms([r[KEY] for r in keep if r.get(KEY)])[0] if KEY else None)
        (mon, son), (aon, _), non, don, ron, hon = cell["on"]
        (mof, sof), (aof, _), nof, dof, rof, hof = cell["off"]
        if mon is None or mof is None:
            empty = "on" if mon is None else "off"
            print(f"  g{g}: no verdict -- the {empty} arm has nothing left "
                  f"(on {non}/{non + don} kept, off {nof}/{nof + dof})")
            continue
        d = 100.0 * (mon - mof) / mof
        c = 100.0 * (aon - aof) / aof if aon and aof else float("nan")
        raw = 100.0 * (ron - rof) / rof if ron and rof else float("nan")
        # A verdict whose two arms sat at different host occupancy is partly
        # measuring the host even after correction: the exponent is a fit,
        # not a law, and it only removes the part the fit explains.
        skew = ""
        if hon and hof and abs(hon / hof - 1) > 0.15:
            skew = f"  LOAD-SKEWED {KEY} {hon:.2f}/{hof:.2f}"
        print(f"  g{g}: on {mon:6.2f} (n={non} sd {son:5.2f})  "
              f"off {mof:6.2f} (n={nof} sd {sof:5.2f})  "
              f"on/off {d:+6.1f} %  corrected {c:+6.1f} %"
              f"   [raw {raw:+6.1f} %, dropped {don + dof}]"
              f"{'  overlap' if abs(mon - mof) < max(son, sof) else ''}{skew}")


def from_log(path):
    """the palindrome block, then the guards, for one ab.sh run"""
    legs = []
    for line in open(path):
        m = re.match(r"^(off|on)\s+J2ME sweep", line)
        if not m:
            continue
        vals = [float(x) for x in re.findall(r"MIPS/cpu=([0-9.]+)", line)]
        js = re.search(r"(\S+-sweep\.json)", line)
        recs = []
        if js:
            try:
                recs = json.load(open(js.group(1)))
            except Exception:
                recs = []
        legs.append((m.group(1), vals, recs))
    if not legs:
        print("no legs in " + path)
        return

    def pool(sel, arm):
        return [v for (a, vals, _) in sel if a == arm for v in vals]

    n = len(legs)
    for label, sel in (("all", legs), ("1st half", legs[:n // 2]),
                       ("2nd half", legs[n // 2:])):
        on, off = pool(sel, "on"), pool(sel, "off")
        (mon, son), (mof, sof) = ms(on), ms(off)
        if mon is None or mof is None:
            continue
        print(f"{label:9} on {mon:7.2f} (n={len(on):2d} sd {son:5.2f})  "
              f"off {mof:7.2f} (n={len(off):2d} sd {sof:5.2f})  "
              f"on/off {100.0 * (mon - mof) / mof:6.1f} %")
    print()
    for i, (a, vals, recs) in enumerate(legs, 1):
        h = " ".join(f"{r[KEY]:.2f}" for r in recs if KEY and r.get(KEY))
        print(f"leg {i} {a:3} " + " ".join(f"{v:.2f}" for v in vals)
              + (f"   {KEY} {h}" if h else ""))
    print()
    guarded([(a, r) for (a, _, r) in legs], os.path.basename(path))


def from_tags(tags):
    legs = {}
    for r in ALL:
        tag = r.get("tag") or ""
        for suf, arm in (("-off", "off"), ("-on", "on")):
            if tag.endswith(suf):
                legs.setdefault(tag[:-len(suf)], []).append((arm, r))
    for base in tags or sorted(legs):
        if base not in legs:
            continue
        guarded([(a, [r]) for a, r in legs[base]], base)
        print()


args = sys.argv[1:]
if args and all(os.path.exists(a) for a in args):
    for a in args:
        from_log(a)
else:
    from_tags(args)
