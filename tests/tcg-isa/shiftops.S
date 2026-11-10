/* lsr/asr #32 immediate encodings (shift_imm = 0) — gas rejects "#32",
 * and .inst cannot take %[...] operands, so these are naked functions
 * with the r0->r0 / cpsr-out-at-[r1] ABI. */
.syntax unified
.arm

.global op_lsr32
op_lsr32:
    .inst 0xe1b00020          @ movs r0, r0, lsr #32  (rm = r0)
    mrs   r2, cpsr
    mov   r2, r2, lsr #28
    str   r2, [r1]
    bx    lr

.global op_asr32
op_asr32:
    .inst 0xe1b00040          @ movs r0, r0, asr #32  (rm = r0)
    mrs   r2, cpsr
    mov   r2, r2, lsr #28
    str   r2, [r1]
    bx    lr

/* A flag-setting register shift whose result feeds a 64-bit multiply or
 * an address in the same TB: the bits shifted out (lsl) or the sign
 * copies (asr) must not reach the consumer. The cmp
 * leaves the destination register as the only copy of the result. */
.global op_lsls_umulhi
op_lsls_umulhi:
    movs  r0, r0, lsl r1
    cmp   r1, #0
    umull r3, r12, r0, r2
    mov   r0, r12
    bx    lr

.global op_asrs_umulhi
op_asrs_umulhi:
    movs  r0, r0, asr r1
    cmp   r1, #0
    umull r3, r12, r0, r2
    mov   r0, r12
    bx    lr

.global op_lsls_ldr
op_lsls_ldr:
    movs  r0, r0, lsl r1
    cmp   r1, #0
    ldr   r0, [r0]
    bx    lr

.global op_lsls_str
op_lsls_str:
    movs  r0, r0, lsl r1
    cmp   r1, #0
    str   r2, [r0]
    bx    lr
