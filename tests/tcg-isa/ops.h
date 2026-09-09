/* Guest-op shims + C reference oracles for the tcg-isa suite.
 *
 * Every helper presets NZCV (msr cpsr_f), executes exactly the one guest
 * instruction form under test and reads CPSR back — all in a single asm
 * block, so nothing the compiler emits can sit between them. The oracles
 * compute the expected (value, flags) pairs from first principles, fully
 * independent of the guest instruction (that is the point of the suite:
 * three backends vs one authored expectation).
 */
#ifndef TCGISA_OPS_H
#define TCGISA_OPS_H

#include <stdint.h>

/* ---------------- data-processing, 2-operand ---------------- */

#define DP2(NAME, INSN)                                                     \
static inline uint32_t NAME(uint32_t a, uint32_t b, uint32_t preset,        \
                            uint32_t *cpsr)                                 \
{                                                                           \
    uint32_t v, p;                                                          \
    __asm__ (                                                               \
        "msr cpsr_f, %[f]\n"                                                \
        INSN "\n"                                                           \
        "mrs %[p], cpsr"                                                    \
        : [v] "=&r" (v), [p] "=&r" (p)                                      \
        : [f] "r" (preset << 28), [a] "r" (a), [b] "r" (b)                  \
        : "cc");                                                            \
    *cpsr = p >> 28;                                                         \
    return v;                                                               \
}

DP2(op_adds, "adds %[v], %[a], %[b]")
DP2(op_subs, "subs %[v], %[a], %[b]")
DP2(op_rsbs, "rsbs %[v], %[a], %[b]")
DP2(op_adcs, "adcs %[v], %[a], %[b]")
DP2(op_sbcs, "sbcs %[v], %[a], %[b]")
DP2(op_rscs, "rscs %[v], %[a], %[b]")
DP2(op_ands, "ands %[v], %[a], %[b]")
DP2(op_orrs, "orrs %[v], %[a], %[b]")
DP2(op_eors, "eors %[v], %[a], %[b]")
DP2(op_bics, "bics %[v], %[a], %[b]")
DP2(op_muls, "muls %[v], %[a], %[b]")       /* C/V unpredictable on v5 */

/* mla rd, rm, rs, rn: v = a*b + c */
static inline uint32_t op_mla(uint32_t a, uint32_t b, uint32_t c,
                              uint32_t preset, uint32_t *cpsr)
{
    uint32_t v, p;
    __asm__ (
        "msr cpsr_f, %[f]\n"
        "mlas %[v], %[a], %[b], %[c]\n"
        "mrs %[p], cpsr"
        : [v] "=&r" (v), [p] "=&r" (p)
        : [f] "r" (preset << 28), [a] "r" (a), [b] "r" (b), [c] "r" (c)
        : "cc");
    *cpsr = p >> 28;
    return v;
}

/* 1-operand */
#define DP1(NAME, INSN)                                                    \
static inline uint32_t NAME(uint32_t a, uint32_t preset, uint32_t *cpsr)   \
{                                                                          \
    uint32_t v, p;                                                         \
    __asm__ (                                                              \
        "msr cpsr_f, %[f]\n"                                               \
        INSN "\n"                                                          \
        "mrs %[p], cpsr"                                                   \
        : [v] "=&r" (v), [p] "=&r" (p)                                     \
        : [f] "r" (preset << 28), [a] "r" (a)                              \
        : "cc");                                                           \
    *cpsr = p >> 28;                                                             \
    return v;                                                              \
}

DP1(op_movs, "movs %[v], %[a]")            /* C/V unchanged (no shift) */
DP1(op_mvns, "mvns %[v], %[a]")

/* flags-only (cmp/cmn/tst/teq) */
#define DP0(NAME, INSN)                                                    \
static inline uint32_t NAME(uint32_t a, uint32_t b, uint32_t preset,       \
                            uint32_t *cpsr)                                \
{                                                                           \
    uint32_t p;                                                             \
    __asm__ (                                                               \
        "msr cpsr_f, %[f]\n"                                                \
        INSN "\n"                                                           \
        "mrs %[p], cpsr"                                                    \
        : [p] "=&r" (p)                                                     \
        : [f] "r" (preset << 28), [a] "r" (a), [b] "r" (b)                  \
        : "cc");                                                            \
    *cpsr = p >> 28;                                                              \
    return 0;                                                               \
}

DP0(op_cmp, "cmp %[a], %[b]")
DP0(op_cmn, "cmn %[a], %[b]")
DP0(op_tst, "tst %[a], %[b]")
DP0(op_teq, "teq %[a], %[b]")

