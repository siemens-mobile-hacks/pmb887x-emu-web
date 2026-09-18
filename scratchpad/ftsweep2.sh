#!/usr/bin/env bash
# Knob sweep, rotated and repeated -- because the sequential design this
# file used to hold cannot resolve anything it was asked to resolve.
#
# Three facts forced the rewrite, all found after it was queued:
#
# 1. The guest workload is bit-identical in every leg.  Mi reads
#    5624.7-5625.9 across all nine legs on disk, a 0.02 % spread: icount
#    is on, the virtual window is fixed at 45 s, so the guest executes the
#    same instructions in the same order every time.  ms/Mi is therefore
#    *pure host speed* with no guest variability in it at all.
#
# 2. insns/frame is not an independent workload check, and never was.
#    fps is the browser's wall-clock render rate, pinned at 62.0-62.4, and
#    insns/frame x ms/Mi = 1e9/fps to within 0.6 % in all nine legs.  So
#    "games 3 and 4 diverged on insns/frame" was ms/Mi restated -- a
#    circular test that discarded the two games whose numbers were
#    inconvenient.  All four games were always valid; the mean was the
#    right statistic.
#
# 3. The bench does not repeat to 3 %.  Two baseline legs, same binary,
#    same knob, fifteen minutes apart: game 1 read 4.604 then 4.126
#    (-10.4 %), game 2 read 4.654 then 4.313 (-7.3 %).  By (1) none of
#    that is the guest.  It is the host -- the box is shared and its
#    1-minute load moved 5.4 -> 3.7 across the same span.
#
# So no verdict below ~10 % survives a sequential A-B design on this
# bench, which is every verdict this session has produced.  The repair is
# rotation plus repetition: each arm runs once per round, and the arm
# order rotates each round so no arm sits systematically early or late in
# the drift.  Each arm is then compared to `base` *within its own round*,
# where the two legs are minutes apart rather than half an hour.
#
# ft1 is a control, not a candidate.  Round 27 measured FTMAX 1 -> 2 as
# +4.7 %; if this design cannot see that, a null on ft4/ft6/pg12 means
# nothing.  pg12 is here because the page-bits leg is exactly the verdict
# that drift ate, and it is owed a real measurement.
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad

FLASH=/workspace/fullflashes/CX70_FW56_clean.bin
START='center:10000,center:10000,center:10000,center:8000'

ARMS=(base ft1 ft4 ft6 pg12 nobc)
q_for() {
  case $1 in
    ft1)  echo 'env=W64_FTMAX=1' ;;
    ft4)  echo 'env=W64_FTMAX=4' ;;
    ft6)  echo 'env=W64_FTMAX=6' ;;
    pg12) echo 'env=W64_PAGEBITS=12' ;;
    *)    echo '' ;;
  esac
}

# nobc is a deletion ceiling, not a candidate -- a V8 flag cannot ship.
# ~77 % of this workload's wall is inside TB bodies, ~11 host cycles per
# guest instruction, and nothing in 32 rounds has ever priced the wasm
# memory bound check that every guest load, store and CPUState access
# carries.  V8 says --wasm-memory64-trap-handling defaults *on*, so the
# checks may already be free; this arm is the only way to find out, and
# the answer bounds a whole family of in-binary ideas (shrink the memory
# so a guard region fits, hoist checks, widen accesses) at one leg's cost.
args_for() {
  case $1 in
    nobc) echo '--js-flags=--no-wasm-bounds-checks' ;;
    *)    echo '' ;;
  esac
}

run() {
  local arm=$1 r=$2 tag="k${2}_${1}"
  local pre="$(cut -d' ' -f1 /proc/loadavg)"
  local cpre="$("$S/calib")"
  EXTRA_Q="$(q_for "$arm")" CHROME_ARGS="$(args_for "$arm")" \
  timeout 900 node tools/j2mebench.mjs --dist dist-jit \
    --flash "$FLASH" --game 1 --start "$START" \
    --tracec --window 45000 --tag "$tag" \
    > "$S/$tag.log" 2>&1
  local rc=$?
  local cpost="$("$S/calib")"
  printf 'CALIB %s pre %s post %s\n' "$tag" "$cpre" "$cpost" >> "$S/calib.log"
  printf '%s rc=%s %s loadpre=%s %s | calib %s / %s\n' "$tag" "$rc" \
    "$(date +%H:%M:%S)" "$pre" \
    "$(grep -haoE 'ms/Mi=[0-9.]+|Mi=[0-9.]+' "$S/$tag.log" | head -2 | tr '\n' ' ')" \
    "$cpre" "$cpost"
}

