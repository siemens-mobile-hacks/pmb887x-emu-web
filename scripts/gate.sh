#!/bin/bash
# Run the correctness gates concurrently and print one verdict table.
#
#   scripts/gate.sh quick     # after an edit, before believing a number
#   scripts/gate.sh keep      # before committing a patch
#   scripts/gate.sh close     # before the session's last commit
#
# Measured on this host (32 cores, 2026-09-16): quick 5 jobs / 152 s,
# keep 11 jobs / 152 s -- both bounded by the single 150 s board boot
# they all overlap with -- and close 15 jobs / 1175 s.  Summed serially
# those are 846 s and 2874 s, which is the whole point.  `close` is
# bounded by boot-ordered (602 s: four boards in one browser, in order,
# and that sequence is the test) and by the 2.5e9 lockstep.
#
#   --dist D     dist under site/ to gate (default dist-jit)
#   --port P     server port for the browser gates (default 8080)
#   --jobs N     max concurrent jobs (default 6; each browser gate peaks
#                around 2 GB RSS, so this is a memory bound, not a CPU one)
#   --only a,b   run just these jobs;  --skip a,b  drops them
#   --list       print the jobs of each tier and exit
#
# Why this can be parallel at all: a gate asks whether the guest reaches a
# state, not how fast it got there.  Nothing here reads a wall clock as a
# result, so host load cannot change a verdict -- which is exactly what is
# NOT true of the benchmarks (workbench/idlebench/uibench/tcgbench), and
# they must still be run alone on a quiet host.  Keep the two apart: gates
# in parallel, measurements serial.
#
# Exit 0 iff every job in the tier passed.  Per-job logs land in
# tests/results/gate-<stamp>/<job>.log and the failing tail is printed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST=dist-jit
PORT=8080
JOBS_MAX=6
TIER=keep
ONLY=""
SKIP=""
LIST=0

while [ $# -gt 0 ]; do
  case "$1" in
    quick|keep|close) TIER="$1"; shift ;;
    --dist) DIST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --jobs) JOBS_MAX="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --list) LIST=1; shift ;;
    *) echo "gate.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

# name | tiers | needs the browser server | command
#
# bootcheck and earlykey are one job per board rather than one job that
# loops: the loop is what made this gate a ten-minute step.  The ORDERED
# multi-board run stays in `close` because booting the boards as
# consecutive pages of one browser is itself a test condition -- the
# second page loads the wasm from cache and starts at full speed, which
# has exposed races the single-board runs miss (see the bootcheck notes in
# optimization-playbook.md).
JOBS=(
  "opsuite|quick keep close|no|bash '$ROOT/scripts/run-tcg-isa.sh'"
  "boot-s75|quick keep close|yes|node '$ROOT/tools/bootcheck.mjs' --dist $DIST --secs 150 --flash s75"
  "boot-el71|quick keep close|yes|node '$ROOT/tools/bootcheck.mjs' --dist $DIST --secs 150 --flash el71"
  "boot-ke800|quick keep close|yes|node '$ROOT/tools/bootcheck.mjs' --dist $DIST --secs 150 --flash ke800"
  "boot-cx70|quick keep close|yes|node '$ROOT/tools/bootcheck.mjs' --dist $DIST --secs 150 --flash cx70"
  "key-s75|keep close|yes|node '$ROOT/tools/earlykey.mjs' --dist $DIST --board s75"
  "key-el71|keep close|yes|node '$ROOT/tools/earlykey.mjs' --dist $DIST --board el71"
  "key-ke800|keep close|yes|node '$ROOT/tools/earlykey.mjs' --dist $DIST --board ke800"
  "key-cx70|keep close|yes|node '$ROOT/tools/earlykey.mjs' --dist $DIST --board cx70"
  "native|keep close|no|node '$ROOT/tests/run.mjs' --label gate --timeout 240"
  "lockstep-wasm|keep close|yes|node '$ROOT/tools/lockstep-wasm.mjs' --port $PORT --dist $DIST --insns 250e6 --runs 1 --label gate"
  "boot-ordered|close|yes|node '$ROOT/tools/bootcheck.mjs' --dist $DIST --secs 150"
  "lockstep-native|close|no|bash '$ROOT/scripts/run-lockstep.sh'"
  "lockstep-full|close|yes|node '$ROOT/tools/lockstep-wasm.mjs' --port $PORT --dist $DIST --insns 2.5e9 --runs 3 --par 3 --label gate-close"
  "firefox|close|yes|gate_firefox"
)

