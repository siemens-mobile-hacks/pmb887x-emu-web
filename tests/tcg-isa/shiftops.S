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