n=${#ARMS[@]}
for r in 1 2 3 4; do
  for ((i = 0; i < n; i++)); do
    run "${ARMS[$(((i + r - 1) % n))]}" "$r"
  done
done

python3 - "$S" <<'PY'
import os, re, sys, statistics as st
S = sys.argv[1]
ARMS = ["base", "ft1", "ft4", "ft6", "pg12", "nobc"]
ROUNDS = [1, 2, 3, 4]
ms, mi, ctr = {}, {}, {}
for r in ROUNDS:
    for a in ARMS:
        p = os.path.join(S, f"k{r}_{a}.log")
        if not os.path.exists(p):
            continue
        t = open(p, errors="replace").read()
        m = re.search(r"\bms/Mi=([0-9.]+)", t)
        if m:
            ms[(a, r)] = float(m.group(1))
        m = re.search(r"(?<![\w/])Mi=([0-9.]+)", t)
        if m:
            mi[(a, r)] = float(m.group(1))
        m = re.search(r"perMi:(.*)", t)
        if m:
            ctr[(a, r)] = dict(
                (k, float(v)) for k, v in
                re.findall(r"([A-Za-z_]\w*)=([0-9.]+)", m.group(1)))

miv = [v for v in mi.values()]
if miv:
    print(f"guest work: Mi {min(miv):.1f}..{max(miv):.1f} "
          f"({(max(miv)-min(miv))/st.mean(miv)*100:.3f}% spread) -- "
          f"{'identical, ms/Mi is pure host speed' if (max(miv)-min(miv))/st.mean(miv) < 0.002 else 'NOT MATCHED, the sweep is void'}")

print("\n=== ms/Mi (lower is faster)")
print(f"{'arm':<7}" + "".join(f"{('r%d' % r):>9}" for r in ROUNDS) +
      f"{'mean':>9}{'spread':>9}")
for a in ARMS:
    v = [ms.get((a, r)) for r in ROUNDS]
    got = [x for x in v if x is not None]
    if not got:
        continue
    sp = (max(got) - min(got)) / st.mean(got) * 100 if len(got) > 1 else 0.0
    print(f"{a:<7}" + "".join(f"{x:>9.3f}" if x else f"{'-':>9}" for x in v) +
          f"{st.mean(got):>9.3f}{sp:>8.1f}%")

print("\n=== paired against base within the same round (drift cancels)")
for a in ARMS:
    if a == "base":
        continue
    d = [(ms[(a, r)] / ms[("base", r)] - 1) * 100
         for r in ROUNDS if (a, r) in ms and ("base", r) in ms]
    if not d:
        continue
    tag = ""
    if len(d) > 1:
        sd = st.stdev(d)
        tag = f"  sd {sd:.2f}%" + ("  [consistent]" if abs(st.mean(d)) > 2 * sd else "  [not resolved]")
    print(f"{a:<6} vs base: " + " ".join(f"{x:+6.2f}%" for x in d) +
          f"   mean {st.mean(d):+.2f}%{tag}")

cal = {}
cp = os.path.join(S, "calib.log")
if os.path.exists(cp):
    for line in open(cp):
        m = re.match(r"CALIB k(\d+)_(\w+) pre alu=([\d.]+) mem=([\d.]+) \S+ "
                     r"post alu=([\d.]+) mem=([\d.]+)", line)
        if m:
            r, a = int(m.group(1)), m.group(2)
            cal[(a, r)] = ((float(m.group(3)) + float(m.group(5))) / 2,
                           (float(m.group(4)) + float(m.group(6))) / 2)
if cal:
    pairs = [(cal[k][0], ms[k]) for k in ms if k in cal]
    print(f"\n=== host-speed probe vs the clock ({len(pairs)} legs)")
    if len(pairs) > 2:
        ax = [p[0] for p in pairs]
        my = [p[1] for p in pairs]
        ma, mm = st.mean(ax), st.mean(my)
        cov = sum((a - ma) * (b - mm) for a, b in pairs)
        va = sum((a - ma) ** 2 for a in ax)
        vb = sum((b - mm) ** 2 for b in my)
        r_ = cov / (va * vb) ** 0.5 if va and vb else 0.0
        print(f"alu {min(ax):.4f}..{max(ax):.4f}s "
              f"({(max(ax)-min(ax))/ma*100:.1f}% spread), "
              f"corr(alu, ms/Mi) r = {r_:+.2f}")
        print("  r near +1 means the drift is core frequency and legs can be "
              "normalised by alu; r near 0 means it is not, and only the "
              "pairing above is trustworthy.")
        print("\n=== paired against base, each leg divided by its own alu probe")
        for a in ARMS:
            if a == "base":
                continue
            d = []
            for r in ROUNDS:
                if (a, r) in ms and ("base", r) in ms and (a, r) in cal and ("base", r) in cal:
                    d.append(((ms[(a, r)] / cal[(a, r)][0]) /
                              (ms[("base", r)] / cal[("base", r)][0]) - 1) * 100)
            if d:
                print(f"{a:<6} vs base: " + " ".join(f"{x:+6.2f}%" for x in d) +
                      f"   mean {st.mean(d):+.2f}%")

b = [ms[("base", r)] for r in ROUNDS if ("base", r) in ms]
if len(b) > 1:
    print(f"\nbase repeatability: {min(b):.3f}..{max(b):.3f} ms/Mi = "
          f"{(max(b)-min(b))/st.mean(b)*100:.1f}% over {len(b)} legs. "
          f"Nothing smaller than this is a result unless the pairing above "
          f"says [consistent].")

print("\n=== mechanism counters (mean over rounds): did the knob do its job?")
keys = ["tbIcount", "tbGen", "lookup", "lookupConfl", "lcFill", "modBytes",
        "modNs", "tbBytes", "smcMiss", "tbAbsorb"]
print(f"{'arm':<7}" + "".join(f"{k:>13}" for k in keys))
for a in ARMS:
    rows = [ctr[(a, r)] for r in ROUNDS if (a, r) in ctr]
    if not rows:
        continue
    print(f"{a:<7}" + "".join(
        f"{st.mean([x.get(k, 0.0) for x in rows]):>13.3f}" for k in keys))
PY
