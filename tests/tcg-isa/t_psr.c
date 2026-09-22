/* msr/mrs flag round-trips (cpu-context moves) + CPSR mode sanity.
 * The full-CPSR capture line doubles as the cross-backend canary: the
 * dump prints the whole masked CPSR, so any I/F/E/T divergence between
 * backends shows up in the byte-diff even though the assert only covers
 * mode + the NZCV round-trip. */
#include "harness.h"
#include "ops.h"

static uint32_t psr_ref;

static uint32_t op_msr_mrs(uint32_t f4)
{
    uint32_t p;

    __asm__ volatile ("msr cpsr_f, %[f]\nmrs %[p], cpsr"
                      : [p] "=r" (p)
                      : [f] "r" (f4 << 28));
    return p;
}

/*
 * A mode change that does not change the *translation* key: SVC and IRQ
 * are both EL1 with the same mmu index, so hflags is identical across
 * this switch and the wasm64 translator carries on inside the same TB
 * (target/arm/tcg/translate.c w64_psr_continue, round 41).  What must
 * still happen is the bank swap, and the instructions after the `msr`
 * must read the *new* bank.  Interrupts are masked across the window
 * because sp_irq is whatever the firmware left there.
 */
static void t_psr_bank(void)
{
    uint32_t svc_before, svc_after, irq_seen;

    __asm__ volatile (
        "mrs    r3, cpsr\n"
        "mov    %[svc0], sp\n"
        "msr    cpsr_c, #0xd2\n"        /* IRQ, I and F masked */
        "mov    sp, %[mark]\n"
        "mov    %[irq], sp\n"
        "msr    cpsr_c, #0xd3\n"        /* back to SVC */
        "mov    %[svc1], sp\n"
        "msr    cpsr_c, r3\n"
        : [svc0] "=&r" (svc_before), [irq] "=&r" (irq_seen),
          [svc1] "=&r" (svc_after)
        : [mark] "r" (0xabcd0000u)
        /* lr is banked by the mode switch, so keep the allocator off it */
        : "r3", "lr");

    check_v("psr/bank_irq", irq_seen, 0xabcd0000u);
    check_v("psr/bank_svc", svc_after, svc_before);
    check_v("psr/bank_mode", ops_get_cpsr() & 0x1fu, 0x13u);
}

void t_psr(void)
{
    char nm[48];

    for (uint32_t f4 = 0; f4 < 16; f4++) {
        uint32_t cpsr = op_msr_mrs(f4);

        nm1(nm, "psr/rt", f4);
        check_v(nm, (cpsr >> 28) & 15u, f4);

        /* mode must be SVC, Thumb bit clear (ARM state) */
        check_v("psr/mode", cpsr & 0x1Fu, 0x13u);
        check_v("psr/tbit", (cpsr >> 5) & 1u, 0u);
    }

    /* full CPSR: first read captured as the reference, later reads must
     * be identical (flags zeroed by the last round-trip above) */
    {
        uint32_t full = ops_get_cpsr();

        if (psr_ref == 0) {
            psr_ref = full & 0x0FFFFFFFu;
        }
        check_v("psr/full", full & 0x0FFFFFFFu, psr_ref);
    }

    t_psr_bank();
}
