/* PL011 UART0 output for the bare-metal versatilepb images. */
#ifndef BAREMETAL_UART_H
#define BAREMETAL_UART_H

#include <stdint.h>

/* PL011 UART0 on -M versatilepb lives at 0x101f1000 (0x10009000 is UART3);
 * qemu drains DR writes with no CR/LCRH setup. FR bit 5 = TX FIFO empty. */
#define UART0_DR (*(volatile uint32_t *)0x101F1000u)
#define UART0_FR (*(volatile uint32_t *)0x101F1018u)

void uputc(char c);
void uart_puts(const char *s);
void uputhex8(uint32_t v);
void uputdec(uint32_t n);

#endif
