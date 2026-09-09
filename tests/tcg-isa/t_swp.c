/* SWP/SWPB (the ARMv5 atomics -> TCG cmpxchg path). */
#include "harness.h"
#include "ops.h"

#define SB 0x02020000u

extern uint32_t op_swp(uint32_t addr, uint32_t newval);
extern uint32_t op_swpb(uint32_t addr, uint32_t newval);

void t_swp(void)
{
    char nm[48];

    op_str(SB, 0x11223344u);
    uint32_t old = op_swp(SB, 0xCAFEBABEu);
    nm0(nm, "swp/old");
    check_v(nm, old, 0x11223344u);
    nm0(nm, "swp/mem");
    check_v(nm, op_ldr(SB), 0xCAFEBABEu);

    /* exchange chain */
    op_str(SB, 0x01020304u);
    uint32_t acc = 0;
    for (uint32_t i = 1; i <= 4; i++) {
        acc += op_swp(SB, i * 0x11111111u);
    }
    nm0(nm, "swp/chain");
    check_v(nm, acc, 0x01020304u + 0x11111111u + 0x22222222u + 0x33333333u);
    nm0(nm, "swp/chain_mem");
    check_v(nm, op_ldr(SB), 0x44444444u);

    /* byte form: bytes at SB+8..11 are DD CC BB AA (LE) */
    op_str(SB + 8, 0xAABBCCDDu);
    old = op_swpb(SB + 10, 0x5Eu);
    nm0(nm, "swpb/old");
    check_v(nm, old, 0xBBu);
    nm0(nm, "swpb/mem");
    check_v(nm, op_ldr(SB + 8), 0xAA5ECCDDu);
}
