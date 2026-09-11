/* tcgbench — bare-metal ARM926EJ-S backend benchmark (versatilepb).
 *
 * Fast iteration for the wasm64 TCG backend (doc/wasm-tcg-backend-plan.md,
 * phase 3+): fixed hot-loop phases that hit the backend's per-op paths
 * directly, on the same machine/boot path as the phase-0a op-suite
 * (-M versatilepb, -kernel, PL011 UART0, seconds per run) instead of the
 * 80 s+ phone-firmware boots, which stay the final gates.
 *
 * Host-side timing: the runner timestamps each phase's serial line
 * (native: -serial stdio streaming; wasm: /serial.log polling), so the
 * guest only prints; the per-phase checksum defeats dead-code elimination
 * and cross-checks backends (identical cksum = same values executed).
 *
 * Phases (shape comments say which backend path they stress):
 *   alu      - register arithmetic/logic chains, no memory (locals/SSA)
 *   mul      - mla/umull chains (mulu2/muls2 paths)
 *   ldst     - load/store loop over a 64 KiB array, word+half+byte
 *              (inline TLB hit path, size-specialized accesses)
 *   ldrd     - ldrd/strd + unaligned ldr/str (the 64-bit/subalign arms)
 *   branch   - short data-dependent branchy loop (goto_tb chaining both
 *              directions, short TBs — the firmware's shape)
 *   mix      - branch + load + rare MMIO poll + arithmetic (approximates
 *              the idle poll loop: chained TBs + TLB-miss MMIO reads)
 *
 * Output contract (byte-exact across backends):
 *   BENCH begin
 *   BENCH <phase> n=<iters> ck=<8hex>
 *   BENCH done cksum=<8hex>
 *   BENCH DONE                     (trailing sentinel for the runner)
 */
#include <stdint.h>

/* PL011 UART0 on -M versatilepb (0x101f1000; qemu drains DR writes with
 * no init).  FR bit 5 = TX FIFO empty (the mix phase polls it as its
 * stand-in for a firmware MMIO register). */
#define UART0_DR (*(volatile uint32_t *)0x101F1000u)
#define UART0_FR (*(volatile uint32_t *)0x101F1018u)

/* Iteration scale: the defaults target roughly 1 s per phase on the
 * native JIT (~50 MIPS).  Build with -DITERS_DIV=n to shrink every
 * phase n-fold (smoke runs). */
#ifndef ITERS_DIV
#define ITERS_DIV 1
#endif
#define IT(n) ((uint32_t)((n) / ITERS_DIV))

static void uputc(char c) { UART0_DR = (uint32_t)(unsigned char)c; }

static void uart_puts(const char *s)
{
    while (*s) {
        uputc(*s++);
    }
}

static void uputhex8(uint32_t v)
{
    static const char H[] = "0123456789abcdef";
    for (int i = 7; i >= 0; i--) {
        uputc(H[(v >> (i * 4)) & 0xf]);
    }
}

static void uputdec(uint32_t n)
{
    /* decimal via shifts only (arm926 has no divide) */
    char b[12];
    int i = 0;
    if (!n) {
        uputc('0');
        return;
    }
    while (n) {
        b[i++] = (char)('0' + (n % 10));
        n /= 10;
    }
    while (i) {
        uputc(b[--i]);
    }
}

/* ---- checksum state (kept live across phases; printed at the end) ---- */
static uint32_t cksum = 0x12345678u;

static void phase_header(const char *name, uint32_t n)
{
    uart_puts("BENCH ");
    uart_puts(name);
    uart_puts(" n=");
    uputdec(n);
    uart_puts(" ck=");
}

static void phase_footer(void)
{
    uputhex8(cksum);
    uputc('\n');
}

/* ---- phases --------------------------------------------------------- */

/* alu: dependent add/sub/logic chains.  No memory traffic; every value
 * is loop-carried, so every op's result feeds the next TB's inputs. */
static void phase_alu(void)
{
    uint32_t n = IT(100000000u);
    uint32_t a = 0x13579bdfu, b = 0x2468ace0u, c = 0x0f0f0f0fu, d = 1;

    phase_header("alu", n);
    for (uint32_t i = 0; i < n; i++) {
        a += b;
        b ^= a >> 3;
        c -= d;
        d = (d << 1) | (d >> 31);
        a ^= c;
        c += b >> 5;
        b -= a & 0x1f1f1f1fu;
        a += i;
    }
    cksum += a + b + c + d;
    phase_footer();
}

