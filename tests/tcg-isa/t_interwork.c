/* ARM<->Thumb interwork (the second frontend): Thumb data ops whose
 * flags the ARM side reads back across the BLX/BX boundary, Thumb memory
 * forms, push/pop, and Thumb<->ARM call chains. */
#include "harness.h"
#include "ops.h"

#define TB_ 0x02030000u

extern uint32_t th_adds, th_subs, th_adcs, th_sbcs, th_lsls, th_asrs,
    th_rors, th_muls, th_ldr_r, th_ldrb_i, th_ldrh_i, th_ldrsh_r,
    th_ldrsb_r, th_str_i, th_strh_i, th_strb_i, th_pushpop, th_call_arm,
    th_call_thumb;

/* call a Thumb function with preset flags; returns r0, CPSR of the last
 * flag-setting insn survives the bx lr (mov/ldr/bx don't touch flags) */
static uint32_t call_thumb(uint32_t fn, uint32_t a, uint32_t b,
                           uint32_t preset, uint32_t *cpsr)
{
    register uint32_t r0 __asm__ ("r0") = a;
    uint32_t p;

    __asm__ volatile (
        "msr cpsr_f, %[f]\n"
        "mov r1, %[b]\n"
        "blx %[fn]\n"
        "mrs %[p], cpsr\n"
        : "+r" (r0), [p] "=&r" (p)
        : [f] "r" (preset << 28), [b] "r" (b), [fn] "r" (fn | 1u)
        : "r1", "r3", "lr", "cc", "memory");
    *cpsr = p >> 28;
    return r0;
}

