#!/usr/bin/env bash
# Everything that had to wait for the sweep to release the host, in one
# shell.  One shell and no pid waiting: PID 1 in this container is
# `sleep infinity` and reaps nothing, so a `while kill -0` loop on an
# orphan never ends.
#
# bcprobe goes first and alone.  It is two minutes, it needs a quiet host
# because it reports nanoseconds per access, and it decides whether the
# largest finding of round 35 -- the 26 % bound check -- is reachable by
# a build flag or not at all.  postsweep is forty minutes of compile and
# benchmark that does not depend on its answer, so it goes after.
set -u
cd /workspace
S=/tmp/claude-1000/-workspace/7bf5ba1e-5200-4b0e-aa53-7900a35c4ca3/scratchpad

# bcprobe needs a cross-origin-isolated page or its *shared* legs cannot
# run, and shared is the axis that decides the whole question.  Its own
# failure mode is a warning and a run on about:blank, which returns half
# an answer that looks like a whole one -- so check the server here.
if ! curl -sSI --max-time 5 http://127.0.0.1:8080/ 2>/dev/null |
     grep -qi 'cross-origin-embedder-policy'; then
  echo "!!! no cross-origin-isolated server on 8080; starting one"
  (cd /workspace && node serve.mjs >"$S/serve-after.log" 2>&1 &)
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sI --max-time 2 http://127.0.0.1:8080/ 2>/dev/null |
      grep -qi 'cross-origin-embedder-policy' && break
    sleep 1
  done
fi

echo "=== bcprobe, Chrome, checks on $(date +%H:%M:%S)"
timeout 300 node tools/bcprobe.mjs --chrome 2>&1 | tee "$S/bc-on.log"

# The control.  If an i64 leg does not fall to its i32 leg here, that
# kernel never exposed a check and its delta above means nothing.
echo "=== bcprobe, Chrome, checks off (control) $(date +%H:%M:%S)"
timeout 300 node tools/bcprobe.mjs --chrome \
  --js-flags=--no-wasm-bounds-checks 2>&1 | tee "$S/bc-off.log"

# The executed TB length, which nothing in this workstream has ever
# measured.  wasm_tbs() returns 0 on this backend under icount unless
# W64_TBSTATS=1, which is why every result JSON carries insnsPerTb:null,
# and three rounds of TB-entry pricing substituted a count derived from
# whichever counter looked like a mean.  Two legs, against the same
# dist-jit the sweep used, before postsweep rebuilds it:
#
#   base -> L, so the per-entry ns finally has a denominator
#   ft4  -> r, the factor FTMAX 3->4 multiplies L by.  The total entry
#           cost is dt/(1-1/r) and needs only r, so this leg is the one
#           that turns "~43 % of wall, assuming executed length scales
#           with translated" into a measurement.
#
# Both legs carry two extra RMWs per entry, so their ms/Mi is spoiled and
# only the ratios mean anything.  wasm_tb_insns() against the icount
# state makes the insns half self-checking.
FLASH=/workspace/fullflashes/CX70_FW56_clean.bin
START='center:10000,center:10000,center:10000,center:8000'
# EXTRA_Q is spliced into the page URL verbatim and app.js reads
# getAll("env"), so two knobs need two `env=` params, not one joined
# assignment -- a joined one silently keeps only the first.
# W64_XCOUNT rides along so exits are counted in the same run as entries.
# The exit census already implies ~18 executed instructions per exit on
# this workload (xGotoptr+xGototb+xGototb1 = 55.4 k/Mi against a
# translated mean of 9.4), which is neither of the two numbers the
# handoff was choosing between; having both counters in one leg says
# whether entries and exits are the same population or whether half the
# hand-offs go uncounted.  Both knobs change the emitted code, so per-Mi
# rates stay exact and the wall does not -- which is all this leg needs.
for leg in tbs_base tbs_ft4; do
  q='env=W64_TBSTATS=1&env=W64_XCOUNT=1'
  [ "$leg" = tbs_ft4 ] && q="$q&env=W64_FTMAX=4"
  echo "=== $leg $(date +%H:%M:%S)"
  EXTRA_Q="$q" \
  timeout 900 node tools/j2mebench.mjs --dist dist-jit \
    --flash "$FLASH" --game 1 --start "$START" \
    --tracec --window 45000 --tag "$leg" \
    > "$S/$leg.log" 2>&1
  echo "$leg rc=$? $(grep -haoE 'insnsPerTb[^,]*|ms/Mi=[0-9.]+' "$S/$leg.log" | head -3 | tr '\n' ' ')"