/* mul: mla + umull chains (64-bit products feed back as 32-bit pairs). */
static void phase_mul(void)
{
    uint32_t n = IT(60000000u);
    uint32_t x = 0xdeadbeefu, y = 0x0badf00du, acc = 0;

    phase_header("mul", n);
    for (uint32_t i = 0; i < n; i++) {
        uint64_t p = (uint64_t)x * (uint64_t)y;
        acc = (uint32_t)(acc + (uint32_t)p ^ (uint32_t)(p >> 32));
        x = x * 3u + 1u;
        y ^= (uint32_t)p >> 7;
    }
    cksum += acc + x + y;
    phase_footer();
}

/* ldst: word/half/byte load-store sweep over a 64 KiB array (fits well
 * inside the TLB; exercises the inline probe + size-specialized hits). */
static uint32_t buf[16384]; /* 64 KiB */

static void phase_ldst(void)
{
    uint32_t n = IT(30000000u);
    uint32_t s = 0x23456789u;

    phase_header("ldst", n);
    for (uint32_t i = 0; i < n; i++) {
        uint32_t j = i & 16383u;
        uint32_t v = buf[j];
        buf[j] = v + s;
        *(volatile uint16_t *)((char *)buf + ((j * 2) & 65534)) =
            (uint16_t)(v >> 16);
        s += *(volatile uint8_t *)((char *)buf + (j & 65535));
        s = (s << 1) | (s >> 31);
    }
    cksum += s + buf[0] + buf[16383];
    phase_footer();
}

/* ldrd: ldrd/strd pairs + unaligned word accesses (the 64-bit and
 * natural-LE unaligned arms of the inline TLB path). */
static void phase_ldrd(void)
{
    uint32_t n = IT(20000000u);
    uint64_t acc = 0;

    phase_header("ldrd", n);
    for (uint32_t i = 0; i < n; i++) {
        uint64_t v64;
        uint32_t *p = &buf[i & 16382u]; /* 8-aligned pairs */
        __asm__ volatile ("ldrd %0, %H0, [%1]" : "=r"(v64) : "r"(p) : "memory");
        acc += v64;
        v64 += i;
        __asm__ volatile ("strd %0, %H0, [%1]" :: "r"(v64), "r"(p) : "memory");
        /* unaligned word load: armv5 qemu semantics = natural LE load */
        uint32_t u = *(uint32_t *)((char *)buf + ((i * 4 + 1) & 65535));
        acc ^= u;
    }
    cksum += (uint32_t)acc ^ (uint32_t)(acc >> 32);
    phase_footer();
}

/* branch: data-dependent short branches — the firmware's TB shape
 * (3-4 insn TBs, taken + untaken goto_tb both hot). */
static uint32_t btab[64];

static void phase_branch(void)
{
    uint32_t n = IT(150000000u);
    uint32_t x = 7, h = 0;

    phase_header("branch", n);
    for (uint32_t i = 0; i < n; i++) {
        uint32_t j = i & 63u;
        x = (x * 1103515245u) + 12345u;
        if (x & 0x80000000u) {
            h += btab[j];
        } else if (x & 0x40000000u) {
            h ^= btab[(j + 1) & 63u];
        } else if (x & 1u) {
            h = (h << 3) | (h >> 29);
        } else {
            h -= j;
        }
    }
    cksum += h + x;
    phase_footer();
}

/* mix: the idle-poll shape — branchy loop, light SRAM traffic, and a
 * rare MMIO read (UART FR) that always takes the TLB-miss/helper path,
 * like the firmware's device polls. */
static void phase_mix(void)
{
    uint32_t n = IT(40000000u);
    uint32_t a = 0xabcdef01u, b = 0x12345678u, h = 0;

    phase_header("mix", n);
    for (uint32_t i = 0; i < n; i++) {
        uint32_t j = i & 16383u;
        a = (a << 7) | (a >> 25);
        b += a;
        if (b & 0x00800000u) {
            h += buf[j];
        } else {
            h ^= b >> 16;
        }
        if ((i & 0xffffu) == 0xffffu) {
            /* poll the UART flag register (MMIO): TXFE is set whenever
             * nothing is mid-print — same shape as a device status poll */
            if (UART0_FR & 0x20u) {
                h += 1;
            }
        }
    }
    cksum += h + a + b;
    phase_footer();
}

