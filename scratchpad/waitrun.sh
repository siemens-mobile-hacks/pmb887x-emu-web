#!/usr/bin/env bash
# Start after.sh the moment the sweep releases the host.
#
# Polling for the process by name, not by pid: PID 1 here is `sleep
# infinity`, so an orphan is never reaped and `kill -0` on it would stay
# true forever.  The bracket in "[f]tsweep2.sh" keeps the grep from
# matching its own command line.
set -u
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad

while ps -eo args 2>/dev/null | grep -q "[f]tsweep2.sh"; do
  sleep 30
done

echo "sweep released the host at $(date +%H:%M:%S); starting after.sh"
bash "$S/after.sh"