/* 64-bit carry chains (TCG add2/sub2 consumers) */
static inline void op_add64(uint32_t alo, uint32_t ahi, uint32_t blo,
                            uint32_t bhi, uint32_t *rlo, uint32_t *rhi,
                            uint32_t *cpsr)
{
    uint32_t lo, hi, p;
    __asm__ (
        "adds %[lo], %[alo], %[blo]\n"
        "adcs %[hi], %[ahi], %[bhi]\n"
        "mrs  %[p], cpsr"
        : [lo] "=&r" (lo), [hi] "=&r" (hi), [p] "=&r" (p)
        : [alo] "r" (alo), [blo] "r" (blo), [ahi] "r" (ahi), [bhi] "r" (bhi)
        : "cc");
    *rlo = lo;
    *rhi = hi;
    *cpsr = p >> 28;
}

static inline void op_sub64(uint32_t alo, uint32_t ahi, uint32_t blo,
                            uint32_t bhi, uint32_t *rlo, uint32_t *rhi,
                            uint32_t *cpsr)
{
    uint32_t lo, hi, p;
    __asm__ (
        "subs %[lo], %[alo], %[blo]\n"
        "sbcs %[hi], %[ahi], %[bhi]\n"
        "mrs  %[p], cpsr"
        : [lo] "=&r" (lo), [hi] "=&r" (hi), [p] "=&r" (p)
        : [alo] "r" (alo), [blo] "r" (blo), [ahi] "r" (ahi), [bhi] "r" (bhi)
        : "cc");
    *rlo = lo;
    *rhi = hi;
    *cpsr = p >> 28;
}

/* ---------------- multiplies ---------------- */

static inline void op_umull(uint32_t a, uint32_t b, uint32_t *lo, uint32_t *hi)
{
    __asm__ ("umull %[lo], %[hi], %[a], %[b]"
             : [lo] "=&r" (*lo), [hi] "=&r" (*hi)
             : [a] "r" (a), [b] "r" (b));
}

static inline void op_smull(uint32_t a, uint32_t b, uint32_t *lo, uint32_t *hi)
{
    __asm__ ("smull %[lo], %[hi], %[a], %[b]"
             : [lo] "=&r" (*lo), [hi] "=&r" (*hi)
             : [a] "r" (a), [b] "r" (b));
}

static inline void op_umlal(uint32_t a, uint32_t b, uint32_t *lo, uint32_t *hi)
{
    __asm__ ("umlal %[lo], %[hi], %[a], %[b]"
             : [lo] "+r" (*lo), [hi] "+r" (*hi)
             : [a] "r" (a), [b] "r" (b));
}

static inline void op_smlal(uint32_t a, uint32_t b, uint32_t *lo, uint32_t *hi)
{
    __asm__ ("smlal %[lo], %[hi], %[a], %[b]"
             : [lo] "+r" (*lo), [hi] "+r" (*hi)
             : [a] "r" (a), [b] "r" (b));
}

/* ---------------- misc ---------------- */

static inline uint32_t op_clz(uint32_t a)
{
    uint32_t v;
    __asm__ ("clz %[v], %[a]" : [v] "=r" (v) : [a] "r" (a));
    return v;
}

static inline uint32_t ops_get_cpsr(void)
{
    uint32_t p;
    __asm__ volatile ("mrs %0, cpsr" : "=r" (p));
    return p;
}

/* ---------------- shifts (flag-setting movs forms) ---------------- */

/* immediate shift, amount 1..31 */
#define SHIFT_I(NAME, AMT)                                                 \
static inline uint32_t NAME(uint32_t a, uint32_t preset, uint32_t *cpsr)   \
{                                                                          \
    uint32_t v, p;                                                         \
    __asm__ (                                                              \
        "msr cpsr_f, %[f]\n"                                               \
        "movs %[v], %[a], " AMT "\n"                                       \
        "mrs %[p], cpsr"                                                   \
        : [v] "=&r" (v), [p] "=&r" (p)                                     \
        : [f] "r" (preset << 28), [a] "r" (a)                              \
        : "cc");                                                           \
    *cpsr = p >> 28;                                                             \
    return v;                                                              \
}

SHIFT_I(op_lsl_1, "lsl #1")
SHIFT_I(op_lsl_8, "lsl #8")
SHIFT_I(op_lsl_31, "lsl #31")
SHIFT_I(op_lsr_1, "lsr #1")
SHIFT_I(op_lsr_8, "lsr #8")
SHIFT_I(op_lsr_31, "lsr #31")
SHIFT_I(op_asr_1, "asr #1")
SHIFT_I(op_asr_8, "asr #8")
SHIFT_I(op_asr_31, "asr #31")
SHIFT_I(op_ror_1, "ror #1")
SHIFT_I(op_ror_8, "ror #8")
SHIFT_I(op_ror_31, "ror #31")

