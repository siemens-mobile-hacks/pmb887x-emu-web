#!/usr/bin/env python3
"""Every leg of an A/B, with the covariates that say whether it is usable.

Two independent tells, and they diagnose different failures:

  mi      instructions retired in the window.  The window is a fixed span of
          the GUEST's clock, so under icount this is a property of the guest
          alone.  Legs whose mi disagrees by more than a fraction of a
          percent played different games and their wall times are not
          comparable -- an invalid leg, not a noisy one.

  busy    the vCPU thread's own CPU over the window / wall.  Below 1.0 the
          thread was descheduled: the guest did the right work, the host
          just did not let it run.  MIPS/cpu already divides this out, but
          only partly -- the residual is MIPS/cpu ~ load**-0.29.

So: mi off => drop the leg.  mi fine but busy/hostBusy off => a host
disturbance, and how much of it MIPS/cpu absorbed is a judgement call that
has to be shown, not asserted.
"""
import glob, json, os, re, statistics as st

RES = "/workspace/tests/results"
TAG = os.environ.get("AB_TAG", "ab")

rows = []
for f in glob.glob(os.path.join(RES, f"j2me-*-{TAG}[123]-g*.json")):
    d = json.load(open(f))
    m = re.search(rf"-{re.escape(TAG)}([123])-g(\d+)", os.path.basename(f))
    if m:
        rows.append((m.group(1), m.group(2), d.get("dist"), d))

if not rows:
    raise SystemExit(f"no legs for tag {TAG!r}")

print(f"{'rep':<4}{'game':<5}{'dist':<20}{'mi':>9}{'ms/Mi':>9}{'MIPS/cpu':>10}"
      f"{'busy':>7}{'hostBusy':>9}{'load0->load':>14}{'fps':>7}")
for rep, game, dist, d in sorted(rows, key=lambda r: (r[0], r[1], r[2] or "")):
    print(f"{rep:<4}{game:<5}{str(dist):<20}{d.get('mi', 0):9.1f}"
          f"{d.get('msPerMi', 0):9.3f}{d.get('mipsCpu') or 0:10.2f}"
          f"{d.get('busy') or 0:7.3f}{d.get('hostBusy') or 0:9.3f}"
          f"{str(d.get('hostLoad0')) + '->' + str(d.get('hostLoad')):>14}"
          f"{d.get('fps', 0):7.2f}")

# The determinism check, per (dist, game): mi should be flat across repeats.
print("\nmi spread across repeats -- 'played the same game?'")
for dist in sorted({r[2] for r in rows}):
    for game in sorted({r[1] for r in rows}):
        v = [d.get("mi", 0) for rep, g, ds, d in rows if ds == dist and g == game]
        if len(v) > 1:
            sp = (max(v) - min(v)) / st.mean(v) * 100
            flag = "  <-- legs played different games" if sp > 1.0 else ""
            print(f"  {dist:<20} g{game}  {['%.1f' % x for x in v]}  "
                  f"spread {sp:.2f}%{flag}")
