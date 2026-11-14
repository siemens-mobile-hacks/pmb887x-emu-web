# Bare-metal ARM926EJ-S op-suite image (doc/wasm-tcg-backend-plan.md, phase 0a).
#
#   make            -> tcgisa.bin (semihosting SYS_EXIT -> qemu exit code
#                      mirrors the suite verdict; native JIT/TCI legs)
#                   -> tcgisa-wasm.bin (parks after printing: the wasm
#                      page's pthread runtime cannot take the exit path —
#                      semihosting exit from the vCPU thread tears the
#                      page down before onExit runs)
#   make install    -> tcgisa-wasm.bin -> site/dist/tcgisa.bin (the page's
#                      ?suite= leg; the runner reads /serial.log and
#                      verdicts from the TAP text)
#
# Freestanding, no libc/libgcc (not even __aeabi_uidiv): everything the
# image executes is either the suite's own instruction shims or plain
# arithmetic the compiler can't "help" with.
BM             := ../baremetal
BAREMETAL_MAIN := tcgisa_main

TEST_OBJS = uart.o harness.o main.o \
            t_arith.o t_logic.o t_shift.o t_mul.o t_clz.o t_psr.o \
            t_ldst.o t_block.o t_swp.o t_sat.o t_interwork.o t_smc.o t_memstress.o \
            t_blit.o shiftops.o condops.o blockops.o smcops.o thumb.o blitops.o

all: tcgisa.bin tcgisa-wasm.bin

include $(BM)/baremetal.mk

%.o: %.c harness.h ops.h $(BM)/uart.h
	$(CC) $(CFLAGS_COMMON) -c -o $@ $<

%.o: %.S
	$(CC) $(CFLAGS_COMMON) -c -o $@ $<

tcgisa.elf: startup-exit.o $(TEST_OBJS) $(BM)/linker.ld
	$(CC) $(CFLAGS_COMMON) startup-exit.o $(TEST_OBJS) -o $@

tcgisa-wasm.elf: startup-park.o $(TEST_OBJS) $(BM)/linker.ld
	$(CC) $(CFLAGS_COMMON) startup-park.o $(TEST_OBJS) -o $@

install: tcgisa-wasm.bin
	cp tcgisa-wasm.bin ../../site/dist/tcgisa.bin
	@echo "installed -> site/dist/tcgisa.bin (page: ?suite=dist/tcgisa.bin)"

clean:
	rm -f *.o tcgisa.elf tcgisa.bin tcgisa-wasm.elf tcgisa-wasm.bin

.PHONY: all install clean
