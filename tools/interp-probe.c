/*
 * What does a TCI-shaped interpreter cost in wasm, relative to native?
 *
 *   gcc  -O2 tools/interp-probe.c -o /tmp/interp-native && /tmp/interp-native
 *   emcc -O3 tools/interp-probe.c -o /tmp/interp.js -sENVIRONMENT=node && node /tmp/interp.js
 *
 * The interpreter tier's whole cost is "how much slower is an interpreted
 * guest instruction than a compiled one".  Natively that ratio is directly
 * measurable -- EL71 runs 131.1 MIPS on the JIT and 21.4 MIPS on TCI, 6.13x
 * -- but it does not transfer to the browser unchanged, because the two
 * sides land in different places there: emitted TB code runs in V8's
 * *baseline* tier while a C interpreter in the main module runs *optimized*.
 *
 * So this measures the one missing factor: the same interpreter loop,
 * compiled native and compiled to wasm.  Shape copied from tcg/tci.c --
 * a byte opcode, a switch the compiler turns into a jump table, operands
 * decoded out of the stream, a register file, and a mix of ALU / branch /
 * load / store / call ops in roughly TCG's proportions so the branch
 * predictor sees a realistic op sequence.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum {
    OP_MOV, OP_ADD, OP_SUB, OP_AND, OP_OR, OP_XOR, OP_SHL, OP_SHR,
    OP_MOVI, OP_LD, OP_ST, OP_BRCOND, OP_SETCOND, OP_CALL, OP_EXIT,
    OP_N
};

/* op frequencies, taken from the round-21 TCG histogram (mov 6.3/TB,
 * add 4.2/TB, qemu_ld/st ~1.7/TB, brcond, goto_tb) */
static const uint8_t MIX[] = {
    OP_MOV, OP_MOV, OP_MOV, OP_MOV, OP_MOV, OP_MOV,
    OP_ADD, OP_ADD, OP_ADD, OP_ADD,
    OP_SUB, OP_AND, OP_OR, OP_XOR, OP_SHL, OP_SHR,
    OP_MOVI, OP_MOVI, OP_MOVI,
    OP_LD, OP_ST,
    OP_SETCOND, OP_BRCOND,
    OP_CALL,
};

#define NREG   32
#define MEMW   4096
#define PROG   (1 << 20)

static uint64_t regs[NREG];
static uint64_t mem[MEMW];
static uint8_t prog[PROG];

static uint64_t helper_call(uint64_t a)
{
    return a * 2654435761u + 1;
}

/*
 * One "TB" is TBLEN ops ending in OP_EXIT; the driver re-enters at a
 * pseudo-random TB each time, the way the dispatcher does.
 */
#define TBLEN  22

static uint64_t run(const uint8_t *p)
{
    uint64_t acc = 0;

    for (;;) {
        uint8_t op = *p++;
        uint8_t a = *p++, b = *p++, c = *p++;

        switch (op) {
        case OP_MOV:  regs[a] = regs[b]; break;
        case OP_ADD:  regs[a] = regs[b] + regs[c]; break;
        case OP_SUB:  regs[a] = regs[b] - regs[c]; break;
        case OP_AND:  regs[a] = regs[b] & regs[c]; break;
        case OP_OR:   regs[a] = regs[b] | regs[c]; break;
        case OP_XOR:  regs[a] = regs[b] ^ regs[c]; break;
        case OP_SHL:  regs[a] = regs[b] << (regs[c] & 63); break;
        case OP_SHR:  regs[a] = regs[b] >> (regs[c] & 63); break;
        case OP_MOVI: regs[a] = (uint64_t)b << 8 | c; break;
        case OP_LD:   regs[a] = mem[(regs[b] + c) & (MEMW - 1)]; break;
        case OP_ST:   mem[(regs[b] + c) & (MEMW - 1)] = regs[a]; break;
        case OP_SETCOND: regs[a] = regs[b] < regs[c]; break;
        case OP_BRCOND:
            if (regs[b] & 1) {
                p += 4;                 /* skip one op, like a taken brcond */
            }
            break;
        case OP_CALL: regs[a] = helper_call(regs[b]); break;
        case OP_EXIT: return acc + regs[0];
        default: abort();
        }
        acc++;
    }
}

static uint64_t now_ns(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000000u + t.tv_nsec;
}

int main(int argc, char **argv)
{
    uint64_t iters = argc > 1 ? strtoull(argv[1], NULL, 0) : 2000000;
    unsigned ntb = PROG / ((TBLEN + 1) * 4);
    uint64_t seed = 12345, t0, t1, sink = 0, ops;
    unsigned i, j;

    for (i = 0; i < ntb; i++) {
        uint8_t *p = prog + i * (TBLEN + 1) * 4;
        for (j = 0; j < TBLEN; j++) {
            seed = seed * 6364136223846793005u + 1442695040888963407u;
            p[j * 4 + 0] = MIX[(seed >> 33) % (sizeof(MIX))];
            p[j * 4 + 1] = (seed >> 13) % NREG;
            p[j * 4 + 2] = (seed >> 21) % NREG;
            p[j * 4 + 3] = (seed >> 29) % NREG;
        }
        p[TBLEN * 4] = OP_EXIT;
    }
    for (i = 0; i < NREG; i++) {
        regs[i] = i * 7 + 1;
    }

    for (i = 0; i < 200000; i++) {          /* warm */
        sink += run(prog + (i % ntb) * (TBLEN + 1) * 4);
    }
    t0 = now_ns();
    for (i = 0; i < iters; i++) {
        seed = seed * 6364136223846793005u + 1442695040888963407u;
        sink += run(prog + ((seed >> 33) % ntb) * (TBLEN + 1) * 4);
    }
    t1 = now_ns();
    ops = (uint64_t)iters * TBLEN;
    printf("entries=%llu ops=%llu  %.2f ns/op  %.1f ns/TB-entry  (sink %llu)\n",
           (unsigned long long)iters, (unsigned long long)ops,
           (double)(t1 - t0) / (double)ops,
           (double)(t1 - t0) / (double)iters,
           (unsigned long long)sink);
    return 0;
}
