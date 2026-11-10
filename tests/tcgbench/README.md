# tcgbench — fast-iteration backend benchmark (versatilepb)

The perf counterpart of the op-suite ([../tcg-isa/](../tcg-isa/)): a
fixed bare-metal ARM926EJ-S workload on `-M versatilepb` whose phases hit
the wasm64 TCG backend's per-op paths directly, timed by timestamping
each phase's serial line. A run takes ~2.5 s on the native JIT and ~15 s
on the wasm page, with per-phase attribution and a cross-backend checksum.
It has no phone devices and no DSP, so it says nothing about a phone
scene: the keep/revert meter for a change is the free-run A/B in
[doc/performance.md](../../doc/performance.md).

It doubles as the **device-tax bench**: `rampoll` vs `mmiopoll` are
instruction-shape mirrors (4 volatile loads + 4 conditional updates per
iteration; verified in disassembly) over SRAM vs four inert MMIO
registers, so their per-access delta *is* the device-dispatch tax. The
whole workload can also run with and without `-icount shift=3,sleep=off`
(`ICOUNTS=0,1`, `?icount=1` on the page).

## Phases

| phase | iters | stresses | insns |
|---|---|---|---|
| `alu` | 100M | loop-carried add/sub/logic chains — reg locals, no memory | ~0.8G |
| `mul` | 60M | mla/umull chains (mulu2/muls2 paths) | ~0.6G |
| `ldst` | 30M | word/half/byte sweep of a 64 KiB array — inline TLB hit path, size-specialized accesses | ~0.4G |
| `ldrd` | 20M | ldrd/strd + unaligned ldr (64-bit + natural-LE arms) | ~0.25G |
| `branch` | 150M | data-dependent short branches — goto_tb chaining both ways, short TBs | ~1.2G |
| `mix` | 40M | branch + SRAM traffic + rare MMIO poll (UART FR) — the idle-poll shape | ~0.4G |
| `rampoll` | 48M | 4 volatile SRAM loads + branch per iter — RAM half of the tax mirror | ~0.55G |
| `mmiopoll` | 1.5M | same loop over 4 inert MMIO regs (PL011 FR, sysctl ID, PL190 status, SP804 value) — the MMIO half | ~0.02G |
| `mmiow` | 1M | MMIO write+read (SP804 control=0, inert) — the write side | ~0.01G |

Total ≈ 5.3G guest insns. Defaults
target ~4.4 s on the native JIT; `make ITERS_DIV=8` shrinks every phase
8-fold for smoke runs (calibration: keep phases ≥1 s on the *slowest leg
you care about* — the wasm leg's serial-poll quantization is 150 ms).
Note the poll mirrors intentionally differ in iteration count (RAM is
~2 orders faster per access) — compare **ns/access**, not phase seconds.

Output contract (byte-exact across backends; the per-phase checksum
`ck=` defeats dead-code elimination and cross-checks legs — a value bug
in any backend shows up as a `!! CHECKSUM MISMATCH`):

```
BENCH begin
BENCH alu n=100000000 ck=........
...
BENCH done cksum=........
BENCH DONE
```

## Building & running

```bash
make -C tests/tcgbench            # tcgbench.bin (SYS_EXIT) + tcgbench-wasm.bin (parks)
make -C tests/tcgbench install    # -> site/dist/tcgbench.bin (page: ?suite=dist/tcgbench.bin)
make -C tests/tcgbench quick install   # + tcgbench-quick*.bin (ITERS_DIV=4) -> site/dist/tcgbench-quick.bin

SUITE=quick node tools/tcgbench.mjs                      # ÷4 smoke image, 40 ms poll

node tools/tcgbench.mjs                                  # native-jit + dist-jit (wasm64)
LEGS=native-jit,native-tci,dist-jit,dist-x node tools/tcgbench.mjs
ICOUNTS=0,1 node tools/tcgbench.mjs                      # icount-tax matrix
RUNS=3 node tools/tcgbench.mjs                           # medians
```

- Legs: `native-jit` / `native-tci` (spawned, `-serial stdio` streamed,
  env overrides `QEMU_JIT`/`QEMU_TCI`) and any `site/<name>` wasm dist
  (page via `?suite=dist/tcgbench.bin&dist=<name>`; `/serial.log`
  polled at 150 ms; `_wasm_insns()` read at `BENCH DONE` for guest MIPS).
- native TCI on this workload takes **minutes** (short branchy TBs are
  its worst case) — hence it is not in the default legs;
  `NATIVE_TIMEOUT_MS` bounds it.
- Results: `tests/results/tcgbench-<ts>.json` + `tcgbench-latest.json`.
