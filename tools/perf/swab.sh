#!/bin/bash
# Paired free-run A/B, all pairs at once: pair p runs leg A and leg B together
# on two whole physical cores each (SMT siblings n, n+16) of the same CCD; A/B
# sides alternate between pairs.  V8 explicit bounds checks on (Android),
# free-run switched on when the measurement starts: both dists must be built
# with tools/perf/freerun.diff applied (see doc/performance.md).
#   swab.sh <scene> <distA> <distB> [pairs 1-4] [measure s]
# More than 4 pairs would share cores and give garbage: run it twice instead.
# Env: BFLAGS=0 drops the bounds checks, ARGS_A/ARGS_B extra chrome args,
# METRIC (vratio), OUT (log dir), PORT_A/PORT_B (server per leg, default 8080).
sc=$1; A=$2; B=$3; n=${4:-4}; m=${5:-20}
[ "$n" -ge 1 ] && [ "$n" -le 4 ] || { echo "pairs must be 1-4" >&2; exit 2; }
metric=${METRIC:-vratio}
SETS=("0,1,16,17" "2,3,18,19" "4,5,20,21" "6,7,22,23" "8,9,24,25" "10,11,26,27" "12,13,28,29" "14,15,30,31")
cd "$(dirname "$0")/../.."
export PLAYWRIGHT_BROWSERS_PATH=$PWD/tools/chrome
export SCENEBENCH_AT_MEASURE="window.__qemu._wasm_free_run(1)"
bf="--js-flags=--wasm-enforce-bounds-checks"
[ "${BFLAGS:-1}" = 0 ] && bf=""
out=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/swab.XXXX")}
mkdir -p "$out"
for p in $(seq 1 "$n"); do
  ORD=(0 4 2 6); o=${ORD[$((p - 1))]}
  s0=${SETS[$o]}; s1=${SETS[$((o + 1))]}
  if [ $((p % 2)) = 1 ]; then ca=$s0; cb=$s1; else ca=$s1; cb=$s0; fi
  PORT=${PORT_A:-8080} SCENEBENCH_CHROME_ARGS="$bf ${ARGS_A:-}" taskset -c "$ca" node tools/scenebench.mjs "$sc" "$A" --runs 1 --measure "$m" > "$out/a$p.log" 2>&1 &
  PORT=${PORT_B:-8080} SCENEBENCH_CHROME_ARGS="$bf ${ARGS_B:-}" taskset -c "$cb" node tools/scenebench.mjs "$sc" "$B" --runs 1 --measure "$m" > "$out/b$p.log" 2>&1 &
  echo "$ca $cb" > "$out/cores$p"
done
wait
get() { grep -h "\] $sc .* r1: " "$1" | head -1 | sed -nE "s/.* $metric=([0-9.]+).*/\1/p"; }
for p in $(seq 1 "$n"); do
  va=$(get "$out/a$p.log"); vb=$(get "$out/b$p.log")
  if [ -n "$va" ] && [ -n "$vb" ]; then
    d=$(awk -v a="$va" -v b="$vb" 'BEGIN{printf "%+.2f", (b/a-1)*100}')
    echo "SWAB $sc p$p [$(cat "$out/cores$p")] A=$va B=$vb B/A=$d%"
  else
    echo "SWAB $sc p$p FAIL"; grep -h "r1:" "$out/a$p.log" "$out/b$p.log" | cut -c1-300
  fi
done | tee "$out/summary.txt"
python3 - "$out/summary.txt" "$sc" <<'EOF' | tee -a "$out/summary.txt"
import re, statistics, sys
v = [float(m) for m in re.findall(r"B/A=([-+][0-9.]+)%", open(sys.argv[1]).read())]
if v:
    sd = statistics.stdev(v) if len(v) > 1 else 0
    print(f"SWAB {sys.argv[2]} mean B/A {statistics.mean(v):+.2f}% over {len(v)} (sd {sd:.2f}, se {sd / len(v) ** 0.5:.2f})")
EOF
echo "logs: $out"