/* register shift (amount from the bottom byte of n; 0 = no shift) */
#define SHIFT_R(NAME, TYPE)                                                \
static inline uint32_t NAME(uint32_t a, uint32_t n, uint32_t preset,       \
                            uint32_t *cpsr)                                \
{                                                                          \
    uint32_t v, p;                                                         \
    __asm__ (                                                              \
        "msr cpsr_f, %[f]\n"                                               \
        "movs %[v], %[a], " TYPE " %[n]\n"                                 \
        "mrs %[p], cpsr"                                                   \
        : [v] "=&r" (v), [p] "=&r" (p)                                     \
        : [f] "r" (preset << 28), [a] "r" (a), [n] "r" (n)                 \
        : "cc");                                                           \
    *cpsr = p >> 28;                                                             \
    return v;                                                              \
}

SHIFT_R(op_lsl_r, "lsl")
SHIFT_R(op_lsr_r, "lsr")
SHIFT_R(op_asr_r, "asr")
SHIFT_R(op_ror_r, "ror")

/* RRX (rotate-right-one-bit through carry) */
static inline uint32_t op_rrx(uint32_t a, uint32_t preset, uint32_t *cpsr)
{
    uint32_t v, p;
    __asm__ (
        "msr cpsr_f, %[f]\n"
        "movs %[v], %[a], rrx\n"
        "mrs %[p], cpsr"
        : [v] "=&r" (v), [p] "=&r" (p)
        : [f] "r" (preset << 28), [a] "r" (a)
        : "cc");
    *cpsr = p >> 28;
    return v;
}

/* lsr #32 / asr #32 immediate encodings (shift_imm=0) live in shiftops.S
 * — gas refuses "#32", and .inst can't take %[operands]. */
uint32_t op_lsr32(uint32_t a, uint32_t *cpsr);
uint32_t op_asr32(uint32_t a, uint32_t *cpsr);

/* ---------------- memory (guest view = plain RAM) ---------------- */

static inline __attribute__((always_inline)) uint32_t op_ldr(uint32_t addr)
{
    uint32_t v;
    __asm__ volatile ("ldr %[v], [%[a]]" : [v] "=&r" (v) : [a] "r" (addr));
    return v;
}

static inline __attribute__((always_inline)) uint32_t op_ldr_off(uint32_t addr, int32_t off)
{
    uint32_t v, o = (uint32_t)off;
    __asm__ volatile ("ldr %[v], [%[a], %[o]]" : [v] "=&r" (v) : [a] "r" (addr), [o] "r" (o));
    return v;
}

static inline __attribute__((always_inline)) uint32_t op_ldr_scaled(uint32_t addr, uint32_t idx)
{
    uint32_t v;
    __asm__ volatile ("ldr %[v], [%[a], %[i], lsl #2]"
             : [v] "=&r" (v) : [a] "r" (addr), [i] "r" (idx));
    return v;
}

static inline __attribute__((always_inline)) uint32_t op_ldr_prewb(uint32_t addr, int32_t off, uint32_t *wb)
{
    uint32_t v, b = addr, o = (uint32_t)off;
    __asm__ volatile ("ldr %[v], [%[b], %[o]]!"
             : [v] "=&r" (v), [b] "+r" (b) : [o] "r" (o));
    *wb = b;
    return v;
}

static inline __attribute__((always_inline)) uint32_t op_ldr_postwb(uint32_t addr, int32_t off, uint32_t *wb)
{
    uint32_t v, b = addr, o = (uint32_t)off;
    __asm__ volatile ("ldr %[v], [%[b]], %[o]"
             : [v] "=&r" (v), [b] "+r" (b) : [o] "r" (o));
    *wb = b;
    return v;
}

static inline void op_str(uint32_t addr, uint32_t v)
{
    __asm__ volatile ("str %[v], [%[a]]" :: [a] "r" (addr), [v] "r" (v) : "memory");
}

static inline void op_str_off(uint32_t addr, int32_t off, uint32_t v)
{
    uint32_t o = (uint32_t)off;
    __asm__ volatile ("str %[v], [%[a], %[o]]"
                      :: [a] "r" (addr), [o] "r" (o), [v] "r" (v) : "memory");
}

static inline __attribute__((always_inline)) uint32_t op_ldrb(uint32_t addr)
{
    uint32_t v;
    __asm__ volatile ("ldrb %[v], [%[a]]" : [v] "=&r" (v) : [a] "r" (addr));
    return v;
}

static inline void op_strb(uint32_t addr, uint32_t v)
{
    __asm__ volatile ("strb %[v], [%[a]]" :: [a] "r" (addr), [v] "r" (v) : "memory");
}

static inline __attribute__((always_inline)) uint32_t op_ldrh(uint32_t addr)
{
    uint32_t v;
    __asm__ volatile ("ldrh %[v], [%[a]]" : [v] "=&r" (v) : [a] "r" (addr));
    return v;
}

