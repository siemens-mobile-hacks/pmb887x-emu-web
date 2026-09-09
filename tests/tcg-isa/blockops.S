/* LDM/STM/LDRD/STRD/SWP shims — register-list instructions can't be
 * expressed with gcc inline-asm operands, so these are small asm
 * functions. Only caller-saved registers are touched (r4 saved where a
 * 4th list register is needed); lr is never in any list.
 *
 *   blk_stm4_<mode>(base)            -> r0 = written-back base; stores 4
 *                                       known words {r1-r3, r12}
 *   blk_stm8(base)                   -> 8 words {r2-r9}, r0 = new base
 *   blk_ldm4_<mode>(src, res)        -> res[0..3] loaded, res[4] = new base
 *   blk_ldm8(src, res)               -> res[0..7] loaded, res[8] = new base
 *   blk_ldrd[_off|_wb](addr, res)    -> res[0..1] loaded (off/wb variants)
 *   blk_strd[_wb](addr, lo, hi)      -> stores the pair (+8 writeback)
 *   op_swp(addr, newval)             -> returns old, stores new
 *   op_swpb(addr, newval)            -> byte form */
.syntax unified
.arm

.macro STMCST4
    ldr   r1, =0x11223344
    ldr   r2, =0x55667788
    ldr   r3, =0x99AABBCC
    ldr   r12, =0xDDEEFF00
.endm

.global blk_stm4_ia
blk_stm4_ia:
    STMCST4
    stmia r0!, {r1-r3, r12}
    bx    lr

.global blk_stm4_ib
blk_stm4_ib:
    STMCST4
    stmib r0!, {r1-r3, r12}
    bx    lr

.global blk_stm4_da
blk_stm4_da:
    STMCST4
    stmda r0!, {r1-r3, r12}
    bx    lr

.global blk_stm4_db
blk_stm4_db:
    STMCST4
    stmdb r0!, {r1-r3, r12}
    bx    lr

/* ---- ldm variants: list is {r2-r4, r12} (r4 saved), res ptr stays r1 ---- */

.global blk_ldm4_ia_nwb
blk_ldm4_ia_nwb:                     @ r0 = src, r1 = res; no writeback
    push  {r4}
    ldmia r0, {r2-r4, r12}
    stmia r1, {r2-r4, r12}
    str   r0, [r1, #16]              @ res[4] = base (unchanged)
    pop   {r4}
    mov   r0, #0
    bx    lr

.global blk_ldm4_ia
blk_ldm4_ia:
    push  {r4}
    ldmia r0!, {r2-r4, r12}
    stmia r1, {r2-r4, r12}
    str   r0, [r1, #16]
    pop   {r4}
    mov   r0, #0
    bx    lr

.global blk_ldm4_ib
blk_ldm4_ib:
    push  {r4}
    ldmib r0!, {r2-r4, r12}
    stmia r1, {r2-r4, r12}
    str   r0, [r1, #16]
    pop   {r4}
    mov   r0, #0
    bx    lr

.global blk_ldm4_da
blk_ldm4_da:
    push  {r4}
    ldmda r0!, {r2-r4, r12}
    stmia r1, {r2-r4, r12}
    str   r0, [r1, #16]
    pop   {r4}
    mov   r0, #0
    bx    lr

.global blk_ldm4_db
blk_ldm4_db:
    push  {r4}
    ldmdb r0!, {r2-r4, r12}
    stmia r1, {r2-r4, r12}
    str   r0, [r1, #16]
    pop   {r4}
    mov   r0, #0
    bx    lr

.global blk_stm8
blk_stm8:                            @ r0 = dst -> r0 = new base
    push  {r4-r9}
    ldr   r2, =0x10101010
    ldr   r3, =0x20202020
    ldr   r4, =0x30303030
    ldr   r5, =0x40404040
    ldr   r6, =0x50505050
    ldr   r7, =0x60606060
    ldr   r8, =0x70707070
    ldr   r9, =0x80808080
    stmia r0!, {r2-r9}
    pop   {r4-r9}
    bx    lr

.global blk_ldm8
blk_ldm8:                            @ r0 = res, r1 = src
    push  {r4-r9}
    ldmia r1!, {r2-r9}
    stmia r0, {r2-r9}
    str   r1, [r0, #32]              @ res[8] = written-back base
    pop   {r4-r9}
    mov   r0, #0
    bx    lr

.global blk_ldrd
blk_ldrd:                            @ r0 = addr, r1 = res
    ldrd  r2, r3, [r0]
    stmia r1, {r2-r3}
    mov   r0, #0
    bx    lr

.global blk_ldrd_off
blk_ldrd_off:                        @ r0 = addr, r1 = res (loads at +8)
    ldrd  r2, r3, [r0, #8]
    stmia r1, {r2-r3}
    mov   r0, #0
    bx    lr

.global blk_ldrd_wb
blk_ldrd_wb:                         @ r0 = addr, r1 = res; r0 <- addr+8
    ldrd  r2, r3, [r0, #8]!
    stmia r1, {r2-r3}
    bx    lr

.global blk_strd
blk_strd:                            @ r0 = addr, r1 = lo, r2 = hi
    mov   r3, r1
    strd  r2, r3, [r0, #4]           @ even pair {r2,r3} at addr+4
    mov   r0, #0
    bx    lr

.global blk_strd_wb
blk_strd_wb:                         @ r0 = addr, r1 = lo, r2 = hi; r0 <- +8
    mov   r3, r1
    strd  r2, r3, [r0, #4]!          @ pair at addr+4, base <- addr+8
    bx    lr

.global op_swp
op_swp:                              @ r0 = addr, r1 = newval -> old in r0
    swp   r2, r1, [r0]
    mov   r0, r2
    bx    lr

.global op_swpb
op_swpb:
    swpb  r2, r1, [r0]
    mov   r0, r2
    bx    lr
