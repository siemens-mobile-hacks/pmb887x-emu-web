/* tcg-isa harness: TAP reporting + value/flags dump lines over PL011 UART0.
 *
 * Output contract (byte-exact across backends — the phase-0a gate diffs
 * the whole stream):
 *   ok n - name            /  not ok n - name          (TAP verdicts)
 *   # name: v=XXXXXXXX f=NZCV                           (machine diff dump)
 *   1..N  /  # result: pass=P fail=F                    (trailing plan)
 * Flag bits not covered by a test's oracle (architecturally unpredictable,
 * e.g. C/V after MUL on ARMv5) are dumped as '-'. */
#ifndef TCGISA_HARNESS_H
#define TCGISA_HARNESS_H

#include <stdint.h>

/* flag packing in the 4-bit words used everywhere below (CPSR order) */
#define F_N 8u
#define F_Z 4u
#define F_C 2u
#define F_V 1u
#define F_NZ (F_N | F_Z)
#define F_NZCV 15u

extern unsigned suite_pass, suite_fail;

void uart_puts(const char *s);
void suite_plan(void);

/* value + selected flags (fmask = which of NZCV the oracle covers) */
void check_vf(const char *name, uint32_t got_v, uint32_t got_f,
              uint32_t exp_v, uint32_t exp_f, uint32_t fmask);
/* value only */
void check_v(const char *name, uint32_t got_v, uint32_t exp_v);
/* value + Q (saturation) flag */
void check_vq(const char *name, uint32_t got_v, uint32_t got_q,
              uint32_t exp_v, uint32_t exp_q);

/* name builders (buf >= 48 bytes); hex components are 8 digits */
void nm0(char *buf, const char *op);
void nm1(char *buf, const char *op, uint32_t a);
void nm2(char *buf, const char *op, uint32_t a, uint32_t b);
void nm3(char *buf, const char *op, uint32_t a, uint32_t b, uint32_t c);

#endif
