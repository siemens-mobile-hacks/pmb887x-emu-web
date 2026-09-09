/* Thumb-mode test bodies (the "second frontend"). Every function keeps
 * its result in r0 and — where the test cares — leaves the CPSR of its
 * last flag-setting instruction intact across the bx lr (bx/mov/ldr
 * don't touch flags), so the ARM-side driver can mrs it. The AAPCS gives
 * Thumb function pointers bit 0 set; the driver ORs it in anyway. */
.syntax unified
.thumb

.macro THFN name
    .global \name
    .thumb_func
\name:
.endm

THFN th_adds
    adds  r0, r0, r1
    bx    lr

THFN th_subs
    subs  r0, r0, r1
    bx    lr

THFN th_adcs
    adcs  r0, r1
    bx    lr

THFN th_sbcs
    sbcs  r0, r1
    bx    lr

THFN th_lsls
    lsls  r0, r1
    bx    lr

THFN th_asrs
    asrs  r0, r1
    bx    lr

THFN th_rors
    rors  r0, r1
    bx    lr

THFN th_muls
    muls  r0, r1
    bx    lr

THFN th_ldr_r
    ldr   r0, [r0, r1]
    bx    lr

THFN th_ldrb_i
    ldrb  r0, [r0, #7]
    bx    lr

THFN th_ldrh_i
    ldrh  r0, [r0, #6]
    bx    lr

THFN th_ldrsh_r
    ldrsh r0, [r0, r1]
    bx    lr

THFN th_ldrsb_r
    ldrsb r0, [r0, r1]
    bx    lr

THFN th_str_i
    str   r1, [r0, #8]
    movs  r0, #1
    bx    lr

THFN th_strh_i
    strh  r1, [r0, #10]
    movs  r0, #1
    bx    lr

THFN th_strb_i
    strb  r1, [r0, #12]
    movs  r0, #1
    bx    lr

/* push/pop (the Thumb LDM/STM forms) + pop {pc} interworking back to ARM */
THFN th_pushpop
    push  {r4, r5, lr}
    movs  r4, #0x44
    movs  r5, #0x55
    movs  r0, #0x66
    adds  r0, r4, r5
    pop   {r4, r5, pc}

/* Thumb -> ARM -> Thumb chain: direct BL to the ARM callee (the linker
 * inserts the v5T interwork veneer); returns through bx */
THFN th_call_arm
    push  {r3, lr}
    bl    arm_adds_callee
    adds  r0, r0, #0x11
    pop   {r3, pc}

/* Thumb -> Thumb call with a nested BL (exercises the Thumb long-branch
 * veneer and both BL/BX transitions) */
THFN th_callee2
    adds  r0, r0, #3
    bx    lr

THFN th_call_thumb
    push  {lr}
    bl    th_callee2
    adds  r0, r0, #0x22
    pop   {pc}

/* ARM-side callee for th_call_arm (STT_FUNC so the linker veneers the
 * thumb BL correctly) */
.arm
.global arm_adds_callee
.type arm_adds_callee, %function
arm_adds_callee:
    adds  r0, r0, #0x100
    bx    lr