static inline __attribute__((always_inline)) uint32_t op_ldrh_off(uint32_t addr, int32_t off)
{
    uint32_t v, o = (uint32_t)off;
    __asm__ volatile ("ldrh %[v], [%[a], %[o]]" : [v] "=&r" (v) : [a] "r" (addr), [o] "r" (o));
    return v;
}

static inline void op_strh(uint32_t addr, uint32_t v)
{
    __asm__ volatile ("strh %[v], [%[a]]" :: [a] "r" (addr), [v] "r" (v) : "memory");
}

static inline __attribute__((always_inline)) uint32_t op_ldrsb(uint32_t addr)
{
    uint32_t v;
    __asm__ volatile ("ldrsb %[v], [%[a]]" : [v] "=&r" (v) : [a] "r" (addr));
    return v;
}

static inline __attribute__((always_inline)) uint32_t op_ldrsh(uint32_t addr)
{
    uint32_t v;
    __asm__ volatile ("ldrsh %[v], [%[a]]" : [v] "=&r" (v) : [a] "r" (addr));
    return v;
}

/* pc-relative literal-pool load */
static inline uint32_t op_ldr_pc(void)
{
    uint32_t r;
    __asm__ volatile ("ldr %[r], =0x6789ABCD" : [r] "=r" (r));
    return r;
}

/* ================================================================ */
/* reference oracles (independent C implementations of ARMv5TE        */
/* programmer-visible semantics; these define the expected values)    */
/* ================================================================ */

#define ORACLE_NZ(r) ((((r) >> 31) & 1u) << 3 | (((r) == 0) ? F_Z : 0u))

/* a + b + cin */
static inline void ref_add(uint32_t a, uint32_t b, uint32_t cin,
                           uint32_t *rv, uint32_t *rf)
{
    uint64_t s = (uint64_t)a + b + (cin & 1u);
    uint32_t r = (uint32_t)s;
    uint32_t c = (uint32_t)(s >> 32) & 1u;
    uint32_t v = ((~(a ^ b)) & (a ^ r)) >> 31;
    *rv = r;
    *rf = ORACLE_NZ(r) | (c << 1) | v;
}

/* a - b - bin */
static inline void ref_sub(uint32_t a, uint32_t b, uint32_t bin,
                           uint32_t *rv, uint32_t *rf)
{
    uint64_t d = (uint64_t)a - b - (bin & 1u);
    uint32_t r = (uint32_t)d;
    uint32_t c = (((d >> 32) & 1u) == 0u); /* C = NOT borrow */
    uint32_t v = ((a ^ b) & (a ^ r)) >> 31;
    *rv = r;
    *rf = ORACLE_NZ(r) | (c << 1) | v;
}

enum { SH_LSL, SH_LSR, SH_ASR, SH_ROR };

/* ARMv5 shift-with-carry-out semantics; amount 0 (register form) leaves
 * C at cin. Returns NZ|C packed; V is never touched by shifts. */
static inline uint32_t ref_shift(int type, uint32_t v, uint32_t n,
                                 uint32_t cin, uint32_t *rv)
{
    uint32_t r = v, c = cin & 1u;

    switch (type) {
    case SH_LSL:
        if (n == 0) {
            r = v;
        } else if (n < 32) {
            r = v << n;
            c = (v >> (32 - n)) & 1u;
        } else if (n == 32) {
            r = 0;
            c = v & 1u;
        } else {
            r = 0;
            c = 0;
        }
        break;
    case SH_LSR:
        if (n == 0) {
            r = v;
        } else if (n < 32) {
            r = v >> n;
            c = (v >> (n - 1)) & 1u;
        } else if (n == 32) {
            r = 0;
            c = (v >> 31) & 1u;
        } else {
            r = 0;
            c = 0;
        }
        break;
    case SH_ASR:
        if (n == 0) {
            r = v;
        } else if (n < 32) {
            r = (uint32_t)((int64_t)(int32_t)v >> n);
            c = (v >> (n - 1)) & 1u;
        } else {
            r = (v >> 31) ? 0xFFFFFFFFu : 0u;
            c = (v >> 31) & 1u;
        }
        break;
    case SH_ROR: {
        uint32_t m = n & 31u;
        if (n == 0) {
            r = v;                       /* register form amount 0 */
        } else if (m == 0) {
            r = v;
            c = (v >> 31) & 1u;          /* multiple of 32, nonzero: qemu's
                                            helper ror_cc models C = bit31 */
        } else {
            r = (v >> m) | (v << (32 - m));
            c = (v >> (m - 1)) & 1u;
        }
        break;
    }
    }
    *rv = r;
    return ORACLE_NZ(r) | (c << 1);
}

#endif /* TCGISA_OPS_H */
