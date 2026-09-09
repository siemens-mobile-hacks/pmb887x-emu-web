/* Entry at 0x00010000 (qemu -kernel raw image). The qemu boot stub at 0x0
 * (r0=0, r1=0x183 board id, r2=0x100 atags) has already jumped here in SVC
 * mode. We just set up a stack, zero .bss, run the suite and exit through
 * the semihosting SYS_EXIT call (clean process exit on every backend). */
#include <stdint.h>

extern int tcgisa_main(void);
extern uint32_t __bss_start[], __bss_end[];

void suite_entry(void)
{
    /* SVC mode, IRQ+FIQ masked (no vector table installed), ARM state */
    __asm__ volatile ("msr cpsr_c, #0xd3" ::: "memory", "cc");
    /* stack top inside the 128 MiB SDRAM, far above the image */
    __asm__ volatile ("ldr sp, =0x00800000");

    for (uint32_t *p = __bss_start; p < __bss_end; p++) {
        *p = 0;
    }

    int fail = tcgisa_main();

    /* semihosting SYS_EXIT: reason ADP_Stopped_ApplicationExit -> exit(0);
     * any other reason makes qemu exit(1) — mirrors the suite verdict */
#ifdef TCGISA_NO_EXIT
    /* wasm-page variant: the semihosting exit path from the vCPU pthread
     * tears the page down before onExit can run — idle instead and let
     * the host-side runner collect the serial log */
    /* wait-for-interrupt (ARM926 CP15) then park */
    __asm__ volatile (
        "mcr p15, 0, r0, c7, c0, 4\n"
        "1: b 1b\n");
#else
    __asm__ volatile (
        "mov r0, #0x18\n"
        "mov r1, %[rc]\n"
        "svc 0x123456\n"
        :: [rc] "r" (fail ? 1u : 0x20026u)
        : "r0", "r1", "memory");
#endif

    for (;;) {
    }
}
