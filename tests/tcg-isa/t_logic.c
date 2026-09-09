/* Logic ops: and/or/eor/bic + mov/mvn. ARMv5 rule under test: N/Z from the
 * result, C/V untouched (covered by presetting all four flags and checking
 * the full word). tst/teq exercise the flag-only forms. */
#include "harness.h"
#include "ops.h"

static const uint32_t pairs[][2] = {
    {0x00000000u, 0x00000000u},
    {0xFFFFFFFFu, 0x00000000u},
    {0xFF00FF00u, 0x0F0F0F0Fu},
    {0x12345678u, 0x12345678u},
    {0xDEADBEEFu, 0xCAFEBABEu},
    {0x80000000u, 0x7FFFFFFFu},
    {0x55555555u, 0xAAAAAAAAu},
    {0xF0F0F0F0u, 0xF0F0F0F0u},
};

static const uint32_t unis[] = {
    0x00000000u, 0xFFFFFFFFu, 0x80000000u, 0x12345678u,
    0x00000001u, 0x7FFFFFFFu, 0x55555555u, 0xF0F0F0F0u,
};

void t_logic(void)
{
    char nm[48];
    uint32_t v, f, ev;

    for (unsigned i = 0; i < sizeof(pairs) / sizeof(pairs[0]); i++) {
        uint32_t a = pairs[i][0], b = pairs[i][1];

        /* C/V-preservation matrix on the first two pairs, else N=1/C=1 */
        const uint32_t presets[] = {0xAu, 0x3u};
        uint32_t preset = (i < 2) ? presets[i] : 0xAu;

        v = op_ands(a, b, preset, &f);
        ev = a & b;
        nm2(nm, "logic/ands", a, b);
        check_vf(nm, v, f, ev, ORACLE_NZ(ev) | (preset & (F_C | F_V)), F_NZCV);

        v = op_orrs(a, b, preset, &f);
        ev = a | b;
        nm2(nm, "logic/orrs", a, b);
        check_vf(nm, v, f, ev, ORACLE_NZ(ev) | (preset & (F_C | F_V)), F_NZCV);

        v = op_eors(a, b, preset, &f);
        ev = a ^ b;
        nm2(nm, "logic/eors", a, b);
        check_vf(nm, v, f, ev, ORACLE_NZ(ev) | (preset & (F_C | F_V)), F_NZCV);

        v = op_bics(a, b, preset, &f);
        ev = a & ~b;
        nm2(nm, "logic/bics", a, b);
        check_vf(nm, v, f, ev, ORACLE_NZ(ev) | (preset & (F_C | F_V)), F_NZCV);

        v = op_tst(a, b, preset, &f);
        ev = a & b;
        nm2(nm, "logic/tst", a, b);
        check_vf(nm, v, f, 0, ORACLE_NZ(ev) | (preset & (F_C | F_V)), F_NZCV);

        v = op_teq(a, b, preset, &f);
        ev = a ^ b;
        nm2(nm, "logic/teq", a, b);
        check_vf(nm, v, f, 0, ORACLE_NZ(ev) | (preset & (F_C | F_V)), F_NZCV);
    }

    /* full C/V preservation matrix on one pair */
    {
        uint32_t a = 0xFF00FF00u, b = 0x0F0F0F0Fu;

        for (uint32_t preset = 0; preset < 4; preset++) {
            v = op_ands(a, b, preset, &f);
            ev = a & b;
            nm1(nm, "logic/ands_cv", preset);
            check_vf(nm, v, f, ev, ORACLE_NZ(ev) | preset, F_NZCV);

            v = op_eors(a, b, preset, &f);
            ev = a ^ b;
            nm1(nm, "logic/eors_cv", preset);
            check_vf(nm, v, f, ev, ORACLE_NZ(ev) | preset, F_NZCV);
        }
    }

    /* movs/mvns: no shifter carry -> C/V preserved */
    for (unsigned i = 0; i < sizeof(unis) / sizeof(unis[0]); i++) {
        uint32_t a = unis[i];
        uint32_t preset = (i & 1) ? 0x5u : 0xAu;

        v = op_movs(a, preset, &f);
        nm1(nm, "logic/movs", a);
        check_vf(nm, v, f, a, ORACLE_NZ(a) | (preset & (F_C | F_V)), F_NZCV);

        v = op_mvns(a, preset, &f);
        ev = ~a;
        nm1(nm, "logic/mvns", a);
        check_vf(nm, v, f, ev, ORACLE_NZ(ev) | (preset & (F_C | F_V)), F_NZCV);
    }
}
