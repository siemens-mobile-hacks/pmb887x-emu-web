#!/bin/bash
# Per-thread CPU of the busiest Chrome renderer on the attached phone, over an
# interval, from /proc/<pid>/task/*/stat through adb (ADB_SERVER_SOCKET as in
# doc/performance.md, "On a phone").  Android's top hides app threads from the
# shell; this does not.  The vCPU is the DedicatedWorker near 100 %: anything
# less, while the guest is behind real time, is time it spent waiting.
#   phonethreads.sh [seconds, default 20]
n=${1:-20}
adb=${ADB:-$(dirname "$0")/../../build/android-emu/sdk/platform-tools/adb}
pid=$($adb shell 'ps -A -o PID,%CPU,NAME --sort=-%cpu | grep -m1 -E "chrome.*:sandboxed"' | awk '{print $1}')
[ -n "$pid" ] || { echo "no Chrome renderer found" >&2; exit 1; }
snap() { $adb shell "cd /proc/$pid/task && for t in *; do read -r l < \$t/stat && echo \"\$t \$l\"; done" 2>/dev/null; }
a=$(snap); sleep "$n"; b=$(snap)
python3 - "$n" "$pid" <(echo "$a") <(echo "$b") <<'PY'
import re, sys
def rd(p):
    d = {}
    for l in open(p, errors="replace"):
        m = re.match(r"(\d+) \d+ \((.*)\) (.*)", l)
        if m:
            f = m.group(3).split()
            d[int(m.group(1))] = (m.group(2), int(f[11]), int(f[12]), int(f[36]))  # utime, stime, cpu
    return d
n = float(sys.argv[1]); a, b = rd(sys.argv[3]), rd(sys.argv[4])
rows = sorted(((b[t][1] - a[t][1], b[t][2] - a[t][2], b[t][0], b[t][3]) for t in b if t in a),
              key=lambda r: -(r[0] + r[1]))
print(f"renderer {sys.argv[2]}: {len(b)} threads, {sum(r[0] + r[1] for r in rows) / n:.0f} % of a core over {n:.0f} s")
for u, s, name, cpu in rows[:14]:
    if u + s:
        print(f"  {(u + s) / n:6.1f} %  user {u / n:5.1f}  sys {s / n:5.1f}  cpu{cpu}  {name}")
PY
