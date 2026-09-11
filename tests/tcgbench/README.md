# tcgbench — fast-iteration backend benchmark (versatilepb)

The perf counterpart of the op-suite ([../tcg-isa/](../tcg-isa/)): a
fixed bare-metal ARM926EJ-S workload on `-M versatilepb` whose phases hit
the wasm64 TCG backend's per-op paths directly, timed by timestamping
each phase's serial line. **Phone-firmware boots are the final gates
only** — 80 s+ per run, device-model noise, hard to attribute; this is
the A/B loop: ~2.5 s native-JIT / ~15 s on the wasm page per run, with
per-phase attribution and a cross-backend checksum.

It doubles as the **device/icount-tax bench**: `rampoll` vs `mmiopoll`
are instruction-shape mirrors (4 volatile loads + 4 conditional updates
per iteration; verified in disassembly) over SRAM vs four inert MMIO
registers, so their per-access delta *is* the device-dispatch tax; and
the whole workload runs with/without `-icount shift=3,sleep=off`
(`ICOUNTS=0,1`, `?icount=1` on the page) to price the icount side.

## Strategy (where each tool sits)

| tool | what it answers | cost |
|---|---|---|
| `tcgbench` (this) | which backend path got faster/slower, per op class | ~10 s |
| `run-tcg-isa.sh` | is every op still *correct* (byte-exact, 3 backends) | ~30 s |
| `bootbench` / `wprof2` | where does the *phone boot* spend time | ~2–4 min |
| `lockstep-wasm` / `idlebench` | final: value-equality over full boots / human metric | 6–15 min |

Iteration loop for backend work: **tcgbench A/B → op-suite → (if emitter
changed) lockstep 20M/250M → idlebench + full 2.5e9 gate at slice close.**

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

Total ≈ 5.3G guest insns, ≈720M TB entries (7.4 insns/TB). Defaults
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

node tools/tcgbench.mjs                                  # native-jit + dist-jit (wasm64)
LEGS=native-jit,native-tci,dist-jit,dist node tools/tcgbench.mjs
ICOUNTS=0,1 node tools/tcgbench.mjs                      # icount-tax matrix
EXTRA_Q="env=W64_NOACCTINLINE=1" node tools/tcgbench.mjs   # backend knob A/B
RUNS=3 node tools/tcgbench.mjs                           # medians
```

- Legs: `native-jit` / `native-tci` (spawned, `-serial stdio` streamed,
  env overrides `QEMU_JIT`/`QEMU_TCI`) and any `site/<name>` wasm dist
  (page via `?suite=dist/tcgbench.bin&dist=<name>`; `/serial.log`
  polled at 150 ms; `_wasm_insns()/_wasm_tbs()` read at `BENCH DONE`
  for guest MIPS + insns/TB).
- native TCI on this workload takes **minutes** (short branchy TBs are
  its worst case) — hence it is not in the default legs;
  `NATIVE_TIMEOUT_MS` bounds it.
- Results: `tests/results/tcgbench-<ts>.json` + `tcgbench-latest.json`.

## Reference numbers (this host, 2026-09-11, phase-3 backend)

| leg | total | MIPS | insns/TB |
|---|---|---|---|
| native-jit | 4.41 s | ~1200 | — |
| dist-jit (wasm64) | 13.7 s | 390 | 7.4 |
| dist (TCI page) | 101.0 s | 53 | — |
| dist-jit + icount shift=3 | 13.2 s | 405 | 7.5 |

**Compute: wasm64 is 7.4× the TCI page on the bench total** (alu 18×,
mul/ldrd 11.7×, ldst 10×, branch 6.9×, mix 10.3×) — the plan's
"compute 3–10× TCI" landed at the top of its range.  **MMIO:
1.07×/1.2× (mmiopoll/mmiow)** — the dispatch tax is shared qemu-core
cost, identical across wasm backends; that is why the device-bound
phone boot sits at TCI parity (idlebench) while the backend holds a
~10× compute reserve.

### The device/icount tax (ns per access, mirrors)

| leg | ram poll | MMIO read | MMIO write | dispatch tax | MMIO/RAM |
|---|---|---|---|---|---|
| native-jit | 1.5 | 225.8 | 166 | **224 ns** | 151× |
| dist-jit | 4.7 | 590.2 | 379 | **586 ns** | 126× |
| dist (TCI) | 52.8 | 631.5 | 454 | **579 ns** | 12× |
| dist-jit +icount | 4.7 | 530.3 | 303 | **526 ns** | 113× |

Conclusions pinned by these numbers:

- **The MMIO dispatch tax is shared qemu-core cost**: wasm64 ≈ TCI
  (590 vs 632 ns, 7 % apart) while both are ~2.6× the native JIT —
  the multiplier is the wasm/emscripten leg of the TLB-miss → `*_mmu`
  helper → memory.c FlatView dispatch → device callback path,
  independent of the backend's compute speed (18× on alu, 1.07× on
  mmiopoll).  A phone firmware polling at ~30 % density would burn
  ~18 % of its time in this path on wasm64.  This is the
  FlatView/TLB-cached-callbacks lever (the one §4.7 pointed at — but
  it must sit in qemu-core where it also helps /dist, NOT in
  memory.c where TCI already rejected it), and the mirrors are its
  clean before/after metric.
- **icount shift=3 is free on this workload post-slice-2** (390 → 405
  MIPS, within noise; insns/TB unchanged 7.4 → 7.5): with inline TB
  accounting the stock model costs nothing on short-TB code, and the
  TB icount-cap never bites far from deadlines. (It does NOT capture
  the phone boots' timer storms — versatilepb with no guest timers
  armed never fires the v-timer machinery; that part of the boot tax
  still needs wprof on real firmware.)

Knob A/B on dist-jit without the tax phases (seconds per phase,
2026-09-11, slice-2 landing):

| phase | default | `W64_NOACCTINLINE=1` | `W64_NOTLB=1` |
|---|---|---|---|
| alu | 1.07 | 3.35 | 1.06 |
| mul | 0.61 | 2.12 | 0.61 |
| ldst | 0.46 | 1.21 | **6.07** |
| ldrd | 0.61 | 1.21 | **10.45** |
| branch | 4.55 | **14.08** | 4.39 |
| mix | 0.91 | 3.03 | 2.12 |
| **total** | **8.20** | **25.00** | **24.70** |

i.e. on TB-entry-dense compute the inline accounting is worth **3.05×**
(the import call cost ~25 ns × 665M entries) and the inline TLB probe
**13–17×** on memory-dense phases — the phone boot shows these same
levers at −16 % window because it is device/icount-bound, not
backend-bound. That gap (562 MIPS compute vs ~55 MIPS boot) is the
device-model tax, and it is where any further end-to-end gains live —
not in the emitter.
