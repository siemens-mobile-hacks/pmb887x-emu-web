#!/usr/bin/env bash
# Where the guest-register write-backs come from.
#
# tcgGst is 9.46 stores and tcgGld 7.18 loads per generated TB against
# 9.73 guest instructions (tbIcount/tbGen) -- 1.71 env memory operations
# for every guest instruction.  Per instruction the stores do not fall as
# TBs lengthen, they RISE: 0.939 at FTMAX 1, 0.972 at the default, 1.026
# at FTMAX 4, because folding through branches adds the very brconds that
# force a write-back.  Lengthening TBs makes this worse.  wasm-diag.h has
# called that a TB-boundary cost since round eleven, but liveness demands
# a write-back at four other kinds of site too, and on ARM two of them are
# everywhere: a brcond (every predicated instruction is one) and a guest
# memory access (which must leave env coherent because it can fault).
#
# The five GSYNC_* counters say which.  SE and CALL are semantics and
# cannot be removed; CBR and BBEND are code shape and a branchless form of
# predication would remove them.  This decides whether that is worth
# building.
#
# Translation-time counters, so this is not a measurement build: the leg's
# ms/Mi is as valid as any other.  Two games because the mix of predicated
# code is a property of the game's compiler, not of the emulator.
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad

FLASH=/workspace/fullflashes/CX70_FW56_clean.bin
START='center:10000,center:10000,center:10000,center:8000'

timeout 2000 node tools/j2mebench.mjs --dist dist-jit \
  --flash "$FLASH" --game 1,2 --start "$START" \
  --tracec --window 30000 --tag gsync \
  > "$S/gsync.log" 2>&1
echo "gsync rc=$? $(date +%H:%M:%S)"

python3 scratchpad/gsyncan.py "$S/gsync.log"
