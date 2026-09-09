/* LDM/STM (all four addressing modes, with/without writeback, 4- and
 * 8-register lists) and LDRD/STRD — see blockops.S for the shims. */
#include "harness.h"
#include "ops.h"

#define BB 0x02010000u

static const uint32_t cst4[4] = {
    0x11223344u, 0x55667788u, 0x99AABBCCu, 0xDDEEFF00u,
};

extern uint32_t blk_stm4_ia(uint32_t);
extern uint32_t blk_stm4_ib(uint32_t);
extern uint32_t blk_stm4_da(uint32_t);
extern uint32_t blk_stm4_db(uint32_t);
extern void blk_ldm4_ia_nwb(uint32_t, uint32_t *);
extern void blk_ldm4_ia(uint32_t, uint32_t *);
extern void blk_ldm4_ib(uint32_t, uint32_t *);
extern void blk_ldm4_da(uint32_t, uint32_t *);
extern void blk_ldm4_db(uint32_t, uint32_t *);
extern uint32_t blk_stm8(uint32_t);
extern void blk_ldm8(uint32_t *res, uint32_t src);
extern void blk_ldrd(uint32_t, uint32_t *);
extern void blk_ldrd_off(uint32_t, uint32_t *);
extern uint32_t blk_ldrd_wb(uint32_t, uint32_t *);
extern void blk_strd(uint32_t, uint32_t, uint32_t);
extern uint32_t blk_strd_wb(uint32_t, uint32_t, uint32_t);

static void prep_words(uint32_t base, const uint32_t *w, unsigned n)
{
    for (unsigned i = 0; i < n; i++) {
        op_str(base + 4u * i, w[i]);
    }
}

