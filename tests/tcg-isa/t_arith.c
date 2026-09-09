/* Data processing: add/sub/rsb/adc/sbc/rsc flag matrices, 64-bit carry
 * chains (TCG add2/sub2), cmp/cmn, and cmp+conditional-mov (setcond). */
#include "harness.h"
#include "ops.h"

static const uint32_t pairs[][2] = {
    {0x00000000u, 0x00000000u},
    {0x00000001u, 0x00000000u},
    {0x00000000u, 0x00000001u},
    {0x00000001u, 0x00000001u},
    {0x00000005u, 0x00000006u},   /* the plan's smoke pair */
    {0x7FFFFFFFu, 0x00000001u},
    {0x7FFFFFFFu, 0x7FFFFFFFu},
    {0x80000000u, 0x80000000u},
    {0xFFFFFFFFu, 0x00000001u},
    {0xFFFFFFFFu, 0xFFFFFFFFu},
    {0x12345678u, 0x9ABCDEF0u},
    {0x80000000u, 0x7FFFFFFFu},
    {0xDEADBEEFu, 0xCAFEBABEu},
    {0xFFFFFFFFu, 0x80000000u},
    {0x00000000u, 0xFFFFFFFFu},
};

static const uint32_t carry_pairs[][2] = {
    {0x00000000u, 0x00000000u},
    {0xFFFFFFFFu, 0x00000001u},
    {0x00000000u, 0x00000001u},
    {0x80000000u, 0x80000000u},
    {0x7FFFFFFFu, 0x00000001u},
    {0x12345678u, 0x9ABCDEF0u},
};

/* ---- cmp + conditional mov (guest-side setcond producer) ---- */