done
# The global next-TB cache (pcc) on J2ME, as a matched pair inside one
# binary.  The base leg's counters say it earns nothing here:
#
#   pccFill 460.814  lcFill 460.766  lcCall 463.649  pccHit 2.746
#
# pccFill tracks lcFill to three digits, so the global table is filled on
# exactly the occasions the *per-TB slot* is filled -- and the slot is
# what answers the next time that site runs.  A cache behind a cache sees
# only the first cache's misses.  Worse, the C-side probe in
# lookup_tb_ptr{,_lc} runs *after* the emitted probe has just missed on
# the identical key, generation and table, so on the lc path it cannot
# hit by construction; pccHit = 2.7/Mi against 963 lookups is that.
#
# Its design ceiling was lookupJc/lookup = 96.5 % (cpu-exec.c:570).  On
# this workload that ratio is 441.281/962.943 = 45.8 %, so the mechanism
# is aimed at less than half the target it was built for and hitting
# 0.28 % of it.
#
# The wall effect may well sit under the 1.4 % base spread.  tbBytes/tbGen
# will not: the emitted probe is ~30 TCG ops at *every* goto_ptr site
# (gen_goto_ptr_pcc, translate.c:1553), and that meter has a 0.04 %
# spread.  So this pair answers the code-size half regardless of whether
# it answers the wall half.
for leg in pcc_on pcc_off; do
  q=''
  [ "$leg" = pcc_off ] && q='env=W64_NOPCC=1&env=W64_NOPCCIN=1'
  echo "=== $leg $(date +%H:%M:%S)"
  EXTRA_Q="$q" \
  timeout 900 node tools/j2mebench.mjs --dist dist-jit \
    --flash "$FLASH" --game 1 --start "$START" \
    --tracec --window 45000 --tag "$leg" \
    > "$S/$leg.log" 2>&1
  echo "$leg rc=$? $(grep -haoE 'ms/Mi=[0-9.]+' "$S/$leg.log" | head -1)"
done
python3 - "$S" <<'PY'
import glob, json, os
for f in sorted(glob.glob(os.path.join("/workspace/tests/results",
                                       "*-dist-jit-pcc_*.json"))):
    d = json.load(open(f)); p = d["perMi"]
    g = p.get("tbGen", 0.0)
    print(f"{d['tag']:<8} msPerMi={d['msPerMi']:<7} "
          f"bytes/TB={p.get('tbBytes',0)/g if g else 0:8.1f} "
          f"pccHit={p.get('pccHit',0):8.3f} pccFill={p.get('pccFill',0):9.3f} "
          f"lcCall={p.get('lcCall',0):8.3f} lookup={p.get('lookup',0):8.3f}")
PY
python3 - "$S" <<'PY'
import glob, json, os, sys
for f in sorted(glob.glob(os.path.join("/workspace/tests/results",
                                       "*-dist-jit-tbs_*.json"))):
    d = json.load(open(f))
    p = d["perMi"]
    ex = sum(p.get(k, 0.0) for k in ("xGotoptr", "xGototb", "xGototb1"))
    ic, gen = p.get("tbIcount", 0.0), p.get("tbGen", 0.0)
    print(f"{d['tag']:<10} insnsPerTb={d['insnsPerTb']} "
          f"exits/Mi={ex:,.0f} insns/exit={1e6/ex if ex else 0:.2f} "
          f"translated len={ic/gen if gen else 0:.2f} "
          f"msPerMi={d['msPerMi']}")
PY

echo "=== postsweep $(date +%H:%M:%S)"
bash "$S/postsweep.sh"
echo "=== after.sh done $(date +%H:%M:%S)"
