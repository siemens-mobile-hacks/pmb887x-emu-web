#!/bin/bash
# Paired boot A/B with tools/bootbench.mjs, all pairs at once: pair p boots
# leg A and leg B together on two whole physical cores each, A/B sides
# alternating between pairs (the core sets of tools/perf/swab.sh).  The boot
# is paced as on the page (no free-run): while the guest is behind real time
# the wall clock between two guest-time marks is the emulator's raw speed.
#   bootab.sh <phone> <distA> <distB> [pairs 1-4]
# Env: SPAN=<v0>,<v1> the guest-time span timed (default 6,12: the EL71
# burst around the boot chime), ARGS_A/ARGS_B extra chrome args, BFLAGS=1
# adds the Android bounds checks, OUT (log dir), WARM=1 boots each leg's
# browser once before the measured boot, PORT (page server, default 8080).
# Columns: burst (wall s over SPAN), speed (producer speed of the longest
# sound), stretchedMs + gapMs = audioMs (ring audio replayed to slow sound
# down, plus underrun silence: the two trade against each other, so judge
# audio by their sum), lagMax, tIdle.
ph=$1; A=$2; B=$3; n=${4:-4}
[ "$n" -ge 1 ] && [ "$n" -le 4 ] || { echo "pairs must be 1-4" >&2; exit 2; }
SETS=("0,1,16,17" "2,3,18,19" "4,5,20,21" "6,7,22,23" "8,9,24,25" "10,11,26,27" "12,13,28,29" "14,15,30,31")
cd "$(dirname "$0")/../.."
export PLAYWRIGHT_BROWSERS_PATH=$PWD/tools/chrome
bf=""
[ "${BFLAGS:-0}" = 1 ] && bf="--js-flags=--wasm-enforce-bounds-checks"
warm=""
[ "${WARM:-0}" = 1 ] && warm="--warm"
out=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/bootab.XXXX")}
mkdir -p "$out"
# serve.mjs gzips a dist's wasm on its first request; a dist built moments
# ago would make its legs wait for that compress while the other side boots
for d in "$A" "$B"; do
  curl -s -H "Accept-Encoding: gzip" -o /dev/null "http://127.0.0.1:${PORT:-8080}/$d/qemu-system-arm.wasm"
done
for p in $(seq 1 "$n"); do
  ORD=(0 4 2 6); o=${ORD[$((p - 1))]}
  s0=${SETS[$o]}; s1=${SETS[$((o + 1))]}
  if [ $((p % 2)) = 1 ]; then ca=$s0; cb=$s1; else ca=$s1; cb=$s0; fi
  BOOTBENCH_CHROME_ARGS="$bf ${ARGS_A:-}" taskset -c "$ca" python3 tools/perf/reap.py node tools/bootbench.mjs "$ph" "$A" --runs 1 --after 0 $warm > "$out/a$p.log" 2>&1 &
  BOOTBENCH_CHROME_ARGS="$bf ${ARGS_B:-}" taskset -c "$cb" python3 tools/perf/reap.py node tools/bootbench.mjs "$ph" "$B" --runs 1 --after 0 $warm > "$out/b$p.log" 2>&1 &
  echo "$ca $cb" > "$out/cores$p"
done
wait
python3 - "$out" "$n" "${SPAN:-6,12}" <<'EOF' | tee "$out/summary.txt"
import json, re, statistics, sys
out, n, span = sys.argv[1], int(sys.argv[2]), sys.argv[3].split(",")
def get(f):
    for line in open(f):
        m = re.search(r"\[bootbench\] \S+ \S+ r1: (.*)", line)
        if m:
            d = {}
            for k, v in re.findall(r"(\S+?)=(\[.*?\]|\S+)", m.group(1)):
                d[k] = v
            return d
    return None
cols = ("burst", "speed", "stretchedMs", "gapMs", "audioMs", "lagMax", "tIdle")
rows = {c: [] for c in cols}
for p in range(1, n + 1):
    a, b = get(f"{out}/a{p}.log"), get(f"{out}/b{p}.log")
    if not a or not b or a.get("ok") != "true" or b.get("ok") != "true":
        print(f"BOOTAB p{p} FAIL"); continue
    def metrics(d):
        r = {}
        w0, w1 = d.get("w@" + span[0]), d.get("w@" + span[1])
        r["burst"] = float(w1) - float(w0) if w0 and w1 else None
        snd = json.loads(d.get("sounds", "[]"))
        r["speed"] = max(snd, key=lambda s: s["len"])["speed"] if snd else None
        for k in ("stretchedMs", "gapMs", "lagMax", "tIdle"):
            r[k] = float(d[k]) if k in d else None
        # stretching and underrun gaps trade against each other
        r["audioMs"] = r["stretchedMs"] + r["gapMs"] if r["stretchedMs"] is not None and r["gapMs"] is not None else None
        return r
    ma, mb = metrics(a), metrics(b)
    line = f"BOOTAB p{p}"
    for c in cols:
        if ma[c] is not None and mb[c] is not None:
            line += f" {c} {ma[c]:g}/{mb[c]:g}"
            rows[c].append((ma[c], mb[c]))
    print(line)
for c in cols:
    v = rows[c]
    if not v:
        continue
    ma, mb = statistics.mean(x for x, _ in v), statistics.mean(y for _, y in v)
    rel = [(y / x - 1) * 100 for x, y in v if x]
    se = statistics.stdev(rel) / len(rel) ** 0.5 if len(rel) > 1 else 0
    print(f"BOOTAB {c}: A {ma:.3f} B {mb:.3f}  B/A {statistics.mean(rel):+.1f}% (se {se:.1f}, n {len(rel)})")
EOF
echo "logs: $out"
