/* The Siemens colour-keyed blit loop (S75 a0a05538, EL71 a0a16888), byte
 * for byte from the head on, so the loop starts a TB as it does in the
 * firmware: target/arm/tcg/w64-fill.c runs its passes in C on the wasm64
 * backend.  blit_run(args) loads the registers from, and stores r1-r5
 * back into, the words t_blit.c lays out. */
.syntax unified
.thumb

    .global blit_run
    .thumb_func
blit_run:
    push  {r4, r5, r6, r7, lr}
    sub   sp, #48
    str   r0, [sp, #0]
    ldr   r1, [r0, #16]
    str   r1, [sp, #44]
    ldr   r1, [r0, #12]
    mov   ip, r1
    ldr   r1, [r0, #20]
    mov   lr, r1
    ldr   r2, [r0, #4]
    ldr   r3, [r0, #8]
    ldr   r4, [r0, #24]
    ldr   r0, [r0, #0]

    movs  r7, #7
    lsls  r7, r7, #13
    mov   r5, lr
    b     2f
1:  ldrh  r1, [r3]
    cmp   r1, r0
    beq   4f
    ldr   r4, blit_colour
    cmp   r1, r7
    beq   3f
    movs  r4, #33
    cmp   r1, #1
    beq   3f
    adds  r4, r1, #0
3:  strh  r4, [r2]
4:  ldr   r1, [sp, #44]
    add   r3, ip
    adds  r2, r1, r2
    subs  r5, #1
2:  cmp   r5, #0
    bne   1b

    ldr   r0, [sp, #0]
    str   r1, [r0, #28]
    str   r2, [r0, #32]
    str   r3, [r0, #36]
    str   r4, [r0, #40]
    str   r5, [r0, #44]
    add   sp, #48
    pop   {r4, r5, r6, r7, pc}

    .balign 4
blit_colour:
    .word 0x12345678
