/* Mixed-size memory stress: an LCG-driven store pattern (byte/half/word
 * through the guest store ops), a full byte-image verification, a load
 * sweep over every width (incl. unaligned words) hashed with FNV-1a, and
 * an LDM/STM loop copying the region. All expectations are computed from
 * a plain C reference image. */
#include "harness.h"
#include "ops.h"

#define MS_BASE  0x01000000u
#define MS_BASE2 0x01100000u
#define MS_SIZE  16384u
#define NOPS     3000u

static uint8_t ms_ref[MS_SIZE];

static uint32_t lcg_state = 0xC0FFEE1u;

static uint32_t lcg_next(void)
{
    lcg_state = lcg_state * 1664525u + 1013904223u;
    return lcg_state;
}

static uint32_t fnv1a(uint32_t h, uint32_t b)
{
    h ^= b & 0xFFu;
    h *= 16777619u;
    return h;
}

static uint32_t ref_word_at(uint32_t i)
{
    return (uint32_t)ms_ref[i] | ((uint32_t)ms_ref[i + 1] << 8)
         | ((uint32_t)ms_ref[i + 2] << 16) | ((uint32_t)ms_ref[i + 3] << 24);
}

static uint32_t ref_half_at(uint32_t i)
{
    return (uint32_t)ms_ref[i] | ((uint32_t)ms_ref[i + 1] << 8);
}

/* ldm/stm copy of 16 bytes per iteration */
static void copy16(uint32_t s, uint32_t d)
{
    __asm__ volatile ("ldmia %[s], {r3-r6}\nstmia %[d], {r3-r6}"
                      :: [s] "r" (s), [d] "r" (d)
                      : "r3", "r4", "r5", "r6", "memory");
}

void t_memstress(void)
{
    char nm[48];
    uint32_t h, eh;

    /* initial image */
    for (uint32_t i = 0; i < MS_SIZE; i++) {
        ms_ref[i] = (uint8_t)(i * 31u + 7u);
        *(volatile uint8_t *)(MS_BASE + i) = ms_ref[i];
    }

    /* random store storm (aligned halves/words only; strb anywhere) */
    for (uint32_t n = 0; n < NOPS; n++) {
        uint32_t kind = lcg_next() % 3u;
        uint32_t idx = lcg_next() % (MS_SIZE - 4u);
        uint32_t val = lcg_next();

        if (kind == 0) {
            op_strb(MS_BASE + idx, val);
            ms_ref[idx] = (uint8_t)val;
        } else if (kind == 1) {
            if (idx & 1u) {
                continue;
            }
            op_strh(MS_BASE + idx, val);
            ms_ref[idx] = (uint8_t)val;
            ms_ref[idx + 1] = (uint8_t)(val >> 8);
        } else {
            if (idx & 3u) {
                continue;
            }
            op_str(MS_BASE + idx, val);
            ms_ref[idx] = (uint8_t)val;
            ms_ref[idx + 1] = (uint8_t)(val >> 8);
            ms_ref[idx + 2] = (uint8_t)(val >> 16);
            ms_ref[idx + 3] = (uint8_t)(val >> 24);
        }
    }

    /* byte image verification */
    h = 2166136261u;
    for (uint32_t i = 0; i < MS_SIZE; i++) {
        h = fnv1a(h, op_ldrb(MS_BASE + i));
    }
    eh = 2166136261u;
    for (uint32_t i = 0; i < MS_SIZE; i++) {
        eh = fnv1a(eh, ms_ref[i]);
    }
    nm0(nm, "stress/bytes");
    check_v(nm, h, eh);

    /* load sweep: every width, strided, incl. unaligned words (+1/+2/+3).
     * The ldrsh low byte mirrors the h-side guest op (sign extension does
     * not change the low byte, so the reference is the plain half byte). */
    h = 2166136261u;
    for (uint32_t i = 0; i < MS_SIZE; i += 7u) {
        h = fnv1a(h, op_ldrb(MS_BASE + i));
    }
    for (uint32_t i = 0; i + 2u <= MS_SIZE; i += 13u) {
        if (!(i & 1u)) {
            h = fnv1a(h, op_ldrh(MS_BASE + i));
            h = fnv1a(h, op_ldrsh(MS_BASE + i) & 0xFFu);
        }
    }
    for (uint32_t i = 0; i + 4u <= MS_SIZE; i += 17u) {
        if (!(i & 3u)) {
            h = fnv1a(h, op_ldr(MS_BASE + i));
        }
    }
    for (uint32_t d = 1; d <= 3; d++) {
        for (uint32_t i = 0; i + 4u + d <= MS_SIZE; i += 29u) {
            h = fnv1a(h, op_ldr(MS_BASE + i + d));
        }
    }
    eh = 2166136261u;
    for (uint32_t i = 0; i < MS_SIZE; i += 7u) {
        eh = fnv1a(eh, ms_ref[i]);
    }
    for (uint32_t i = 0; i + 2u <= MS_SIZE; i += 13u) {
        if (!(i & 1u)) {
            eh = fnv1a(eh, ref_half_at(i));
            eh = fnv1a(eh, ms_ref[i]);
        }
    }
    for (uint32_t i = 0; i + 4u <= MS_SIZE; i += 17u) {
        if (!(i & 3u)) {
            eh = fnv1a(eh, ref_word_at(i));
        }
    }
    for (uint32_t d = 1; d <= 3; d++) {
        for (uint32_t i = 0; i + 4u + d <= MS_SIZE; i += 29u) {
            eh = fnv1a(eh, ref_word_at(i + d));
        }
    }
    nm0(nm, "stress/loads");
    check_v(nm, h, eh);

    /* ldm/stm block copy, then hash the destination against the
     * reference byte image */
    for (uint32_t off = 0; off + 16u <= MS_SIZE; off += 16u) {
        copy16(MS_BASE + off, MS_BASE2 + off);
    }
    h = 2166136261u;
    for (uint32_t i = 0; i < MS_SIZE; i++) {
        h = fnv1a(h, op_ldrb(MS_BASE2 + i));
    }
    eh = 2166136261u;
    for (uint32_t i = 0; i < MS_SIZE; i++) {
        eh = fnv1a(eh, ms_ref[i]);
    }
    nm0(nm, "stress/copy");
    check_v(nm, h, eh);
}