void t_interwork(void)
{
    char nm[48];
    uint32_t v, f, ev, ef;

    /* memory image for the thumb loads/stores */
    for (uint32_t i = 0; i < 32; i++) {
        op_strb(TB_ + i, 0x70u + i * 3u);
    }

    v = call_thumb((uint32_t)&th_adds, 5, 6, 0, &f);
    ref_add(5, 6, 0, &ev, &ef);
    nm0(nm, "thumb/adds");
    check_vf(nm, v, f, ev, ef, F_NZCV);

    v = call_thumb((uint32_t)&th_adds, 0x7FFFFFFF, 1, 0, &f);
    ref_add(0x7FFFFFFF, 1, 0, &ev, &ef);
    nm0(nm, "thumb/adds_ovf");
    check_vf(nm, v, f, ev, ef, F_NZCV);

    v = call_thumb((uint32_t)&th_subs, 3, 8, 0, &f);
    ref_sub(3, 8, 0, &ev, &ef);
    nm0(nm, "thumb/subs");
    check_vf(nm, v, f, ev, ef, F_NZCV);

    for (uint32_t cin = 0; cin <= 1; cin++) {
        v = call_thumb((uint32_t)&th_adcs, 0xFFFFFFFF, 0, cin << 1, &f);
        ref_add(0xFFFFFFFF, 0, cin, &ev, &ef);
        nm0(nm, "thumb/adcs");
        check_vf(nm, v, f, ev, ef, F_NZCV);

        v = call_thumb((uint32_t)&th_sbcs, 0, 1, cin << 1, &f);
        ref_sub(0, 1, !cin, &ev, &ef);
        nm0(nm, "thumb/sbcs");
        check_vf(nm, v, f, ev, ef, F_NZCV);
    }

    static const uint32_t svals[] = { 0x00000001u, 0x80000000u, 0xFFFFFFFFu, 0x12345678u };
    static const uint32_t samts[] = { 1, 4, 31, 32, 33 };
    for (unsigned i = 0; i < sizeof(svals) / sizeof(svals[0]); i++) {
        uint32_t a = svals[i];

        for (unsigned k = 0; k < sizeof(samts) / sizeof(samts[0]); k++) {
            uint32_t n = samts[k];

            v = call_thumb((uint32_t)&th_lsls, a, n, 0xA, &f);
            ef = ref_shift(SH_LSL, a, n, 1, &ev);
            nm1(nm, "thumb/lsls", n);
            check_vf(nm, v, f, ev, ef, F_NZCV);

            v = call_thumb((uint32_t)&th_asrs, a, n, 0xA, &f);
            ef = ref_shift(SH_ASR, a, n, 1, &ev);
            nm1(nm, "thumb/asrs", n);
            check_vf(nm, v, f, ev, ef, F_NZCV);

            v = call_thumb((uint32_t)&th_rors, a, n, 0xA, &f);
            ef = ref_shift(SH_ROR, a, n, 1, &ev);
            nm1(nm, "thumb/rors", n);
            check_vf(nm, v, f, ev, ef, F_NZCV);
        }
    }

    v = call_thumb((uint32_t)&th_muls, 0x10000, 0x10000, 0, &f);
    nm0(nm, "thumb/muls");
    check_vf(nm, v, f, 0, ORACLE_NZ(0u), F_NZ);

    v = call_thumb((uint32_t)&th_muls, 0xFFFFFFFF, 0xFFFFFFFF, 0, &f);
    nm0(nm, "thumb/muls_ovf");
    check_vf(nm, v, f, 1, ORACLE_NZ(1u), F_NZ);

    /* thumb memory forms */
    v = call_thumb((uint32_t)&th_ldr_r, TB_, 4, 0, &f);
    nm0(nm, "thumb/ldr_r");
    check_v(nm, v, op_ldr(TB_ + 4));

    v = call_thumb((uint32_t)&th_ldrb_i, TB_, 0, 0, &f);
    nm0(nm, "thumb/ldrb_i");
    check_v(nm, v, op_ldrb(TB_ + 7));

    v = call_thumb((uint32_t)&th_ldrh_i, TB_, 0, 0, &f);
    nm0(nm, "thumb/ldrh_i");
    check_v(nm, v, op_ldrh(TB_ + 6));

    v = call_thumb((uint32_t)&th_ldrsh_r, TB_, 5, 0, &f);
    nm0(nm, "thumb/ldrsh_r");
    check_v(nm, v, op_ldrsh(TB_ + 5));

    v = call_thumb((uint32_t)&th_ldrsb_r, TB_, 6, 0, &f);
    nm0(nm, "thumb/ldrsb_r");
    check_v(nm, v, op_ldrsb(TB_ + 6));

    call_thumb((uint32_t)&th_str_i, TB_ + 16, 0x13579BDF, 0, &f);
    nm0(nm, "thumb/str_i");
    check_v(nm, op_ldr(TB_ + 16 + 8), 0x13579BDFu);

    call_thumb((uint32_t)&th_strh_i, TB_ + 16, 0xBEEF, 0, &f);
    nm0(nm, "thumb/strh_i");
    check_v(nm, op_ldrh(TB_ + 16 + 10), 0xBEEFu);

    call_thumb((uint32_t)&th_strb_i, TB_ + 16, 0x5E, 0, &f);
    nm0(nm, "thumb/strb_i");
    check_v(nm, op_ldrb(TB_ + 16 + 12), 0x5Eu);

    /* push/pop + pop {pc} interwork back to ARM */
    v = call_thumb((uint32_t)&th_pushpop, 0, 0, 0, &f);
    ref_add(0x44, 0x55, 0, &ev, &ef);
    nm0(nm, "thumb/pushpop");
    check_vf(nm, v, f, ev, ef, F_NZCV);

    /* thumb -> ARM callee -> thumb -> ARM chain */
    v = call_thumb((uint32_t)&th_call_arm, 0x21, 0, 0, &f);
    ref_add(0x121, 0x11, 0, &ev, &ef);
    nm0(nm, "thumb/call_arm");
    check_vf(nm, v, f, ev, ef, F_NZCV);

    /* thumb -> thumb nested BL chain: 0x21 +3 +0x22 = 0x46 */
    v = call_thumb((uint32_t)&th_call_thumb, 0x21, 0, 0, &f);
    ref_add(0x24, 0x22, 0, &ev, &ef);
    nm0(nm, "thumb/call_thumb");
    check_vf(nm, v, f, ev, ef, F_NZCV);
}
