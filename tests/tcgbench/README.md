# tcgbench — fast-iteration backend benchmark (versatilepb)

The perf counterpart of the op-suite ([../tcg-isa/](../tcg-isa/)): a
fixed bare-metal ARM926EJ-S workload on `-M versatilepb` whose phases hit
the wasm64 TCG backend's per-op paths directly, timed by timestamping
each phase's serial line. **Phone-firmware boots are the final gates
only** — 80 s+ per run, device-model noise, hard to attribute; this is
the A/B loop: ~2.5 s native-JIT / ~8 s on the wasm page per run, with
per-phase attribution and a cross-backend checksum.

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

Total ≈ 4.6G guest insns, ≈665M TB entries (6.9 insns/TB). Defaults
target ~2.5 s on the native JIT; `make ITERS_DIV=8` shrinks every phase
8-fold for smoke runs (calibration: keep phases ≥1 s on the *slowest leg
you care about* — the wasm leg's serial-poll quantization is 150 ms).

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
| native-jit | 2.44 s | ~1900 | — |
| dist-jit (wasm64) | 8.20 s | 562 | 6.9 |

Knob A/B on dist-jit (seconds per phase):

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
