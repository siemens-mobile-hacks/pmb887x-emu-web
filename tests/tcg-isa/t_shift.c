/* Shifts: lsl/lsr/asr/ror immediate (1..31), the immediate #32 encodings
 * (shift_imm=0, via .inst), register amounts incl. 0 (no shift, C stays)
 * and 32/33/64, plus RRX through both C values. movs forms -> N/Z from
 * result, C = carry-out (or unchanged for amount 0), V untouched. */
#include "harness.h"
#include "ops.h"

static const uint32_t vals[] = {
    0x00000000u, 0x00000001u, 0x80000000u, 0xFFFFFFFFu,
    0x12345678u, 0x80000001u, 0xF0000001u, 0x00000010u,
};

static uint32_t shift_imm(int type, int n, uint32_t a, uint32_t preset,
                          uint32_t *f)
{
    switch ((type << 8) | n) {
    case (SH_LSL << 8) | 1:  return op_lsl_1(a, preset, f);
    case (SH_LSL << 8) | 8:  return op_lsl_8(a, preset, f);
    case (SH_LSL << 8) | 31: return op_lsl_31(a, preset, f);
    case (SH_LSR << 8) | 1:  return op_lsr_1(a, preset, f);
    case (SH_LSR << 8) | 8:  return op_lsr_8(a, preset, f);
    case (SH_LSR << 8) | 31: return op_lsr_31(a, preset, f);
    case (SH_ASR << 8) | 1:  return op_asr_1(a, preset, f);
    case (SH_ASR << 8) | 8:  return op_asr_8(a, preset, f);
    case (SH_ASR << 8) | 31: return op_asr_31(a, preset, f);
    case (SH_ROR << 8) | 1:  return op_ror_1(a, preset, f);
    case (SH_ROR << 8) | 8:  return op_ror_8(a, preset, f);
    default:                 return op_ror_31(a, preset, f); /* (SH_ROR<<8)|31 */
    }
}

static const char *const tname[] = { "lsl", "lsr", "asr", "ror" };

static uint32_t shift_reg(int type, uint32_t a, uint32_t n, uint32_t preset,
                          uint32_t *f)
{
    switch (type) {
    case SH_LSL: return op_lsl_r(a, n, preset, f);
    case SH_LSR: return op_lsr_r(a, n, preset, f);
    case SH_ASR: return op_asr_r(a, n, preset, f);
    default:     return op_ror_r(a, n, preset, f);
    }
}

static void nm_shift(char *nm, const char *pfx, int type, uint32_t v,
                     uint32_t n)
{
    char *q = nm;
    const char *s = pfx;
    while (*s) *q++ = *s++;
    *q++ = '/';
    s = tname[type];
    while (*s) *q++ = *s++;
    *q++ = '/';
    static const char hx[] = "0123456789abcdef";
    for (int i = 28; i >= 0; i -= 4) *q++ = hx[(v >> i) & 0xf];
    *q++ = ',';
    for (int i = 28; i >= 0; i -= 4) *q++ = hx[(n >> i) & 0xf];
    *q = 0;
}

void t_shift(void)
{
    char nm[48];
    uint32_t v, f, ev, ef;
    static const int imms[] = { 1, 8, 31 };

    /* immediate forms */
    for (unsigned i = 0; i < sizeof(vals) / sizeof(vals[0]); i++) {
        uint32_t a = vals[i];
        uint32_t preset = (i & 1) ? 0x5u : 0xAu; /* V/C both polarities */

        for (int t = SH_LSL; t <= SH_ROR; t++) {
            for (unsigned k = 0; k < sizeof(imms) / sizeof(imms[0]); k++) {
                int n = imms[k];
                v = shift_imm(t, n, a, preset, &f);
                ef = ref_shift(t, a, (uint32_t)n, (preset >> 1) & 1u, &ev)
                     | (preset & F_V);
                nm_shift(nm, "shift/imm", t, a, (uint32_t)n);
                check_vf(nm, v, f, ev, ef, F_NZCV);
            }
        }
    }

    /* immediate #32 encodings (lsr/asr; C comes from bit 31, no preset) */
    for (unsigned i = 0; i < sizeof(vals) / sizeof(vals[0]); i++) {
        uint32_t a = vals[i];

        v = op_lsr32(a, &f);
        ef = ref_shift(SH_LSR, a, 32, 0, &ev);
        nm_shift(nm, "shift/imm32", SH_LSR, a, 32);
        check_vf(nm, v, f, ev, ef, (F_N | F_Z | F_C));

        v = op_asr32(a, &f);
        ef = ref_shift(SH_ASR, a, 32, 0, &ev);
        nm_shift(nm, "shift/imm32", SH_ASR, a, 32);
        check_vf(nm, v, f, ev, ef, (F_N | F_Z | F_C));
    }

    /* register forms: amount 0 (no shift, C unchanged), 1, 31, 32, 33, 64 */
    static const uint32_t amts[] = { 0, 1, 31, 32, 33, 64 };
    for (unsigned i = 0; i < sizeof(vals) / sizeof(vals[0]); i++) {
        uint32_t a = vals[i];

        for (int t = SH_LSL; t <= SH_ROR; t++) {
            for (unsigned k = 0; k < sizeof(amts) / sizeof(amts[0]); k++) {
                uint32_t n = amts[k];
                uint32_t preset = ((i + k) & 1) ? 0x5u : 0xAu;

                v = shift_reg(t, a, n, preset, &f);
                ef = ref_shift(t, a, n, (preset >> 1) & 1u, &ev)
                     | (preset & F_V);
                nm_shift(nm, "shift/reg", t, a, n);
                check_vf(nm, v, f, ev, ef, F_NZCV);
            }
        }
    }

    /* RRX through both C values (V preserved) */
    for (unsigned i = 0; i < sizeof(vals) / sizeof(vals[0]); i++) {
        uint32_t a = vals[i];

        for (unsigned cin = 0; cin <= 1; cin++) {
            uint32_t preset = cin ? 0x3u : 0x1u; /* C=cin, V=1 */

            v = op_rrx(a, preset, &f);
            ev = ((cin & 1u) << 31) | (a >> 1);
            ef = ORACLE_NZ(ev) | ((a & 1u) << 1) | (preset & F_V);
            nm1(nm, "shift/rrx", a);
            check_vf(nm, v, f, ev, ef, F_NZCV);
        }
    }
}
