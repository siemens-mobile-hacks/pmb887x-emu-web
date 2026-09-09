/* Self-modifying code: the image runs from SDRAM, so stores can patch
 * code. Two flavors (smcops.S):
 *  - cross-TB: patch another function between calls -> plain
 *    translation-block invalidation on the next lookup;
 *  - same-TB: the store modifies the next instruction of its own basic
 *    block -> qemu must catch the write to the currently-executing TB
 *    (notdirty -> cpu_io_recompile) and re-run the tail fresh. */
#include "harness.h"

extern uint32_t smc_target(void);
extern uint32_t smc_self(uint32_t insn);
extern uint32_t smc_slot;

void t_smc(void)
{
    char nm[48];
    volatile uint32_t *slot = &smc_slot;
    volatile uint32_t *target = (volatile uint32_t *)smc_target;

    check_v("smc/cross_before", smc_target(), 0x5Au);

    target[0] = 0xe3a000a5u;           /* mov r0, #0xA5 */
    check_v("smc/cross_after", smc_target(), 0xA5u);

    target[0] = 0xe3a0003cu;           /* mov r0, #60 */
    check_v("smc/cross_again", smc_target(), 0x3Cu);

    /* repeated patch/execute cycles: invalidate the same page over and
     * over (the flash unlock/write pattern, in miniature) */
    target[0] = 0xe3a0005au;
    uint32_t sum = 0;
    for (uint32_t i = 1; i <= 8; i++) {
        target[0] = 0xe3a00000u | i;   /* mov r0, #i */
        sum += smc_target();
    }
    check_v("smc/loop_sum", sum, 36u);

    /* same-TB: the store modifies the instruction right after itself
     * inside its own basic block. qemu's ARM target does not use
     * precise_smc (only i386/s390x do): the in-flight TB runs to
     * completion on the already-translated code and the patch takes
     * effect from the next TB lookup — deterministic emulator
     * semantics, asserted here: each call returns the slot content as
     * it was before this call's store. */
    uint32_t s = 0;
    uint32_t prev = 0x5Au;
    for (uint32_t i = 1; i <= 8; i++) {
        uint32_t r = smc_self(0xe3a00000u | (i + 0x10u));

        nm1(nm, "smc/self", i);
        check_v(nm, r, prev);
        s += r;
        prev = i + 0x10u;
    }
    check_v("smc/self_sum", s, 0x5Au + (0x11u + 0x17u) * 7u / 2u);

    /* leave the slot in its original state for reproducible re-runs */
    *slot = 0xe3a0005au;
}
