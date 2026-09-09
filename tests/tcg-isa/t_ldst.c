/* Loads/stores: all widths, sign-extensions, scaled/pre/post-index
 * writeback forms, and unaligned word semantics. Oracle = the byte
 * image: this qemu (ARMv5, LE) serves unaligned ldr/str as natural LE
 * accesses — verified against the native JIT reference when the
 * expectations below were authored. */
#include "harness.h"
#include "ops.h"

#define GB 0x02000000u

static uint8_t ref[64];

static uint32_t ref_word(uint32_t off)
{
    return (uint32_t)ref[off] | ((uint32_t)ref[off + 1] << 8)
         | ((uint32_t)ref[off + 2] << 16) | ((uint32_t)ref[off + 3] << 24);
}

static uint32_t ref_half(uint32_t off)
{
    return (uint32_t)ref[off] | ((uint32_t)ref[off + 1] << 8);
}

void t_ldst(void)
{
    char nm[48];
    uint32_t v, wb;

    /* deterministic byte image, written to the guest region with plain
     * stores (setup — not the instructions under test) */
    for (uint32_t i = 0; i < sizeof(ref); i++) {
        ref[i] = (uint8_t)(i * 37u + 11u);
        *(volatile uint8_t *)(GB + i) = ref[i];
    }

    /* aligned words */
    for (uint32_t off = 0; off <= 28; off += 4) {
        nm1(nm, "ldst/ldr", off);
        check_v(nm, op_ldr(GB + off), ref_word(off));
    }

    /* unaligned words (+1/+2/+3) — natural LE semantics */
    for (uint32_t d = 1; d <= 3; d++) {
        nm1(nm, "ldst/ldr_unal", d);
        check_v(nm, op_ldr(GB + 8 + d), ref_word(8 + d));
    }

    /* immediate offsets, positive and negative */
    nm0(nm, "ldst/ldr_off_p");
    check_v(nm, op_ldr_off(GB + 16, 12), ref_word(28));
    nm0(nm, "ldst/ldr_off_n");
    check_v(nm, op_ldr_off(GB + 32, -16), ref_word(16));

    /* scaled register offset */
    nm0(nm, "ldst/ldr_scaled");
    check_v(nm, op_ldr_scaled(GB, 5), ref_word(20));

    /* pre/post-index writeback */
    v = op_ldr_prewb(GB, 8, &wb);
    nm0(nm, "ldst/ldr_prewb_v");
    check_v(nm, v, ref_word(8));
    nm0(nm, "ldst/ldr_prewb_b");
    check_v(nm, wb, GB + 8);

    v = op_ldr_postwb(GB, 4, &wb);
    nm0(nm, "ldst/ldr_postwb_v");
    check_v(nm, v, ref_word(0));
    nm0(nm, "ldst/ldr_postwb_b");
    check_v(nm, wb, GB + 4);

    /* bytes */
    for (uint32_t off = 0; off < 16; off++) {
        nm1(nm, "ldst/ldrb", off);
        check_v(nm, op_ldrb(GB + off), ref[off]);
    }

    /* halves (aligned) */
    for (uint32_t off = 0; off <= 14; off += 2) {
        nm1(nm, "ldst/ldrh", off);
        check_v(nm, op_ldrh(GB + off), ref_half(off));
    }
    nm0(nm, "ldst/ldrh_off");
    check_v(nm, op_ldrh_off(GB, 10), ref_half(10));

    /* sign extensions: pick offsets whose top bits are set */
    {
        static const uint32_t boffs[] = { 1, 9, 21, 33 };
        for (unsigned i = 0; i < sizeof(boffs) / sizeof(boffs[0]); i++) {
            uint32_t o = boffs[i];
            uint32_t exp = (uint32_t)ref[o];

            if (exp & 0x80u) {
                exp |= 0xFFFFFF00u;
            }
            nm1(nm, "ldst/ldrsb", o);
            check_v(nm, op_ldrsb(GB + o), exp);
        }
        static const uint32_t hoffs[] = { 2, 14, 26, 38 };
        for (unsigned i = 0; i < sizeof(hoffs) / sizeof(hoffs[0]); i++) {
            uint32_t o = hoffs[i];
            uint32_t exp = ref_half(o);

            if (exp & 0x8000u) {
                exp |= 0xFFFF0000u;
            }
            nm1(nm, "ldst/ldrsh", o);
            check_v(nm, op_ldrsh(GB + o), exp);
        }
    }

    /* pc-relative literal load */
    nm0(nm, "ldst/ldr_pc");
    check_v(nm, op_ldr_pc(), 0x6789ABCDu);

    /* ---- stores, read back with guest loads ---- */
    op_str(GB + 32, 0xCAFEBABEu);
    nm0(nm, "ldst/str");
    check_v(nm, op_ldr(GB + 32), 0xCAFEBABEu);

    op_str_off(GB + 32, 8, 0xFEEDFACEu);
    nm0(nm, "ldst/str_off");
    check_v(nm, op_ldr(GB + 40), 0xFEEDFACEu);

    /* unaligned store at +1: bytes 33..36 must be the LE image */
    op_str_off(GB + 32, 1, 0x12345678u);
    {
        uint32_t got = op_ldrb(GB + 33) | (op_ldrb(GB + 34) << 8)
                     | (op_ldrb(GB + 35) << 16) | ((uint32_t)op_ldrb(GB + 36) << 24);

        nm0(nm, "ldst/str_unal");
        check_v(nm, got, 0x12345678u);
        /* the untouched neighbours pin down the access width */
        nm0(nm, "ldst/str_unal_lo");
        check_v(nm, op_ldr(GB + 28), ref_word(28));
    }

    op_strb(GB + 44, 0xE7u);
    nm0(nm, "ldst/strb");
    check_v(nm, op_ldrb(GB + 44), 0xE7u);
    nm0(nm, "ldst/strb_side");
    check_v(nm, op_ldrb(GB + 45), ref[45]);

    op_strh(GB + 46, 0xBEEFu);
    nm0(nm, "ldst/strh");
    check_v(nm, op_ldrh(GB + 46), 0xBEEFu);
    nm0(nm, "ldst/strh_side");
    check_v(nm, op_ldrb(GB + 48), ref[48]);

    /* writeback stores */
    {
        uint32_t b = GB + 48;

        __asm__ volatile ("str %[v], [%[b], #8]!"
                          : [b] "+r" (b)
                          : [v] "r" (0x5A5AA5A5u)
                          : "memory");
        nm0(nm, "ldst/str_prewb_v");
        check_v(nm, op_ldr(GB + 56), 0x5A5AA5A5u);
        nm0(nm, "ldst/str_prewb_b");
        check_v(nm, b, GB + 56);
    }
    {
        uint32_t b = GB + 56;

        __asm__ volatile ("str %[v], [%[b]], #8"
                          : [b] "+r" (b)
                          : [v] "r" (0xC3C3C3C3u)
                          : "memory");
        nm0(nm, "ldst/str_postwb_v");
        check_v(nm, op_ldr(GB + 56), 0xC3C3C3C3u);
        nm0(nm, "ldst/str_postwb_b");
        check_v(nm, b, GB + 64);
    }
}
