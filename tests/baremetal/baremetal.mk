# Shared build of the bare-metal versatilepb images (tests/tcg-isa,
# tests/tcgbench): compiler flags, the startup and UART objects and the
# .bin rule.
# The including Makefile sets BM (this directory) and BAREMETAL_MAIN (the C
# function startup.c runs), and includes this after its default target.

CROSS   ?= arm-none-eabi-
CC      := $(CROSS)gcc
OBJCOPY := $(CROSS)objcopy

CFLAGS_COMMON = -mcpu=arm926ej-s -mfloat-abi=soft -ffreestanding -fno-builtin \
                -fno-stack-protector -fno-common -O2 -Wall -Wextra \
                -nostdlib -nostartfiles -T $(BM)/linker.ld -Wl,--build-id=none \
                -I $(BM)

# startup-exit: semihosting SYS_EXIT (native legs);
# startup-park: parks instead (the wasm page leg)
startup-exit.o: $(BM)/startup.c
	$(CC) $(CFLAGS_COMMON) -DBAREMETAL_MAIN=$(BAREMETAL_MAIN) -c -o $@ $<

startup-park.o: $(BM)/startup.c
	$(CC) $(CFLAGS_COMMON) -DBAREMETAL_MAIN=$(BAREMETAL_MAIN) -DBAREMETAL_NO_EXIT -c -o $@ $<

uart.o: $(BM)/uart.c $(BM)/uart.h
	$(CC) $(CFLAGS_COMMON) -c -o $@ $<

%.bin: %.elf
	$(OBJCOPY) -O binary $< $@
	@ls -l $@