extern uint32_t cond_eq(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_ne(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_cs(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_cc(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_mi(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_pl(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_vs(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_vc(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_hi(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_ls(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_ge(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_lt(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_gt(uint32_t, uint32_t, uint32_t *);
extern uint32_t cond_le(uint32_t, uint32_t, uint32_t *);

typedef uint32_t (*cond_fn)(uint32_t, uint32_t, uint32_t *);

static int cond_eval(int cc, uint32_t f)
{
    int n = (f >> 3) & 1, z = (f >> 2) & 1, c = (f >> 1) & 1, v = f & 1;

    switch (cc) {
    case 0: return z;                 /* eq */
    case 1: return !z;                /* ne */
    case 2: return c;                 /* cs */
    case 3: return !c;                /* cc */
    case 4: return n;                 /* mi */
    case 5: return !n;                /* pl */
    case 6: return v;                 /* vs */
    case 7: return !v;                /* vc */
    case 8: return c && !z;           /* hi */
    case 9: return !c || z;           /* ls */
    case 10: return n == v;           /* ge */
    case 11: return n != v;           /* lt */
    case 12: return !z && (n == v);   /* gt */
    default: return z || (n != v);    /* le */
    }
}

static const struct { const char *cc; cond_fn fn; } conds[] = {
    {"eq", cond_eq}, {"ne", cond_ne}, {"cs", cond_cs}, {"cc", cond_cc},
    {"mi", cond_mi}, {"pl", cond_pl}, {"vs", cond_vs}, {"vc", cond_vc},
    {"hi", cond_hi}, {"ls", cond_ls}, {"ge", cond_ge}, {"lt", cond_lt},
    {"gt", cond_gt}, {"le", cond_le},
};

static const uint32_t cmp_pairs[][2] = {
    {0x00000000u, 0x00000000u},
    {0x00000001u, 0x00000000u},
    {0x00000000u, 0x00000001u},
    {0x00000001u, 0x00000001u},
    {0x80000000u, 0x7FFFFFFFu},
    {0x7FFFFFFFu, 0x80000000u},
    {0xFFFFFFFFu, 0xFFFFFFFEu},
    {0x00000005u, 0x0000000Au},
    {0x0000000Au, 0x00000005u},
    {0xFFFFFFFBu, 0x00000005u},
};

void t_arith(void)
{
    char nm[48];
    uint32_t v, f, ev, ef;

    for (unsigned i = 0; i < sizeof(pairs) / sizeof(pairs[0]); i++) {
        uint32_t a = pairs[i][0], b = pairs[i][1];

        v = op_adds(a, b, 0, &f);
        ref_add(a, b, 0, &ev, &ef);
        nm2(nm, "arith/adds", a, b);
        check_vf(nm, v, f, ev, ef, F_NZCV);

        v = op_subs(a, b, 0, &f);
        ref_sub(a, b, 0, &ev, &ef);
        nm2(nm, "arith/subs", a, b);
        check_vf(nm, v, f, ev, ef, F_NZCV);

        v = op_rsbs(a, b, 0, &f);
        ref_sub(b, a, 0, &ev, &ef);
        nm2(nm, "arith/rsbs", a, b);
        check_vf(nm, v, f, ev, ef, F_NZCV);

        v = op_cmp(a, b, 0, &f);
        ref_sub(a, b, 0, &ev, &ef);
        nm2(nm, "arith/cmp", a, b);
        check_vf(nm, v, f, 0, ef, F_NZCV);

        v = op_cmn(a, b, 0, &f);
        ref_add(a, b, 0, &ev, &ef);
        nm2(nm, "arith/cmn", a, b);
        check_vf(nm, v, f, 0, ef, F_NZCV);
    }

    /* carry-dependent forms, both carry-in values */
    for (unsigned i = 0; i < sizeof(carry_pairs) / sizeof(carry_pairs[0]); i++) {
        uint32_t a = carry_pairs[i][0], b = carry_pairs[i][1];

        for (uint32_t cin = 0; cin <= 1; cin++) {
            uint32_t preset = cin << 1;

            v = op_adcs(a, b, preset, &f);
            ref_add(a, b, cin, &ev, &ef);
            nm2(nm, "arith/adcs", a, b);
            check_vf(nm, v, f, ev, ef, F_NZCV);

            v = op_sbcs(a, b, preset, &f);
            ref_sub(a, b, !cin, &ev, &ef);
            nm2(nm, "arith/sbcs", a, b);
            check_vf(nm, v, f, ev, ef, F_NZCV);

            v = op_rscs(a, b, preset, &f);
            ref_sub(b, a, !cin, &ev, &ef);
            nm2(nm, "arith/rscs", a, b);
            check_vf(nm, v, f, ev, ef, F_NZCV);
        }
    }

    /* 64-bit carry chains (adds+adcs / subs+sbcs -> TCG add2/sub2) */
    static const uint32_t wide[][4] = {
        {0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u},
        {0xFFFFFFFFu, 0x00000000u, 0x00000001u, 0x00000000u},
        {0x00000000u, 0x00000000u, 0x00000000u, 0x00000001u},
        {0xFFFFFFFFu, 0x00000000u, 0xFFFFFFFFu, 0x00000000u},
        {0x12345678u, 0x9ABCDEF0u, 0x87654321u, 0x0FEDCBA9u},
        {0x00000000u, 0x7FFFFFFFu, 0x00000001u, 0x00000000u},
        {0x00000000u, 0x80000000u, 0x00000000u, 0x80000000u},
        {0xDEADBEEFu, 0xCAFEBABEu, 0xFEEDFACEu, 0x0BADCAFEu},
    };
    for (unsigned i = 0; i < sizeof(wide) / sizeof(wide[0]); i++) {
        uint32_t alo = wide[i][0], ahi = wide[i][1];
        uint32_t blo = wide[i][2], bhi = wide[i][3];
        uint32_t lo, hi;

        op_add64(alo, ahi, blo, bhi, &lo, &hi, &f);
        ref_add(alo, blo, 0, &ev, &ef);
        nm3(nm, "arith/add64lo", alo, blo, ahi);
        check_vf(nm, lo, 0, ev, 0, 0);
        ref_add(ahi, bhi, (ef >> 1) & 1u, &ev, &ef);
        nm3(nm, "arith/add64hi", ahi, bhi, blo);
        check_vf(nm, hi, f, ev, ef, F_NZCV);

        op_sub64(alo, ahi, blo, bhi, &lo, &hi, &f);
        ref_sub(alo, blo, 0, &ev, &ef);
        nm3(nm, "arith/sub64lo", alo, blo, ahi);
        check_vf(nm, lo, 0, ev, 0, 0);
        ref_sub(ahi, bhi, ((ef >> 1) & 1u) == 0u, &ev, &ef);
        nm3(nm, "arith/sub64hi", ahi, bhi, blo);
        check_vf(nm, hi, f, ev, ef, F_NZCV);
    }

    /* every condition code against flag matrices produced by cmp */
    for (unsigned i = 0; i < sizeof(cmp_pairs) / sizeof(cmp_pairs[0]); i++) {
        uint32_t a = cmp_pairs[i][0], b = cmp_pairs[i][1];

        ref_sub(a, b, 0, &ev, &ef);
        for (unsigned c = 0; c < sizeof(conds) / sizeof(conds[0]); c++) {
            v = conds[c].fn(a, b, &f);
            nm0(nm, "arith/cond/x"); /* rebuilt below with the cc name */
            {
                static const char hx[] = "0123456789abcdef";
                char *p = nm;
                const char *s;
                for (s = "arith/cond/"; *s; ) *p++ = *s++;
                for (s = conds[c].cc; *s; ) *p++ = *s++;
                *p++ = '/';
                for (int k = 28; k >= 0; k -= 4) *p++ = hx[(a >> k) & 0xf];
                *p++ = '+';
                for (int k = 28; k >= 0; k -= 4) *p++ = hx[(b >> k) & 0xf];
                *p = 0;
            }
            check_vf(nm, v, f, (uint32_t)cond_eval((int)c, ef), ef, F_NZCV);
        }
    }
}