/* ---- device/icount tax mirrors (same loop body, SRAM vs MMIO) ----
 *
 * rampoll and mmiopoll are written to compile to the SAME instruction
 * sequence (4 volatile reads + 4 conditional updates per iteration);
 * only the addresses differ.  The per-access cost delta IS the
 * device-dispatch tax (TLB-miss helper -> memory.c FlatView dispatch ->
 * device callback).  All four MMIO registers are inert reads:
 *   UART0 FR   0x101f1018  PL011 flags (TXFE set, no side effects)
 *   sysctl ID  0x10000000  V2P-Bus sysreg ID (read-only)
 *   VIC status 0x10140000  PL190 IRQStatus (0 with IRQs masked)
 *   SP804 val  0x101e2004  timer1 value (timer never started)
 * mmiow writes timer1 control=0 (already the reset state — inert) and
 * reads it back: the write side of the same dispatch path.
 *
 * Iteration counts differ between the mirrors (RAM is ~2 orders faster
 * per access); the runner reports ns/access per phase, so the mirrors
 * compare per-access, not per-phase. */
static volatile uint32_t pollram[16];  /* 4 words used; volatile: keep
 * the loads in the loop (gcc hoists them otherwise — the phase would
 * measure pure ALU, not RAM polling) */

#define MMIO_UART_FR  (*(volatile uint32_t *)0x101F1018u)
#define MMIO_SYS_ID   (*(volatile uint32_t *)0x10000000u)
#define MMIO_VIC_STAT (*(volatile uint32_t *)0x10140000u)
#define MMIO_SP804_V  (*(volatile uint32_t *)0x101E2004u)
#define MMIO_SP804_C  (*(volatile uint32_t *)0x101E2008u)

static void phase_rampoll(void)
{
    uint32_t n = IT(48000000u);
    uint32_t h = 0;

    pollram[0] = 0x20u;                 /* TXFE-like constants so the */
    pollram[1] = 0x41001174u;           /* branch pattern matches too */
    pollram[2] = 0u;
    pollram[3] = 0xffffffffu;

    phase_header("rampoll", n);
    for (uint32_t i = 0; i < n; i++) {
        uint32_t v0 = pollram[0];
        uint32_t v1 = pollram[1];
        uint32_t v2 = pollram[2];
        uint32_t v3 = pollram[3];
        if (v0 & 0x20u) h += 1;
        if (v1 & 0x10u) h ^= v1 >> 4;
        if (v2)         h -= 2;
        if (v3 & 1u)    h += 3;
        (void)i;
    }
    cksum += h;
    phase_footer();
}

static void phase_mmiopoll(void)
{
    uint32_t n = IT(1500000u);
    uint32_t h = 0;

    phase_header("mmiopoll", n);
    for (uint32_t i = 0; i < n; i++) {
        uint32_t v0 = MMIO_UART_FR;
        uint32_t v1 = MMIO_SYS_ID;
        uint32_t v2 = MMIO_VIC_STAT;
        uint32_t v3 = MMIO_SP804_V;
        if (v0 & 0x20u) h += 1;
        if (v1 & 0x10u) h ^= v1 >> 4;
        if (v2)         h -= 2;
        if (v3 & 1u)    h += 3;
    }
    cksum += h;
    phase_footer();
}

static void phase_mmiow(void)
{
    uint32_t n = IT(1000000u);
    uint32_t h = 0;

    phase_header("mmiow", n);
    for (uint32_t i = 0; i < n; i++) {
        MMIO_SP804_C = 0u;               /* control=0: disabled (reset state) */
        uint32_t v = MMIO_SP804_C;
        if (v & 0x80u) h += 1;           /* enabled bit: never set */
        h += v & 1u;
    }
    cksum += h;
    phase_footer();
}

int bench_main(void)
{
    uart_puts("BENCH begin\n");
    phase_alu();
    phase_mul();
    phase_ldst();
    phase_ldrd();
    phase_branch();
    phase_mix();
    phase_rampoll();
    phase_mmiopoll();
    phase_mmiow();
    uart_puts("BENCH done cksum=");
    uputhex8(cksum);
    uart_puts("\nBENCH DONE\n");
    return 0;
}
