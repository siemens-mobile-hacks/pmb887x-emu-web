# Bare-metal tcgbench image (see bench.c header): the fast-iteration
# perf workload for the wasm64 TCG backend.
#
#   make                 -> tcgbench.bin (semihosting SYS_EXIT; native legs)
#                        -> tcgbench-wasm.bin (parks; wasm page leg)
#   make install         -> tcgbench-wasm.bin -> site/dist/tcgbench.bin
#                           (page: ?suite=dist/tcgbench.bin)
#   make quick           -> tcgbench-quick.bin / tcgbench-quick-wasm.bin
#                           (ITERS_DIV=4: 4x fewer iterations per phase; the
#                           smoke/iteration image — tools/tcgbench.mjs SUITE=quick)
#   make install         -> also installs tcgbench-quick.bin into site/dist

BM             := ../baremetal
BAREMETAL_MAIN := bench_main

OBJS = bench.o uart.o

all: tcgbench.bin tcgbench-wasm.bin

include $(BM)/baremetal.mk

ITERS_DIV ?= 1
CFLAGS_COMMON += -DITERS_DIV=$(ITERS_DIV)

quick: tcgbench-quick.bin tcgbench-quick-wasm.bin

# the quick images are separate objects so both variants coexist
bench-quick.o: bench.c $(BM)/uart.h Makefile
	$(CC) $(CFLAGS_COMMON) -UITERS_DIV -DITERS_DIV=4 -c -o $@ $<

tcgbench-quick.elf: startup-exit.o bench-quick.o uart.o $(BM)/linker.ld
	$(CC) $(CFLAGS_COMMON) startup-exit.o bench-quick.o uart.o -o $@

tcgbench-quick-wasm.elf: startup-park.o bench-quick.o uart.o $(BM)/linker.ld
	$(CC) $(CFLAGS_COMMON) startup-park.o bench-quick.o uart.o -o $@

%.o: %.c
	$(CC) $(CFLAGS_COMMON) -c -o $@ $<

# rewritten only when ITERS_DIV changes, so bench.o follows the divisor
iters-div.stamp: FORCE
	@echo '$(ITERS_DIV)' | cmp -s - $@ || echo '$(ITERS_DIV)' > $@

bench.o: iters-div.stamp

tcgbench.elf: startup-exit.o $(OBJS) $(BM)/linker.ld
	$(CC) $(CFLAGS_COMMON) startup-exit.o $(OBJS) -o $@

tcgbench-wasm.elf: startup-park.o $(OBJS) $(BM)/linker.ld
	$(CC) $(CFLAGS_COMMON) startup-park.o $(OBJS) -o $@

install: tcgbench-wasm.bin tcgbench-quick-wasm.bin
	cp tcgbench-wasm.bin ../../site/dist/tcgbench.bin
	cp tcgbench-quick-wasm.bin ../../site/dist/tcgbench-quick.bin
	@echo "installed -> site/dist/tcgbench.bin + tcgbench-quick.bin (page: ?suite=dist/tcgbench[-quick].bin)"

clean:
	rm -f *.o *.elf *.bin iters-div.stamp

.PHONY: all quick install clean FORCE
