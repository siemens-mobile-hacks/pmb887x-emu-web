# Patch-series review for upstreaming (2026-09-08)

Review of patches 0001–0009 (excluding the 0005 wasm32 DRAFT) with two
goals: (a) can any patch be improved, (b) is each patch really
wASM-only, or generally helpful?  Policy applied per maintainer
preference: **minimize the total patch surface** — keep only what is
needed to run on WASM or measurably improves performance; de-gate
`__EMSCRIPTEN__` ifdefs only where the native measurement shows a real
win.

Everything below is backed by measurements taken in this session
(methods: `tools/bootbench.mjs` v-window for wasm; `tools/tcibench.mjs`
LCD-milestone and the icount2 `target=MHz` debug output for native TCI;
`tests/run.mjs` for the native suite).

## Verdicts at a glance

| patch | verdict | changes made |
|---|---|---|
| 0001 ui/wasm | wasm-only by nature (platform backend) | trimmed dead diagnostics (`wasm_exit_*`, `wasm_cpu_halted`) |
| 0002 futex/condvar + icount2-helper skip | wasm-only (Asyncify/emscripten; icount2 is fork-only) | **fixed**: `qemu_cond_timedwait` now reports timeouts; dropped the goto_tb-disable + cpu-exec accounting hunks (superseded/cancelled within the series) |
| 0003 TCI TLB probe + direct dispatch | **NOT wasm-only — de-gated** | ifdefs removed; signature-tag sentinel fixes the `(void)->void` libffi fallback; pointer classification is host-size aware |
| 0004 io-recompile MMIO accounting | wasm-only (longjmp cost is a wasm problem; icount2-gated) | cpu-exec.c/translate-all.c hunks dropped — both files are now **pristine** in the final tree |
| 0007 tci_tbhdr per-TB icount2 accounting | wasm/fork-only | now purely additive (tbhdr op + tb_start emit); the goto_tb revert hunk is gone (0002 no longer disables chaining) |
| 0008 TCI immediate forms | generic already | **3 bug fixes** (native compile error, latent i64 upper-bits corruption, disassembler group hijack) |
| 0009 main-loop futex wait | wasm-only | removed dead `qemu_main_loop_wait_init` |

Net surface change: the series no longer touches `accel/tcg/cpu-exec.c`
or `accel/tcg/translate-all.c` at all; 0004 is down to two files.

## Measurements

### Native TCI (S75 fullflash, this machine, interleaved runs)

| build | splash milestone (default `-icount shift=3`) | steady rate (icount2 model) |
|---|---|---|
| stock qemu TCI (pristine worktree) | 40.9 s | 14.6–14.9 MHz |
| patches with 0003 emscripten-gated | 40.9 s | 13.6–13.9 MHz |
| **patches with 0003 de-gated (final)** | **36.9 s (−10%)** | **19.7–20.1 MHz (+44%)** |

(plugins are disabled with `--enable-tcg-interpreter` by configure, so
`tools/tcibench.mjs` measures deterministic-boot wall time to the LCD
milestone, and the icount2 `QEMU_ICOUNT2_DEBUG=1 target=` column gives
a per-second guest-throughput number.)

The icount2-model gain is exaggerated by the per-insn cycle helper
(helper call per guest instruction — the exact pathology 0002 fixes on
wasm); the default-model −10% is the honest number for a stock boot.

### wasm (S75, headless Chromium, v=2→7 window, interleaved A/B)

| build | runs |
|---|---|
| series before this session | 53.9 / 58.4 s |
| series after this session's changes | 51.5 / 53.4 s |

Parity to slightly better (host noise ±6% in this session; the earlier
46–49 s numbers were taken on a quieter host).  A per-cif signature-tag
memoization was also measured on native (+8% icount2-model, 0% default
model / wasm) and **dropped** — it only helps the exotic
native-TCI+icount2 combination and adds surface.

### Regression tests

- `tests/run.mjs` (native JIT build of the patched tree): **all four
  flashes PASS** (s75 65.3, el71 40.7, c81 31.5, ke800 77.3 MIPS).
- wasm soak (`tools/serialwatch.mjs 60`): v advances 0.05→2.96, ~5.7M
  insns/s, LCD updates, no `>>EXIT<<`; `serialwatch` degrades
  gracefully where the removed `wasm_exits`/`wasm_irq_bits` exports
  used to be.

## Per-patch notes

