#!/usr/bin/env python3
"""
Apply the duty guard to tools/j2mebench.mjs.  Run only when no leg is in
flight: the runner is re-read from disk per leg, so an edit mid-battery
splits the legs before and after it.

Exact anchors, and a non-zero exit if any of them moved -- a patch that
half-applies to a measurement tool is worse than one that does not apply.
Idempotent: a second run is a no-op.
"""
import sys

P = sys.argv[1] if len(sys.argv) > 1 else "/workspace/tools/j2mebench.mjs"
src = open(P, encoding="utf-8").read()

OPT_A = 'const windowV = Number(opt("window", 45000));    // 0 = wall-clock --measure instead\n'
OPT_B = OPT_A + '''// The window's own workload check.  fps only answers "did anything
// draw", and a J2ME title screen draws at 58-61 -- so it passes, and the
// leg then reports a real rate for the wrong workload.  duty is guest
// instructions retired per unit of the guest's *own* clock, so unlike
// fps or MIPS it does not move when the host or the build gets faster:
// it moves when the guest does something else.  On this image game 2
// sits at 0.150 playing, 0.087 on its title screen and 0.282 when the
// walk landed in another game, with nothing in between.  --duty <v>
// (or J2ME_DUTY) redoes the walk for a window outside +/-25 % of v.
// Two-sided: the wrong-game window is *above* the expectation, and it is
// the dangerous one, because its rate looks perfectly ordinary.
//
// One value per --game entry, in the same order, because a sweep's games
// do not share a duty; a single value covers every game, and 0 is off.
// Supply it only for a game whose duty is known -- an expectation that
// cannot be met burns three attempts and then fails the leg.
const dutySpec = String(opt("duty", process.env.J2ME_DUTY || "0")).split(",").map(Number);
'''

ACC_A = """      if (w.a && w.c) {
        const fps = (w.c.fb - w.a.fb) / ((w.c.t - w.a.t) / 1000);
        if (fps >= 2) ({ a, c } = w);
        else console.log(`[j2me] attempt ${attempt}: window drew ${fps.toFixed(1)} fps — not a game`);
      }
"""
ACC_B = """      if (w.a && w.c) {
        const fps = (w.c.fb - w.a.fb) / ((w.c.t - w.a.t) / 1000);
        const duty = ((w.c.insns - w.a.insns) * 8) / ((w.c.v - w.a.v) || 1);
        const wantDuty = dutySpec[gi] || dutySpec[0] || 0;
        if (fps < 2)
          console.log(`[j2me] attempt ${attempt}: window drew ${fps.toFixed(1)} fps — not a game`);
        else if (wantDuty && Math.abs(duty - wantDuty) > 0.25 * wantDuty)
          console.log(`[j2me] attempt ${attempt}: duty ${duty.toFixed(3)} vs ${wantDuty} — a window on something else`);
        else ({ a, c } = w);
      }
"""

SWP_A = '`g${r.game}: MIPS/cpu=${r.mipsCpu} cpu=${r.cpu} Mi=${r.mi}`'
SWP_B = '`g${r.game}: MIPS/cpu=${r.mipsCpu} cpu=${r.cpu} Mi=${r.mi} duty=${r.duty}`'

edits = [("--duty option", OPT_A, OPT_B),
         ("window accept test", ACC_A, ACC_B),
         ("sweep line", SWP_A, SWP_B)]

done, bad = [], []
for name, a, b in edits:
    if b in src:
        done.append(name + " (already applied)")
    elif src.count(a) == 1:
        src = src.replace(a, b)
        done.append(name)
    else:
        bad.append(f"{name}: anchor found {src.count(a)} times, expected 1")

if bad:
    print("runner-duty: NOT applied --")
    for m in bad:
        print("  " + m)
    sys.exit(1)

open(P, "w", encoding="utf-8").write(src)
print("runner-duty: " + ", ".join(done))
