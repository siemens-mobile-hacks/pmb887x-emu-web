#!/usr/bin/env python3
"""Profile the bins where a J2ME game is actually working.

A J2ME game is not one workload.  Game 1 of CX70_FW56 spends 27 of its 32
bins at duty 0.15 and five at duty 1.0, and the window-wide perMi rollup
is an average over phases that behave nothing alike.  Worse, the rollup is
*dominated by the idle phase*: a wall-paced event (a display refresh, a
timer tick) divided by the few instructions an idle guest retires gives a
large per-Mi, so the counter profile of a window describes the part of it
that was not computing.  See doc/lessons.md, "Per-Mi does not make a
host-paced counter guest-relative".

So: difference the --tracec samples into bins, keep the saturated ones,
and profile those.  That is the phase whose speed the user can feel.

  AB_TAG=disc python3 scratchpad/bins.py            # every game of a sweep
  AB_TAG=disc AB_DUTY=0.8 python3 scratchpad/bins.py

Counter names are parsed from the same header the tools derive them from
(tools/diagnames.mjs): the indices are the wasm_memstat ABI and a
transcribed list drifts silently.
"""
import glob, json, os, re, sys

RES = "/workspace/tests/results"
HDR = "/workspace/qemu/include/qemu/wasm-diag.h"
TAG = os.environ.get("AB_TAG", "disc")
DIST = os.environ.get("AB_DIST", "dist-jit")
DUTY = float(os.environ.get("AB_DUTY", "0.8"))
MODE = os.environ.get("AB_MODE", "sat")
NS_PER_INSN = 8          # icount shift=3


def names():
    h = open(HDR).read()
    body = h[h.index("enum {"):h.index("WASM_DIAG_N")]
    camel = lambda s: re.sub(r"_([a-z0-9])", lambda m: m.group(1).upper(), s.lower())
    out = [camel(m.group(1))
           for m in re.finditer(r"^\s+WASM_DIAG_([A-Z0-9_]+)\s*(?:=|,)", body, re.M)]
    if len(out) < 80:
        sys.exit(f"parsed only {len(out)} counters from wasm-diag.h")
    return out


NAMES = names()


def bins(rec):
    """[(duty, dInsns, dFb, [dCounters])] -- one entry per --tracec interval."""
    tc = rec.get("traceCs") or []
    out = []
    for p, q in zip(tc, tc[1:]):
        dv, di, dfb = q[0] - p[0], q[1] - p[1], q[2] - p[2]
        if dv <= 0 or di <= 0:
            continue
        out.append((di * NS_PER_INSN / dv, di, dfb,
                    [b - a for a, b in zip(p[3], q[3])]))
    return out


def select(bs):
    """The bins worth profiling, and a word for what they are.

    Only AMF Bowling saturates on this host.  Every title in CX70_games
    idles 65-90 % of steady play (duty 0.09-0.34) because J2ME frame pacing
    is timer-driven, and their one saturated bin each is a level load --
    modCompileNs-dominated, a cold-start cost rather than the phase whose
    speed a player feels.  "steady" keeps the modal band instead: the
    median duty +-40 %, which drops both the load spike and the dead splash
    bins at duty 0.01.
    """
    if MODE != "steady":
        return [b for b in bs if b[0] >= DUTY], f"duty>={DUTY}"
    live = sorted(b[0] for b in bs if b[0] >= 0.03)
    if not live:
        return [], "no live bins"
    med = live[len(live) // 2]
    lo, hi = 0.6 * med, 1.4 * med
    return ([b for b in bs if lo <= b[0] <= hi],
            f"{lo:.2f}<=duty<={hi:.2f} (median {med:.2f})")


def profile(rec):
    bs = bins(rec)
    hot, _ = select(bs)
    if not hot:
        return None, len(bs), 0
    mi = sum(b[1] for b in hot) / 1e6
    agg = {}
    for _, _, _, c in hot:
        for i, dv in enumerate(c):
            if dv:
                agg[NAMES[i]] = agg.get(NAMES[i], 0) + dv
    return {k: v / mi for k, v in agg.items()}, len(bs), len(hot)


rows = {}
for f in sorted(glob.glob(os.path.join(RES, f"j2me-*-{DIST}-{TAG}-g*.json"))):
    if f.endswith("-sweep.json"):
        continue
    rec = json.load(open(f))
    prof, nb, nh = profile(rec)
    g = rec.get("game")
    duties = [round(b[0], 2) for b in bins(rec)]
    _, how = select(bins(rec))
    print(f"g{g}: {nh}/{nb} bins kept [{how}]  "
          f"window duty={rec.get('duty')}  MIPS/cpu={rec.get('mipsCpu')}  "
          f"cpu={rec.get('cpu')}  fps={rec.get('fps')}  Mi={rec.get('mi')}")
    print(f"     duty by bin: {duties}")
    if prof:
        rows[g] = prof

if not rows:
    sys.exit("\nNo saturated bins anywhere -- either no game really played "
             "(check the -game.png panels) or --tracec was off.")

# Cross-game: a lever that only helps one title is not a J2ME lever.
allk = sorted({k for p in rows.values() for k in p},
              key=lambda k: -max(rows[g].get(k, 0) for g in rows))
gs = sorted(rows)
print(f"\n{'counter':<18}" + "".join(f"{'g' + str(g):>12}" for g in gs)
      + f"{'max/min':>10}   (per Mi, saturated bins only)")
for k in allk[:40]:
    vs = [rows[g].get(k, 0) for g in gs]
    if max(vs) < 0.01:
        continue
    lo = min(v for v in vs if v > 0) if any(vs) else 0
    ratio = (max(vs) / lo) if lo else float("inf")
    print(f"{k:<18}" + "".join(f"{v:12.2f}" for v in vs)
          + (f"{ratio:9.1f}x" if ratio != float("inf") else "        --"))

print("\nA counter that is large in EVERY column is a J2ME-wide lever.")
print("A counter with a big max/min is that title's own behaviour, and a")
print("fix aimed at it is worth only that title's share of the suite.")
