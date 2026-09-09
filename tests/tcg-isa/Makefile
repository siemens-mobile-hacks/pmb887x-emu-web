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
CROSS   ?= arm-none-eabi-
CC      := $(CROSS)gcc
OBJCOPY := $(CROSS)objcopy

CFLAGS_COMMON = -mcpu=arm926ej-s -mfloat-abi=soft -ffreestanding -fno-builtin \
                -fno-stack-protector -fno-common -O2 -Wall -Wextra \
                -nostdlib -nostartfiles -T linker.ld -Wl,--build-id=none

TEST_OBJS = harness.o main.o \
            t_arith.o t_logic.o t_shift.o t_mul.o t_clz.o t_psr.o \
            t_ldst.o t_block.o t_swp.o t_sat.o t_interwork.o t_smc.o t_memstress.o \
            shiftops.o condops.o blockops.o smcops.o thumb.o

all: tcgisa.bin tcgisa-wasm.bin

%.o: %.c harness.h ops.h
	$(CC) $(CFLAGS_COMMON) -c -o $@ $<

%.o: %.S
	$(CC) $(CFLAGS_COMMON) -c -o $@ $<

startup-exit.o: startup.c
	$(CC) $(CFLAGS_COMMON) -c -o $@ $<

startup-park.o: startup.c
	$(CC) $(CFLAGS_COMMON) -DTCGISA_NO_EXIT -c -o $@ $<

tcgisa.elf: startup-exit.o $(TEST_OBJS) linker.ld
	$(CC) $(CFLAGS_COMMON) startup-exit.o $(TEST_OBJS) -o $@

tcgisa-wasm.elf: startup-park.o $(TEST_OBJS) linker.ld
	$(CC) $(CFLAGS_COMMON) startup-park.o $(TEST_OBJS) -o $@

%.bin: %.elf
	$(OBJCOPY) -O binary $< $@
	@ls -l $@

install: tcgisa-wasm.bin
	cp tcgisa-wasm.bin ../../site/dist/tcgisa.bin
	@echo "installed -> site/dist/tcgisa.bin (page: ?suite=dist/tcgisa.bin)"

clean:
	rm -f *.o tcgisa.elf tcgisa.bin tcgisa-wasm.elf tcgisa-wasm.bin

.PHONY: all install clean
