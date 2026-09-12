# tcg-isa — guest op-suite (phase 0a)

The bare-metal ARM926EJ-S test image from
[doc/wasm-tcg-backend-plan.md](../../doc/wasm-tcg-backend-plan.md) §5
phase 0a: it exercises the guest instruction classes that map onto the
TCG ops the wasm64 backend implements, asserts
oracle-computed `(value, NZCV)` pairs and *dumps* every computed value —
one stream, three uses:

1. **per-op debugging** — TAP verdicts (`ok`/`not ok n - name`) name the
   exact op class + operands when something diverges;
2. **cross-backend diffing** — the `# name: v=XXXXXXXX f=NZCV` dump
   lines make the whole run byte-comparable (native JIT vs native TCI vs
   the wasm page — `tools/tcgisa.mjs` for the TCI dist, `tcgisa64.mjs`
   for the wasm64 backend);
3. **emulator-semantics canary** — rare/unpredictable corners are pinned
   to this qemu's behavior (see below), so a backend change that alters
   them fails the byte-diff.

## Building & running

```bash
scripts/run-tcg-isa.sh            # build + native JIT + native TCI + wasm page,
                                  # byte-compare; exit 0 = gate green
WASM=0 scripts/run-tcg-isa.sh     # native legs only
```

Manual:

```bash
make -C tests/tcg-isa                                   # tcgisa.bin + tcgisa-wasm.bin
build/qemu-native-build/qemu-system-arm -M versatilepb \
    -kernel tests/tcg-isa/tcgisa.bin -semihosting \
    -display none -monitor none -serial file:/tmp/ser.log
```

On the wasm page: `make install` then open
`http://127.0.0.1:8080/?suite=dist/tcgisa.bin` (or
`node tools/tcgisa.mjs 8080 out.log` headlessly).

## Machine & conventions

- `-M versatilepb` (same arm926 core as the phones, zero board deps,
  already compiled into the wasm build), raw image loaded by `-kernel`
  at `0x00010000`, entry there; PL011 UART0 at `0x101f1000` (0x10009000
  is UART3).
- `tcgisa.bin` terminates via semihosting `SYS_EXIT` — qemu exits 0/1
  with the suite verdict. `tcgisa-wasm.bin` parks instead: the wasm
  pthread runtime cannot take the exit path (semihosting exit from the
  vCPU thread tears the page down before `onExit` can run), so the page
  leg reads `/serial.log` and verdicts from the TAP text.
- Freestanding, no libc/libgcc (not even `__aeabi_uidiv`): the image
  contains only the shims and plain code — nothing the compiler could
  substitute for the instruction under test.
- Every op shim is a single asm block: preset NZCV (`msr cpsr_f`),
  execute exactly the one instruction form, read CPSR back. Expectations
  come from C reference implementations (`ops.h`) computed independently
  of the guest instruction.

## Coverage

| file | guest classes | TCG ops |
|---|---|---|
| t_arith.c | adds/subs/rsbs/adcs/sbcs/rscs flag matrices, cmp/cmn, 64-bit adds/subs chains, cmp+conditional mov (all 14 ccs) | add/sub/adc/sbc/setcond, add2/sub2, brcond |
| t_logic.c | ands/orrs/eors/bics/tst/teq, movs/mvns with C/V-preservation matrices | and/or/xor/andc (N/Z-only flag rules) |
| t_shift.c | lsl/lsr/asr/ror imm (1..31) + the imm-#32 encodings, register amounts 0/1/31/32/33/64, RRX through both C | shl/shr/sar/rotl/rotr + carry-out |
| t_mul.c | mul/mla, umull/umlal, smull/smlal at boundaries | mul/mulu2/muls2, 64-bit add |
| t_clz.c | clz | clz |
| t_psr.c | msr/mrs NZCV round-trips + CPSR mode canary | cpu-context moves |
| t_ldst.c | ldr/str all widths + sign-extends, scaled/pre/post-index writeback, unaligned words, pc-relative literal | qemu_ld/st MO_* matrix |
| t_block.c | ldm/stm all four modes ± writeback (4/8 regs), ldrd/strd ± writeback | decomposed loads/stores |
| t_swp.c | swp/swpb exchange chains | atomics (cmpxchg path) |
| t_sat.c | qadd/qsub/qdadd/qdsub incl. the sticky Q model | saturating helpers |
| t_interwork.c | Thumb adds/subs/adcs/sbcs/shifts/muls/memory + push/pop, BLX/BX chains, thumb↔ARM calls | second frontend |
| t_smc.c | cross-TB and same-TB self-modifying code, patch storms | TB invalidation / notdirty path |
| t_memstress.c | LCG-driven mixed-size store storm, full-width load sweep, ldm/stm region copy, FNV hashes | everything under load |

Not covered: guest division (arm926 has none) and floats (no FPU;
softfloat runs as helpers).

## Emulator-pinned expectations

Authored against the native JIT (the plan's §5 reference) where the
architecture is unpredictable or differs from silicon:

- unaligned `ldr`/`str` (pre-v6): natural little-endian access, no
  rotation (this qemu's `op_load_rr` passes plain `MO_UL`);
- `ror` by register with amount ≡ 0 (mod 32), amount ≠ 0: C = bit 31 of
  the value (qemu `helper_ror_cc`; v7 silicon would use bit 0);
- same-TB SMC: the modifying store's own basic block runs to completion
  on the already-translated code — ARM does not set `precise_smc` (only
  i386/s390x do) — the patch is observed from the next TB lookup;
- `mul`/`mla` C/V and 64-bit multiply flags: unpredictable → dumped as
  `-`, never compared.

If any of these change in qemu, the byte-diff fails the gate — that is
the point.
