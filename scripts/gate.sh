#!/bin/bash
# Run the correctness gates concurrently and print one verdict table.
#
#   scripts/gate.sh quick     # after an edit, before believing a number
#   scripts/gate.sh keep      # before committing a patch
#   scripts/gate.sh close     # before the session's last commit
#
# quick has 7 jobs, keep 14 and close 23 (--list names them).  Measured on
# this host (32 cores) at aa89576 (2026-11-14): close took 905 s, against
# 2631 s for its jobs one after another, which is the whole point.  It is
# bounded by boot-ordered (754 s -- five boards in one browser, in order,
# and that sequence is the test condition, so it cannot be split).  The
# jobs of quick sum to 763 s and those of keep to 1009 s; the board boots
# (150 s each) are the longest of them.
#
#   --dist D     dist under site/ to gate (default dist)
#   --port P     server port for the browser gates (default 8080).  opsuite
#                starts a server of its own on P+13 (8093 by default), so
#                gates that run at the same time need ports 14 or more apart
#   --jobs N     max concurrent jobs (default 6; each browser gate peaks
#                around 2 GB RSS, so this is a memory bound, not a CPU
#                one).  Note lockstep-full runs its three comparisons
#                with --par 3 internally, so it is worth ~3 slots and
#                ~6 GB on its own -- it is not counted as such here.
#   --only a,b   run just these jobs;  --skip a,b  drops them (a name that
#                is no job of any tier exits 2)
#   --list       print the jobs of each tier and exit
#
# Why this can be parallel at all: a gate asks whether the guest reaches a
# state, not how fast it got there.  Some ask it by a wall-clock deadline
# (bootcheck's --secs and its instruction minimums, the native suite's 15 s
# boot-init and --timeout, ffboot's MAX, and the job time limits below), but
# each is set far above the time the state takes, so the load of the gates
# running together does not change a verdict.  An overloaded host can still
# fail one: rerun that job alone before believing it.  The benchmarks
# (idlebench/uibench/tcgbench/loadbench) are different: their result IS a
# time, and they must be run alone on a quiet host.  Keep the two apart:
# gates in parallel, measurements serial.
#
# Exit 0 iff every job in the tier passed.  Per-job logs land in
# tests/results/gate-<stamp>-<random>/<job>.log and the failing tail is printed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST=dist
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
[[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$PORT" -le 65522 ] ||
  { echo "gate.sh: --port must be 1..65522, not '$PORT'" >&2; exit 2; }
PORT_TCG=$((PORT + 13))
[[ "$JOBS_MAX" =~ ^[1-9][0-9]*$ ]] ||
  { echo "gate.sh: --jobs must be 1 or more, not '$JOBS_MAX'" >&2; exit 2; }
# efa-web, ui-acceptance and ffboot take the server from the environment
export PORT
# the playwright browsers are downloaded into tools/chrome; default to
# them, as tools/parbench.sh does
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/tools/chrome}"

# name | tiers | needs the browser server | time limit (s) | command
#
# The time limit stops a job that hangs (a frozen page that never answers,
# a qemu that never exits) so that the gate still ends.  Each is about four
# times the job's time in the close gates of 2026-11-14 (boot-* 152 s,
# key-* 27 s, boot-ordered 754 s, lockstep-native 491 s, lockstep-full
# 348 s, firefox 131 s, native 61 s, lockstep-wasm 67 s, ui 55 s), so a
# loaded host does not reach it; a job that does is a FAIL marked TIMEOUT.
#
# bootcheck and earlykey are one job per board rather than one job that
# loops: the loop is what made this gate a ten-minute step.  The ORDERED
# multi-board run stays in `close` because booting the boards as
# consecutive pages of one browser is itself a test condition -- the
# second page loads the wasm from cache and starts at full speed, which
# has exposed races the single-board runs miss (see "Gates" in
# doc/lessons.md).
#
# firefox and ui boot a pinned image (--flash, a tools/lib/boards.mjs id),
# not whatever TESTFLASH or the gitignored testflash.local.json names, so
# they run on a fresh clone and boot the same image everywhere.
#
# ui always drives the page's default dist (dist): --dist does not reach
# it.  It is here because nothing else runs it, and a UI check nobody runs
# rots -- its slow-warning check failed unnoticed because a page-level CPU
# throttle does not reach the guest's workers.
JOBS=(
  "unit|quick keep close|no|120|node --test '$ROOT'/tests/unit/*.test.mjs"
  "opsuite|quick keep close|no|600|PORT_TCG=$PORT_TCG WASM=1 TCGISA_DIST=$DIST bash '$ROOT/scripts/run-tcg-isa.sh'"
  "boot-s75|quick keep close|yes|600|node '$ROOT/tools/bootcheck.mjs' --port $PORT --dist $DIST --secs 150 --flash s75"
  "boot-el71|quick keep close|yes|600|node '$ROOT/tools/bootcheck.mjs' --port $PORT --dist $DIST --secs 150 --flash el71"
  "boot-ke800|quick keep close|yes|600|node '$ROOT/tools/bootcheck.mjs' --port $PORT --dist $DIST --secs 150 --flash ke800"
  "boot-cx70|quick keep close|yes|600|node '$ROOT/tools/bootcheck.mjs' --port $PORT --dist $DIST --secs 150 --flash cx70"
  "boot-ke970|quick keep close|yes|600|node '$ROOT/tools/bootcheck.mjs' --port $PORT --dist $DIST --secs 150 --flash ke970"
  "key-s75|keep close|yes|300|node '$ROOT/tools/earlykey.mjs' --port $PORT --dist $DIST --board s75"
  "key-el71|keep close|yes|300|node '$ROOT/tools/earlykey.mjs' --port $PORT --dist $DIST --board el71"
  "key-ke800|keep close|yes|300|node '$ROOT/tools/earlykey.mjs' --port $PORT --dist $DIST --board ke800"
  "key-cx70|keep close|yes|300|node '$ROOT/tools/earlykey.mjs' --port $PORT --dist $DIST --board cx70"
  "key-ke970|keep close|yes|300|node '$ROOT/tools/earlykey.mjs' --port $PORT --dist $DIST --board ke970"
  "native|keep close|no|900|node '$ROOT/tests/run.mjs' --label gate --timeout 240"
  "lockstep-wasm|keep close|yes|600|node '$ROOT/tools/lockstep-wasm.mjs' --port $PORT --dist $DIST --insns 250e6 --runs 1 --label gate-wasm"
  "boot-ordered|close|yes|2400|node '$ROOT/tools/bootcheck.mjs' --port $PORT --dist $DIST --secs 150"
  "lockstep-native|close|no|1800|bash '$ROOT/scripts/run-lockstep.sh'"
  "lockstep-full|close|yes|1500|node '$ROOT/tools/lockstep-wasm.mjs' --port $PORT --dist $DIST --insns 2.5e9 --runs 3 --par 3 --label gate-close"
  "firefox|close|yes|600|gate_firefox"
  "detect|close|no|300|node '$ROOT/tools/detect-check.mjs'"
  "efa-web|close|yes|300|PORT=$PORT node '$ROOT/tools/efa-web.mjs' && PORT=$PORT node '$ROOT/tools/efa-web.mjs' noefa"
  "ui|close|yes|600|PORT=$PORT node '$ROOT/tools/ui-acceptance.mjs' --flash s75"
  "card|close|yes|600|node '$ROOT/tools/cardcheck.mjs' --port $PORT --dist $DIST --flash el71"
  "cardfolder|close|yes|600|node '$ROOT/tools/cardfoldercheck.mjs' --port $PORT --dist $DIST --flash s75"
)

# ffboot reports in text, not an exit code: the Firefox module budget is
# blown when modules created exceed batch closes + compactions (temp>0),
# and any page error is a failure.
gate_firefox() {
  local tmp progress errors
  tmp="$(mktemp)"
  # tee rather than capture: a two-minute job whose log stays empty until
  # it exits is indistinguishable from a hung one.
  BROWSER=firefox PORT="$PORT" MAX=120 node "$ROOT/tools/ffboot.mjs" --flash s75 "$DIST" 2>&1 | tee "$tmp"
  progress="$(grep -o 'progress=.*' "$tmp" | tail -1 | cut -d= -f2-)"
  errors="$(grep -o 'errors=[0-9]*' "$tmp" | tail -1 | cut -d= -f2)"
  rm -f "$tmp"
  [ -n "$progress" ] && [ -n "$errors" ] || { echo "gate: ffboot produced no verdict"; return 1; }
  [ "$errors" = "0" ] || { echo "gate: ffboot errors=$errors"; return 1; }
  [ "$progress" = "ok" ] || { echo "gate: ffboot progress=$progress"; return 1; }
  return 0
}
# a job runs in a bash of its own under timeout
export -f gate_firefox
export ROOT DIST

in_list() { case ",$2," in *,"$1",*) return 0 ;; *) return 1 ;; esac; }

