#include "uart.h"

void uputc(char c) { UART0_DR = (uint32_t)(unsigned char)c; }

void uart_puts(const char *s)
{
    while (*s) {
        uputc(*s++);
    }
}

void uputhex8(uint32_t v)
{
    static const char hexd[] = "0123456789abcdef";
    for (int i = 7; i >= 0; i--) {
        uputc(hexd[(v >> (i * 4)) & 0xf]);
    }
}

/* decimal without __aeabi_uidiv (arm926 has no divide; keep the images
 * free of libgcc so nothing outside the tests can perturb codegen) */
void uputdec(uint32_t n)
{
    static const uint32_t p10[10] = {
        1000000000u, 100000000u, 10000000u, 1000000u, 100000u,
        10000u, 1000u, 100u, 10u, 1u,
    };
    unsigned started = 0;
    for (int i = 0; i < 10; i++) {
        unsigned d = 0;
        while (n >= p10[i]) {
            n -= p10[i];
            d++;
        }
        if (d) {
            started = 1;
        }
        if (started || i == 9) {
            uputc((char)('0' + d));
        }
    }
}
