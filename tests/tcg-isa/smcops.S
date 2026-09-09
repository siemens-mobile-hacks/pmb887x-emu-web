/* Self-modifying-code targets. The image runs from SDRAM (qemu -kernel
 * loads it into RAM at 0x00010000), so guest stores can patch code pages
 * and exercise the TCG invalidation paths:
 *
 *  - smc_target: cross-TB SMC — the patching store executes in a
 *    different TB than the patched instruction (patch from C, call again).
 *  - smc_self:   same-TB SMC — the store modifies the *next* instruction
 *    of its own basic block; qemu must catch the write to the currently
 *    executing TB and re-translate (cpu_io_recompile) instead of running
 *    the stale translated insn. r0 = replacement instruction word. */
.syntax unified
.arm

.global smc_target
smc_target:
    mov   r0, #0x5A
    bx    lr

.global smc_self
smc_self:
    ldr   r1, =smc_slot
    str   r0, [r1]
    .global smc_slot
smc_slot:
    mov   r0, #0x5A
    bx    lr
