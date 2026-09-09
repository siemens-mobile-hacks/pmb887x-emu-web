/* Multiplies: mul/mla (N/Z only — C/V are unpredictable on ARMv5, dumped
 * as '-') and the 64-bit forms umull/umlal/smull/smlal at boundary values
 * (value only; all flags unpredictable). umull/umlal exercise the TCG
 * mulu2/add2 pair, smull/smlal the signed one. */
#include "harness.h"
#include "ops.h"

static const uint32_t mpairs[][2] = {
    {0x00000000u, 0x00000000u},
    {0x00000001u, 0x00000001u},
    {0x00000000u, 0xFFFFFFFFu},
    {0xFFFFFFFFu, 0xFFFFFFFFu},
    {0x00010000u, 0x00010000u},   /* 2^16 * 2^16 = 2^32 exactly */
    {0x80000000u, 0x00000002u},
    {0x00000002u, 0x80000000u},
    {0x7FFFFFFFu, 0x7FFFFFFFu},
    {0xFFFFFFFFu, 0x80000000u},
    {0x80000000u, 0x80000000u},
    {0x12345678u, 0x9ABCDEF0u},
};

static const uint32_t accs[] = { 0x00000000u, 0x00000001u, 0xFFFFFFFFu };

void t_mul(void)
{
    char nm[48];
    uint32_t v, f, ev;

    for (unsigned i = 0; i < sizeof(mpairs) / sizeof(mpairs[0]); i++) {
        uint32_t a = mpairs[i][0], b = mpairs[i][1];

        v = op_muls(a, b, 0, &f);
        ev = a * b;                 /* uint32 wrap == truncated product */
        nm2(nm, "mul/muls", a, b);
        check_vf(nm, v, f, ev, ORACLE_NZ(ev), F_NZ);

        for (unsigned k = 0; k < sizeof(accs) / sizeof(accs[0]); k++) {
            uint32_t c = accs[k];

            v = op_mla(a, b, c, 0, &f);
            ev = a * b + c;
            nm3(nm, "mul/mlas", a, b, c);
            check_vf(nm, v, f, ev, ORACLE_NZ(ev), F_NZ);
        }

        {
            uint32_t lo = 0, hi = 0;

            op_umull(a, b, &lo, &hi);
            uint64_t p = (uint64_t)a * b;
            nm2(nm, "mul/umull_lo", a, b);
            check_v(nm, lo, (uint32_t)p);
            nm2(nm, "mul/umull_hi", a, b);
            check_v(nm, hi, (uint32_t)(p >> 32));

            op_smull(a, b, &lo, &hi);
            int64_t sp = (int64_t)(int32_t)a * (int64_t)(int32_t)b;
            nm2(nm, "mul/smull_lo", a, b);
            check_v(nm, lo, (uint32_t)sp);
            nm2(nm, "mul/smull_hi", a, b);
            check_v(nm, hi, (uint32_t)((uint64_t)sp >> 32));

            /* accumulate (64-bit add into the running product) */
            lo = 0x11112222u;
            hi = 0x33334444u;
            op_umlal(a, b, &lo, &hi);
            uint64_t ua = ((uint64_t)0x33334444u << 32) | 0x11112222u;
            ua += (uint64_t)a * b;
            nm2(nm, "mul/umlal_lo", a, b);
            check_v(nm, lo, (uint32_t)ua);
            nm2(nm, "mul/umlal_hi", a, b);
            check_v(nm, hi, (uint32_t)(ua >> 32));

            lo = 0x11112222u;
            hi = 0x9999AAAAu;
            op_smlal(a, b, &lo, &hi);
            int64_t sa = (int64_t)(((uint64_t)0x9999AAAAu << 32) | 0x11112222u);
            sa += (int64_t)(int32_t)a * (int64_t)(int32_t)b;
            nm2(nm, "mul/smlal_lo", a, b);
            check_v(nm, lo, (uint32_t)sa);
            nm2(nm, "mul/smlal_hi", a, b);
            check_v(nm, hi, (uint32_t)((uint64_t)sa >> 32));
        }
    }
}
