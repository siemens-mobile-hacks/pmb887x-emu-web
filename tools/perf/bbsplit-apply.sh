#!/usr/bin/env bash
# Probes 2+3: split GSYNC_BBEND into br / predication-label / other-label.
#
# DO NOT RUN THIS WHILE THE -O3 A/B IS PENDING.  That A/B compares the
# already-deployed site/dist-jit against a tree that differs only in the
# optimization level; any source change here lands in the -O3 arm alone and
# confounds it.  Apply after -O3 is decided.
#
# Why it is worth a build: the predication lever is currently bracketed
# between 0.17 % and 11.5 % of write-backs, because a predicated A32
# instruction charges two different counters -- the brcond over it (CBR) and
# the label after it (BBEND) -- and BBEND cannot currently tell that label
# from a folded branch.  GSYNC_PRED measures the second half directly, which
# turns the bracket into a number.
#
# The partition is exact.  At the one la_bb_end call site the opcode can only
# be set_label or br: brcond is taken by the COND_BRANCH arm above it, and
# exit_tb/goto_tb/goto_ptr by BB_EXIT.  So BR + PRED + LBL == BBEND, and
# bbsplitan.py checks that identity rather than assuming it.
set -euo pipefail
cd /workspace/qemu

python3 - <<'PY'
import os, sys

# DRY=1 checks every anchor against the tree without touching it -- worth
# running the moment the patch is written, since a stale anchor found then
# costs nothing and found at apply time costs a build slot.
DRY = os.environ.get("DRY", "0") == "1"


def sub(path, old, new, count=1):
    src = open(path).read()
    n = src.count(old)
    if n != count:
        sys.exit(f"!!! {path}: anchor matched {n} times, expected {count}\n--- anchor ---\n{old}")
    if DRY:
        print(f"ok  {path}  (dry run)")
        return
    open(path, "w").write(src.replace(old, new))
    print(f"ok  {path}")

# ---------------------------------------------------------------- wasm-diag.h
# Appended at the END of the enum: tools/diagnames.mjs parses this header
# positionally, so an insertion higher up renames every counter in every
# binary already built.  That trap cost round seventeen.
sub("include/qemu/wasm-diag.h",
"""    WASM_DIAG_PRED_A32,      /* an A32 instruction with cond != AL */
    WASM_DIAG_PRED_SEL,      /* ... of which this many could be a movcond */

    WASM_DIAG_N""",
"""    WASM_DIAG_PRED_A32,      /* an A32 instruction with cond != AL */
    WASM_DIAG_PRED_SEL,      /* ... of which this many could be a movcond */

    /*
     * GSYNC_BBEND, split.  These three partition it exactly: at the one
     * la_bb_end call site the opcode can only be set_label or br, because
     * brcond is taken by the COND_BRANCH arm above it and the exit/goto ops
     * by BB_EXIT.  BR + PRED + LBL == BBEND is therefore an identity worth
     * checking, not an approximation.
     *
     * They are appended at the end of the enum because tools/diagnames.mjs
     * derives names positionally from this header: inserting one higher up
     * renames every counter in every binary already built.
     */
    WASM_DIAG_GSYNC_BR,      /* an unconditional br (a folded branch) */
    WASM_DIAG_GSYNC_PRED,    /* a label closing a predicated instruction */
    WASM_DIAG_GSYNC_LBL,     /* any other label */

    /*
     * Every demand la_charge fires, counted once more without consulting
     * the blame.  The causes must sum to exactly this.  It is not
     * redundant: la_why is a zero-initialised thread-local, so a demand
     * charged before anything blamed that temp increments counter index 0
     * -- an unrelated counter -- and nothing else would ever show it.
     */
    WASM_DIAG_GSYNC_TOT,

    WASM_DIAG_N""")

sub("tcg/tcg.c",
"""    if (ts->kind == TEMP_GLOBAL) {
        wasm_diag_stat[la_why[ts - s->temps]]++;
    }""",
"""    if (ts->kind == TEMP_GLOBAL) {
        wasm_diag_stat[la_why[ts - s->temps]]++;
        wasm_diag_stat[WASM_DIAG_GSYNC_TOT]++;
    }""")