### 0001 — ui: wasm display/input backend
Wasm-only by definition.  Improvements made: removed the TB-exit
histogram (`wasm_exit_account` was called from `cpu_loop_exec_tb` on
every non-chained TB exit — pure debugging weight) and the
`wasm_cpu_halted` probe (one-shot audit tooling only).  Kept:
`wasm_fb_*`, `wasm_send_key`, `wasm_quit` (page), `wasm_vclock`,
`wasm_tbs`, `wasm_insns`, `wasm_fb_updates` (bench/tooling + internal
adaptive refresh).  An SPSC-ring blit-image cache for pixman was
considered and skipped (adds surface, not measurable on the boot
metric).

### 0002 — futex + QemuCond + icount2-helper skip
The emscripten futex/QemuCond port is the load-bearing wasm fix
(Asyncify breaks cross-worker pthread_cond delivery).  Bug found and
fixed: `qemu_cond_timedwait_impl` always returned `true`, so
`qemu_sem_timedwait` could never time out and thread-pool idle threads
never exited on wasm; now `emscripten_futex_wait`'s `-ETIMEDOUT` is
propagated (checked all in-tree users; the pmb887x DSP idle loops
ignore the return value, cacard/migration are unaffected).
Surface reduced: the `tcg_out_goto_tb` disable (added here, reverted by
0007) is now never added; the cpu-exec.c per-TB accounting (added here,
reworked by 0004, removed by 0007) is gone from the series — the final
icount2 accounting lives solely in 0007's interpreter header op.

### 0003 — TCI TLB probe + direct helper dispatch
**Answer to "really wasm-only?": no.**  Both mechanisms are plain TCI
improvements; the wasm gating was incidental.  De-gated after the
native measurements above.  Additional fixes while here:
- signature tag `0` was both "unclassifiable" and the valid tag of
  `(void)->void` helpers, which therefore always took the libffi path;
  now `TCI_TAG_UNCLASSIFIED` is a distinct sentinel;
- `FFI_TYPE_POINTER` is classified per host pointer size (the old code
  would have mis-dispatched pointer args on 32-bit hosts had it been
  de-gated as-is).
A memoized per-cif tag (native +8% under icount2 only) was measured and
dropped as surface (see Measurements).

### 0004 — io-recompile MMIO boundary accounting
Wasm-only and icount2-gated; the ~150 µs emscripten longjmp is the
whole motivation (native setjmp hop is ~1 µs — not worth diverging from
stock semantics).  Surface reduced: after 0007, cpu-exec.c and
translate-all.c carried only dead `#ifdef` comment blocks and an unused
include — both files are now untouched by the series.  `QEMU_IO_REWIND`
env override kept (documented A/B/fallback for the romd exception).

### 0007 — tci_tbhdr per-TB icount2 accounting
Wasm/fork-only (icount2).  Restructured to be purely additive: the TB
header op + `tcg_out_tb_start` emission.  Boot-verified by this session
again after the de-gating of 0003 (interleaved runs above).

### 0008 — TCI immediate forms
Already generic (the only patch written that way from the start), but
it had never actually been compiled natively.  Three bugs fixed:
1. interpreter handlers passed `&t1` (`tcg_target_ulong*`) to an
   `int32_t*` out-parameter — a hard compile error under gcc-14+
   pointer-type checking (native builds), and on wasm a latent
   correctness bug: the upper 32 bits of `t1` kept stale data, which
   any i64 immediate-form op (`addi` on a 64-bit TCG value with a small
   constant) would have folded into the result;
2. the disassembler cases were appended to the stock 3-reg ALU case
   group, hijacking its `tci_args_rrr` decoder (garbage `-d in_asm`
   output for every stock ALU op);
3. same pointer-type error in the disassembler cases.

### 0009 — main-loop futex wait
Wasm-only (emscripten poll()/proxy semantics).  Dead
`qemu_main_loop_wait_init` stub removed.  Everything else unchanged and
still load-bearing (+22% end-to-end documented in its header).

## Reproducing the numbers

```bash
# native TCI A/B (default timing model)
QEMU_BIN=build/qemu-native-tci-nomemo/qemu-system-arm node tools/tcibench.mjs
# native TCI steady-state throughput (icount2 model)
ICOUNT=precise-clocks=on QEMU_ICOUNT2_DEBUG=1 QEMU_BIN=... \
  bash scripts/run-native.sh fullflashes/s75_*.bin 2>&1 | grep -oE 'target=[0-9.]+'
# wasm A/B
PORT=8080 node tools/bootbench.mjs 110
# regression suite
QEMU_BIN=build/qemu-native-jit/qemu-system-arm node tests/run.mjs --label <x>
```
