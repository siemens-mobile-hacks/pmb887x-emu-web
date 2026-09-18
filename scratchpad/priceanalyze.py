#!/usr/bin/env python3
"""Price the display chain and the exception path as a share of wall time.

Both instruments calibrate themselves, because two get_clock_realtime()
reads back to back measure ~70 ns of nothing and that floor would otherwise
sit inside the answer.  The floors are not interchangeable:

  DISP_CAL   one empty interval per burst, beside one measured span.
  EXC_CAL    one empty interval per exception (cpu-exec.c:1617-1627),
             while EXC_BQL_NS covers TWO spans, EXC_DO_NS one, and
             EXC_LJ_NS one -- but EXC_LJ_NS is counted EXC_LJ_N times,
             which is not EXC_N.  So the floor is reduced to a per-read
             cost and charged per span, rather than subtracting EXC_CAL
             once and calling it calibrated.

A counter that did not move is absent from the record, not zero, so a
missing dispNs/excN means the env knob never reached the page -- which
site/app.js does silently when two assignments share one env= parameter.
That is checked before any share is printed.
"""
import glob, json, os, sys

RES = "/workspace/tests/results"
TAG = os.environ.get("AB_TAG", "price")
DIST = os.environ.get("AB_DIST", "dist-jit")

files = [f for f in sorted(glob.glob(os.path.join(RES, f"j2me-*-{DIST}-{TAG}-g*.json")))
         if not f.endswith("-sweep.json")]
if not files:
    sys.exit(f"no results for tag {TAG}")

print(f"{'game':>5}{'wall s':>8}{'Mi':>8}{'ms/Mi':>8}{'duty':>6}"
      f"{'exc/Mi':>8}{'ns/exc':>8}{'exc %':>7}{'  lj%':>6}{'bql%':>6}{'do%':>5}"
      f"{'px/Mi':>8}{'ns/px':>7}{'disp %':>8}")
tot = {}
for f in files:
    r = json.load(open(f))
    c = r.get("counters") or {}
    g, wall, mi = r.get("game"), r.get("wall"), r.get("mi")
    wns = wall * 1e9
    excn, lj_n = c.get("excN", 0), c.get("excLjN", 0)
    if not excn:
        print(f"g{g}: excN absent -- W64_EXCNS never reached the page"); continue
    floor = c.get("excCal", 0) / excn
    lj = c.get("excLjNs", 0) - lj_n * floor
    bql = c.get("excBqlNs", 0) - 2 * excn * floor
    do = c.get("excDoNs", 0) - excn * floor
    exc = lj + bql + do
    burst = c.get("dispBurst", 0)
    disp = c.get("dispNs", 0) - c.get("dispCal", 0)
    px = c.get("lcdPx", 0)
    print(f"{g:>5}{wall:>8.2f}{mi:>8.1f}{r.get('msPerMi'):>8.3f}{r.get('duty'):>6.3f}"
          f"{excn / mi:>8.0f}{(exc / excn if excn else 0):>8.0f}"
          f"{100 * exc / wns:>7.1f}{100 * lj / wns:>6.1f}"
          f"{100 * bql / wns:>6.1f}{100 * do / wns:>5.1f}"
          f"{px / mi:>8.0f}{(disp / px if px else 0):>7.1f}"
          f"{100 * disp / wns:>8.1f}")
    tot.setdefault("exc", []).append(100 * exc / wns)
    tot.setdefault("lj", []).append(100 * lj / wns)
    tot.setdefault("disp", []).append(100 * disp / wns)
    if not burst:
        print(f"      (g{g}: dispBurst absent -- W64_DISPNS never reached the page)")

if tot:
    m = lambda k: sum(tot[k]) / len(tot[k])
    print(f"\nmean over {len(tot['exc'])} titles: exception path {m('exc'):.1f} % of wall "
          f"(of which the longjmp unwind alone {m('lj'):.1f} %), display chain {m('disp'):.1f} %")
    print("\nThe unwind is the half a build flag can move: on this build every\n"
          "siglongjmp calls out to JS, throws, unwinds the wasm frames into an\n"
          "invoke_* catch and calls setThrew back in.  -sSUPPORT_LONGJMP=wasm\n"
          "makes it a wasm throw with no JS on the path.")
