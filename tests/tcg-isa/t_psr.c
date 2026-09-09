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
}
