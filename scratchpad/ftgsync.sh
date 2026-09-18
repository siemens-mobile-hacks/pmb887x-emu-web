#!/usr/bin/env bash
# Probe 1 of the predication bracket: split GSYNC_BBEND into the fold's
# share and everything else, with no rebuild.
#
# w64_defer_taken (translate.c:1913) emits a tcg_gen_br per folded branch
# and sets its label later; arm_post_translate_insn independently places
# the condlabel of every predicated instruction.  Both land in BBEND, and
# the bracket in doc/performance-handoff.md is wide precisely because the
# counter cannot tell them apart.  W64_FTMAX=0 makes the guard
# `s->w64_ft_n >= w64_ft_max()` true on the first branch, so folding stops
# entirely: the BBEND that SURVIVES is the non-fold population, which is
# the ceiling predication can possibly be drawing from.
#
# Translation-time counters, so the wall here is not the result and this
# does not need a quiet host to the degree a benchmark does.  It does need
# the A/B to be finished first -- do not overlap them.
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad

FLASH=/workspace/fullflashes/CX70_FW56_clean.bin
START='center:10000,center:10000,center:10000,center:8000'

for leg in ft3 ft0; do
  q=''
  [ "$leg" = ft0 ] && q='env=W64_FTMAX=0'
  echo "=== $leg $(date +%H:%M:%S)"
  EXTRA_Q="$q" \
  timeout 1500 node tools/j2mebench.mjs --dist dist-jit \
    --flash "$FLASH" --game 1,2 --start "$START" \
    --tracec --window 30000 --tag "$leg" \
    > "$S/$leg.log" 2>&1
  echo "$leg rc=$?"
done

python3 scratchpad/ftgsyncan.py
