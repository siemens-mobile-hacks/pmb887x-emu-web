#include "harness.h"

unsigned suite_pass, suite_fail;
static unsigned suite_n;

static void put_f(uint32_t mask, uint32_t f)
{
    /* dump one NZCV char: '0'/'1' when the oracle covers it, '-' when the
     * bit is architecturally unpredictable for this op */
    for (int i = 3; i >= 0; i--) {
        uint32_t bit = 1u << i;
        if (mask & bit) {
            uputc((char)('0' + ((f & bit) != 0)));
        } else {
            uputc('-');
        }
    }
}

/* "ok N - name" (or "not ok"), then the dump line up to its value; the
 * caller appends its flag field and the newline */
static void report(const char *name, unsigned ok, uint32_t got_v)
{
    suite_n++;
    uart_puts(ok ? "ok " : "not ok ");
    uputdec(suite_n);
    uart_puts(" - ");
    uart_puts(name);
    uputc('\n');

    uart_puts("# ");
    uart_puts(name);
    uart_puts(": v=");
    uputhex8(got_v);
}

static void report_expected(uint32_t exp_v)
{
    uart_puts("#   expected v=");
    uputhex8(exp_v);
}

static void tally(unsigned ok)
{
    if (ok) {
        suite_pass++;
    } else {
        suite_fail++;
    }
}

void check_vf(const char *name, uint32_t got_v, uint32_t got_f,
              uint32_t exp_v, uint32_t exp_f, uint32_t fmask)
{
    unsigned ok = (got_v == exp_v) && ((got_f ^ exp_f) & fmask) == 0;

    report(name, ok, got_v);
    uart_puts(" f=");
    put_f(fmask, got_f);
    uputc('\n');
    if (!ok) {
        report_expected(exp_v);
        uart_puts(" f=");
        put_f(fmask, exp_f);
        uputc('\n');
    }
    tally(ok);
}

void check_v(const char *name, uint32_t got_v, uint32_t exp_v)
{
    check_vf(name, got_v, 0, exp_v, 0, 0);
}

void check_vq(const char *name, uint32_t got_v, uint32_t got_q,
              uint32_t exp_v, uint32_t exp_q)
{
    unsigned ok = (got_v == exp_v) && (got_q == exp_q);

    report(name, ok, got_v);
    uart_puts(" q=");
    uputc((char)('0' + (got_q != 0)));
    uputc('\n');
    if (!ok) {
        report_expected(exp_v);
        uart_puts(" q=");
        uputc((char)('0' + (exp_q != 0)));
        uputc('\n');
    }
    tally(ok);
}

void suite_plan(void)
{
    uart_puts("1..");
    uputdec(suite_pass + suite_fail);
    uart_puts("\n# result: pass=");
    uputdec(suite_pass);
    uart_puts(" fail=");
    uputdec(suite_fail);
    uart_puts("\n");
}

/* ---- name builders ------------------------------------------------- */

static char *nm_copy(char *buf, const char *op)
{
    while (*op) {
        *buf++ = *op++;
    }
    return buf;
}

static char *nm_h(char *buf, uint32_t v)
{
    static const char HEXD[] = "0123456789abcdef";

    for (int i = 7; i >= 0; i--) {
        *buf++ = HEXD[(v >> (i * 4)) & 0xf];
    }
    return buf;
}

void nm0(char *buf, const char *op)
{
    buf = nm_copy(buf, op);
    *buf = 0;
}

void nm1(char *buf, const char *op, uint32_t a)
{
    buf = nm_copy(buf, op);
    *buf++ = '/';
    buf = nm_h(buf, a);
    *buf = 0;
}

void nm2(char *buf, const char *op, uint32_t a, uint32_t b)
{
    buf = nm_copy(buf, op);
    *buf++ = '/';
    buf = nm_h(buf, a);
    *buf++ = '+';
    buf = nm_h(buf, b);
    *buf = 0;
}

void nm3(char *buf, const char *op, uint32_t a, uint32_t b, uint32_t c)
{
    buf = nm_copy(buf, op);
    *buf++ = '/';
    buf = nm_h(buf, a);
    *buf++ = '+';
    buf = nm_h(buf, b);
    *buf++ = '+';
    buf = nm_h(buf, c);
    *buf = 0;
}
