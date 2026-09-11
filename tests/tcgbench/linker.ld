/* Bare-metal tcgbench: raw image loaded by -kernel at 0x00010000
 * (entry there; qemu's 0x0 boot stub sets r0=0/r1=0x183/r2=0x100 then jumps). */
ENTRY(bench_entry)
SECTIONS {
  . = 0x00010000;
  .text    : { *(.text .text.*) *(.glue_7) *(.glue_7t) }
  .rodata  : { *(.rodata .rodata.*) }
  .data    : { *(.data .data.*) }
  .bss (NOLOAD) : { __bss_start = .; *(.bss .bss.*) *(COMMON) __bss_end = .; }
  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.attributes) *(.comment) }
}
