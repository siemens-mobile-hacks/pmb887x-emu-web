/* Entry at 0x00010000 (qemu -kernel raw image; qemu's 0x0 boot stub has
 * already jumped here in SVC mode with r0=0/r1=0x183/r2=0x100).  Same
 * conventions as tests/tcg-isa/startup.c: SVC mode, IRQ+FIQ masked,
 * stack at 0x00800000, zero .bss, run, then semihosting SYS_EXIT —
 * except the wasm variant parks (the wasm pthread runtime cannot take
 * the exit path; the runner reads /serial.log instead). */
#include <stdint.h>

extern int bench_main(void);
extern uint32_t __bss_start[], __bss_end[];

void bench_entry(void)
{
    __asm__ volatile ("msr cpsr_c, #0xd3" ::: "memory", "cc");
    __asm__ volatile ("ldr sp, =0x00800000");

    for (uint32_t *p = __bss_start; p < __bss_end; p++) {
        *p = 0;
    }

    bench_main();

#ifdef TCGBENCH_NO_EXIT
    __asm__ volatile (
        "mcr p15, 0, r0, c7, c0, 4\n"
        "1: b 1b\n");
#else
    {
        uint32_t rc = 0x20026u;   /* ADP_Stopped_ApplicationExit */
        __asm__ volatile (
            "mov r0, #0x18\n"
            "mov r1, %[rc]\n"
            "svc 0x123456\n"
            :: [rc] "r" (rc)
            : "r0", "r1", "memory");
    }
#endif

    for (;;) {
    }
}