# ffboot reports in text, not an exit code: the Firefox module budget is
# blown when modules created exceed batch closes + compactions (temp>0),
# and any page error is a failure.
gate_firefox() {
  local tmp temp errors
  tmp="$(mktemp)"
  # tee rather than capture: a two-minute job whose log stays empty until
  # it exits is indistinguishable from a hung one.
  BROWSER=firefox PORT="$PORT" MAX=120 node "$ROOT/tools/ffboot.mjs" "$DIST" 2>&1 | tee "$tmp"
  temp="$(grep -o 'temp=-\?[0-9]*' "$tmp" | tail -1 | cut -d= -f2)"
  errors="$(grep -o 'errors=[0-9]*' "$tmp" | tail -1 | cut -d= -f2)"
  rm -f "$tmp"
  [ -n "$temp" ] && [ -n "$errors" ] || { echo "gate: ffboot produced no verdict"; return 1; }
  [ "$errors" = "0" ] || { echo "gate: ffboot errors=$errors"; return 1; }
  [ "$temp" -le 0 ] || { echo "gate: ffboot temp=$temp throwaway modules"; return 1; }
  return 0
}

in_list() { case ",$2," in *,"$1",*) return 0 ;; *) return 1 ;; esac; }

if [ "$LIST" = 1 ]; then
  for t in quick keep close; do
    printf '%-7s' "$t:"
    for j in "${JOBS[@]}"; do
      IFS='|' read -r name tiers _s _c <<<"$j"
      [[ " $tiers " == *" $t "* ]] && printf ' %s' "$name"
    done
    echo
  done
  exit 0
fi

selected=()
for j in "${JOBS[@]}"; do
  IFS='|' read -r name tiers _srv _cmd <<<"$j"
  [[ " $tiers " == *" $TIER "* ]] || continue
  [ -z "$ONLY" ] || in_list "$name" "$ONLY" || continue
  [ -z "$SKIP" ] || ! in_list "$name" "$SKIP" || continue
  selected+=("$j")
done
[ ${#selected[@]} -gt 0 ] || { echo "gate.sh: no jobs selected" >&2; exit 2; }

# ---- the browser gates need a server; start one only if nothing answers --
need_server=0
for j in "${selected[@]}"; do
  IFS='|' read -r _n _t srv _c <<<"$j"
  [ "$srv" = yes ] && need_server=1
done

SRV=""
if [ "$need_server" = 1 ] && ! curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "gate: starting serve.mjs on $PORT"
  ( cd "$ROOT" && PORT=$PORT HTTPS=0 node serve.mjs >/dev/null 2>&1 ) &
  SRV=$!
  for _ in $(seq 60); do
    curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; }
trap cleanup EXIT

# serve.mjs regenerates the gzip sidecar on the first request after a
# deploy; paying that inside a gate's own boot has faked slow starts before.
if [ "$need_server" = 1 ]; then
  curl -s -o /dev/null -H 'Accept-Encoding: gzip' \
    "http://127.0.0.1:$PORT/$DIST/qemu-system-arm.wasm" 2>/dev/null || true
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
LOGDIR="$ROOT/tests/results/gate-$STAMP"
mkdir -p "$LOGDIR"

echo "gate: tier=$TIER dist=$DIST jobs=${#selected[@]} concurrency=$JOBS_MAX"
echo "gate: logs in $LOGDIR"
t_all=$(date +%s)

names=()
for j in "${selected[@]}"; do
  IFS='|' read -r name _t _s cmd <<<"$j"
  names+=("$name")
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS_MAX" ]; do wait -n 2>/dev/null || break; done
  (
    t0=$(date +%s)
    eval "$cmd" >"$LOGDIR/$name.log" 2>&1
    rc=$?
    echo "$rc $(( $(date +%s) - t0 ))" >"$LOGDIR/$name.rc"
  ) &
done
wait

echo
printf '%-16s %-7s %7s  %s\n' JOB VERDICT TIME LOG
fail=0
for name in "${names[@]}"; do
  read -r rc secs <"$LOGDIR/$name.rc" 2>/dev/null || { rc=99; secs=0; }
  if [ "$rc" = 0 ]; then verdict=PASS; else verdict=FAIL; fail=1; fi
  printf '%-16s %-7s %6ss  %s\n' "$name" "$verdict" "$secs" "$LOGDIR/$name.log"
done

if [ "$fail" = 1 ]; then
  for name in "${names[@]}"; do
    read -r rc _ <"$LOGDIR/$name.rc" 2>/dev/null || rc=99
    [ "$rc" = 0 ] && continue
    echo
    echo "---- $name (exit $rc), last 25 lines ----"
    tail -25 "$LOGDIR/$name.log"
  done
fi

echo
echo "gate: $TIER $( [ $fail = 0 ] && echo GREEN || echo RED ) in $(( $(date +%s) - t_all ))s"
exit $fail
