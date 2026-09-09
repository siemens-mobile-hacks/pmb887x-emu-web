/* clz (ARMv5TE). */
#include "harness.h"
#include "ops.h"

static const uint32_t vals[] = {
    0x00000000u, 0x00000001u, 0x00000002u, 0x000000FFu,
    0x00000100u, 0x00008000u, 0x00010000u, 0x7FFFFFFFu,
    0x80000000u, 0xFFFFFFFFu, 0x12345678u,
};

static uint32_t ref_clz(uint32_t v)
{
    uint32_t n = 0;
    for (int i = 31; i >= 0; i--) {
        if (v & (1u << i)) {
            break;
        }
        n++;
    }
    return n;
}

void t_clz(void)
{
    char nm[48];

    for (unsigned i = 0; i < sizeof(vals) / sizeof(vals[0]); i++) {
        nm1(nm, "clz/clz", vals[i]);
        check_v(nm, op_clz(vals[i]), ref_clz(vals[i]));
    }
}
