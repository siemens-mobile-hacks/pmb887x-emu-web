/* cmp + conditional mov: one function per condition code.
 *
 * ABI: r0 = a, r1 = b, r2 = pointer to the CPSR result. Returns 1/0 in r0
 * per the condition, with the CPSR of the cmp captured before any
 * flag-clean instruction runs. This is the guest-side producer of TCG
 * setcond/brcond ops (ARMv5 has no CSEL/movlt-immediate — the pattern
 * compilers emit is exactly cmp + conditional mov). */
.syntax unified
.arm

.macro CONDFN cc
    .global cond_\cc
cond_\cc:
    mov   r12, #0
    cmp   r0, r1
    mov\cc r12, #1
    mrs   r3, cpsr
    mov   r3, r3, lsr #28   @ keep the 4-bit NZCV word
    str   r3, [r2]
    mov   r0, r12
    bx    lr
.endm

CONDFN eq
CONDFN ne
CONDFN cs
CONDFN cc
CONDFN mi
CONDFN pl
CONDFN vs
CONDFN vc
CONDFN hi
CONDFN ls
CONDFN ge
CONDFN lt
CONDFN gt
CONDFN le
