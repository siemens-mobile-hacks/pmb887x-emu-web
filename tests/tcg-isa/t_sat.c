/* Saturating arithmetic (ARMv5TE QADD/QSUB/QDADD/QDSUB -> TCG
 * setcond/saturating helpers). Value + the Q sticky flag. */
#include "harness.h"

static inline uint32_t op_qadd(uint32_t a, uint32_t b, uint32_t *q)
{
    uint32_t v, p;

    __asm__ ("qadd %[v], %[a], %[b]\nmrs %[p], cpsr"
             : [v] "=&r" (v), [p] "=&r" (p)
             : [a] "r" (a), [b] "r" (b));
    *q = (p >> 27) & 1u;
    return v;
}

static inline uint32_t op_qsub(uint32_t a, uint32_t b, uint32_t *q)
{
    uint32_t v, p;

    __asm__ ("qsub %[v], %[a], %[b]\nmrs %[p], cpsr"
             : [v] "=&r" (v), [p] "=&r" (p)
             : [a] "r" (a), [b] "r" (b));
    *q = (p >> 27) & 1u;
    return v;
}

static inline uint32_t op_qdadd(uint32_t a, uint32_t b, uint32_t *q)
{
    uint32_t v, p;

    __asm__ ("qdadd %[v], %[a], %[b]\nmrs %[p], cpsr"
             : [v] "=&r" (v), [p] "=&r" (p)
             : [a] "r" (a), [b] "r" (b));
    *q = (p >> 27) & 1u;
    return v;
}

static inline uint32_t op_qdsub(uint32_t a, uint32_t b, uint32_t *q)
{
    uint32_t v, p;

    __asm__ ("qdsub %[v], %[a], %[b]\nmrs %[p], cpsr"
             : [v] "=&r" (v), [p] "=&r" (p)
             : [a] "r" (a), [b] "r" (b));
    *q = (p >> 27) & 1u;
    return v;
}

/* saturate an int64 to int32 */
static int32_t sat32(int64_t x, uint32_t *q)
{
    if (x > 0x7FFFFFFFll) {
        *q = 1;
        return 0x7FFFFFFF;
    }
    if (x < -0x80000000ll) {
        *q = 1;
        return (int32_t)(-0x80000000ll);
    }
    return (int32_t)x;
}

static uint32_t ref_qadd(uint32_t a, uint32_t b, uint32_t *q)
{
    *q = 0;
    return (uint32_t)sat32((int64_t)(int32_t)a + (int64_t)(int32_t)b, q);
}

static uint32_t ref_qsub(uint32_t a, uint32_t b, uint32_t *q)
{
    *q = 0;
    return (uint32_t)sat32((int64_t)(int32_t)a - (int64_t)(int32_t)b, q);
}

static uint32_t ref_qdadd(uint32_t a, uint32_t b, uint32_t *q)
{
    uint32_t q1 = 0, q2 = 0;
    int32_t d = sat32((int64_t)(int32_t)b * 2, &q1);
    int32_t r = sat32((int64_t)(int32_t)a + d, &q2);

    *q = q1 | q2;
    return (uint32_t)r;
}

static uint32_t ref_qdsub(uint32_t a, uint32_t b, uint32_t *q)
{
    uint32_t q1 = 0, q2 = 0;
    int32_t d = sat32((int64_t)(int32_t)b * 2, &q1);
    int32_t r = sat32((int64_t)(int32_t)a - d, &q2);

    *q = q1 | q2;
    return (uint32_t)r;
}

static const uint32_t spairs[][2] = {
    {0x00000000u, 0x00000000u},
    {0x00000001u, 0x00000002u},
    {0x7FFFFFFFu, 0x00000001u},   /* add saturates */
    {0x7FFFFFFFu, 0x7FFFFFFFu},
    {0x80000000u, 0xFFFFFFFFu},   /* sub saturates (add -1) */
    {0x80000000u, 0x80000000u},
    {0x7FFFFFFFu, 0x80000000u},   /* add INT32_MIN: no saturation */
    {0x12345678u, 0x9ABCDEF0u},
    {0x40000000u, 0x40000000u},   /* qd*: double = INT32_MIN exactly */
    {0x7FFFFFFFu, 0x40000001u},   /* qd*: double saturates */
    {0x80000000u, 0xC0000000u},   /* qd*: double saturates negative */
    {0xDEADBEEFu, 0xCAFEBABEu},
};

void t_sat(void)
{
    char nm[48];
    uint32_t v, q, ev, eq;
    uint32_t q_sticky = 0; /* Q is sticky across ops (cleared only by msr) */

    for (unsigned i = 0; i < sizeof(spairs) / sizeof(spairs[0]); i++) {
        uint32_t a = spairs[i][0], b = spairs[i][1];

        v = op_qadd(a, b, &q);
        ev = ref_qadd(a, b, &eq);
        nm2(nm, "sat/qadd", a, b);
        check_vq(nm, v, q, ev, q_sticky | eq);
        q_sticky |= eq;

        v = op_qsub(a, b, &q);
        ev = ref_qsub(a, b, &eq);
        nm2(nm, "sat/qsub", a, b);
        check_vq(nm, v, q, ev, q_sticky | eq);
        q_sticky |= eq;

        v = op_qdadd(a, b, &q);
        ev = ref_qdadd(a, b, &eq);
        nm2(nm, "sat/qdadd", a, b);
        check_vq(nm, v, q, ev, q_sticky | eq);
        q_sticky |= eq;

        v = op_qdsub(a, b, &q);
        ev = ref_qdsub(a, b, &eq);
        nm2(nm, "sat/qdsub", a, b);
        check_vq(nm, v, q, ev, q_sticky | eq);
        q_sticky |= eq;
    }
}
