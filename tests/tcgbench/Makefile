# Bare-metal tcgbench image (see bench.c header): the fast-iteration
# perf workload for the wasm64 TCG backend.
#
#   make                 -> tcgbench.bin (semihosting SYS_EXIT; native legs)
#                        -> tcgbench-wasm.bin (parks; wasm page leg)
#   make install         -> tcgbench-wasm.bin -> site/dist/tcgbench.bin
#                           (page: ?suite=dist/tcgbench.bin)
#   make ITERS_DIV=8     -> 8x fewer iterations per phase (smoke runs)

CROSS   ?= arm-none-eabi-
CC      := $(CROSS)gcc
OBJCOPY := $(CROSS)objcopy

CFLAGS_COMMON = -mcpu=arm926ej-s -mfloat-abi=soft -ffreestanding -fno-builtin \
                -fno-stack-protector -fno-common -O2 -Wall -Wextra \
                -nostdlib -nostartfiles -T linker.ld -Wl,--build-id=none

OBJS = bench.o

all: tcgbench.bin tcgbench-wasm.bin

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

install: tcgbench-wasm.bin
	cp tcgbench-wasm.bin ../../site/dist/tcgbench.bin
	@echo "installed -> site/dist/tcgbench.bin (page: ?suite=dist/tcgbench.bin)"

clean:
	rm -f *.o tcgbench.elf tcgbench.bin tcgbench-wasm.elf tcgbench-wasm.bin

.PHONY: all install clean
