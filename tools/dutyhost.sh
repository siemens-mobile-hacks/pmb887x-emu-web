#!/bin/bash
# Run a command as if every core were RUN/(RUN+STOP) as fast: the command and
# all its descendants are stopped for STOP ms out of every RUN+STOP ms.
#
#   RUN=2 STOP=8 tools/dutyhost.sh node tools/scenebench.mjs bobby dist-jit --keyscale 3
#
# Unlike tools/slowhost.sh, whose spinners share each core with the command
# so a woken thread can wait a whole scheduler slice for its core, all of
# the command's threads run in parallel while it runs and wake each other at
# native latency.  That is a phone with several slow, mostly idle cores, the
# case for anything that spreads work over threads.  The model is coarse:
# time stands still in RUN+STOP ms steps rather than passing slower.
#
# Playwright starts the browser in a session of its own, so the process
# groups to stop are collected from the whole descendant tree (every second).
#
# Env: RUN (default 2) and STOP (default 8), in milliseconds.
set -euo pipefail
export DUTY_RUN="${RUN:-2}" DUTY_STOP="${STOP:-8}"
exec python3 - "$@" <<'EOF'
import os, signal, subprocess, sys, time
run = float(os.environ["DUTY_RUN"]) / 1000
stop = float(os.environ["DUTY_STOP"]) / 1000
child = subprocess.Popen(sys.argv[1:], start_new_session=True)

def groups():
    parent = {}
    for name in os.listdir("/proc"):
        if name.isdigit():
            try:
                with open(f"/proc/{name}/stat") as f:
                    fields = f.read().rsplit(")", 1)[1].split()
                parent[int(name)] = (int(fields[1]), int(fields[2]))   # ppid, pgrp
            except (OSError, IndexError, ValueError):
                pass
    tree, todo = {child.pid}, [child.pid]
    while todo:
        p = todo.pop()
        for q, (pp, _) in parent.items():
            if pp == p and q not in tree:
                tree.add(q)
                todo.append(q)
    return {parent[p][1] for p in tree if p in parent}

def signal_all(pgids, sig):
    for g in pgids:
        try:
            os.killpg(g, sig)
        except ProcessLookupError:
            pass

print(f"dutyhost: run {run*1000:g} ms, stop {stop*1000:g} ms (~{100*run/(run+stop):.0f} % of each core)", file=sys.stderr)
pgids, refreshed = groups(), time.monotonic()
try:
    nxt = time.monotonic()
    while child.poll() is None:
        if time.monotonic() - refreshed > 1.0:
            pgids, refreshed = groups(), time.monotonic()
        nxt += run
        time.sleep(max(0, nxt - time.monotonic()))
        signal_all(pgids, signal.SIGSTOP)
        nxt += stop
        time.sleep(max(0, nxt - time.monotonic()))
        signal_all(pgids, signal.SIGCONT)
finally:
    signal_all(groups() | pgids, signal.SIGCONT)
sys.exit(child.wait())
EOF
