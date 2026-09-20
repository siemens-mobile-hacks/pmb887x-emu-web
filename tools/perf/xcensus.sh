#!/usr/bin/env bash
# The boundary census, on the workload the user actually named.
#
# Everything the tree knows about where TB boundaries go was measured on an
# EL71 boot or an idle menu (playbook 0h says so outright).  The verdict it
# produced is the one open lever left: calls (xwOther) + their returns
# (xwBx) are 45 % of all exits, ~17 % of wall, and removing them means
# inlining a callee into its caller's TB.  Every other mechanism is closed.
#
# A J2ME MIDlet is a bytecode interpreter, and an interpreter's dispatch is
# not a call -- it is `ldr pc, [rX, rY]`, which lands in xwPcst, not
# xwOther.  So the census may look completely different here, and the size
# of the only remaining lever is unknown on the only workload that matters.
# Measure it before building anything.
#
# W64_XCOUNT=1 counts exits by kind in the generated code, W64_XWHY=1
# attributes each indirect one to the guest instruction that asked.  Both
# emit counter code into every TB, so the wall clock from this leg is not
# comparable to anything -- the counters are the result.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"

FLASH=/workspace/fullflashes/CX70_FW56_clean.bin
START='center:10000,center:10000,center:10000,center:8000'

EXTRA_Q='env=W64_XCOUNT=1&env=W64_XWHY=1' \
timeout 2700 node tools/j2mebench.mjs --dist dist-jit \
  --flash "$FLASH" --game 1,2,3,4 --start "$START" \
  --tracec --window 45000 --tag xcen \
  > "$S/xcen.log" 2>&1
echo "rc=$?"

grep -E "^J2ME " "$S/xcen.log" | sort -u
echo "--- the census (zero xGotoptr would mean the knob is not in this binary)"
grep -o "perMi:.*" "$S/xcen.log" | tr ' ' '\n' |
  grep -E "^(xGoto|xSelf|xw|lookup|execIter|tbIcount|tbGen)" || true
