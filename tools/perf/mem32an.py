#!/usr/bin/env python3
"""Pair two dists leg by leg and report the delta.

Pairs within a repeat and game, so host drift across the run cancels
instead of landing in the spread -- the failure mode of the previous A/B
on this host.

Defaults to the mem32 A/B; AB_A / AB_B / AB_TAG re-point it at any other
pair built the same way (the -O3 arm uses AB_B=dist-jit-o3, AB_TAG=o3).
"""
import glob, json, os, re, statistics as st

RES = "/workspace/tests/results"
A = os.environ.get("AB_A", "dist-jit")
B = os.environ.get("AB_B", "dist-jit-mem32")
TAG = os.environ.get("AB_TAG", "ab")
# Two arms are not always two dists: a browser-flag arm is the same dist run
# differently, and then the tag is the only thing telling them apart.
TAGA = os.environ.get("AB_TAGA", TAG)
TAGB = os.environ.get("AB_TAGB", TAG)


def legs(dist, tag):
    out = {}
    for f in glob.glob(os.path.join(RES, f"j2me-*-{dist}-{tag}[123]-g*.json")):
        d = json.load(open(f))
        m = re.search(rf"-{re.escape(tag)}([123])-g(\d+)", os.path.basename(f))
        if m:
            out[(m.group(1), m.group(2))] = d
    return out


# dist-jit's own glob would also match dist-jit-mem32 if the suffix were a
# tag rather than part of the dist name; it is not, but be explicit.
base, var = legs(A, TAGA), legs(B, TAGB)
if TAGA != TAGB:
    A, B = f"{A}/{TAGA}", f"{B}/{TAGB}"
keys = sorted(set(base) & set(var))
if not keys:
    raise SystemExit(f"no paired legs yet ({A} {len(base)}, {B} {len(var)})")

# Screen for host bursts.  MIPS/cpu divides out a descheduled thread but
# only partly -- the residual is MIPS/cpu ~ load**-0.29 -- so a leg measured
# through a burst is not merely noisy, it is biased, and pairing cannot save
# a pair whose other arm ran on a different host.  hostBusy is every core's
# non-idle fraction over this window alone, which is independent of anything
# the build does; `mi` is checked separately (tools/perf/legs.py) and says
# whether the guest did the same work at all.
#
# The rule: a pair is dirty if either arm's hostBusy exceeds twice the median
# across all legs.  Both estimates are printed -- screening that is not shown
# is indistinguishable from picking the answer.
allbusy = sorted(float(d.get("hostBusy") or 0) for d in
                 list(base.values()) + list(var.values()))
med = allbusy[len(allbusy) // 2] or 1.0

print(f"{'rep/game':<10}{A + ' ms/Mi':>18}{B + ' ms/Mi':>20}{'delta':>9}"
      f"{'MIPS a':>11}{'MIPS b':>12}{'delta':>9}  host")
dms, dmips = [], []
cms, cmips = [], []
dirty = []
for k in keys:
    b, m = base[k], var[k]
    bm, mm = float(b["msPerMi"]), float(m["msPerMi"])
    bi, mi = float(b["mipsCpu"]), float(m["mipsCpu"])
    hb, hm = float(b.get("hostBusy") or 0), float(m.get("hostBusy") or 0)
    # ms/Mi is a cost: negative is better.  MIPS is a rate: positive is.
    a, c = (mm - bm) / bm * 100, (mi - bi) / bi * 100
    dms.append(a)
    dmips.append(c)
    bad = max(hb, hm) > 2 * med
    if bad:
        dirty.append((k, hb, hm))
    else:
        cms.append(a)
        cmips.append(c)
    print(f"r{k[0]}/g{k[1]:<7}{bm:18.3f}{mm:20.3f}{a:+8.2f}%"
          f"{bi:11.3f}{mi:12.3f}{c:+8.2f}%"
          f"  {hb:.3f}/{hm:.3f}{'  BURST' if bad else ''}")

print(f"\nhostBusy median {med:.3f}; a pair is dropped if either arm "
      f"exceeds {2 * med:.3f}")
for k, hb, hm in dirty:
    print(f"  dropped r{k[0]}/g{k[1]}: hostBusy {hb:.3f}/{hm:.3f} "
          f"-- the host was busy, not the build")


def summarize(name, xs, better):
    if len(xs) < 2:
        print(f"\n{name}: {xs[0]:+.2f}% (one pair only, no spread)")
        return
    mean, sd = st.mean(xs), st.stdev(xs)
    se = sd / len(xs) ** 0.5
    verdict = ("resolved" if abs(mean) > 2 * se else "NOT resolved")
    print(f"\n{name}: mean {mean:+.2f}% sd {sd:.2f}% se {se:.2f}% "
          f"over {len(xs)} pairs -- {verdict} ({better} is better)")


summarize("ms/Mi     all pairs", dms, "negative")
summarize("MIPS/cpu  all pairs", dmips, "positive")
if dirty:
    summarize(f"ms/Mi     screened ({len(dirty)} dropped)", cms, "negative")
    summarize(f"MIPS/cpu  screened ({len(dirty)} dropped)", cmips, "positive")

# Validity check: did the two arms run the same guest?
#
# Only GUEST-paced counters can answer that.  Per-Mi normalisation makes a
# counter guest-relative only if the event it counts is caused by the guest;
# an event paced by the host clock -- a TB flush driven by module GC, a
# worker wake, a compile -- happens at a rate per SECOND, so dividing it by
# guest instructions makes a faster arm look like it does less of it.  The
# translation-side counters that used to be listed here (tcgGst, tbGen,
# tbBytes...) are all in that host-paced group: they move by roughly
# -(1 - 1/speedup) and reading them as a regression is a mistake.
# tools/perf/ctrdiff.py diffs every counter paired, with the spread, and is
# the tool for that question.
GUEST = ("execIter", "excSwi", "armIrq", "hflagsCalls", "lcdPx", "ssiByte",
         "dmacRun", "tpuTimer", "lookup", "slowMiss")
print(f"\n{'counter':<12}{A:>14}{B:>16}{'delta':>9}"
      "   (guest-paced: these must not move)")
for c in GUEST:
    bv = [float(base[k]["perMi"].get(c, 0)) for k in keys]
    mv = [float(var[k]["perMi"].get(c, 0)) for k in keys]
    if not any(bv):
        continue
    b, m = st.mean(bv), st.mean(mv)
    d = (m - b) / b * 100 if b else 0.0
    print(f"{c:<12}{b:14.3f}{m:16.3f}{d:+8.2f}%{'   <-- MOVED' if abs(d) > 3 else ''}")