void t_block(void)
{
    char nm[48];
    uint32_t res[9];

    /* STM IA: words at base+0..+12, base' = base+16 */
    uint32_t nb = blk_stm4_ia(BB + 64);
    nm0(nm, "block/stm4_ia_b");
    check_v(nm, nb, BB + 64 + 16);
    for (unsigned i = 0; i < 4; i++) {
        nm1(nm, "block/stm4_ia", i);
        check_v(nm, op_ldr(BB + 64 + 4u * i), cst4[i]);
    }

    /* STM IB: words at base+4..+16, base' = base+16 */
    nb = blk_stm4_ib(BB + 128);
    nm0(nm, "block/stm4_ib_b");
    check_v(nm, nb, BB + 128 + 16);
    for (unsigned i = 0; i < 4; i++) {
        nm1(nm, "block/stm4_ib", i);
        check_v(nm, op_ldr(BB + 128 + 4u * (i + 1)), cst4[i]);
    }

    /* STM DA: transfers ascend from b-4n+4 (n=4: r1@b-12..r12@b),
     * base' = b-4n */
    nb = blk_stm4_da(BB + 256);
    nm0(nm, "block/stm4_da_b");
    check_v(nm, nb, BB + 256 - 16);
    for (unsigned i = 0; i < 4; i++) {
        nm1(nm, "block/stm4_da", i);
        check_v(nm, op_ldr(BB + 256 - 12 + 4u * i), cst4[i]);
    }

    /* STM DB: transfers ascend from b-4n (n=4: r1@b-16..r12@b-4),
     * base' = b-4n */
    nb = blk_stm4_db(BB + 384);
    nm0(nm, "block/stm4_db_b");
    check_v(nm, nb, BB + 384 - 16);
    for (unsigned i = 0; i < 4; i++) {
        nm1(nm, "block/stm4_db", i);
        check_v(nm, op_ldr(BB + 384 - 16 + 4u * i), cst4[i]);
    }

    /* LDM IA without writeback: base unchanged */
    prep_words(BB + 512, cst4, 4);
    blk_ldm4_ia_nwb(BB + 512, res);
    nm0(nm, "block/ldm4_nwb_b");
    check_v(nm, res[4], BB + 512);
    for (unsigned i = 0; i < 4; i++) {
        nm1(nm, "block/ldm4_nwb", i);
        check_v(nm, res[i], cst4[i]);
    }

    /* LDM IA: base' = base+16 */
    blk_ldm4_ia(BB + 512, res);
    nm0(nm, "block/ldm4_ia_b");
    check_v(nm, res[4], BB + 512 + 16);
    for (unsigned i = 0; i < 4; i++) {
        nm1(nm, "block/ldm4_ia", i);
        check_v(nm, res[i], cst4[i]);
    }

    /* LDM IB: r_i from [b+4+4i] (the word at b+16 is untouched RAM = 0),
     * base' = b+4n */
    blk_ldm4_ib(BB + 512, res);
    nm0(nm, "block/ldm4_ib_b");
    check_v(nm, res[4], BB + 512 + 16);
    for (unsigned i = 0; i < 3; i++) {
        nm1(nm, "block/ldm4_ib", i);
        check_v(nm, res[i], cst4[i + 1]);
    }
    nm1(nm, "block/ldm4_ib", 3);
    check_v(nm, res[3], 0u);

    /* LDM DA: r_i from [b-4n+4+4i] (n=4: from b-12), base' = b-4n */
    prep_words(BB + 576 - 12, cst4, 4);
    blk_ldm4_da(BB + 576, res);
    nm0(nm, "block/ldm4_da_b");
    check_v(nm, res[4], BB + 576 - 16);
    for (unsigned i = 0; i < 4; i++) {
        nm1(nm, "block/ldm4_da", i);
        check_v(nm, res[i], cst4[i]);
    }

    /* LDM DB: r_i from [b-4n+4i] (n=4: from b-16), base' = b-4n */
    prep_words(BB + 640 - 16, cst4, 4);
    blk_ldm4_db(BB + 640, res);
    nm0(nm, "block/ldm4_db_b");
    check_v(nm, res[4], BB + 640 - 16);
    for (unsigned i = 0; i < 4; i++) {
        nm1(nm, "block/ldm4_db", i);
        check_v(nm, res[i], cst4[i]);
    }

    /* 8-register forms */
    nb = blk_stm8(BB + 768);
    nm0(nm, "block/stm8_b");
    check_v(nm, nb, BB + 768 + 32);
    for (unsigned i = 0; i < 8; i++) {
        nm1(nm, "block/stm8", i);
        check_v(nm, op_ldr(BB + 768 + 4u * i), 0x10101010u * (i + 1));
    }
    blk_ldm8(res, BB + 768);
    nm0(nm, "block/ldm8_b");
    check_v(nm, res[8], BB + 768 + 32);
    for (unsigned i = 0; i < 8; i++) {
        nm1(nm, "block/ldm8", i);
        check_v(nm, res[i], 0x10101010u * (i + 1));
    }

    /* LDRD/STRD */
    op_str(BB + 896, 0xAAAA5555u);
    op_str(BB + 900, 0x0BADC0DEu);
    op_str(BB + 904, 0x13572468u);
    op_str(BB + 908, 0x2468ACE0u);

    blk_ldrd(BB + 896, res);
    nm0(nm, "block/ldrd_lo");
    check_v(nm, res[0], 0xAAAA5555u);
    nm0(nm, "block/ldrd_hi");
    check_v(nm, res[1], 0x0BADC0DEu);

    blk_ldrd_off(BB + 896, res);
    nm0(nm, "block/ldrd_off_lo");
    check_v(nm, res[0], 0x13572468u);
    nm0(nm, "block/ldrd_off_hi");
    check_v(nm, res[1], 0x2468ACE0u);

    nb = blk_ldrd_wb(BB + 896, res);
    nm0(nm, "block/ldrd_wb_lo");
    check_v(nm, res[0], 0x13572468u);
    nm0(nm, "block/ldrd_wb_hi");
    check_v(nm, res[1], 0x2468ACE0u);
    nm0(nm, "block/ldrd_wb_b");
    check_v(nm, nb, BB + 896 + 8);

    /* strd stores an even pair {r2,r3} at addr+4/+8 (r2 = "hi" arg) */
    blk_strd(BB + 960, 0xDEADBEEFu, 0xCAFEBABEu);
    nm0(nm, "block/strd_hi");
    check_v(nm, op_ldr(BB + 964), 0xCAFEBABEu);
    nm0(nm, "block/strd_lo");
    check_v(nm, op_ldr(BB + 968), 0xDEADBEEFu);

    nb = blk_strd_wb(BB + 960, 0xFEEDFACEu, 0x5A5AA5A5u);
    nm0(nm, "block/strd_wb_hi");
    check_v(nm, op_ldr(BB + 964), 0x5A5AA5A5u);
    nm0(nm, "block/strd_wb_lo");
    check_v(nm, op_ldr(BB + 968), 0xFEEDFACEu);
    nm0(nm, "block/strd_wb_b");
    check_v(nm, nb, BB + 960 + 4);
}