# The claim these counters sum to TCG_GST is wrong and has been since they
# were written; correct it while the file is open.
sub("include/qemu/wasm-diag.h",
"""     * and these five counters test it.  Their sum should track TCG_GST:
     * a residue means stores are being emitted for a reason other than
     * liveness demanding one (allocator pressure is the candidate), and
     * that residue is itself worth reading.""",
"""     * and these five counters test it.  Their sum is NOT TCG_GST and never
     * was.  la_charge fires once per global output arg whose liveness marks
     * SYNC_ARG -- a sync *demand* -- while TCG_GST fires inside temp_sync,
     * which emits nothing when the global is already coherent.  Demands run
     * 1.32-1.35x stores; against the demand total the five causes sum to
     * 100.0 %.  Take shares against their own sum, not against TCG_GST.""")

sub("include/qemu/wasm-diag.h",
"""    WASM_DIAG_GSYNC_BBEND,   /* a label or br (la_bb_end); goto_tb is BB_EXIT,
                                checked first, so it charges GSYNC_EXIT */""",
"""    WASM_DIAG_GSYNC_BBEND,   /* retired: la_bb_end charges GSYNC_BR / _PRED /
                                _LBL instead, and those three partition this
                                exactly.  Kept because diagnames.mjs reads
                                the enum positionally -- deleting it renames
                                every later counter in every binary already
                                built.  It reads 0 in a split build, which is
                                the tell that the split is live. */""")

sub("include/qemu/wasm-diag.h",
"""     * the ceiling in stores.  That share is not yet measured: BBEND does
     * not distinguish a condlabel from any other label or from a br.""",
"""     * the ceiling in stores.  GSYNC_PRED is that share, measured: it counts
     * exactly the labels arm_skip_unless created.  It covers all three of
     * its callers, though -- the A32 path, the trans_ helper and the Thumb
     * IT block -- while PRED_A32 counts only the A32 path, so GSYNC_PRED
     * over PRED_A32 is not a per-instruction ratio.""")

# -------------------------------------------------------------------- tcg.h
sub("include/tcg/tcg.h",
"""struct TCGLabel {
    bool present;
    bool has_value;
    uint16_t id;""",
"""/* Why a label exists, for the GSYNC_BBEND split.  0 is "anything else". */
enum {
    W64_LBL_OTHER = 0,
    W64_LBL_PRED,            /* closes a predicated insn (arm_skip_unless) */
};

struct TCGLabel {
    bool present;
    bool has_value;
    uint16_t id;
    uint8_t w64_origin;      /* free: pads out before the 8-aligned union */""")

# -------------------------------------------------------------------- tcg.c
sub("tcg/tcg.c",
"static void la_bb_end(TCGContext *s, int ng, int nt)",
"static void la_bb_end(TCGContext *s, int ng, int nt, int why)")

sub("tcg/tcg.c",
"            la_blame_kill(s, i, WASM_DIAG_GSYNC_BBEND);",
"            la_blame_kill(s, i, why);")

sub("tcg/tcg.c",
"""            } else if (def->flags & TCG_OPF_BB_END) {
                assert_carry_dead(s);
                la_bb_end(s, nb_globals, nb_temps);
            } else if (def->flags & TCG_OPF_SIDE_EFFECTS) {""",
"""            } else if (def->flags & TCG_OPF_BB_END) {
                int why;
                assert_carry_dead(s);
                if (opc == INDEX_op_br) {
                    why = WASM_DIAG_GSYNC_BR;
                } else if (opc == INDEX_op_set_label &&
                           arg_label(op->args[0])->w64_origin == W64_LBL_PRED) {
                    why = WASM_DIAG_GSYNC_PRED;
                } else {
                    why = WASM_DIAG_GSYNC_LBL;
                }
                la_bb_end(s, nb_globals, nb_temps, why);
            } else if (def->flags & TCG_OPF_SIDE_EFFECTS) {""")

# --------------------------------------------------------------- translate.c
# Tagged here and not in arm_gen_condlabel, which trans_CBZ also calls for a
# conditional *branch* -- that label is not predication and must stay OTHER.
sub("target/arm/tcg/translate.c",
"""    arm_gen_condlabel(s);
    arm_gen_test_cc(cond ^ 1, s->condlabel.label);""",
"""    arm_gen_condlabel(s);
    s->condlabel.label->w64_origin = W64_LBL_PRED;
    arm_gen_test_cc(cond ^ 1, s->condlabel.label);""")
PY

echo
echo "=== applied.  Counter order (diagnames.mjs reads this positionally):"
grep -n 'WASM_DIAG_GSYNC_\|WASM_DIAG_PRED_\|WASM_DIAG_N' include/qemu/wasm-diag.h | tail -12