all_names=""
for j in "${JOBS[@]}"; do
  IFS='|' read -r name _rest <<<"$j"
  all_names+="$name,"
done
IFS=, read -ra asked <<<"$ONLY,$SKIP"
for name in "${asked[@]}"; do
  [ -z "$name" ] || in_list "$name" "$all_names" ||
    { echo "gate.sh: no job named '$name' (gate.sh --list prints them)" >&2; exit 2; }
done

if [ "$LIST" = 1 ]; then
  for t in quick keep close; do
    printf '%-7s' "$t:"
    for j in "${JOBS[@]}"; do
      IFS='|' read -r name tiers _rest <<<"$j"
      [[ " $tiers " == *" $t "* ]] && printf ' %s' "$name"
    done
    echo
  done
  exit 0
fi

selected=()
names_selected=()
for j in "${JOBS[@]}"; do
  IFS='|' read -r name tiers _rest <<<"$j"
  [[ " $tiers " == *" $TIER "* ]] || continue
  [ -z "$ONLY" ] || in_list "$name" "$ONLY" || continue
  [ -z "$SKIP" ] || ! in_list "$name" "$SKIP" || continue
  selected+=("$j")
  names_selected+=("$name")
done
[ ${#selected[@]} -gt 0 ] || { echo "gate.sh: no jobs selected" >&2; exit 2; }

# ---- the browser gates need a server: this checkout's, or one of its own --
need_server=0
for j in "${selected[@]}"; do
  IFS='|' read -r _n _t srv _rest <<<"$j"
  [ "$srv" = yes ] && need_server=1
done

# A gate stopped half way must not leave its jobs behind: their browsers and
# the unpaced native qemus keep running on their own otherwise.  The same
# goes for its server and for a pre-step (a native build) still running.
#
# A signal from outside (`timeout 170 gate.sh`, Ctrl-C, a closed terminal)
# reaches the whole process group of this shell, so the job subshells die
# with it and their children cannot be found from them any more.  Each job's
# `timeout` leads a process group of its own (it calls setpgid), which the
# signal does not reach; the job records that group in JOBDIR and the
# cleanup kills every member of it and everything below them.  Playwright
# starts its browser in a session of its own, which is why the descendants
# are collected as well as the group.
SRV="" pre="" JOBDIR=""
# the jobs not yet reaped, by pid: a finished job's pid can be reused
declare -A live=()
descendants() {
  local c
  for c in $(pgrep -P "$1"); do echo "$c"; descendants "$c"; done
}
cleanup() {
  local p g f all=()
  for p in "${!live[@]}" $pre; do
    kill -0 "$p" 2>/dev/null && all+=("$p" $(descendants "$p"))
  done
  if [ -n "$JOBDIR" ]; then
    for f in "$JOBDIR"/*; do
      [ -f "$f" ] || continue
      g="$(<"$f")"
      for p in $(pgrep -g "$g"); do all+=("$p" $(descendants "$p")); done
    done
  fi
  if [ ${#all[@]} -gt 0 ]; then
    kill "${all[@]}" 2>/dev/null
    # a browser or a qemu can take a moment over a TERM; whatever is left
    # after 15 s is killed, so that nothing outlives the gate
    for _ in $(seq 150); do
      for p in "${all[@]}"; do kill -0 "$p" 2>/dev/null && break; p=""; done
      [ -z "$p" ] && break
      sleep 0.1
    done
    kill -KILL "${all[@]}" 2>/dev/null
  fi
  [ -z "$SRV" ] || kill "$SRV" 2>/dev/null
  [ -z "$JOBDIR" ] || rm -rf "$JOBDIR"
  return 0
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# A trap runs only once a foreground command has finished, so a step that
# can take minutes runs in the background, where `wait` gives way to it.
run_pre() { # <log> <command...>
  local rc=0
  "${@:2}" >"$1" 2>&1 &
  pre=$!
  wait "$pre" || rc=$?
  pre=""
  return "$rc"
}

# A server that already answers on the port is used only if it serves this
# checkout's site/: the page (app.js) and the dist's engine (qemu-source.txt)
# must be the ones here, or the gate would pass another tree.
served_is_ours() {
  local f served
  for f in app.js "$DIST/qemu-source.txt"; do
    served="$(curl -sf "http://127.0.0.1:$PORT/$f" 2>/dev/null)" || served="<none>"
    [ -f "$ROOT/site/$f" ] || { [ "$served" = "<none>" ] && continue; }
    if [ ! -f "$ROOT/site/$f" ] || [ "$served" != "$(cat "$ROOT/site/$f")" ]; then
      echo "gate: the server on $PORT does not serve this checkout (its $f differs from site/$f);" \
           "stop it or pick another --port" >&2
      return 1
    fi
  done
}

if [ "$need_server" = 1 ]; then
  if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    served_is_ours || exit 1
  else
    echo "gate: starting serve.mjs on $PORT"
    # shellcheck source=serve-local.sh
    . "$ROOT/scripts/serve-local.sh"
    start_serve "$ROOT" "$PORT" || { echo "gate: no serve.mjs of its own on $PORT"; exit 1; }
  fi
fi

# serve.mjs regenerates the gzip sidecar on the first request after a
# deploy; paying that inside a gate's own boot has faked slow starts before.
if [ "$need_server" = 1 ]; then
  run_pre /dev/null curl -s -o /dev/null -H 'Accept-Encoding: gzip' \
    "http://127.0.0.1:$PORT/$DIST/qemu-system-arm.wasm" || true
fi

# mktemp: two gates started in the same second must not share a directory
mkdir -p "$ROOT/tests/results"
LOGDIR="$(mktemp -d "$ROOT/tests/results/gate-$(date +%Y%m%d-%H%M%S)-XXXX")"

# The native jobs run the reference builds of qemu/ as it is checked out;
# bring them up to date before any job starts (incremental, seconds when
# nothing changed).  Concurrent jobs must not each rebuild them, and a
# lockstep job against a stale reference fails for nothing.
need_jit=0 need_tci=0 need_plugins=0
for name in "${names_selected[@]}"; do
  case "$name" in
    native|lockstep-wasm|lockstep-full) need_jit=1 ;;
    opsuite|lockstep-native) need_jit=1 need_tci=1 ;;
  esac
  case "$name" in
    native|lockstep-*) need_plugins=1 ;;
  esac
done
if [ "$need_jit" = 1 ]; then
  echo "gate: native reference build (scripts/build-native.sh)"
  run_pre "$LOGDIR/build-native.log" bash "$ROOT/scripts/build-native.sh" ||
    { echo "gate: native reference build failed: $LOGDIR/build-native.log"; exit 1; }
fi
if [ "$need_tci" = 1 ]; then
  echo "gate: native TCI build (scripts/build-native-tci.sh)"
  run_pre "$LOGDIR/build-native-tci.log" bash "$ROOT/scripts/build-native-tci.sh" ||
    { echo "gate: native TCI build failed: $LOGDIR/build-native-tci.log"; exit 1; }
fi
if [ "$need_plugins" = 1 ]; then
  echo "gate: test plugins (scripts/build-plugins.sh)"
  run_pre "$LOGDIR/build-plugins.log" bash "$ROOT/scripts/build-plugins.sh" ||
    { echo "gate: plugin build failed: $LOGDIR/build-plugins.log"; exit 1; }
fi

JOBDIR="$(mktemp -d "${TMPDIR:-/tmp}/gate-jobs-XXXXXX")"

echo "gate: tier=$TIER dist=$DIST jobs=${#selected[@]} concurrency=$JOBS_MAX"
echo "gate: logs in $LOGDIR"
t_all=$(date +%s)

# The server started above is a background job of this shell too: count and
# wait for the gate's own jobs only, or the wait never returns.
names=()
# waits for one job to end and forgets it
reap_one() {
  local done_pid="" rc=0
  wait -n -p done_pid "${!live[@]}" 2>/dev/null || rc=$?
  if [ -n "$done_pid" ]; then
    unset "live[$done_pid]"
  elif [ "$rc" = 127 ]; then
    live=()
  fi
}
for j in "${selected[@]}"; do
  IFS='|' read -r name _t _s limit cmd <<<"$j"
  names+=("$name")
  while [ "${#live[@]}" -ge "$JOBS_MAX" ]; do reap_one; done
  (
    t0=$(date +%s)
    # timeout signals the job's whole process group; -k for one that
    # ignores the TERM.  Started in the background so that its pid, the
    # group's id, can be recorded for cleanup()
    timeout -k 30 "$limit" bash -c "$cmd" >"$LOGDIR/$name.log" 2>&1 &
    echo "$!" >"$JOBDIR/$name"
    wait "$!"
    rc=$?
    rm -f "$JOBDIR/$name"
    secs=$(( $(date +%s) - t0 ))
    if { [ "$rc" = 124 ] || [ "$rc" = 137 ]; } && [ "$secs" -ge "$limit" ]; then
      echo "gate: $name timed out after ${limit}s" >>"$LOGDIR/$name.log"
      rc=timeout
    fi
    echo "$rc $secs" >"$LOGDIR/$name.rc"
  ) &
  live[$!]=1
done
while [ "${#live[@]}" -gt 0 ]; do reap_one; done

echo
printf '%-16s %-7s %7s  %s\n' JOB VERDICT TIME LOG
fail=0
for name in "${names[@]}"; do
  read -r rc secs <"$LOGDIR/$name.rc" 2>/dev/null || { rc=99; secs=0; }
  case "$rc" in
    0) verdict=PASS ;;
    timeout) verdict=TIMEOUT; fail=1 ;;
    *) verdict=FAIL; fail=1 ;;
  esac
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
