#!/bin/bash
# Paired free-run A/B, all pairs at once: pair p runs leg A and leg B together
# on two whole physical cores each (with their SMT siblings, from the host's
# topology: tools/perf/coresets.sh); A/B core sides and which leg starts
# first alternate between pairs.  V8 explicit bounds checks on (Android),
# free-run switched on when the measurement starts: both dists must be built
# with tools/perf/freerun.diff applied (see doc/performance.md).
#   swab.sh <scene> <distA> <distB> [pairs 1-4] [measure s]
# More than 4 pairs would share cores and give garbage: run it twice instead.
# Env: BFLAGS=0 drops the bounds checks, ARGS_A/ARGS_B extra chrome args,
# METRIC (vratio), OUT (log dir), PORT (page server, default 8080), PORT_A/PORT_B
# (a server per leg, default PORT).
sc=$1; A=$2; B=$3; n=${4:-4}; m=${5:-20}
[ "$n" -ge 1 ] && [ "$n" -le 4 ] || { echo "pairs must be 1-4" >&2; exit 2; }
metric=${METRIC:-vratio}
cd "$(dirname "$0")/../.."
source tools/perf/coresets.sh
need_sets "$n"
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$PWD/tools/chrome}
export SCENEBENCH_AT_MEASURE="window.__qemu._wasm_free_run(1)"
bf="--js-flags=--wasm-enforce-bounds-checks"
[ "${BFLAGS:-1}" = 0 ] && bf=""
out=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/swab.XXXX")}
mkdir -p "$out"
# serve.mjs gzips a dist's wasm on its first request; a dist built moments
# ago would make its legs wait for that compress while the other side runs
pa=${PORT_A:-${PORT:-8080}}; pb=${PORT_B:-${PORT:-8080}}
curl -s -H "Accept-Encoding: gzip" -o /dev/null "http://127.0.0.1:$pa/$A/qemu-system-arm.wasm"
curl -s -H "Accept-Encoding: gzip" -o /dev/null "http://127.0.0.1:$pb/$B/qemu-system-arm.wasm"
# the runs are background jobs: a signal stops them as well, and the script
# exits 128+n
runs=()
stop_runs() {
  trap - HUP INT TERM
  kill -"$1" "${runs[@]}" 2>/dev/null
  wait
  exit $((128 + $2))
}
trap 'stop_runs HUP 1' HUP
trap 'stop_runs INT 2' INT
trap 'stop_runs TERM 15' TERM
leg_a() {
  PORT=$pa SCENEBENCH_CHROME_ARGS="$bf ${ARGS_A:-}" taskset -c "$ca" node tools/scenebench.mjs "$sc" "$A" --runs 1 --measure "$m" > "$out/a$p.log" 2>&1 &
  runs+=($!)
}
leg_b() {
  PORT=$pb SCENEBENCH_CHROME_ARGS="$bf ${ARGS_B:-}" taskset -c "$cb" node tools/scenebench.mjs "$sc" "$B" --runs 1 --measure "$m" > "$out/b$p.log" 2>&1 &
  runs+=($!)
}
for p in $(seq 1 "$n"); do
  ORD=(0 4 2 6); o=${ORD[$((p - 1))]}
  s0=${SETS[$o]}; s1=${SETS[$((o + 1))]}
  if [ $((p % 2)) = 1 ]; then ca=$s0; cb=$s1; else ca=$s1; cb=$s0; fi
  # the later-started leg does better (doc/performance.md, position bias)
  if [ $((p % 2)) = 1 ]; then leg_a; leg_b; first=A; else leg_b; leg_a; first=B; fi
  echo "$ca $cb, $first first" > "$out/cores$p"
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
