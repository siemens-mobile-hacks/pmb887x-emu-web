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

CROSS   ?= arm-none-eabi-
CC      := $(CROSS)gcc
OBJCOPY := $(CROSS)objcopy

CFLAGS_COMMON = -mcpu=arm926ej-s -mfloat-abi=soft -ffreestanding -fno-builtin \
                -fno-stack-protector -fno-common -O2 -Wall -Wextra \
                -nostdlib -nostartfiles -T linker.ld -Wl,--build-id=none

OBJS = bench.o

ITERS_DIV ?= 1
CFLAGS_COMMON += -DITERS_DIV=$(ITERS_DIV)

all: tcgbench.bin tcgbench-wasm.bin

quick: tcgbench-quick.bin tcgbench-quick-wasm.bin

# the quick images are separate objects so both variants coexist
bench-quick.o: bench.c Makefile
	$(CC) $(CFLAGS_COMMON) -UITERS_DIV -DITERS_DIV=4 -c -o $@ $<

tcgbench-quick.elf: startup-exit.o bench-quick.o linker.ld
	$(CC) $(CFLAGS_COMMON) startup-exit.o bench-quick.o -o $@

tcgbench-quick-wasm.elf: startup-park.o bench-quick.o linker.ld
	$(CC) $(CFLAGS_COMMON) startup-park.o bench-quick.o -o $@

%.o: %.c
	$(CC) $(CFLAGS_COMMON) -c -o $@ $<

startup-exit.o: startup.c
	$(CC) $(CFLAGS_COMMON) -c -o $@ $<

startup-park.o: startup.c
	$(CC) $(CFLAGS_COMMON) -DTCGBENCH_NO_EXIT -c -o $@ $<

tcgbench.elf: startup-exit.o $(OBJS) linker.ld
	$(CC) $(CFLAGS_COMMON) startup-exit.o $(OBJS) -o $@

tcgbench-wasm.elf: startup-park.o $(OBJS) linker.ld
	$(CC) $(CFLAGS_COMMON) startup-park.o $(OBJS) -o $@

%.bin: %.elf
	$(OBJCOPY) -O binary $< $@
	@ls -l $@

install: tcgbench-wasm.bin tcgbench-quick-wasm.bin
	cp tcgbench-wasm.bin ../../site/dist/tcgbench.bin
	cp tcgbench-quick-wasm.bin ../../site/dist/tcgbench-quick.bin
	@echo "installed -> site/dist/tcgbench.bin + tcgbench-quick.bin (page: ?suite=dist/tcgbench[-quick].bin)"

clean:
	rm -f *.o *.elf *.bin

.PHONY: all quick install clean
