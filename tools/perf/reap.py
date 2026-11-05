#!/usr/bin/env python3
# reap.py CMD ARGS...: runs CMD as a child subreaper, so the orphans it leaves
# (chrome helpers) are reaped here instead of piling up as zombies under the
# container's PID 1 (sleep infinity, which never reaps).
import ctypes, os, sys, time

PR_SET_CHILD_SUBREAPER = 36
ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
pid = os.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
code = 0
while True:
    try:
        p, st = os.wait()
    except ChildProcessError:
        break
    if p == pid:
        code = os.waitstatus_to_exitcode(st)
        break
deadline = time.time() + 15
while time.time() < deadline:
    try:
        p, _ = os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        break
    if p == 0:
        time.sleep(0.2)
sys.exit(code)
