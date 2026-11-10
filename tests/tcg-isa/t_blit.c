/* The firmware's colour-keyed blit loop (blitops.S) against a C model:
 * every pixel class, scaled, mirrored and zero steps, page crossings,
 * more passes than one helper call takes, overlapping buffers. */
#include "harness.h"

#define BA 0x02040000u      /* the guest's buffers */
#define BM 0x02060000u      /* the model's, laid out alike */
#define BLEN 0x8000u

struct blit_args {
    uint32_t key, dst, src, sstep, dstep, count, r4;
    uint32_t r[5];          /* r1-r5 afterwards */
};

extern void blit_run(struct blit_args *a);

static void blit_model(struct blit_args *a)
{
    uint32_t r1 = 0, r2 = a->dst, r3 = a->src, r4 = a->r4, r5 = a->count;

    while (r5 != 0) {
        r1 = *(volatile uint16_t *)r3;
        if (r1 != a->key) {
            if (r1 == 0xe000u) {
                r4 = 0x12345678u;
            } else if (r1 == 1) {
                r4 = 33;
            } else {
                r4 = r1;
            }
            *(volatile uint16_t *)r2 = (uint16_t)r4;
        }
        r1 = a->dstep;
        r3 += a->sstep;
        r2 += r1;
        r5--;
    }
    a->r[0] = r1;
    a->r[1] = r2;
    a->r[2] = r3;
    a->r[3] = r4;
    a->r[4] = r5;
}

static void blit_seed(uint32_t base, uint32_t seed)
{
    volatile uint16_t *p = (volatile uint16_t *)base;

    for (uint32_t i = 0; i < BLEN / 2; i++) {
        uint32_t v;

        seed = seed * 1664525u + 1013904223u;
        v = seed >> 16;
        switch ((seed >> 8) & 7) {
        case 0:
        case 1:
            v = 0xf81fu;    /* the key most cases use */
            break;
        case 2:
            v = 0xe000u;
            break;
        case 3:
            v = 1;
            break;
        }
        p[i] = (uint16_t)v;
    }
}

static uint32_t blit_hash(uint32_t base)
{
    const volatile uint16_t *p = (const volatile uint16_t *)base;
    uint32_t h = 0x811c9dc5u;

    for (uint32_t i = 0; i < BLEN / 2; i++) {
        h = (h ^ p[i]) * 0x01000193u;
    }
    return h;
}

static const struct {
    uint32_t key, dst, src;     /* offsets into the buffer */
    int32_t sstep, dstep;
    uint32_t count;
} cases[] = {
    { 0xf81f, 0x4000, 0x0000, 2, 2, 1 },
    { 0xf81f, 0x4000, 0x0000, 2, 2, 2 },
    { 0xf81f, 0x4000, 0x0000, 2, 2, 3 },
    { 0xf81f, 0x4000, 0x0000, 2, 2, 100 },
    { 0xf81f, 0x4000, 0x0ff0, 2, 2, 100 },          /* source page */
    { 0xf81f, 0x4fe2, 0x0000, 2, 2, 100 },          /* destination page */
    { 0xf81f, 0x4000, 0x0000, 2, 2, 6000 },         /* past one call */
    { 0xf81f, 0x4000, 0x0000, 4, 2, 2000 },
    { 0xf81f, 0x4000, 0x0000, 2, 6, 1000 },
    { 0xf81f, 0x4000, 0x0000, 0, 2, 300 },
    { 0xf81f, 0x4000, 0x0000, 2, 0, 300 },
    { 0xf81f, 0x4000, 0x2ffe, -2, 2, 5000 },        /* mirrored */
    { 0xf81f, 0x6ffe, 0x0000, 2, -2, 5000 },
    { 0xf81f, 0x6ffe, 0x2ffe, -6, -4, 1500 },
    { 0xf81f, 0x1002, 0x1000, 2, 2, 3000 },         /* smears forward */
    { 0xf81f, 0x1000, 0x1002, 2, 2, 3000 },
    { 0xf81f, 0x1000, 0x1000, 2, 2, 3000 },
    { 0xf81f, 0x1004, 0x1000, 2, 4, 1000 },
    { 0xe000, 0x4000, 0x0000, 2, 2, 3000 },         /* the key first */
    { 0x0001, 0x4000, 0x0000, 2, 2, 3000 },
    { 0x1f81f, 0x4000, 0x0000, 2, 2, 3000 },        /* no pixel matches */
    { 0xf81f, 0x4000, 0x0000, 3, 2, 300 },          /* unaligned loads */
    { 0xf81f, 0x4001, 0x0000, 2, 2, 300 },          /* unaligned stores */
};

void t_blit(void)
{
    char nm[48];

    for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        struct blit_args g = {
            .key = cases[i].key,
            .dst = BA + cases[i].dst,
            .src = BA + cases[i].src,
            .sstep = (uint32_t)cases[i].sstep,
            .dstep = (uint32_t)cases[i].dstep,
            .count = cases[i].count,
            .r4 = 0xdeadbeefu + i,
        };
        struct blit_args m = g;

        m.dst = BM + cases[i].dst;
        m.src = BM + cases[i].src;
        blit_seed(BA, i + 1);
        blit_seed(BM, i + 1);
        blit_run(&g);
        blit_model(&m);

        nm1(nm, "blit/r1", i);
        check_v(nm, g.r[0], m.r[0]);
        nm1(nm, "blit/r2", i);
        check_v(nm, g.r[1] - BA, m.r[1] - BM);
        nm1(nm, "blit/r3", i);
        check_v(nm, g.r[2] - BA, m.r[2] - BM);
        nm1(nm, "blit/r4", i);
        check_v(nm, g.r[3], m.r[3]);
        nm1(nm, "blit/r5", i);
        check_v(nm, g.r[4], m.r[4]);
        nm1(nm, "blit/mem", i);
        check_v(nm, blit_hash(BA), blit_hash(BM));
    }
}
