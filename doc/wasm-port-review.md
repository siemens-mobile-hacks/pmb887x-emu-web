# Review of the qemu `wasm-browser-port` series against master (2026-09-12)

Critical review of the `qemu/` submodule branch against qemu-pmb887x
master, measured against the branch's acceptance criteria: **the best
wasm performance possible, correctness maintained, and as little
deviation from master as necessary.**

```
tree:    qemu/  (Azq2/qemu-pmb887x, local branch wasm-browser-port = origin/wasm-patches)
base:    origin/master = 8b9d485bc2  "pmb887x: add KE970 scroll wheel"
tip:     HEAD = debfa3d6f5           "pmb887x: seed the RTC counter in the layout the firmware expects"
series:  43 commits, 79 files, +10,604 / −155 lines
```

Patch numbers (0001…0045) are the ones the other docs use; the
commit-to-number map is in [upstream-branch.md](upstream-branch.md).
Line numbers are HEAD (`debfa3d6f5`).

## 1. Verdict in brief

**Nothing found invalidates the branch's shipped behaviour today** — the
native boot suite, op-suite and manual TCI boots all pass on this tree —
but the review found real bugs in every tier, several of which sit on
the page's default path:

| # | Severity | Where | One line |
|---|---|---|---|
| R-01 | BUG-HIGH | `include/qemu/futex.h:81` | `qemu_futex_wait` passes a 0 ms timeout to `emscripten_futex_wait` (= immediate timeout, proven with emsdk source + test): every `QemuEvent`/`QemuLockCnt` wait busy-spins; the RCU thread pegs a core at the idle screen. One-word fix (`INFINITY`). |
| R-02 | BUG-MED (latent hang) | `accel/tcg/icount-common.c:405-416` | Under the shipped `rt=banked` cap the main loop hands a virtual deadline back with `qemu_cpu_kick`, which cannot wake an idle rr thread; reachable after `rr_idle_advance`'s 64-iteration bound. |
| R-03 | BUG-MED (generic) | `system/physmem.c:3119-3124` | 0016's range-scoped topology flush never clears `tb_jmp_cache`; a remap (SCU BROM mirror, TCM, EBU; upstream PAM) can execute a stale TB until the guest's next TLB flush. |
| W-01/02/03 | BUG-MED (wasm64, any ARMv6T2+ guest) | `tcg/wasm64/tcg-target.c.inc` | `deposit_i32`, mid-field `sextract`, and `bswap32_i64` emit **invalid wasm modules** (validated with V8); unreachable on the ARM926 firmware, fatal for any other `qemu-system-arm` CPU model. |
| W-04 | BUG-MED (wasm64, shipped) | `tcg-target.c.inc:2497-2610` | The per-TB temp-module prelude has unchecked 1-byte section sizes; ≥ 15 helper imports in one TB → rejected module, ≥ ~20 → unsigned underflow writes ~4 GB of zeros into a stack buffer. Built for every TB although temp modules are never instantiated in the default config. |
| W-05 | BUG-MED (wasm64, shipped) | `tcg-target.c.inc:40` | `uint8_t n_labels`: a TB with ≥ 256 labels (a 1 KB page of conditional ARM insns / Thumb IT blocks) wraps and forward branches jump to the TB start. |
| R-04/05/06 | BUG-MED (generic) | `accel/tcg/cputlb.c` (0018) | Fill-time MMIO dispatch: byte-swap inverted on big-endian hosts; per-piece value masking dropped; `ioeventfd_nb` cached at fill time but never invalidated (virtio ioeventfd bypass on TCG). |
| R-07/08 | BUG-MED (generic TCI) | `tcg/tci.c` (0003/0011) | Direct helper dispatch reads i32 args from the wrong half of the slot on big-endian hosts (and trips CFI); the generic inline fast path dereferences unaligned host pointers. |
| R-09 | BUG-MED (wasm, shipped) | `util/main-loop.c:361-367` | Main-loop futex reset-then-wait loses a wake that lands after the timeout was computed (≤ 500 ms latency on key input / flash BH / REALTIME timers). |
| R-10 | DEVIATION | `hw/arm/pmb887x/dsp.c:49` | The AFE cherry-pick flips `#define STUB_DSP 1`: every native build now runs the HLE DSP stub, contradicting the docs' "native semantics unchanged" claim; the LLE-side edits in the same commit are compiled out. |
| R-16 | REMOVE | `meson.build:4642` | `subdir('tests')` is commented out for every host (the working tree already restores it; commit that). |

Removal / simplification budget (details in §6): about **550 lines can
go from `tcg/wasm64/` at zero perf cost** (dead `TCG_TARGET_HAS_*`
block, unreferenced outop tables, bring-up forensics, measured-and-
decided A/B arms), another **~450 lines (the per-TB temp-module path)
and the always-emitted lockstep probes need one A/B each**, the
un-gated diagnostic counters and three ARM/wasm-specific hooks in
generic files should be gated, and two product decisions each unlock a
large block: the **TCI tier (~1,350 lines of `tcg/tci*`)** and the
**opt-in icount2 mode (~100 lines)**. Every measured win in the playbook
survives all of it.

Recommended order: §9.

## 2. Method

Two independent reviewers (Claude Fable 5.1) read every hunk of the
series against master: one for the wasm64 TCG backend (`tcg/wasm64/**`
plus its hooks in `tcg/tcg.c`, `tcg/meson.build`, `include/tcg/tcg.h`
and the accel/tcg call sites it depends on), one for everything else
(accel/tcg core, TCI, threading and main loop, system/memory, the ARM
frontend, pmb887x devices, ui/wasm.c, build config). Each finding was
verified by reading both the master and the HEAD side of the code path
and, where cheap, by compiling or executing a reproduction; the
per-finding confidence records how far that went. The highest-severity
findings were then re-verified independently against the source by the
coordinating reviewer. Findings are numbered `W-nn` (wasm64 backend)
and `R-nn` (rest). The perf argument for each removal candidate cites
[optimization-playbook.md](optimization-playbook.md) § What landed or
the commit message; where there is no number it says so and names the
meter. Two GLM-authored reviews of the same tree were written in parallel
(`wasm-port-glm-review-part1.md`, `-part2.md`); §11 maps their items onto
this review, folds in the ones that verified, and records the two that
did not.

Severity scale:

| Severity | Meaning |
|---|---|
| BUG-HIGH | wrong result, crash or hang in a shipped configuration (the page defaults or the native reference build) |
| BUG-MED | wrong on a reachable but less common path (an opt-in knob, another target/host, a rare guest sequence) |
| BUG-LOW | latent or theoretical; needs a code change elsewhere or an unusual configuration to surface |
| REMOVE | can be dropped with no expected perf cost |
| SIMPLIFY | can be reduced, merged or expressed through an existing upstream mechanism |
| DEVIATION | unnecessary divergence from master (gating, generality, native behaviour) |
| STYLE | cosmetic |

### What was compiled and run

| Check | Result |
|---|---|
| Native JIT build (`configure --target-list=arm-softmmu --disable-docs --disable-werror`, gcc, `build/qemu-review-native`) | OK. 6 warnings: `system/icount2.c:128,136` missing prototypes (`icount2_ticks_now`, `icount2_w64_acct_addrs`); `accel/tcg/translate-all.c:612,618` missing prototypes (`wasm_add_io_barrier`/`wasm_is_io_barrier` declared only under `__EMSCRIPTEN__`, defined unconditionally); `hw/arm/pmb887x/dsp.c:294` unused `dsp_exec_command_ch0`; `utils/tomlc17.c:1634` pre-existing. |
| Native TCI build (`--enable-tcg-interpreter`, `build/qemu-review-tci`) | OK. Same 6 plus `tcg/tci.c:344,399,455` "`always_inline` function might not be inlinable unless also declared `inline`" (`tci_probe_a`, `tci_ld_fast`, `tci_st_fast`) — gcc may not inline the 0011 fast path natively (R-33). |
| wasm64 build: incremental recompile of every changed non-backend object in `build/qemu-wasm64` (no link, no deploy) | OK. 17× missing prototypes for the `EMSCRIPTEN_KEEPALIVE` exports in `ui/wasm.c`, 3× in `system/icount2.c`, the `dsp.c` unused function. |
| Guest op-suite `WASM=0 scripts/run-tcg-isa.sh` on both review binaries | PASS: native JIT 1156/1156, native TCI 1156/1156, serial logs byte-identical (97,941 bytes). |
| Native boot suite `node tests/run.mjs --label review-jit --timeout 240` (JIT) | 4/4 PASS: s75 83.5 MIPS / 3.96 G insns, el71 65.5, c81 51.1, ke800 85.8 (no icount); LCD content at 10.3 / 5.9 / 5.9 / 19.1 s. |
| Native boot suite on the TCI binary | Harness unusable: QEMU disables plugins with `--enable-tcg-interpreter` and `tests/run.mjs` hard-codes `-plugin insncount.so`. Replaced by manual 150 s boots of all four fullflashes with the `run-native.sh` recipe + HMP `screendump`/`info registers`: all four reach real LCD content (S75 idle screen, C81 "23:09 / Поиск сети", EL71/KE800 saturated screens), no `hardware error` / `>>EXIT<<` / assertion. |
| `emscripten_futex_wait` 0 ms semantics (standalone emcc test, emsdk 4.0.10, `-pthread -sPROXY_TO_PTHREAD`, node) | `timeout=0: rc=-ETIMEDOUT elapsed=0.041 ms`; `timeout=50: elapsed=50.07 ms`. Confirms R-01; emsdk source (`emscripten_futex_wait.c:140`) agrees: only `INFINITY` waits indefinitely. |
| Hand-assembled wasm modules reproducing the emitter's byte sequences for `deposit_i32`, mid-field `sextract_i32`, `bswap32_i64` (`WebAssembly.validate`, node 22) | Three **invalid modules** (W-01..W-03); `bswap32_i64` also semantically wrong with the opcode fixed. |
| Model of the temp-module prelude size arithmetic | 1-byte section sizes overflow at 15 imports, the 256-byte prelude at ~20 (W-04). |

### What could not be checked

Big-endian hosts, 32-bit hosts, `--enable-cfi`, MTTCG/SMP targets,
record/replay, the browser runtime (no browser benchmark was run; the
docs' gates were not re-run), a wasm TCI build (no `dist` build dir on
this host), lockstep, decoding a *real* emitted wasm module (there is
no dump knob short of a compile failure — the byte sequences were
reproduced from the emitter source). Findings that depend on those are
labelled with what would confirm them.

### Why the existing gates did not catch the emitter bugs

The S75/EL71/C81/KE800 boots and the 2.5e9-insn lockstep pass because
the ARM926 (ARMv5TE) frontend never emits `deposit_i32`, a mid-field
`sextract_i32`, or `bswap32_i64` (they come from `BFI/PKH/SBFX` =
ARMv6T2+ and `REV32` = AArch64), never has ≥ 15 distinct helper imports
in one TB, and never had ≥ 256 labels in one TB. W-01..W-03 are real
for `arm-softmmu` in general (any ARMv6T2+ CPU model); W-04/W-05 are
reachable in principle on the pmb887x firmware.

## 3. Findings — wasm64 TCG backend (`W-nn`)

### W-01 — `deposit` (I32) emits an ill-typed module (i64 scratch read into an i32 `or`)
- **Severity:** BUG-MED (CompileError → the vCPU worker dies). BUG-HIGH for any ARMv6T2+ guest on `qemu-system-arm`; unreachable on ARM926 firmware.
- **Location:** `tcg/wasm64/tcg-target.c.inc:1871-1889` (`tgen_deposit`); same bug at `:1895-1913` (`tgen_depositi`, dead — W-17). Introduced by 0017.
- **Evidence:**
  ```c
      w64_deposit_field(s, t, a2, 0, false, ofs, len);
      w64_local_set(s, w64_scr(t));          /* I32: local.set $scr32 (i32) */
      w64_get(s, a1, t);
      w64_const(s, t, ~(tcg_target_long)mask);
      w64_u8(s, t == TCG_TYPE_I32 ? 0x71 : 0x83);           /* and */
      w64_local_get(s, W64_L_SCR0);          /* ALWAYS $scr0 = the i64 scratch */
      w64_u8(s, t == TCG_TYPE_I32 ? 0x72 : 0x84);           /* or */
  ```
  `w64_scr(TCG_TYPE_I32)` is `W64_L_SCR32` (i32) but the read-back is hard-coded to `W64_L_SCR0` (i64). V8 rejects the sequence: `i32.or[1] expected type i32, found local.get of type i64`. The I64 form validates.
- **Reachability:** `INDEX_op_deposit` (I32) is emitted by `target/arm/tcg/translate.c:4542` (`BFI`), `:4681/4685` (`PKHBT/PKHTB`), `translate-vfp.c:3413`, `tcg_gen_deposit_z_i32` (ofs ≠ 0), and synthesized by `optimize.c` `fold_extract2`. `TCG_TARGET_deposit_valid` accepts everything, so the middle-end never expands it.
- **Fix:** `w64_local_get(s, w64_scr(t))`. Add the op to the op-suite for a v6T2 CPU (`-cpu arm1176` / `cortex-a8`).
- **Confidence:** high (validated).

### W-02 — `sextract` with `ofs+len != width` emits `local.set` on an empty stack
- **Severity:** BUG-MED (CompileError). Unreachable on ARMv5 (`SBFX` is v6T2); reachable on v6T2+ and via `tcg_gen_sextract_i32` from any frontend/optimizer path.
- **Location:** `tcg/wasm64/tcg-target.c.inc:1964-1989` (`tgen_sextract`), 0017.
- **Evidence:**
  ```c
      } else {
          int scr_ = w64_scr(t);
          tgen_extract(s, t, a0, a1, ofs, len);   /* ends with w64_set_i32/i64(a0): stack empty */
          w64_local_set(s, scr_);                 /* pops nothing */
          w64_local_get(s, scr_);
  ```
  V8: `not enough arguments on the stack for local.set (need 1, got 0)`. The `ofs+len == width` arm validates. Note `tcg_gen_sextract_i32` routes *every* case with `ofs+len != 32` here because `TCG_TARGET_sextract_valid` accepts everything, including the canonical `ofs==0, len 8/16` cases.
- **Fix:** open-code the shift pair: `get a1; shl (width-ofs-len); shr_s (width-len); set a0`. No scratch needed.
- **Confidence:** high (validated).

### W-03 — `bswap32_i64` uses `i32.rotr` on i64 operands and swaps the wrong half
- **Severity:** BUG-MED (CompileError; wrong value if the opcode were fixed). Unreachable on AArch32; advertised nevertheless.
- **Location:** `tcg/wasm64/tcg-target.c.inc:2080-2123`, 0017.
- **Evidence:** lines 2083 and 2092 emit `0x78` (`i32.rotr`) with i64 operands (V8: `i32.rotr[0] expected type i32, found local.get of type i64`). With `0x8a` (`i64.rotr`) substituted, `rotr(x,32) & 0xffffffff` isolates the *upper* 32 bits, so the result is `bswap32(x >> 32)`: `0x1122334455667788` → `0xee772211` instead of `0x88776655`. The OZ/OS/preserve flag handling that follows is built on that wrong value.
- **Fix:** `x & 0xffffffff` (no rotate), then the i32 two-mask byte swap with i64 opcodes, then the flag handling as written; or lower through `i32.wrap` → the i32 path → `extend`. Add the op to the op-suite.
- **Confidence:** high (validated).

### W-04 — Temp-module prelude: unchecked 1-byte section sizes and a 256-byte cap; overflow corrupts the stack
- **Severity:** BUG-MED (crash at *translation* time in the shipped configuration when one TB references ≥ 15 distinct helper imports; ≥ ~20 imports overwrites the stack). Rare but reachable: a 256-insn ARM TB using all of `ldrb/ldrsb/ldrh/ldrsh/ldr/ldrd/strb/strh/str/strd` (10 `*_mmu` imports) plus `w64_lockstep_account`, `helper_lookup_tb_ptr`, `cpsr_read`, `cpsr_write` and one cp15 helper already reaches 15.
- **Location:** `tcg/wasm64/tcg-target.c.inc:2497-2610` (`tcg_out_tb_finalize`), 0017.
- **Evidence:**
  - type/import/export sections are written with a single size byte: `w.b[start - 1] = w.n - start; tcg_debug_assert(w.n - start < 128);` (lines 2517-2518, 2550-2551, 2566-2567). The import section is `21 + 7·min(n,10) + 8·max(n−10,0)` bytes → 131 at n = 15, so from 15 imports the size byte is wrong and the browser rejects the module.
  - The filler: `unsigned room = target - w.n; tcg_debug_assert(w.n <= target); if (room > 0) { if (room - 2 <= 127) {...} else {...}; room -= 2 + nleb; while (room--) wb_u8(&w, 0); }` (2575-2608). With `w.n > target`, or `room == 1` or `room == 2`, `room` underflows and the loop writes ~4 GB of zeros into `struct w64_buf { uint8_t b[W64_PRELUDE + 16]; }` on the stack. None of the `tcg_debug_assert`s exist in the release build (`build/qemu-wasm64/config-host.h:102`: `#undef CONFIG_DEBUG_TCG`).
  - `W64_MAX_IMPORTS` is 24 and `W64_MAX_TYPES` 12: the per-TB tables permit sizes the prelude cannot encode.
- **Why it matters although temp modules are never instantiated:** the prelude is built for every TB regardless (W-20).
- **Fix:** (a) drop the temp-module path (W-20) and stop emitting the prelude; or (b) make `tcg_out_tb_finalize` return "TB too large" so `tcg_gen_code` returns `-2` (the existing halve-`max_insns` retry in `tb_gen_code`), encode section sizes with `wb_uleb`, and cap `W64_MAX_IMPORTS` at 14 or grow the prelude.
- **Confidence:** high on the arithmetic; medium on how often a real TB reaches 15 imports.

### W-05 — Label counter is `uint8_t`: a TB with ≥ 256 labels branches to region 0
- **Severity:** BUG-MED (wrong control flow, low probability). ARM926 pages are 1 KB → ≤ 256 ARM or ≤ 512 Thumb insns per TB; every conditional insn creates a label (`arm_skip_unless`), so a page of conditional ARM code or a Thumb TB of IT blocks reaches 256.
- **Location:** `tcg/wasm64/tcg-target.c.inc:40` (`uint8_t n_labels;`), `:385-387`, `:408`, 0017.
- **Evidence:** `tcg_debug_assert(W.n_labels < 0xffff); W.label_idx[l->id] = ++W.n_labels;` — the assert cannot fail on a `uint8_t`; at the 256th label `n_labels` wraps to 0, `label_idx` becomes 0 ("unplaced"), forward fixups are never patched (`tcg_debug_assert(W.n_fixup == 0)` at finalize is compiled out), the padded `i32.const` stays 0 → `bp = 0` → the branch re-enters region 0 (the TB start). Region guards also compare against the wrapped value.
- **Fix:** `uint16_t n_labels` (the compare immediates are `sleb32`). Make `l->id < W64_MAX_LABELS` a hard check (return "TB too large") rather than a debug assert — `label_idx[l->id]` is an OOB write in release otherwise (W-13).
- **Confidence:** high.

### W-06 — `tcg_out_mb` is a no-op while `TCG_TARGET_DEFAULT_MO = 0`
- **Severity:** BUG-LOW (needs a second thread touching guest RAM).
- **Location:** `tcg/wasm64/tcg-target.c.inc:966-969`, `tcg-target-mo.h:10`, 0017.
- **Evidence:** `TCG_TARGET_DEFAULT_MO 0` tells the core "the host provides no ordering, emit `mb` where the guest needs it"; the backend then discards every `mb`. The comment says "single-threaded guest, single linear memory" — true for the vCPU, but the build has other pthreads sharing the same linear memory (`hw/arm/pmb887x/dsp.c:1523` creates the `pmb887x-dsp` worker; the main-loop thread runs device timers). Wasm plain loads/stores on shared memory carry no cross-thread ordering.
- **Fix:** emit `atomic.fence` (`0xfe 0x03`) for non-zero `a0` — ARMv5 firmware issues essentially no barriers, so the cost is nil — or document that the DSP worker never touches guest RAM outside the BQL (with R-10 the native reference runs the HLE stub anyway).
- **Confidence:** medium (the DSP worker's memory accesses were not audited).

### W-07 — Batch member is staged before the TB is committed: discarded TBs leave stale members
- **Severity:** BUG-LOW (single-vCPU rr never hits the `existing_tb` race; the `encode_search`-overflow retry hits it only if a batch closes on the exact TB that then overflows; consequences appear only when that batch is later evicted and re-ensured, which the playbook says is 0 per boot with default knobs). Plausibly the root of the open `SOURCE-CORRUPT` item in [performance-handoff.md](performance-handoff.md).
- **Location:** `tcg/wasm64/tcg-target.c.inc:2645` (`w64_batch_member` called from `tcg_out_tb_finalize`, i.e. inside `tcg_gen_code`, before `tb_gen_code`'s `encode_search` / `tb_link_page`), `wasm64.c:1761-1777` (`W64BATCHRETRY`), `wasm64.c:1409-1434` (`w64_batch_ensure`). 0017, 0019.
- **Evidence:** `tb_gen_code` can discard a translated TB after `tcg_gen_code` returned (`existing_tb != tb`, or `encode_search` overflow → `goto buffer_overflow`) and reuse `code_gen_ptr`. `w64_batch_member` handles the same-address retry only for the *open* batch ("the stale member is always the last one: truncate it"). If the batch *closed* on that member, the landed record keeps `member[m].tcptr/body_len/fix_end` pointing at bytes the next translation overwrites; `w64_assemble_instantiate(&l->src)` on re-ensure/compaction re-reads them: a length change is caught by the size walk (→ `w64_batch_ensure` fails → `abort()`), a same-length overwrite passes the walk and produces a wrong or invalid module.
- **Fix:** move the staging call into `tb_gen_code` after `tb_link_page` succeeds (a `tcg_tb_committed(tb)`-style hook), or add an unstage hook at both discard points; for landed records, mark a member dead instead of re-reading the buffer.
- **Confidence:** high on the mechanism; low on practical frequency.

### W-08 — `tcg_code_gen_epilogue` is never set; `goto_ptr` compares the lookup result against NULL
- **Severity:** BUG-LOW (works by accident in release; `CONFIG_DEBUG_TCG` builds abort in `tcg_prologue_init`).
- **Location:** `tcg/wasm64/tcg-target.c.inc:2750-2752` (empty `tcg_target_qemu_prologue`), `:925`, `wasm64.c:1962`; `tcg/tcg.c:1926` (`tcg_debug_assert(tcg_code_gen_epilogue != NULL)` under `#ifndef CONFIG_TCG_INTERPRETER`). 0017, 0026.
- **Evidence:** `helper_lookup_tb_ptr` returns `tcg_code_gen_epilogue` on a miss; here that is NULL, so the emitted `i64.eq` against 0 and the dispatcher's `next == 0 || next == epilogue` test rely on the unset global. TCI is exempted from the assert; wasm64 is not.
- **Fix:** extend the `#ifndef CONFIG_TCG_INTERPRETER` in `tcg.c:1919-1927` to cover `CONFIG_TCG_WASM64` (or key both off `HAVE_TCG_QEMU_TB_EXEC`, W-22) and use `i64.eqz`.
- **Confidence:** high.

### W-09 — `TCG_TARGET_CALL_ARG_I128 = NORMAL` / `RET_I128 = NORMAL` advertised but `tcg_out_call` cannot lay out i128
- **Severity:** BUG-LOW (no i128 helper is reachable from the A32 frontend; `TCG_TARGET_HAS_qemu_ldst_i128 = 0`).
- **Location:** `tcg/wasm64/tcg-target.h:97-98`, `tcg-target.c.inc:1028-1073`, 0017.
- **Evidence:** `p[i] = w64_typecode_to_wasm((mask >> ((i + 1) * 3)) & 7)` assumes one typemask entry per `info->in[]` slot; an i128 NORMAL argument occupies two slots but one typecode (7) → `0xff` → in release becomes an `i64` param on the next slot and mis-indexes every later argument; a 128-bit return hits `g_assert_not_reached()`.
- **Fix:** set both to `TCG_CALL_ARG_BY_REF` / `TCG_CALL_RET_BY_REF`, or implement the two-slot case. At minimum turn the debug asserts into hard errors.
- **Confidence:** high.

### W-10 — `w64_cmp[]` has no `TSTEQ/TSTNE` entries; a stray TST cond would emit opcode `0x00` (`unreachable`)
- **Severity:** BUG-LOW (unreachable: `TCG_TARGET_HAS_tst = 0` makes `optimize.c` lower TST conds first).
- **Location:** `tcg/wasm64/tcg-target.c.inc:417-435`, 0017.
- **Fix:** `tcg_debug_assert(w64_cmp[c].i32 != 0)` in `w64_cmp_op`. Cosmetic.

### W-11 — Prologue accounting runs before the `icount_decr` check: `TB_EXIT_REQUESTED` entries are counted (icount2 drift)
- **Severity:** BUG-LOW (opt-in `?icount=precise-clocks` only; TCI's `tci_tbhdr` behaves the same, so both engines agree).
- **Location:** `tcg/wasm64/tcg-target.c.inc:2349-2427` (emitted before `w64_emit_loop_head`, i.e. before `gen_tb_start`'s brcond), 0017/0029.
- **Evidence:** a TB entered and immediately exited with `TB_EXIT_REQUESTED` has already added `tb->icount` to `icount2_ticks` and `wasm_tb_stats`; it is re-entered and counted again after the interrupt. Under interrupt storms icount2 runs ahead of executed instructions.
- **Fix:** not needed for the shipped timing model; if icount2 accuracy matters, emit the accounting after `gen_tb_start`'s check (needs a frontend hook).

### W-12 — Speculation records `BLX <imm>` targets with the caller's Thumb bit; such TBs are dead weight
- **Severity:** BUG-LOW (perf only: the wrong-`flags` TB is inserted into the QHT but never matches a lookup; it costs a translation, a batch slot and compile bytes).
- **Location:** `accel/tcg/translator.c:111-141` (`translator_note_succ` records `dest` only), `target/arm/tcg/translate.c` (`trans_BLX_i` → `gen_goto_tb`), `accel/tcg/cpu-exec.c:747` (`TCGTBCPUState t = s;`). 0020, 0019.
- **Evidence:** `arm_get_tb_cpu_state` stores `env->thumb` in `flags`; `w64_speculate` copies the root's `flags` into every successor. The playbook's own note ("blx: a Thumb target recorded while in ARM mode → alignment fault") shows the case was defended against faulting, not against the waste. The `ldr pc,[pc,#-4]` literal path correctly skips `target & 1`.
- **Fix:** pass the successor's Thumb bit (a 1-bit `flags` delta in `w64_succ[]`), or drop the hint from `trans_BLX_i`. Measure with `W64_DEBUG=1`'s `W64SPEC made=` counter.

### W-13 — Debug-only bounds asserts guard fixed-size emitter tables (release = silent overflow)
- **Severity:** BUG-LOW (each individually unlikely; together they are the only guard on `W`'s layout).
- **Location:** `tcg-target.c.inc:333` (`n_types < 12`), `:348` (`n_imp < 24`), `:385` (`l->id < 1024`), `:794` (`n_fixup < 1024`), `:291` (`n_blk < 32`), `:2468/2479/2518/2551/2567/2577/2610` (finalize). 0017.
- **Evidence:** all are `tcg_debug_assert`, compiled out. `W.imp[24]` overflow writes into `W.blk[]`; `label_idx[l->id]` with `l->id ≥ 1024` writes into `n_labels/fixup[]`. `tcg_gen_code` already has a defined "TB too large, retry with half the insns" path (`return -2`).
- **Fix:** turn each into `if (...) { W.overflow = true; return; }` and have `tcg_out_tb_finalize` return `-2` to `tcg_gen_code`.

### W-14 — Compaction assumes a ≤ 2-byte count LEB (≤ 16383 functions); tunable knobs can exceed it
- **Severity:** BUG-LOW (defaults give ≤ ~1200 members per merged module; only `W64_COMPACT_MEMBERS`/`W64_COMPACT_BATCHES` sweeps reach 256 × 128 = 32768; the size walk then rejects the module and compaction disables itself — a silent perf cliff).
- **Location:** `wasm64.c:1121` (`uint64_t total = (src->n_member + 1) < 128 ? 1 : 2;`), 0019.
- **Fix:** compute the LEB length properly or clamp `n_member` in `w64_compact`.

### W-15 — `tidx` and table growth: every translation attempt allocates a slot (including discarded TBs)
- **Severity:** BUG-LOW (a sparse funcref table; ~8 bytes per wasted slot; reset at `tb_flush`).
- **Location:** `tcg-target.c.inc:2293` (`w64_alloc_tidx()` in `tcg_out_tb_start`), `wasm64.c:532-537`.
- **Fix:** allocate in `w64_batch_member` (the success point).

### W-16 — Dead `TCG_TARGET_HAS_*` block in `tcg-target.h`
- **Severity:** REMOVE (~80 lines; perf: none).
- **Location:** `tcg/wasm64/tcg-target.h:102-182`, 0017.
- **Evidence:** master's core references none of `TCG_TARGET_HAS_{bswap16,div,rem,ext8s,…,muls2,mulu2,mulsh,muluh,qemu_st8,extrl/extrh_i64_i32}_i32/_i64` any more (checked with `git grep` on `origin/master` over `include tcg/tcg.c tcg/tcg-op.c tcg/optimize.c tcg/tci accel`): only `TCG_TARGET_HAS_extr_i64_i32`, `TCG_TARGET_HAS_qemu_ldst_i128`, `TCG_TARGET_HAS_tst` survive, and those already live in `tcg-target-has.h`. `HAVE_TCG_QEMU_TB_EXEC` is referenced only by `tcg/tci/tcg-target.h` on master (a fossil). Op availability in 11.x is decided solely by the `outop_*` tables and `tcg-target-has.h`.
- **Fix:** delete lines 102-182; keep `tcg-target-has.h`. The header comment ("Phase 1 … no chaining") is stale too.

### W-17 — Unreferenced outop tables: `outop_depositi`, `outop_deposit_zr`, `outop_muluh_i64`
- **Severity:** REMOVE (~45 lines; perf: none).
- **Location:** `tcg-target.c.inc:1895-1932`, `:1841-1843`, 0017.
- **Evidence:** the core dispatches `INDEX_op_deposit` through `&outop_deposit` only and picks `.out_rri`/`.out_rzr` from *that* struct; the backend's `outop_deposit` sets only `.out_rrr` with `C_O1_I2(r, r, r)`, so the two separate structs are never read. `outop_muluh_i64` is not in `all_outop[]` (`tcg.c:1200` uses `outop_muluh`, typed by `TCGOP_TYPE`).
- **Fix:** delete; if a constant-field deposit is wanted, add `.out_rri = tgen_depositi` to `outop_deposit` with `C_O1_I2(r, r, rC)` (after fixing W-01 there too).

### W-18 — Bring-up debug scaffolding still in the emitter/runtime
- **Severity:** REMOVE (~350 lines; perf: none — all cold or translation-time, but they are the bulk of the getenv surface).
- **Locations / commits:**
  - `tcg-target.c.inc:1084-1101` — `W64CALL` print block with an inline `w64_typecode_to_wasm(0/4/6)` self-test ("bring-up paranoia after observing an -O3 inlining artifact"); 0017.
  - `wasm64.c:890-985, 1145-1277, 1660-1697` — batch-corruption forensics: `w64_sum` FNV over every member body at stage time and again at close, `w64_bad_*` `/w64bad-N.bin` dumps, the assembled-code-section re-walk with hex dumps (`W64BATCHBAD`), `W64BATCHSKIP`; 0019. The one functional piece is the `W64BATCHRETRY` same-address truncation at `wasm64.c:1761-1777` (keep; W-07); the "skip landing on failure" outcome can become `abort()` once temp modules are gone (W-20).
  - `wasm64.c:96-186` — the JS import-signature prober in `w64_instantiate` (probes 22×5 candidate signatures per import on a link failure); 0017.
  - `wasm64.c:848-886` — `performance.now()` × 4 and `__w64tR/tM/tI/tA` globals per batch instantiate; 0019.
  - `accel/tcg/cpu-exec.c:703-724` — `st[6]` speculation statistics + `W64SPEC` print; `accel/tcg/translate-all.c:404-417` — `W64_TBLOG` and the `w64_spec_active` global that exists only to feed it; 0019.
  - `wasm64.c:1427-1430` — `getenv("W64_DEBUG")` on every 1024th re-ensure (not cached like the others).
- **Fix:** delete; keep `W64_DEBUG`'s one useful output (`W64BATCH close#`/`W64COMPACT #`) behind a single cached flag (`tools/repro.mjs` and the `?w64debug=1` page switch read it).

### W-19 — `W64_NOACCTINLINE` and `W64_NOTLB` A/B paths
- **Severity:** REMOVE (~60 lines; perf: none — both measured and decided: `W64_NOACCTINLINE=1` 3.05× slower, `W64_NOTLB=1` 13–17× slower on ld/st per [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md)).
- **Location:** `tcg-target.c.inc:1152-1160, 2262-2269, 2312-2336, 2423-2427`; `wasm64.c:1876-1884` (`w64_tb_account`), `wasm64.c:501-507` (`if (!LS.inited) w64_ls_init()` — dead since `w64_init` arms it eagerly). 0017.
- **Notes:** dropping `W64_NOACCTINLINE` also removes the `acc_*` import registration and the second import-table variant; dropping `W64_NOTLB` removes the `fast=false` arms of `tgen_qemu_ld/st`. Update [diagnostics.md](diagnostics.md) and `tools/tcgbench.mjs`.

### W-20 — The per-TB "temp module" path is effectively dead in the shipped configuration
- **Severity:** SIMPLIFY (~450 lines; perf: **unknown — needs A/B**, expected neutral-to-positive: 276 + 4·n_imp bytes less code buffer per TB, no per-TB prelude assembly, no `removeFunction` churn; removes W-04 entirely).
- **Location:** `tcg-target.c.inc:2432-2646` (prelude assembly, `struct w64_buf`, import table after the module), `wasm64.c:48-194` (`w64_instantiate`), `wasm64.c:1919-1932`, `1804-1829` (`w64_batch_close_pending`), `W64_DESC_MODLEN/NIMP/ICOUNT` in `wasm64.h`, `W64_NOBATCH`, `W64_NOCLOSEEXEC`. 0017, 0019.
- **Evidence:** `tcg_qemu_tb_exec` reaches `w64_instantiate` only when `w64_batch_close_pending(tb)` returns false, i.e. batching is off (`W64_NOBATCH`), `W64_NOCLOSEEXEC` is set, or the batch was skipped for corruption. In the default configuration every TB either lands with its batch on the 128th member or has its batch closed at its first execution, so `desc[FIDX]` is never 0-and-untagged at dispatch. The playbook confirms ("zero W64 diagnostics", "re-ensures stay 0"). Yet every TB still pays: the 256-byte prelude construction, the descriptor `mod_len`/`n_imp`/`icount` fields (`W64_DESC_ICOUNT` has **no reader** — only the write at `tcg-target.c.inc:2291`), and the per-TB `W.type/W.imp` tables whose only purpose is the temp module's own type/import sections.
- **Fix:** delete the temp-module path; on a failed batch assembly `abort()` (an emitter bug — W-01..W-05 show the walk-validation cannot catch the realistic failures anyway); shrink the descriptor to `{fidx, batch_tag|id, tidx}`; drop `w64_add_type`/`w64_import_idx` (call sites already record the union index, so `w64_callidx` can emit the 2-byte LEB of `uimp` directly; fixups then only matter for compaction). A/B: `tools/idlebench.mjs --quick` interleaved on `dist-jit` (t0.25G/t0.5G are the compile-bound milestones), plus a `W64_DEBUG=1` counter confirming zero temp instantiations first (open question §8.4).

### W-21 — Lockstep and chain-stop probes are emitted into every TB although lockstep is off
- **Severity:** SIMPLIFY (perf: **unknown — needs A/B**; one `i32.load`+`if` per TB entry (~5 M/s) and one `i32.load`+`i32.or` per chained jump; likely ≤ 1 %).
- **Location:** `tcg-target.c.inc:2323-2328, 2414-2422` (`w64_lockstep_account` import + `w64_ls_on` test), `:869-872, 927-930` (`w64_chain_stop` load in every `goto_tb`/`goto_ptr`); 0017.
- **Evidence:** `W64_LOCKSTEP` is read from the environment at process start and nothing changes it later, so the emitter can decide at translation time (cache the `getenv` in a static like `w64_tlb_inline()`), emit the import/test only when armed, and omit the `w64_chain_stop` term otherwise. The lockstep gate boots with `?lockstep=1` and still gets the instrumented code.
- **A/B:** `tools/tcgbench.mjs` (alu/branch phases isolate per-TB-entry and per-jump costs).

### W-22 — Three `#ifdef CONFIG_TCG_WASM64` hooks in `tcg/tcg.c` + the `tcg.h` declaration switch
- **Severity:** DEVIATION (minor; perf none).
- **Location:** `tcg/tcg.c:121-124, 253, 360-363, 1864, 6763-6766`, `include/tcg/tcg.h:937`.
- **Notes:** the `tcg_out_set_label` hook inside `tcg_out_label` is genuinely needed (no other backend callback fires at label placement). The `tcg_out_tb_finalize` hook could reuse an existing per-backend finalize slot (`TCG_TARGET_NEED_POOL_LABELS` + `tcg_out_pool_finalize`) — arguably hackier than one `#ifdef`; keep it but make it return an int so W-04/W-13 can report "TB too large" (`-2`). The two `#if !defined(CONFIG_TCG_INTERPRETER) && !defined(CONFIG_TCG_WASM64)` edits (`tcg.c:253/1864`, `tcg.h:937`) can all key off `HAVE_TCG_QEMU_TB_EXEC` (defined by both tci and wasm64 `tcg-target.h`), which shrinks the master diff to a macro rename and makes the epilogue assert (W-08) follow the same switch.

### W-23 — Hooks outside `tcg/wasm64/` that are not gated to the backend / target
- **Severity:** DEVIATION.
- **Items:**
  1. `accel/tcg/cputlb.c:70, 1575, 2435, 2977` — `wasm_diag_stat[]` defined and `TLB_FILL`/`IO_LD`/`IO_ST` incremented **unconditionally**: native builds pay a global read-modify-write per TLB fill and per MMIO access (also a data race under MTTCG). Every other counter in the file is `#ifdef __EMSCRIPTEN__`. Same for `tcg/tci.c:372,490` and `system/memory.c` (`TOPO_COMMIT` ×2, `TOPO_REUSED`, `ROMD_FLIP`). 0012/0014/0016. (= R-15.)
  2. `include/exec/translator.h:173` / `accel/tcg/translator.c:111` — `translator_note_succ` is a real out-of-line call (with an `#ifdef`-emptied body) on native builds from `translator_use_goto_tb`, `trans_BL`, `trans_BLX_i`; make it a `static inline` no-op when `!CONFIG_TCG_WASM64`. 0020.
  3. `accel/tcg/cpu-exec.c:401-417` — `W64_GET_TB_CPU_STATE` hard-binds `arm_get_tb_cpu_state` under `__EMSCRIPTEN__` (breaks an emscripten build of any other target); `curr_cflags_fast` re-implements `curr_cflags`'s three conditions (a silent divergence if upstream adds one). 0044. (= R-17.)
  4. `include/exec/translation-block.h:129-137` — 26 bytes per TB (`w64_succ[3]`, `w64_nsucc`, `w64_explored`) — fine (gated), but `w64_succ` could be `uint32_t[3]` since 0038 narrows the values to 32 bits anyway.

### W-24 — `addFunction` signature strings are wrong (harmless)
- **Severity:** STYLE. `wasm64.c:193` (`'jjji'`), `:885` (`'jjjii'`): emscripten's signature string is return-type-first (`'ijjj'`, `'ijjji'`). `addFunction` ignores `sig` for a real wasm export, which is why it works.

### W-25 — Register-file bookkeeping inconsistencies
- **Severity:** STYLE. `tcg_target_reg_alloc_order` lists `TCG_REG_R30` (`:2659`) but `tcg_target_available_regs` is `MAKE_64BIT_MASK(0, 28)` (`:2733`), so R30 is never allocatable; `TCG_REG_TMP` (R28) is reserved but never used (scratch goes through the `$scr*` locals); `W64_L64(TCG_AREG0)`/`W64_L64(TCG_REG_CALL_STACK)` are declared but unreachable — two dead i64 locals per function; `memset(&W, 0, sizeof(W))` (`:2279`) clears ~12 KB per translation where resetting six counters suffices; `i64.eq` against `tcg_code_gen_epilogue` where `i64.eqz` would do (W-08).

### W-26 — Memory import hard-codes the 2 GB heap
- **Severity:** STYLE (robustness). `tcg-target.c.inc:2529-2532`, `wasm64.c:1061-1064` (`min = max = W64_MEM_PAGES` 32768). Correct for `-sTOTAL_MEMORY=2GB` without growth; any change to the link flag becomes a link error at the first instantiation, and `W64_EXIT_GOTOPTR`/`exit_tb`'s 31-bit pointer assumption (`wasm64.h:86-89`) silently depends on it too. A runtime check in `w64_init` (`emscripten_get_heap_max() == 2 GiB`) would make the dependency explicit.

### W-27 — Dead and duplicate items from the cross-check
- **Severity:** REMOVE / STYLE. Raised by the parallel GLM review (part 2, B1/B5/B8/B10/A7); verified unless marked.
- `tcg-target.c.inc:358-361`: `w64_out_desc_u32` is defined and never called (the descriptor is written with `stl_p` directly). Delete.
- `tcg-target.h:184` duplicates `TCG_TARGET_HAS_qemu_ldst_i128` from `tcg-target-has.h:9` (goes with W-16).
- `W.blk[].kind` is write-only; `w64_add_type(0, NULL, …)` passes `NULL` to a zero-length `memcpy` (technically UB); `W64_NOBATCH` treats an empty value as unset while every other knob treats presence as set. All trivial.
- **Not independently verified here:** the forensic re-walk in `w64_assemble_instantiate` may read `mod.b[k]` past `mod.n` when a member's declared body length is inconsistent (the final total check runs after the reads) — moot if W-18 removes the walk; `w64_union_import` (`wasm64.c:715`) does not check that a batch is open, unlike `w64_union_type` — every current caller pairs the two.

### W-28 — Perf opportunities flagged by the parallel review (need measurement; not review findings)
- **Label-region chain:** every taken intra-TB branch re-enters the loop head and walks the `if (bp <= k)` guards, O(#labels) per taken branch, ~10 B of code per label. A `br_table` over the regions (one indirect branch) is the structural alternative; the backend plan does not list it today. Meter: `tools/tcgbench.mjs` branch phase.
- **`TCG_REG_R30`:** instead of dropping it from the allocation order (W-25), make it allocatable (`MAKE_64BIT_MASK(0, 29)`, 29 registers instead of 28); expect ≤ 1 %, A/B before keeping.

### Verified correct in the backend (recorded so the coverage table means something)
- **LEB/encoding:** `w64_uleb/sleb32/sleb64` standard; the 5-byte padded `i32.const` for forward branches is a valid non-minimal `sleb32` for values < 2^28; the 2-byte padded `call` index is a valid non-minimal LEB; `mb_uleb_p5` for the code-section size; all i32/i64 opcodes, comparison opcodes, memory opcodes, `if (result t)` block types, `0xfe 0x11/0x18` atomics with align 3, `return_call_indirect typeidx=0 tableidx=0` operand order, active element segments, memory64 memarg (i64 address, u64 offset LEB), locals layout (3 params + 33 i32 + 32 i64 + 1 i32 + 3 i64 → indices used by `W64_L32/L64/L_BP/L_SCR*`); the function ends `end(if) end(loop) i32.const 0 end`, which validates.
- **Label scheme:** `loop { if (bp<=0) R0 end if (bp<=1) R1 end … }` with `bp` set + `br loop` is sound for forward and backward branches; `br` depth = `n_blk-1-loop_idx` is right for every nesting the emitter creates.
- **Representation tracking (`W.rep`):** safe because master's allocator guarantees every temp is `TEMP_VAL_MEM`/`CONST`/`DEAD` at every label (`tcg_reg_alloc_bb_end` → `temp_save`), so no register value flows across a control-flow merge; the only mixed-type path (`extrl_i64_i32` as a plain mov / register reuse in `tcg_reg_alloc_mov`) is handled by the per-register rep. The `data == addr` hazard in `qemu_ld` is handled by the `$scr2` snapshot.
- **Calls:** slot layout (`8*i`, i32 stored/loaded as 32-bit LE), typemask decoding for i32/s32/i64/s64/ptr, return → `R0` local with rep update, clobber set `{R0,R1}` (wasm locals survive calls), `TCG_CALL_NO_*` handled by the core; the `tp` store of `ra + GETPC_ADJ` before every call resolves through `cpu_unwind_data_from_tb` to the containing insn because `gen_insn_end_off[]` and `ra` are both `code_buf`-relative and `tb->tc.size` covers prelude + body + import table; `qemu_ld/st` pass their `ra` explicitly. (0034's `getpc.h` change is correct.)
- **TLB probe:** matches aarch64's `prepare_host_addr`: `fast_ofs` via `tlb_mask_table_ofs` (fast index, not mmu_idx), index `(addr >> (PAGE_BITS-5)) & mask` as a byte offset, compare `addr_read/addr_write` against `(addr + (s_mask-a_mask)) & (PAGE_MASK|a_mask)` (page-straddle and misalignment go to the helper), flags bits 6–8 can never match, addend arithmetic in i64, 32-bit guest addresses zero-extended, `MO_BSWAP`/non-NONE/IFALIGN atomicity → helper, victim TLB left to the helper, helper signatures match `helper_ld*_mmu`/`st*_mmu`, `MemOpIdx` as i32.
- **Ops:** add/sub/mul/and/or/xor/shl/shr/sar/rotl/rotr/div*/rem* (wasm masks shift counts; traps on /0 and INT_MIN/-1 are UB in TCG too), andc/orc/eqv/nand/nor, neg/not/ctpop, clz/ctz with the zero-operand select, setcond (i32 rep zero-extends correctly for I64), movcond via `if (result t)`, brcond/brcondi, mulu2/muls2/muluh/mulsh (I32; I64 forms `C_NotImplemented`), extract, deposit I64, bswap16 (both types, all flags), bswap32 I32, bswap64, ext*/extr*, ld/st all sizes with negative env offsets, `sti`, `addi_ptr`, `exit_tb` (31-bit pointer in an i32 return), `goto_tb` (reads `jmp_target_addr[n]` at run time; `tb_target_set_jmp_target` no-op, TCI-style), `goto_ptr` (tail call when `fidx != 0`, else the `[sp-8]` handoff — **the 0022 handoff path is still live as the uninstantiated-target fallback, not dead**), `tcg_target_const_match` accepts all (I32 consts sign-extended by `tcg_constant_internal`, truncated on emission).
- **Chaining/invalidation:** `tb_phys_invalidate → tb_jmp_unlink → tb_reset_jump` rewrites the slot the emitted code re-reads; `CF_INVALID` filtered by `tb_lookup`; `tb_flush` runs `w64_batch_flush` before `tcg_region_reset_all` in serial context with no TB on the stack; eviction/compaction only run from C between TBs, never under a live wasm frame; the `fidx==0` guard makes chains into evicted members fall back to the dispatcher, which re-ensures the batch; the `icount_decr` check is emitted by `gen_tb_start` at the top of every TB body, so chained/tail-called TBs still observe interrupts and the icount budget; `cpu_exec_loop`'s `last_tb/tb_exit` contract holds.
- **Speculation:** non-faulting probes (`probe_access_full_mmu`) before any faulting `get_page_addr_code` for the target *and* the following page; `cflags` equals `curr_cflags` (excludes the one-shot `CF_COUNT`/`CF_LAST_IO`/`CF_MEMI_ONLY`); speculated TBs are ordinary hash entries keyed by `(phys_pc, pc, flags, cs_base, cflags)`, so a later mode/mapping change simply fails to match them; a `tb_flush` during speculation is detected via `tb_flush_count`; 1 MB headroom check; `explored` flag lifetime = TB lifetime.
- **Runtime:** synchronous `new WebAssembly.Module` is legal in a worker; TAB grows before any element segment can index past it; `removeFunction` never targets a running thunk; no leaks in `w64_batch_close`/`w64_compact`/`w64_landed_free*`/`w64_assemble_instantiate`; `B`/`W` are `__thread`, everything else is touched only by the single vCPU thread (rr); stack depth is bounded (tail calls for chains, plain calls for helpers, no helper re-enters `cpu_exec`; `cpu_loop_exit` unwinds JIT frames via the JS exception).
- **Gating/portability:** `tcg/meson.build` adds `wasm64.c` only for `host_arch == 'wasm64' && !tcg_interpreter`; `CONFIG_TCG_WASM64` is false on every native build and on the TCI wasm build; all `tcg.c`/`tcg.h` edits are ifdef-gated; `tcg/region.c`'s `PROT_EXEC`/`mprotect` paths are no-ops on emscripten.

## 4. Findings — everything else (`R-nn`)

### R-01 — `qemu_futex_wait()` on emscripten passes a 0 ms timeout: every `QemuEvent`/`QemuLockCnt` wait busy-spins
- **Severity:** BUG-HIGH (wasm, shipped). **Introduced:** 0002 (`include/qemu/futex.h:81`).
- **Evidence:** `include/qemu/futex.h:78-82`:
  ```c
  static inline void qemu_futex_wait(void *f, unsigned val)
  {
      /* 0 timeout = wait indefinitely; spurious wakes are allowed by design */
      emscripten_futex_wait(f, val, 0);
  }
  ```
  The comment is false. emsdk 4.0.10 `system/lib/pthread/emscripten_futex_wait.c`: `int64_t max_wait_ns = -1; if (max_wait_ms != INFINITY) { max_wait_ns = (int64_t)(max_wait_ms * 1000 * 1000); }` → a 0 ms wait is a 0 ns `memory.atomic.wait32`, i.e. immediate `-ETIMEDOUT`. Measured (standalone emcc test on a pthread): returns in 0.041 ms. Patch 0021 already discovered exactly this for `QemuCond` ("`qemu_cond_wait_impl` passed 0 ms … every untimed wait was a lock/unlock spin") and fixed `util/qemu-thread-posix.c` with `INFINITY`, but `futex.h` was left as is. `HAVE_FUTEX` stays defined for emscripten (`futex.h:27`; the `#undef` is only in the final `#else`), so `util/event.c:qemu_event_wait()` takes the futex path: `while (true) { … qemu_futex_wait(ev, EV_BUSY); }` — with an immediately-returning wait this is a tight spin (each iteration also calls `_emscripten_yield`). Same for `util/lockcnt.c` contended paths.
- **Why it matters:** `call_rcu_thread` sits in `qemu_event_wait(&rcu_call_ready_event)` whenever no RCU callback is pending — at the idle screen the RCU worker pegs one core for the lifetime of the page; during boot it spins between `call_rcu`s. `wait_for_readers()` (`synchronize_rcu`, `drain_call_rcu`) spins on the main-loop worker. [wasm-threads-audit.md](wasm-threads-audit.md) measured "three busy DedicatedWorker threads at ~35 % each" during boot and attributed the non-vCPU ones to "waiting"; a thread parked in `emscripten_futex_wait` and one spinning through it are indistinguishable in the CDP profile that audit used, so the audit does not exclude this.
- **Fix:** `emscripten_futex_wait(f, val, INFINITY)` and fix the comment. Then verify with OS-level per-thread CPU at the idle screen (`/proc/<pid>/task/*/stat` on the renderer, as in the audit's §1). The playbook's `tIdle`/`t1.3G` numbers may move on loaded hosts if the spinning worker was stealing CPU.
- **Confidence:** high for the semantics (proven) and the composition (upstream `qemu_event_wait` is unchanged); the *observable* CPU cost should be confirmed by the measurement above.

### R-02 — Under the real-time cap the main loop hands a virtual deadline back to the vCPU with a plain `qemu_cpu_kick`, which cannot wake an idle rr thread: latent guest hang
- **Severity:** BUG-MED (latent hang in the shipped `QEMU_ICOUNT_RTCAP=banked` wasm configuration; HIGH if the trigger is ever hit). **Introduced:** 0032 (`accel/tcg/icount-common.c:405-416`), interacting with 0023 (`tcg-accel-ops-rr.c:133`).
- **Evidence:** `icount-common.c:405-416`:
  ```c
  if (icount_rtcap && !qemu_in_vcpu_thread()) {
      if (!qatomic_read(&rtcap_vcpu_waiting)) {
          qemu_cpu_kick(first_cpu);
      }
      return;
  }
  ```
  Stock uses `qemu_clock_notify()` → `qemu_timer_notify_cb()` → `async_run_on_cpu(first_cpu, do_nothing)` precisely because (stock comment) "qemu_cpu_kick is not enough to kick a halted CPU out of qemu_tcg_wait_io_event". `rr_wait_io_event()` loops `while (all_cpu_threads_idle() && replay_can_wait()) qemu_cond_wait_bql(first_cpu->halt_cond)`; a kick only broadcasts the cond (and sets `exit_request`, which `cpu_thread_is_idle()` ignores), so the thread goes straight back to sleep with the deadline unhandled.
  When can the vCPU be in the untimed wait with a virtual deadline pending? `rr_idle_advance()` (`tcg-accel-ops-rr.c:133`) is bounded: `for (i = 0; i < 64 && all_cpu_threads_idle(); i++)`. After 64 consecutive non-interrupting virtual deadlines in one halt it returns with deadlines still pending, `rr_cpu_thread_fn` calls `qemu_notify_event()` and parks in `rr_wait_io_event()`. The main loop then runs `icount_start_warp_timer()` (`util/main-loop.c:691`) and takes the branch above. With `rt=off` (native, benchmarks) the stock path wakes the vCPU correctly, so only the shipped `rt=banked`/`strict` page is exposed; recovery needs an external event that makes the CPU non-idle (key press, DSP/host timer raising an IRQ).
- **Fix:** replace the kick with `async_run_on_cpu(first_cpu, do_nothing, RUN_ON_CPU_NULL)` (mirroring `qemu_timer_notify_cb`), or remove the 64 bound in `rr_idle_advance` (keep the BQL release per iteration) so it never exits with a pending deadline, or make `rr_cpu_thread_fn` skip `rr_wait_io_event` while a virtual deadline is pending.
- **Confidence:** high on the logic; the reachability of 64 back-to-back non-interrupting deadlines on these boards is not demonstrated (the RTC ptimer / completion timers are candidates). A 5-minute idle-screen soak with `rt=banked` and a counter on the `i == 64` exit settles it.

### R-03 — The range-scoped topology flush no longer clears `tb_jmp_cache`; a remap can execute a stale TB
- **Severity:** BUG-MED (generic, un-gated; reachable on this board; usually self-healing). **Introduced:** 0016 (`accel/tcg/cputlb.c:571`, `system/physmem.c:3106-3127`).
- **Evidence:** Stock `tcg_commit_cpu` did `tlb_flush(cpu)`, whose `tlb_flush_by_mmuidx_async_work` ends with `tcg_flush_jmp_cache(cpu)` (`cputlb.c:465`). HEAD `tcg_commit_cpu` (`physmem.c:3119-3124`) calls `tlb_flush_phys_ranges()` for *every* topology commit that is not `pend_all`, and `tlb_flush_phys_ranges()` never touches the jump cache (the only other clear is in the page-range flush, `cputlb.c:950`). The jump cache is virtual-pc-indexed: `tb_lookup()` (`cpu-exec.c:245-266`) returns a TB on `(pc, cs_base, flags, cflags)` equality without consulting the TLB or the TB's physical page. After a topology change that puts different code behind the same guest physical address, a jump-cache hit returns the TB translated from the *old* mapping; only a qht lookup (`get_page_addr_code` → new phys page) would find the right one.
  Reachable here: `hw/arm/pmb887x/scu.c:218` toggles the BROM mirror at address 0 (`memory_region_set_enabled(p->brom_mirror, ROMAMCR.MOUNT_BROM)`), `hw/arm/pmb887x/tcm.c:46-58` inserts/removes/resizes the TCM regions, `ebu.c:87-92` remaps chip-select regions. Generic upstream cases: x86 PAM/SMRAM shadowing, ARM boards with a remappable boot ROM. The romd toggle itself is the benign case (same bytes behind the page). The stale entry survives until the guest's next TLB maintenance, which is why the suites do not catch it.
- **Fix:** call `tcg_flush_jmp_cache(cpu)` from `tcg_commit_cpu` whenever the commit was *not* romd-only (memory.c knows: set a flag on the full path), and keep the romd-only path jump-cache-free. Cost: one 64 KB clear per real topology change — what stock paid on every commit.
- **Confidence:** high on the mechanism; not demonstrated on the boards (needs a jc hit on a remapped page in the same mode before the next guest TLB flush).

### R-04 — Fill-time MMIO dispatch: `io_swap` is inverted on big-endian hosts
- **Severity:** BUG-MED (generic; big-endian hosts). **Introduced:** 0018 (`accel/tcg/cputlb.c:1302-1303`).
- **Evidence:** `full->io_swap = (((MO_BE & MO_BSWAP) != 0) != dev_be) | ((((MO_LE & MO_BSWAP) != 0) != dev_be) << 1);` — the intent is stock `adjust_endianness()`: swap iff `(op & MO_BSWAP) != devend_memop(endianness)`. On a big-endian host `MO_BE == 0` and `MO_LE == MO_BSWAP` (`include/exec/memop.h:32-36`), so bit 0 evaluates to `dev_be` instead of `!dev_be` (and bit 1 to `!dev_be` instead of `dev_be`): every MMIO access through a resolved entry is byte-swapped the wrong way on s390x/ppc64be hosts. The expression is right only because little-endian hosts make `MO_BE != 0`.
- **Fix:** the read piece is always big-endian-assembled and the write piece little-endian, so the host-independent form is `io_swap = (!dev_be) | (dev_be << 1)`.
- **Confidence:** high (pure reading of the macro definitions); no BE host available.

### R-05 — Fill-time MMIO dispatch drops stock's per-access value masking
- **Severity:** BUG-MED (generic; sloppy device models / multi-piece accesses). **Introduced:** 0018 (`cputlb.c:2395`, `2939`).
- **Evidence:** stock `memory_region_read_accessor` does `*value |= (tmp & mask) << shift` with `mask = MAKE_64BIT_MASK(0, access_size * 8)`; stock `memory_region_write_accessor` passes `tmp = (*value >> shift) & mask`. The fast path passes the raw return value (`val = full->io_read_fn(...)`) into `ret_be = (ret_be << (this_size * 8)) | val` and passes the full `val_le` (up to 64 bits) to `io_write_fn` for a `this_size`-byte piece. A device returning e.g. `0xFFFFFFFF` for a 2-byte read (common for "unimplemented register") corrupts the preceding piece of a split load; a device that stores `value` into a wider field sees the next piece's bytes.
- **Fix:** `val &= MAKE_64BIT_MASK(0, this_size * 8)` after the read call; `tmp &= MAKE_64BIT_MASK(0, this_size * 8)` before the write call (one AND each).
- **Confidence:** high.

### R-06 — Fill-time MMIO dispatch caches `!mr->ioeventfd_nb` but `memory_region_add_eventfd` never flushes TLBs
- **Severity:** BUG-MED (generic; virtio/vhost ioeventfd on TCG). **Introduced:** 0018 (`cputlb.c:1287`).
- **Evidence:** `if (ops->write && !mr->ioeventfd_nb) full->io_wmask |= …` is evaluated once at fill time. `memory_region_add_eventfd()`/`del_eventfd()` only set `ioeventfd_update_pending`, and `memory_region_transaction_commit`'s `else if (ioeventfd_update_pending)` branch neither re-renders nor calls the listener `commit` (no `tcg_commit`, no flush). A TLB entry for a virtio-mmio/virtio-pci notify page filled before the guest configured the queue keeps dispatching writes directly to `ops->write`, bypassing `memory_region_dispatch_write_eventfds()` — the iothread/vhost backend is never kicked.
- **Fix:** make `memory_region_add_eventfd/del_eventfd` take the full commit path (`memory_region_update_pending = true`), or resolve `io_wmask` without the ioeventfd shortcut and check `mr->ioeventfd_nb` at access time (one load).
- **Confidence:** high on the code path; not exercised by this board.

### R-07 — TCI direct helper dispatch assumes a little-endian host (and trips CFI)
- **Severity:** BUG-MED (generic TCI on big-endian hosts; `--enable-cfi` builds). **Introduced:** 0003 (`tcg/tci.c:534-620`, `1219-1237`).
- **Evidence:** i32 helper arguments are stored by the backend with `tcg_out_st(TCG_TYPE_I32)` → `INDEX_op_st32` (`tcg/tci/tcg-target.c.inc:1350-1358`): a 4-byte store at offset 0 of the 8-byte slot. `tci_call_direct` reads them as `(uint32_t)stack[i]` — the low half of the `uint64_t` slot — which on a big-endian host is the *other* half (libffi reads 4 bytes at `call_slots[i]`, so stock is right). Likewise the u32 return: `stack[0] = (uint32_t)ret` on a 32-bit BE host is read back by stock `regs[TCG_REG_R0] = *(uint32_t *)stack` from the wrong half. Also, `tci_call_direct` calls helpers through prototypes that differ from the real ones (`uint32_t` for `int32_t`/pointer params, etc.); with `--enable-cfi` (`-fsanitize=cfi-icall`) that aborts — `tcg_qemu_tb_exec` is `QEMU_DISABLE_CFI` but `tci_call_direct` is a separate non-inlined function without it.
- **Fix:** read/write the i32 slots via `*(uint32_t *)&stack[i]` (matching the backend's store) or store i32 args zero-extended (`TCG_CALL_ARG_EXTEND`), and mark `tci_call_direct` `QEMU_DISABLE_CFI`. The per-call `tci_call_tag()` loop can also be precomputed at emit time next to `[func, cif]` (SIMPLIFY, TCI tier only).
- **Confidence:** high (layout verified in `tcg_out_st`); no BE host to run.

### R-08 — TCI generic fast path dereferences unaligned host pointers
- **Severity:** BUG-MED (generic TCI on strict-alignment hosts; UB elsewhere). **Introduced:** 0011 (`tcg/tci.c:399-478`).
- **Evidence:** `tci_tlb_probe()` admits an access with `a_mask < s_mask` (`MO_ATOM_IFALIGN`/no `MO_ALIGN`, misaligned within the page — the compare uses `addr + (s_mask - a_mask)` like native backends) and `tci_ld_fast`/`tci_st_fast` then do `v = *(uint32_t *)haddr` (`tci.c:430`) etc. Native backends only emit such loads on hosts that support them; stock TCI never dereferenced guest memory itself (helpers use `ld*_p`/memcpy). On SPARC/m68k/strict ARM32 this is SIGBUS. The size-specialised ops (0012) are safe: `tci_probe_a` requires the low `s_mask` bits clear.
- **Fix:** use `ldl_he_p`/`stl_he_p`-style memcpy accessors (identical code on x86/wasm).
- **Confidence:** high.

### R-09 — wasm main-loop futex wait: reset-then-wait loses a wake that arrives after the timeout was computed
- **Severity:** BUG-MED (wasm shipped; bounded latency, not a hang). **Introduced:** 0009 (`util/main-loop.c:361-367`).
- **Evidence:** `os_host_main_loop_wait()` does `qatomic_set(&ml_futex_wake, 0); … emscripten_futex_wait(&ml_futex_wake, 0, timeout)`. The wake side is `if (qatomic_xchg(&ml_futex_wake, 1) == 0) emscripten_futex_wake(...)`. A `qemu_notify_event()`/`aio_notify()` from the vCPU thread between `main_loop_wait`'s timeout computation (`aio_ctx_prepare`, `timerlist_deadline_ns`) and the `qatomic_set(…, 0)` sets the flag to 1, which the waiter then clears before sleeping — the wake is lost and the BH/timer runs only at the computed timeout. Stock is race-free because the eventfd stays readable and `notify_me` protects the window. The worst case is the display refresh timer (≤ 500 ms idle), so key input / the flash write BH / `qemu_clock_notify` for REALTIME timers armed from the vCPU (DSP PCM refill, icount2 completion timers) can lag up to 0.5 s.
- **Fix:** use a sequence counter: snapshot `seq` *before* computing the timeout (in `main_loop_wait`), wake = `seq++` + `futex_wake`, wait = `futex_wait(&seq, snapshot, timeout)`; or clear the flag in `main_loop_wait` before `glib_pollfds_fill`/`aio_ctx_prepare`.
- **Confidence:** high on the race; frequency not measured.

### R-10 — AFE cherry-pick silently switches every board to the HLE DSP stub on native builds; the LLE-side changes in the same commit are dead code
- **Severity:** DEVIATION (large, un-gated behavioural change of the native reference). **Introduced:** `10403b1df9` (`hw/arm/pmb887x/dsp.c:49`).
- **Evidence:** master: `// #define STUB_DSP 1` (the LLE Teak core on a worker thread is the model). HEAD: `#define STUB_DSP 1`. The whole `#else` half of `dsp.c` — including the ~150 lines this commit adds there (`dsp_afe_timer_cb`, `dsp_wait_comm_clear`, `comm_pending`, the paced worker loop, `dsp_runtime_pace_afe` consumers) — is compiled out; the gcc warning `dsp_exec_command_ch0 defined but not used` is from the stub half. [upstream-branch.md](upstream-branch.md) § Safety properties says "Everything that changes semantics under native builds is either `__EMSCRIPTEN__`-gated … or confined to the TCI interpreter"; this commit contradicts that. The native suite passes with the stub, so it is the fork's reference now, but lockstep/native comparisons no longer exercise the LLE DSP that qemu-pmb887x master runs, and the `runtime.c`/`peripheral.c`/`afe.c` LLE changes (`dsp_bus_advance_afe`, `dsp_bus_advance_timers`, `dsp_runtime_pace_afe`) are untestable in this tree. (versions.env records that master alone aborts every Siemens fullflash in L1 GSM frame handling and this commit is what fixes it — so the *stub* is the working configuration; the deviation is that it is a silent global `#define`.)
- **Recommendation:** make the choice explicit and per-build (a meson option or a board-config key, defaulting to LLE natively and HLE on wasm, or HLE everywhere with the docs updated), and drop the dead `#if 0` debug blocks (`dsp.c:892`, `dsp/runtime.c:227`). The STUB path is self-consistent: the PCM block read (`DSP_PCM_BUF_WORD + DSP_PCM_MAX_WORDS - 1 = 2975` words) is inside `DSP_RAM_SIZE` (3072 words); the audio FIFO is mutex-protected; `afe_audio_set_format` reopens the voice under the BQL.
- **Confidence:** high.

### R-11 — romd FlatView stash: lifetime and identity edge cases
- **Severity:** BUG-LOW (three related latent issues; generic, un-gated). **Introduced:** 0016 (`system/memory.c:86-186`, `1281-1320`, `1338`).
- **(a) Stash eviction outside a transaction leaves a freed view referenced by the TLB.** `romd_stash_record()` (`memory.c:149-161`) unrefs the evicted view and sets `romd_stash_evicted`; the only consumer is `tcg_commit()` during a listener commit. `address_space_init()` → `address_space_update_topology()` → `generate_memory_topology()` runs *without* a commit (device hot-plug with its own AS, CPU hot-plug): the evicted view's refcount can reach zero and `flatview_destroy` is RCU-scheduled while TLB entries filled against it (`CPUTLBEntryFull.section` points into `view->dispatch`) survive until the next commit's full flush. Not reachable on pmb887x (all AS at machine init, TLB empty).
- **(b) The stash keeps up to 16 stale generations alive.** Every `generate_memory_topology()` result is stashed, including the full-path renders whose `topo_gen` can never match again (lookup requires `s->gen == topo_gen`). Each stashed view holds `memory_region_ref()` on every MR it covers and its whole dispatch radix tree, so a hot-unplugged device is not finalised (no `DEVICE_DELETED`) until 16 later topology commits evict it, and 16 dispatch trees of a large machine stay resident. **SIMPLIFY:** drop all stash slots whenever `topo_gen++` runs (`memory.c:1338`) — they are dead by construction — and set the evicted latch there. That also bounds (a) to the romd path.
- **(c) `romd_signature()` hashes only the first 16 off-list MRs** (`memory.c:120`, `n = MIN(len, 16)` before sorting): two different sets that share the same first 16 insertion-ordered pointers hash equal → a wrong variant is adopted. Needs > 16 ROM-device MRs in command mode simultaneously (pmb887x creates one rom_device MR per flash partition, `flash.c:1056`). Fix: hash all entries, or force `topo_gen++`/no-reuse when `len > 16`.
- Also: the header comment (`memory.c:74-76`) says `topo_gen` is bumped "in finalize" — it is not (`memory_region_finalize` only removes the MR from the off-list); the reasoning still holds because the earlier `del_subregion` bumped it, but the comment is wrong.
- **Confidence:** high for (b)/(c); (a) medium (needs a hot-plug scenario).

### R-12 — `cpu_handle_interrupt` early return can livelock record/replay; `rr_idle_advance` changes checkpoint order
- **Severity:** BUG-LOW (record/replay only). **Introduced:** 0013 (`accel/tcg/cpu-exec.c:1036-1039`), 0023 (`tcg-accel-ops-rr.c:167`).
- **Evidence:** `cpu_handle_exception()` returns `false` with `exception_index >= 0` in the replay branch (`else if (!replay_has_interrupt())` fall-through: replay has an interrupt to deliver first). The new `if (unlikely(cpu->exception_index >= 0)) return true;` at the top of `cpu_handle_interrupt` then bounces straight back to `cpu_handle_exception` without ever processing the interrupt — an infinite loop in replay mode. Separately, `rr_idle_advance()` calls `icount_start_warp_timer()` from the vCPU thread, whose `replay_checkpoint(CHECKPOINT_CLOCK_WARP_START)` stock only issues from the main loop, so recordings change order. Outside replay the early return is semantically identical to the longjmp path (verified: `last_tb` reset per outer iteration, `cpu_tb_exec` sets `can_do_io`, the `u16.high` clearing is redundant but harmless).
- **Fix:** make the early return conditional on a dedicated "inline exception pending" flag set only by `gen_exception_exit`/`helper_wfi` (or on `replay_mode == REPLAY_MODE_NONE`), and gate the whole thing `#ifdef __EMSCRIPTEN__` — it exists only for wasm and costs every build a branch per loop iteration.
- **Confidence:** high.

### R-13 — `qemu_timer_notify_cb` budget check reads the virtual clock inside a timer notify: new "Bad icount read" exposure
- **Severity:** BUG-LOW (latent; icount, all builds). **Introduced:** 0028 (`system/cpu-timers.c:262-270`).
- **Evidence:** `qemu_clock_deadline_ns_all(QEMU_CLOCK_VIRTUAL, …)` → `qemu_clock_get_ns` → `icount_get_raw_locked()`, which `exit(1)`s with "Bad icount read" if `cpu->running && !cpu->neg.can_do_io`. Stock `qemu_timer_notify_cb` never touched the clock. Any `timer_mod()` on the vCPU thread with `can_do_io == false` now aborts — today none exists (MMIO callbacks run with `can_do_io` true via the rewind or the wasm skip; ARM cp15 timer writes are `ARM_CP_IO`), but a target helper arming a timer without `translator_io_start()` would trip it. The check itself is correct (`left = u16.low + icount_extra` is conservative at TB granularity).
- **Fix:** compute the deadline only when `cpu->neg.can_do_io` (else keep the stock unconditional `cpu_exit`).

### R-14 — Fill-time TLB growth frees `fulltlb` under callers that may hold a `CPUTLBEntryFull *`
- **Severity:** BUG-LOW (generic; needs an audit of `probe_access_full` users). **Introduced:** 0040 (`cputlb.c:1425-1434`).
- **Evidence:** the growth path inside `tlb_set_page_full` calls `tlb_flush_one_mmuidx_locked` → `tlb_mmu_resize_locked` → `g_free(fast->table); g_free(desc->fulltlb)`. cputlb's own callers re-derive `index`/`entry`/`full` after a fill (`mmu_lookup1` "maybe_resized", `probe_access_internal`, `atomic_mmu_lookup`, `mmu_lookup`'s two-page case) — verified. Upstream only resizes at flush time, so target code that keeps the `pfull` from one `probe_access_full()` across a second probe of the same mmu_idx (e.g. `target/arm/tcg/mte_helper.c:allocation_tag_mem_probe`, not built for this board) was safe and now sees a dangling pointer every 2·n fills. Also `n_fills` counts same-page refills (`TLB_INVALID` sub-page entries), which can inflate growth on guests with pages smaller than `TARGET_PAGE_SIZE` (perf only). `n_used_entries`, `c.dirty`, window stats and the victim table are handled.
- **Fix:** audit the `probe_access_full*` users that cache `full`, or perform the growth at the *next* flush instead of in the fill (record "wanted size"), which keeps upstream's invariant.

### R-15 — `wasm_diag_stat[]` increments are un-gated on native in several places
- **Severity:** REMOVE (no perf value natively; data race under MTTCG). **Introduced:** 0012/0014/0016. (= W-23.1.)
- **Evidence:** un-gated increments: `cputlb.c:1575` (`tlb_fill_align`, every TLB fill), `cputlb.c:2435` and `2977` (`do_ld_mmio_beN`/`do_st_mmio_leN`, every MMIO access), `tcg/tci.c:372,490` (helper fallbacks), `system/memory.c` (`TOPO_COMMIT` ×2, `TOPO_REUSED`, `ROMD_FLIP`). Plain `++` on a global from vCPU threads; a cache line on every fill/MMIO on native. Everything else is behind `#ifdef __EMSCRIPTEN__`.
- **Fix:** wrap all of them in `#ifdef __EMSCRIPTEN__` (or a `wasm_diag_inc()` macro that compiles to nothing natively). Perf: native none/slightly positive; wasm none.

### R-16 — `meson.build` comments out `subdir('tests')` for every host
- **Severity:** REMOVE. **Introduced:** 0017 (`meson.build:4642`).
- Committed state: `#if host_os != 'emscripten'` / `#  subdir('tests')` / `#endif` — native builds lose the whole test tree (qtest, unit tests). The working tree already restores it; commit that. (`-Dqom_cast_debug=false` lives in the build script only, not the tree; fine.)

### R-17 — `curr_cflags_fast` / `arm_get_tb_cpu_state` hard-wire the ARM target into generic `cpu-exec.c`
- **Severity:** DEVIATION (breaks any other emscripten target). **Introduced:** 0044 (`cpu-exec.c:401-411`). (= W-23.3.)
- **Evidence:** `TCGTBCPUState arm_get_tb_cpu_state(CPUState *cs); #define W64_GET_TB_CPU_STATE(cpu) arm_get_tb_cpu_state(cpu)` under `#ifdef __EMSCRIPTEN__`. Measured gain −2…−4 % on milestones (playbook 0044), so keep the idea but implement it target-neutrally: a `CONFIG_TARGET_ARM`-guarded include of the target hook, or `-flto` for the wasm link (the devirtualisation then happens automatically). `curr_cflags_fast` (inline copy of `curr_cflags`) should live next to `curr_cflags` as `static inline` in a header so both builds share it.

### R-18 — `wasm_peek()`/`wasm_reg()` read guest state from the JS main thread without RCU/BQL
- **Severity:** BUG-LOW (diagnostics only). **Introduced:** 0002/0012 (`ui/wasm.c:193-222`).
- `cpu_memory_rw_debug()` → `address_space_translate` takes `rcu_read_lock()` on a thread never registered with RCU and races with the vCPU. Only used by tooling; document "call only while paused" or route through a BH.

### R-19 — Inline SVC exit (0013): correct for the shipped core; two nits
- **Severity:** BUG-LOW / STYLE. (`target/arm/tcg/translate.c:1074-1088`, `7086-7091`.)
- Verified equivalent to `raise_exception()` for A32 without EL2/EL3/M: `target_el` is 1 in both `exception_target_el()` and `default_exception_el()`, `arm_hcr_el2_eff()` is 0, the syndrome is the same constant, `condexec` is synced by `arm_tr_tb_stop`, PC by `trans_SVC`, `ss_active` keeps the helper, icount accounting is unchanged (SVC ends the TB). Nits: the `exception_index` store uses `offsetof(CPUState, exception_index) - sizeof(CPUState)` (relies on the `env`-follows-`CPUState` build assertion; the upstream idiom is `offsetof(ArchCPU, parent_obj.exception_index) - offsetof(ArchCPU, env)`), and `HELPER(wfi)`'s added `cs->neg.can_do_io = true` (`op_helper.c:418`) is redundant (`cpu_tb_exec` sets it after every TB).

### R-20 — `helper_cpsr_write` hflags skip (0045): sound, upstreamable
- `cpsr_write()` writes NZCV/Q/GE/IT/T only into the dedicated fields (`CACHED_CPSR_BITS`), and `arm_get_tb_cpu_state()` adds `THUMB`/`CONDEXEC` dynamically, not via `env->hflags`; every `rebuild_hflags_a32` input the instruction can touch (mode → EL/mmu_idx/SCTLR, E, IL, PAN) lives in `uncached_cpsr`. `cpsr_write_check_irq()` sets `icount_decr.u16.high = -1`, which the next TB's `gen_tb_start` brcond honours, and `cpu_loop_exec_tb` returns on the negative `u32` without touching the icount budget — same as `cpu_exit`. Recommend sending upstream.

### R-21 — Victim-TLB masked compare (0018 part b): an upstream bug fix, send it
- `victim_tlb_hit()` (`cputlb.c:1730`) now uses `tlb_hit_page(cmp, page)` instead of `cmp == page`; entries carrying `TLB_FORCE_SLOW`/`TLB_NOTDIRTY` in `addr_idx` could never hit the victim TLB upstream. Correct and independent of everything else.

### R-22 — `tlb_flush_phys_ranges` / phys summary (0016/0043): correct apart from R-03
- Verified: victim table walked; `tlb_n_used_entries_dec` maintained; `large_page_*` left conservative; summary bits only added on fill/promotion and rewritten exactly when a group is walked; `tlb_phys_ranges_mask` returns all-ones on overflow; `tcg_commit` reads the eviction latch synchronously (before the `async_run_on_cpu` deferral); `pend_*` arrays only touched under the BQL. Cosmetic: `include/hw/core/cpu.h:214-217` says "one bit per 64 MB" while `TLB_PHYS_BUCKET_BITS 25` is 32 MB; `CPUTLBDesc` grows by 2 KB per mmu_idx (`phys_group[256]`) and `CPUTLBEntryFull` by ~40 bytes (`victim_tlb_hit` copies three of them per promotion). Keep; measured neutral on its own (playbook 0043), kept for the scaling property.

### R-23 — `io_prepare` skip under stock icount (0010): consistent, with one wrong comment
- `cpu->neg.can_do_io = true; icount_update(cpu);` (`cputlb.c:1680-1681`) is idempotent and the clock the callback sees is "TB start + whole TB", as documented. For lockstep readers: a mid-TB timer read therefore differs from native's exact-insn value by up to one TB; lockstep passing means the firmware's reads never propagated a difference, not that the values are equal. The `else { /* !can_do_io without any icount mode: not expected. */ cpu_io_recompile }` branch (`cputlb.c:1683`) *is* the normal path for the LG boards: stock QEMU 11 manages `can_do_io` for every TB (`translator.c:275-284`) and recompiles any mid-TB MMIO regardless of icount; the io-barrier mechanism (0014) is what makes that cheap. Fix the comment.

### R-24 — io barriers (0014/0036): correct; hash collisions only cost re-rewinds
- Barrier-split TBs get `can_do_io = true` because the translator emits it before the last insn, so a 1-insn TB never rewinds again — verified against `translator_loop`. `tb_phys_invalidate(tb, -1)` from inside the running TB followed by `cpu_loop_exit_noexc` is the same pattern as self-modifying-code invalidation. The 64-entry direct-mapped set indexed by `pc >> 2` collides for adjacent Thumb insns (P and P+2 evict each other → alternating rewinds; perf only). `wasm_add_io_barrier`/`wasm_is_io_barrier` are defined unconditionally but declared only under `__EMSCRIPTEN__` (native `-Wmissing-prototypes`): gate the definitions too.

### R-25 — TCI immediate forms (0008): sound; TB header (0007) is an unconditional cost on the TCI tier
- `tcg_target_const_match` for I32 accepts `(uint32_t)val == (uint32_t)(int16_t)val`: the middle end stores I32 constants sign-extended and stock TCI computes every I32 op in host width (`tci_compare32`, `st32`, `ext*_i32_i64` truncate), so the "upper bits undefined" convention is real and the immediate forms preserve it. `tci_setcond32_ri` truncates both operands. OK. The `#ifdef __EMSCRIPTEN__` `tci_tbhdr` op calls `icount2_advance()` (two atomics + a deadline compare) and `wasm_tb_account()` at *every* TB entry even under stock icount (`tci.c:1274-1291`), which 0029 removed for wasm64 — **SIMPLIFY:** emit the header only when `icount2_enabled()`, and feed `wasm_tb_account` from a cheaper place (or drop it: the page reads `wasm_tbs/insns` only for benchmarks). Effect: unknown, TCI tier only — A/B per playbook rung 2 on `dist`.

### R-26 — `rr_idle_advance` (0023) and the RT cap (0032): otherwise faithful
- Same clock steps in the same order as the main-loop path under `sleep=off`; `sleep=on` falls back to the warp timer exactly as before; the BQL is released between iterations; `icount_handle_deadline`'s `qemu_in_vcpu_thread()` assertion holds. `icount_rtcap_excess_ns` uses the monotonic REALTIME clock; after `vm_stop`/pause, "banked" credits the paused wall time (the guest runs unpaced until it catches up) — document or re-anchor on `vm_start`. `rr_idle_advance_realtime` (no icount, LG boards) is wasm-gated and only moves timer execution to the vCPU thread; both functions could share one body (SIMPLIFY).

### R-27 — see § 7 (knob inventory)

### R-28 — Threading primitives (0002/0021): the seq+futex `QemuCond` is correct
- Waiter increments `waiters` and snapshots `seq` under the user mutex, signaller bumps `seq` (seq_cst) then wakes if `waiters > 0`: no lost wake-up; spurious wakes are tolerated by every QEMU cond user; `int` wrap is fine (equality). `qemu_cond_timedwait_ns` returns `rc != -ETIMEDOUT`, so `-EWOULDBLOCK` (value changed) counts as a wake — correct. `event_notifier_set/test_and_clear` as an atomic flag is fine because nothing on wasm polls the fd. The "fd set is never watched" main loop means `-monitor stdio`, `qemu_set_fd_handler` users and the iohandler context are dead on wasm — acceptable for the page, worth one line in [diagnostics.md](diagnostics.md).

### R-29 — `flash-blk.c` write-behind (0031): correct given how it is used
- Both callers pass pointers into the MR's RAM (`flash.c:211`, `492`), the array is only read at partition init (`flash.c:1065`), reset does not reload it, the BH and the vCPU writer both run under the BQL, and `vm_change_state(!running)` flushes before `bdrv_close_all`. Errors are reported by `exit(1)` from the BH instead of to the guest (acceptable on wasm). The only residual is R-09's up-to-500 ms BH delay. Coalescing keeps the storage pointer, so an `erase` followed by programming inside the same pending range is written with the final bytes — exact.

### R-30 — pmb887x device changes (0024/0039): equivalent by construction
- VIC: the `vic_irq_handler` early-return is level-only (pending state derives purely from `level`; the bridge ack path uses `vic_set_level`); reset clears the bitmap. DIF: `mux_tab[cd][lane][byte] | mux_const ^ invert` is the exact linear decomposition of the bit loop, rebuilt by the only writer `dif_update_mux`; pin/request caches reset to −1 in `dif_reset`. DMAC burst branch reads the whole burst before writing (differs from per-word interleaving only for overlapping mem2mem with differing endianness); `dmac_handle_signal` ignores unchanged levels, so the DIF request cache is safe. `pmb887x_srb_set_isr` ctz loop is equivalent. `pmb887x_completion_clock()` keeps REALTIME under icount2 (re-entrant `timerlist_rearm`) — correct, but `mod.h` now drags `qemu/timer.h` + `system/cpu-timers.h` into every device (STYLE). These are native perf wins too (44 % of the vCPU in the stopwatch case) and belong in qemu-pmb887x master.

### R-31 — RTC `cnt-format` (0033): correct, upstream branch exists
- `mktimegm()` of the `qemu_get_timedate()` tm gives the same "local time as seconds" the Siemens firmware expects for both `-rtc base=` variants; unknown formats are rejected at realize; the property string is freed by qdev. Nothing to change.

### R-32 — Asyncify onlylist (0031): complete for the exercised paths, loud on the rest, possibly stale
- The list covers boot, rw flash (BH path), shutdown and the thread-pool worker stack; `qemu_coroutine_forbid_current_thread()` on the rr thread turns a vCPU-side switch into an abort instead of a silent derail (good). Not covered: HMP/QMP commands that enter the block layer beyond `screendump` (`commit`, `drive_*`), migration/savevm, `bdrv_reopen` — each aborts with the message. Fine for the page; list them in [diagnostics.md](diagnostics.md). The wasm64 reviewer adds: entries `tcg_qemu_tb_exec`, `cpu_tb_exec`, `helper_ld*/st*_mmu`, `do_ld_*/do_st_*`, `int_ld_*/int_st_*`, `io_readx/io_writex`, `flash_*`, `pmb887x_flash*` cannot be on a switch stack any more once flash writes are BH-deferred and the vCPU thread forbids coroutines — instrumenting the MMIO slow path costs Asyncify overhead there. **Needs measurement:** re-capture with `QEMU_COSTACK=1` on the current tree and A/B (idlebench on an MMIO-heavy phase) with the stale families removed.

### R-33 — STYLE / small items
- `tcg/tci.c:344,399,455`: add `inline` to the `QEMU_ALWAYS_INLINE` functions (gcc warning; possibly lost inlining on native TCI).
- `tcg/tci/tcg-target.c.inc:1234-1243` comment says "a_mask == 0 (no MO_ALIGN bits)" while the predicate requires `MO_ALIGN` (a_mask == s_mask); the interpreter comment is the right one.
- `include/hw/core/cpu.h:268` refers to a non-existent `io_size_mask`; "ioeventf d" typo (twice); "64 MB" vs 32 MB (R-22).
- `system/icount2.c`: prototypes for `icount2_ticks_now`, `icount2_w64_acct_addrs`, `wasm_io_advance` in a header; `ui/wasm.c`: a `ui/wasm.h` with the exports (or `-Wno-missing-prototypes` for that file).
- `hw/arm/pmb887x/dsp.c:892`, `dsp/runtime.c:227`: `#if 0` debug blocks; `dsp/hle.h` puts a `static` string-table function (`dsp_cmd_name`) in a header used by one file.
- `accel/tcg/cputlb.c:21-22`: two stray blank lines; `translate-all.c:654` the "Some guests must re-execute the branch" comment block was re-indented to column 0 outside the `#ifdef`.
- `util/coroutine-wasm.c:132`: `getenv("QEMU_COSTACK")` on **every** coroutine switch → cache the result once.
- `configs/meson/emscripten.txt`: `--emit-symbol-map` in the cross file is fine.

### R-34 — `ui/wasm.c` key ring publishes the tail with a relaxed store
- **Severity:** BUG-LOW (hardening; wasm). **Introduced:** 0001 (`ui/wasm.c:265-278`). Raised by the parallel GLM review (part 1, A3); verified.
- **Evidence:** the producer (JS main thread) writes `key_ring[tail & …].lnx/.down` and then publishes with `qatomic_set(&key_ring_tail, tail + 1)` (relaxed); the consumer `wasm_key_bh` does `qatomic_read(&key_ring_tail)` (relaxed) and reads the slot. Nothing orders the slot stores before the tail store at the language level, so the consumer can observe the new tail with stale slot contents (a dropped or duplicated keycode). Hard to hit on current engines.
- **Fix:** `qatomic_store_release` on the tail and `qatomic_load_acquire` in the consumer (or `smp_wmb()` before publishing).

### R-35 — `dsp_hexdump` mixes byte and word units
- **Severity:** STYLE (debug print only, `DPRINTF`). **Introduced:** the AFE cherry-pick (`hw/arm/pmb887x/dsp.c:168-190`; the function does not exist on master). Raised by GLM part 1 (A7); verified.
- **Evidence:** `const uint16_t *line = (uint16_t *)buf + b;` adds the byte offset `b` to a `uint16_t *`, so each 16-"byte" line reads 32 bytes and the next line starts 32 bytes in; `if (i < len)` inside `for (i < len)` is tautological. Stays within RAM bounds; logs the wrong data when debugging command buffers.
- **Fix:** `(uint8_t *)buf + b` and read `len / 2` words, or pass word counts.

### R-36 — Small items from the cross-check (verified unless marked)
- `include/qemu/wasm-diag.h:19`: `WASM_DIAG_TXN_NOEXIT` is declared but nothing writes it — a dead enum entry; remove.
- `accel/tcg/cputlb.c:1486`: `tlb_resolve_io_dispatch()` runs for every fill including RAM pages (8 stores plus the `alias`/`ops`/`accepts` checks before its early return). Early-out on `memory_region_is_ram(mr)` before the stores. Perf: negligible after 0040 (fills drop to ~35/s in the JVM phase), zero risk.
- `util/async.c:464-472`: on wasm `aio_notify()` calls `qemu_main_loop_wake()` unconditionally, before the `notified`/`notify_me` check; stock only kicks the notifier when `notify_me` says the main loop is (about to be) waiting. `qemu_main_loop_wake` is an `xchg` that notifies only on a 0→1 transition, so the cost is small — fold into R-09's fix (a `notify_me`-gated wake keeps the level-triggered semantics).
- 0018 fast-path MMIO hits bypass `memory_region_{read,write}_accessor`, so `trace_memory_region_ops_read/write` and the subpage trace events are never emitted for them; `-trace enable=memory_region_ops_*` silently changes behaviour. Document it, or leave the fast mask empty when those trace events are enabled at fill time (DEVIATION, minor; GLM part 1 A10.1).
- 0018 snapshots `ops`/`opaque` at fill (R-06 covers `ioeventfd_nb`); a device that swaps `mr->ops`/`mr->opaque` at runtime without a topology change keeps being called through the stale pointers. No device on this board does that; make the contract explicit with a comment or an assert in the mutators (GLM part 1 A10.2).
- `accel/tcg/icount-common.c`: the RT-cap statics `rtcap_v0/rtcap_r0` and `rr_rtcap_throttle`'s `last_v` are unsynchronized; all writers are the vCPU thread, so at worst a moment of mis-pacing — STYLE (GLM part 1 A13).

## 5. Dependency structure (what falls away with what)

**TCI-tier only** (~1,350 lines; falls away entirely if the interpreter tier is dropped): 0003, 0007 (`tci_tbhdr` + `tcg_out_tb_start`), 0008, 0011, 0012 in `tcg/tci.c` + `tcg/tci/*`; `-sASYNCIFY_REMOVE=tcg_qemu_tb_exec` in `configs/meson/emscripten.txt`; the `wasm_tb_account` feed and the `LD_HELPER/ST_HELPER` counters. Everything the wasm64 backend needs from the core (io_prepare skip, SVC exit, barriers, romd variants, io fast dispatch, idle warp, RT cap, growth, summary) is independent of TCI. Whether the TCI tier stays is a product decision ([architecture.md](architecture.md) keeps it as the reference/fallback tier and the JIT-bisection oracle; the native TCI build is also the lockstep b-side). The 0003/0008 gains are real on native TCI too (−10 % splash, +44 % icount2 rate per the commit messages), so those two are upstream candidates in their own right once R-07/R-08 are fixed.

**icount2 (precise-clocks) only** (~100 lines; falls away if that opt-in mode is dropped): `system/icount2.c` (+60: 1 kHz floor, `wasm_io_advance`, `icount2_ticks_now`, `icount2_w64_acct_addrs`), the `icount2_enabled()` branch of `io_prepare` (`cputlb.c:1654-1662`), the `gen_icount2_cycles`/`trans_B_cond_thumb` `__EMSCRIPTEN__` returns in `translate.c`, `pmb887x_completion_clock()`'s REALTIME branch (would become plain `QEMU_CLOCK_VIRTUAL`), the `icount2_advance` call in `tci_tbhdr`, `mod.h`'s `cpu-timers.h` include, the wasm64 accounting prologue variant (0029 already made it conditional). The default timing model uses none of it; the docs keep icount2 as a slow-host guard.

**Diagnostics only** (zero-cost when gated; removable without perf change): `include/qemu/wasm-diag.h` and all counter sites (0012/0014/0016/0041/0042), the `ui/wasm.c` exports `wasm_tbs/insns/memstat/reg/pc/peek/irq_pending/vclock`, `W64_TBLOG`, `QEMU_COSTACK`, `W64_DEBUG` prints in `w64_speculate`, the `dsp.c` hexdumps/DPRINTF tables, the wasm64 forensics (W-18). Keep the header and the cold counters the tooling reads; gate the un-gated sites (R-15).

**wasm-only core hooks, gated and inert natively** (verified): 0002 futex/cond, 0009/0035 main loop, 0010 io_prepare skip, 0013 SVC exit (except the early return, R-12), 0014/0036 barriers, 0021 notifier, 0025 halt costs, 0031 flash BH + coroutine forbid, 0037 realtime idle, 0044 devirtualise, all `W64_*` hooks under `CONFIG_TCG_WASM64`.

**Un-gated generic changes** (change native behaviour; each is either equivalence-preserving as reviewed or has a finding): 0016 (R-03, R-11), 0018 (R-04/05/06; R-21 is a fix), 0023 (R-12 r/r), 0028 (R-13), 0032 (default off natively; R-02 only under the cap), 0040 (R-14), 0043 (OK), 0045 (OK), 0013's early return (R-12), 0024/0039/0033 devices (OK), the AFE cherry-pick (R-10), `meson.build` tests (R-16), the un-gated counters (R-15), `translator_note_succ` as a real call (W-23.2).

## 6. Removal / simplification budget

Grouped by what it costs. Line counts are approximate.

**(a) Drop now, no perf effect expected**

| Item | Lines | Finding |
|---|---|---|
| dead `TCG_TARGET_HAS_*` block + `HAVE_TCG_QEMU_TB_EXEC` fossil in `tcg/wasm64/tcg-target.h` | ~80 | W-16 |
| unreferenced `outop_depositi`, `outop_deposit_zr`, `outop_muluh_i64` | ~45 | W-17 |
| bring-up forensics and debug prints in the wasm64 emitter/runtime (`W64CALL`, `w64_sum`/`w64_bad_*` dumps, the code-section re-walk, the JS signature prober, `performance.now()` timing globals, `W64SPEC` stats, `W64_TBLOG` + `w64_spec_active`) | ~350 | W-18 |
| `W64_NOTLB` / `W64_NOACCTINLINE` A/B arms (measured 13–17× / 3× slower, decided) + the dead `LS.inited` check | ~60 | W-19 |
| unused constraint sets in `tcg-target-con-set.h` | ~7 | coverage table |
| un-gated `wasm_diag_stat` increments on native fill/MMIO/topology paths → gate; the cleanest form is one `CONFIG_WASM_DIAG` compile switch around the header, every counter site, the `ui/wasm.c` stat exports and `W64_DEBUG`/`W64_TBLOG` (default off, on for perf-debug builds) — the same ~35 sites, one `#ifdef` name | 0 (gating) | R-15, R-36 |
| `subdir('tests')` restore in `meson.build` | −3 | R-16 |
| `getenv("QEMU_COSTACK")` per coroutine switch → cache; `#if 0` DSP debug blocks; duplicated `curr_cflags_fast` → shared inline | ~30 | R-33, R-17 |

**(b) Drop after one A/B each**

| Item | Lines | Expected | Meter | Finding |
|---|---|---|---|---|
| per-TB temp-module path (prelude assembly, `w64_instantiate`, `W64_NOBATCH`, `W64_NOCLOSEEXEC`, descriptor `MODLEN/NIMP/ICOUNT`, per-TB type/import tables) | ~450 | neutral to positive (less code buffer per TB, no prelude work) — also removes W-04 | `tools/idlebench.mjs --quick` interleaved, t0.25G/t0.5G; first confirm zero temp instantiations with a `W64_DEBUG` counter | W-20 |
| lockstep + chain-stop probes emitted into every TB | ~20 (gating) | ≤ 1 % | `tools/tcgbench.mjs` alu/branch phases | W-21 |
| `tci_tbhdr` accounting under stock icount (TCI tier) | ~10 (gating) | small, TCI only | playbook rung 2 on `dist` | R-25 |
| stale Asyncify onlylist families (`helper_*_mmu`, `do_*`, `io_*`, `flash_*`) | ~40 | small | re-capture with `QEMU_COSTACK=1`, idlebench MMIO-heavy phase | R-32 |
| romd stash: drop all slots on `topo_gen++` | −10 / +5 | none | native suite | R-11(b) |

**(c) Product decisions**

| Item | Lines | Consequence |
|---|---|---|
| drop the TCI tier (`dist`) | ~1,350 | loses the fallback engine, the JIT-bisection oracle and the lockstep b-side; the page default is unaffected |
| drop icount2 / `?icount=precise-clocks` | ~100 | loses the slow-host frequency controller the docs keep as a guard |
| make the DSP stub choice explicit (R-10) | 0 | restores a documented native reference |

**(d) Keep — measured wins** (every row of the playbook's "What landed" table survives (a)–(b)): 0003/0008/0011/0012 (if the TCI tier stays), 0009, 0010, 0013, 0014, 0016, 0017, 0018, 0019–0032, 0034–0045, 0033, the device work. The 0022 goto_ptr handoff path is **not** dead (it is the live fallback for uninstantiated tail-call targets) and stays.

## 7. Environment knobs the series adds (`getenv`)

| Knob | Where read (cached?) | Still used by | Verdict |
|---|---|---|---|
| `QEMU_IO_REWIND` | `accel/tcg/cputlb.c:1639` (static) | page `?iorewind=1` | A/B escape hatch for 0010 — keep or drop with it |
| `QEMU_ICOUNT_RTCAP` | `accel/tcg/icount-common.c:523` (all builds; default `banked` on wasm, `off` native) | page `?rt=`; benchmarks pass `off`; not `run-native.sh` | shipping knob; native/web pacing disagree (handoff item 5) |
| `QEMU_COSTACK` | `util/coroutine-wasm.c:132` — **on every coroutine switch** | onlylist capture recipe only | cache the result (R-33) |
| `QEMU_ICOUNT2_DEBUG` | pre-existing in master | page | unchanged |
| `W64_DEBUG` | `tcg-target.c.inc:1088`, `wasm64.c:1303,1512,1841`, `cpu-exec.c:711` (static); `wasm64.c:1427` (**every 1024th re-ensure, uncached**) | page `?w64debug=1`, `tools/repro.mjs` | keep one cached flag for batch/compact stats; drop the `W64CALL` print (W-18) |
| `W64_TBLOG` | `translate-all.c:409` (static) | nobody | REMOVE (W-18) |
| `W64_SPEC_N` | `cpu-exec.c:706` (static) | docs | keep (default 32) |
| `W64_NOTLB` | `tcg-target.c.inc:1157` (static, per ld/st translation) | docs only | REMOVE (W-19) |
| `W64_NOACCTINLINE` | `tcg-target.c.inc:2266` (static) | `tools/tcgbench.mjs` example, docs | REMOVE (W-19) |
| `W64_NOBATCH`, `W64_BATCH_N` | `wasm64.c:656-663` (static) | `tools/bootbench.mjs` comment, `site/app.js` comment, plan gates (`W64_BATCH_N=4`) | `W64_NOBATCH` dies with W-20; `W64_BATCH_N` keep (cheap, exercises union-table pressure) |
| `W64_NOCLOSEEXEC` | `wasm64.c:1817` (static) | nobody (undocumented) | REMOVE (W-20) |
| `W64_COMPACT_BATCHES`, `W64_COMPACT_MEMBERS`, `W64_LIVE_MAX` | `wasm64.c:615-646` (static) | `tools/idlebench.mjs`, [diagnostics.md](diagnostics.md); both sweeps rejected | keep as documented A/B knobs (W-14 bounds the count LEB) |
| `W64_LOCKSTEP`, `_PERIOD`, `_EPOCH`, `_MEMINSNS`, `_INSNS`, `_FROM`, `_TO`, `_MEM` | `wasm64.c:440-470` (once, `w64_ls_init`) | page `?lockstep=1&ls-*`, `tools/lockstep-wasm.mjs` | keep (correctness gate); gate the emitted probes on it (W-21) |

No knob is on an *execution* hot path; `w64_tlb_inline()`/`w64_acct_inline()` cost one static load per translated ld/st and per TB, `LS.stop` one load per dispatcher round.

## 8. Open questions and how to settle them

1. **R-01 in the browser:** OS-level per-thread CPU of the renderer at the idle screen before and after the one-word fix; re-run `idlebench` on a loaded host (a spinning worker steals CPU there).
2. **R-02 reachability:** instrument the `i == 64` exit of `rr_idle_advance` and soak the S75 idle screen with `rt=banked` for 5 minutes; any hit means the hang is live.
3. **R-03 on this board:** lockstep windows around the SCU ROMAMCR unmount and the TCM enable (`tools/lockstep-wasm.mjs --insns 20e6`), or a native `-d exec` diff with and without the jump-cache flush.
4. **W-20 preconditions:** confirm zero `w64_instantiate` calls in a full boot with a counter split by source next to `WASM_DIAG_MOD_COUNT` before deleting the temp-module path.
5. **W-04/W-05 frequency on pmb887x:** translation-time histograms of `W.n_imp` and `W.n_labels` per boot behind `W64_DEBUG` — or just fix both (tiny) and stop caring.
6. **W-06:** does the `pmb887x-dsp` worker (or any non-vCPU thread) access guest RAM outside the BQL? Audit `dsp_worker` for `address_space_*`/`cpu_physical_memory_*`/`memory_region_get_ram_ptr` use. With R-10 the native reference runs the HLE stub, so the question is wasm-only.
7. **Op-suite coverage:** add a v6T2+ CPU model (`-cpu arm1176`) run with `bfi`/`sbfx`/`pkhbt`/`rev` cases — the cheapest regression guard for the emitter (W-01..W-03 would have been caught).
8. **Mid-TB clock visibility (R-23):** a targeted trace diff of GPTU/TPU reads between native and wasm would quantify the ≤ 1-TB deviation lockstep cannot see.
9. **STUB_DSP intent (R-10):** is the LLE DSP meant to remain the native reference? If yes the define must be per-host; if no, update [upstream-branch.md](upstream-branch.md)'s safety claim and drop the dead LLE edits from the cherry-pick.
10. **TCI on big-endian / strict-alignment hosts (R-07/R-08):** a TCI build on s390x (upstream CI) shows R-07 on the first helper call; misaligned loads under `MO_ATOM_IFALIGN` on a strict host show R-08.
11. **Native suite for TCI:** `tests/run.mjs` cannot run the TCI tier (plugins unavailable with `--enable-tcg-interpreter`); add a `--no-plugin` mode (milestones from serial/LCD only) so the fallback tier gets a real gate.
12. **Asyncify onlylist staleness (R-32):** re-capture with `QEMU_COSTACK=1`; if the `helper_*_mmu`/`do_*`/`io_*` families no longer appear, dropping them un-instruments the MMIO slow path.

## 9. Recommended order of work

1. **One-line fixes with shipped impact:** R-01 (`INFINITY`), R-02 (`async_run_on_cpu` or unbounded `rr_idle_advance`), R-09 (seq-counter wait), W-05 (`uint16_t`), R-16 (commit the `meson.build` restore). Re-run the three-fullflash gate and idlebench; expect R-01 to move the loaded-host numbers.
2. **Emitter correctness:** W-01, W-02, W-03; then W-13/W-04 (turn the debug asserts into a "TB too large" return) — or take W-20 and delete the prelude, which removes W-04 outright. Add the v6T2 op-suite run.
3. **Generic-core correctness before any upstreaming:** R-03 (jump-cache flush on non-romd commits), R-04/R-05/R-06 (0018), R-07/R-08 (TCI), R-11(b)/(c), R-12 (gate the early return + replay), R-13, R-14 (audit or move growth to flush time).
4. **Deviation cleanup and hardening:** R-15/W-23.1 (gate the counters), R-17/W-23.3 (target-neutral devirtualise), W-23.2 (inline no-op), R-10 (explicit DSP stub choice), W-16/W-17/W-18/W-19/W-27 (dead code), W-22 (`HAVE_TCG_QEMU_TB_EXEC` switch), R-34 (key-ring release/acquire), R-33/R-35/R-36.
5. **Measured simplifications:** W-20, W-21, R-25, R-32 — one interleaved A/B each per the playbook.
6. **Upstream candidates** (reduce the fork's deviation by moving code out of it): R-21 victim compare and R-20 hflags skip to QEMU; 0033 RTC (branch exists), 0024/0039 device work and `pmb887x_completion_clock` to qemu-pmb887x master; 0028 with R-13's guard; 0023 idle warp (RFC, r/r caveat); 0016 after R-03/R-11 (RFC — pflash users benefit); 0003/0008 after R-07/R-08.

## 10. Coverage

### wasm64 backend (`tcg/wasm64/tcg-target.c.inc`, 2752 lines, per op group)

| Region (HEAD lines) | What | Verdict | Notes |
|---|---|---|---|
| 1-63 per-TB state `W` | label/fixup/type/import/blk tables, `rep` | fix | `uint8_t n_labels` (W-05); debug-only bounds (W-13); 12 KB memset per TB (W-25) |
| 64-127 LEB emitters | uleb/uleb32_p5/sleb32/sleb64 | keep | padded forms are valid non-minimal LEBs |
| 129-155 `w64_callidx` | 2-byte call index + `CF` fixup record | keep | with W-20 could emit `uimp` directly |
| 157-283 locals / rep / consts | `w64_get_i32/i64`, `w64_set_*`, `w64_const*` | keep | rep tracking sound given master's allocator invariants |
| 285-311 control-flow helpers | `blk_push/pop`, `br_loop` | keep | depth arithmetic verified |
| 313-352 types/imports | `w64_add_type`, `w64_import_idx` | drop with W-20 | only feed the temp module |
| 354-411 loop head / `tcg_out_set_label` | region scheme, forward fixups | fix | W-05 |
| 413-462 cmp table, binop rrr/rri | | keep | W-10 |
| 464-628 ld/st (TCG-internal), `sti` | i32/i64 (+8/16/32 variants), negative offsets | keep | verified |
| 630-775 mov/movi/ext*/extr*/addi_ptr/xchg | | keep | verified incl. mixed rep |
| 777-818 `br`, `exit_tb` | | keep | 31-bit pointer in i32 (W-26) |
| 820-895 `goto_tb` | runtime slot read + `return_call_indirect` | keep-but-trim | `w64_chain_stop` term (W-21) |
| 897-964 `goto_ptr` | tail call + `[sp-8]` handoff | keep | handoff is the live fallback (0022 not dead); `i64.eqz` (W-08) |
| 966-978 `mb`, `tb_target_set_jmp_target` | | fix (W-06) / keep | |
| 980-1111 `tcg_out_call` | tp store, arg reload, typemask, result | keep-but-trim | W-09, W-18 |
| 1113-1404 `qemu_ld/st` + TLB probe | `w64_tlb_setup/probe/haddr`, fast tables, helper arm | keep | verified against aarch64; `W64_NOTLB` arm droppable (W-19) |
| 1406-1462 add/mul/logic/shift/div/sub | | keep | |
| 1464-1595 andc/orc/eqv/nand/nor/neg/not | | keep | |
| 1597-1662 ctpop/clz/ctz | | keep | |
| 1664-1755 setcond/negsetcond/movcond/brcond | | keep | |
| 1757-1843 mulu2/muls2/muluh/mulsh | | keep / drop | `outop_muluh_i64` dead (W-17) |
| 1845-1932 deposit (+`depositi`, `deposit_zr`) | | **fix** / drop | W-01; two dead tables (W-17) |
| 1934-1997 extract/sextract/extract2 | | **fix** | W-02 |
| 1999-2172 bswap16/32/64 | | **fix** (bswap32 I64) | W-03; bswap16/bswap64 verified |
| 2174-2254 remaining outop tables | ld8u..st32, extrh, carry ops, div2 | keep | |
| 2256-2430 `tcg_out_tb_start` | descriptor, locals, inline accounting prologue, loop head | keep-but-trim | W-11, W-15, W-19/W-21, `W64_DESC_ICOUNT` unread |
| 2432-2646 `tcg_out_tb_finalize` | prelude sections + filler + import table + `w64_batch_member` | **fix** / drop with W-20 | W-04, W-07 |
| 2648-2752 target boilerplate | reg order, oarg reg, const_match, init, empty prologue | keep-but-trim | W-08, W-25 |

### wasm64 runtime and hooks

| File / region | Lines | Verdict | Notes |
|---|---|---|---|
| `tcg/wasm64/wasm64.c` 1-231 dispatcher glue, `w64_instantiate` JS | 231 | drop with W-20 (+ the sig prober, W-18) | `w64_icount2_sync_now`, `w64_init`, `w64_acct_*` keep |
| `wasm64.c` 252-527 lockstep fold | 276 | keep | correctness gate; dead `LS.inited` line (W-19) |
| `wasm64.c` 529-537 tidx allocator | 9 | keep | W-15 |
| `wasm64.c` 539-830 batch tables, `mb_*`, JS `w64_remove/tab_unset/tab_clear` | 292 | keep | union-table capacity math verified |
| `wasm64.c` 833-888 `w64_batch_instantiate` JS | 56 | keep-but-trim | timing globals (W-18); GC nudge keep (Firefox) |
| `wasm64.c` 890-1001 forensics | 112 | drop (W-18) | cold |
| `wasm64.c` 1003-1315 `w64_assemble_instantiate` | 313 | keep-but-trim | drop the 130-line walk (W-18/W-20); W-14 |
| `wasm64.c` 1317-1481 evict / live list / ensure / landed registry | 165 | keep | guards by batch tag verified; W-07 on re-ensure |
| `wasm64.c` 1483-1651 `w64_compact` | 169 | keep (compaction-off measured 0..−3 % at +18 % RSS) | W-14 |
| `wasm64.c` 1653-1802 `w64_batch_close`, `w64_batch_member` | 150 | keep-but-trim | close-time re-validation (W-18); `W64BATCHRETRY` keep |
| `wasm64.c` 1804-1829 `w64_batch_close_pending` | 26 | keep | the actual first-exec path; `W64_NOCLOSEEXEC` drop |
| `wasm64.c` 1831-1870 `w64_batch_flush` | 40 | keep | |
| `wasm64.c` 1872-1970 `w64_tb_account`, `w64_chain_stop`, `tcg_qemu_tb_exec` | 99 | keep-but-trim | `w64_tb_account` drop (W-19); temp-module branch drop (W-20) |
| `tcg/wasm64/wasm64.h` | 173 | keep-but-trim | `W64_DESC_MODLEN/NIMP/ICOUNT`, `W64_MAX_TYPES/IMPORTS` go with W-20 |
| `tcg/wasm64/tcg-target.h` | 184 | keep-but-trim | W-16; stale "Phase 1" header comment |
| `tcg/wasm64/tcg-target-has.h` | 24 | keep | accept-all `*_valid` fine once W-01/W-02 are fixed |
| `tcg/wasm64/tcg-target-con-set.h` | 20 | keep-but-trim | 7 sets referenced by no outop |
| `tcg/wasm64/tcg-target-con-str.h`, `tcg-target-opc.h.inc` | 13 / 4 | keep | |
| `tcg/wasm64/tcg-target-mo.h` | 12 | fix (W-06) | |
| `tcg/tcg.c`, `include/tcg/tcg.h`, `tcg/meson.build` | +14/−2, 1, +4 | keep (W-22 optional) | gating correct; native and TCI builds unaffected |

### Everything else

| File | Lines | Patches | Verdict | Notes |
|---|---|---|---|---|
| accel/tcg/cpu-exec.c | +268/−2 | 0013 0019 0020 0030 0038 0041 0044 | keep-but-trim | R-12, R-17/W-23.3, W-12, W-18 stats; `w64_speculate` clean |
| accel/tcg/cputlb.c | +486/−5 | 0004 0010 0012 0014 0016 0018 0040 0041 0043 | keep-but-fix | R-03, R-04/05/06, R-14, R-15, R-23 comment; R-21 upstreamable |
| accel/tcg/icount-common.c | +69/−1 | 0025 0032 | keep-but-fix | R-02 |
| accel/tcg/internal-common.h | +6 | 0014 | keep | declare barriers unconditionally (R-24) |
| accel/tcg/tb-maint.c | +15 | 0014 0017 | keep | gated; flush ordering correct |
| accel/tcg/tcg-accel-ops-icount.c | +9/−1 | 0025 | keep | wasm-only |
| accel/tcg/tcg-accel-ops-rr.c | +158/−1 | 0023 0031 0032 0037 0041 0042 | keep-but-fix | R-02 (64 bound), R-12, R-26; merge the two idle functions |
| accel/tcg/tlb-bounds.h | +2 | 0040 | keep | |
| accel/tcg/translate-all.c | +71/−3 | 0014 0019 0030 0041 | keep-but-trim | `W64_TBLOG` (W-18); barrier definitions gate (R-24) |
| accel/tcg/translator.c | +61 | 0014 0019 0020 0036 0038 | keep | barrier split verified; W-23.2 inline no-op natively |
| configs/meson/asyncify-only.txt | +203 | 0031 | keep, needs-measurement | R-32 |
| configs/meson/emscripten.txt | +15/−2 | 0001 0002 0017 0031 | keep | |
| hw/arm/pmb887x/board.c | +4 | 0033 | keep | |
| hw/arm/pmb887x/dif_v1.c, ssc.c | +1/−1 each | 0024 | keep | |
| hw/arm/pmb887x/dif_v2.c | +74/−26 | 0024 0039 | keep | R-30; upstream to pmb887x master |
| hw/arm/pmb887x/dmac.c | +19/−2 | 0024 0039 | keep | R-30 |
| hw/arm/pmb887x/dsp.c | +586/−23 | AFE | needs-decision | R-10 |
| hw/arm/pmb887x/dsp/{hle.h,peripheral.c,peripheral.h,afe.c,internal.h,runtime.c,runtime.h,tests/compat.h} | +483/−4 | AFE | keep (dead natively except afe.c audio) | LLE-side code compiled out under STUB_DSP |
| hw/arm/pmb887x/flash-blk.c | +73/−1 | 0031 | keep | R-29 |
| hw/arm/pmb887x/mod.c / mod.h | +5/−4, +17 | 0039 / 0024 | keep | header include bloat (STYLE) |
| hw/arm/pmb887x/rtc.c | +34/−7 | 0033 | keep | upstream branch exists |
| hw/arm/pmb887x/vic.c | +43/−35 | 0039 | keep | R-30 |
| include/accel/tcg/getpc.h | +4/−1 | 0034 | keep | verified |
| include/exec/cputlb.h, icount.h, translation-block.h, translator.h | +51 | 0016 0032 0019/0020/0030 0020 | keep | TB grows only under CONFIG_TCG_WASM64 (W-23.4) |
| include/hw/core/cpu.h | +48 | 0018 0040 0043 | keep-but-trim | comments (R-22/R-33); struct growth noted |
| include/qemu/coroutine-core.h | +11 | 0031 | keep | |
| include/qemu/event_notifier.h | +3 | 0021 | keep | |
| include/qemu/futex.h | +25 | 0002 | **fix** | R-01 |
| include/qemu/main-loop.h, thread.h, thread-posix.h | +15 | 0002 0032 | keep | |
| include/qemu/wasm-diag.h | +69 | 0012 0014 0016 0041 0042 | keep (gate users) | R-15 |
| include/system/memory.h | +14 | 0016 | keep | |
| meson.build | +4/−3 | 0001 0017 | **fix** | R-16 |
| qapi/ui.json | +5/−1 | 0001 | keep | `if: CONFIG_WASM_UI` consistent |
| system/cpu-timers.c | +19/−1 | 0028 | keep-but-fix | R-13 |
| system/cpus.c | +5 | 0032 | keep | |
| system/icount2.c | +60 | 0002 0004 0017 | keep (icount2-only) | prototypes; 1 kHz floor documented |
| system/memory.c | +229/−1 | 0016 | keep-but-fix | R-11, R-15 |
| system/physmem.c | +69/−1 | 0016 | keep-but-fix | R-03 |
| target/arm/tcg/op_helper.c | +44/−2 | 0025 0027 0045 | keep | R-19 nit; R-20 upstreamable |
| target/arm/tcg/tlb_helper.c | +7 | 0014 | keep | gated counter |
| target/arm/tcg/translate.c | +70/−5 | 0002 0013 0020 0027 | keep | R-19; `DISAS_JUMP` paths verified with the helper's kick; W-12 |
| tcg/tci.c | +1044/−4 | 0003 0007 0008 0011 0012 | keep-but-fix (TCI tier) | R-07, R-08, R-25, R-33; 0012 emitter filter is exact |
| tcg/tci/tcg-target-con-set.h, -con-str.h, -opc.h.inc, tcg-target.c.inc | +261/−14 | 0007 0008 0012 | keep (TCI tier) | R-33 comment |
| ui/meson.build, ui/wasm.c | +388 | 0001 0002 0012 0017 0019 | keep-but-trim | R-18; exports lack prototypes |
| util/async.c | +8 | 0009 | keep | |
| util/coroutine-wasm.c | +42 | 0031 | keep-but-trim | cache `QEMU_COSTACK` |
| util/event_notifier-posix.c | +21 | 0021 | keep | |
| util/main-loop.c | +88 | 0009 0035 | keep-but-fix | R-09 |
| util/qemu-thread-posix.c | +126 | 0002 0021 0032 | keep | R-28 |

## 11. Cross-check against the parallel GLM review

Mapping of the GLM items onto this review and the outcome of verifying
the ones this review had not raised.

**Part 1 (everything outside `tcg/wasm64`)**

| GLM | Here | Outcome |
|---|---|---|
| A1 futex 0 ms | R-01 | agree |
| A2 main-loop wake erased between iterations | R-09 | agree (same race, described from the other side of the window) |
| A3 key-ring ordering | R-34 | added, verified |
| A4 timer-notify shortcut ignores REALTIME deadlines natively | — | **refuted:** `qemu_timer_notify_cb` still routes `type != QEMU_CLOCK_VIRTUAL` to `qemu_notify_event()` exactly as stock (`system/cpu-timers.c:242-246`), so arming a realtime timer never kicked the vCPU in stock either; the 0028 shortcut only affects VIRTUAL deadlines and is sound. R-13 stays the only caveat |
| A5 ARM hard-wired in `cpu-exec.c` | R-17 | agree |
| A6 un-gated counters | R-15 | agree |
| A7 `dsp_hexdump` units | R-35 | added, verified (new in the AFE commit) |
| A8 dead `TXN_NOEXIT`, per-switch `getenv`, duplicated comment, uncommitted `meson.build` | R-36, R-33, R-16 | agree; enum added |
| A9 `STUB_DSP` flip | R-10 | agree |
| A10 MMIO fast dispatch caveats | R-36 | trace bypass and late-mutation caveats added. **A10's statement that `io_swap` "matches `adjust_endianness` on any host" is wrong** — see R-04 (`MO_BE == 0` on a big-endian host) |
| A11 TCI i32 "upper bits undefined" invariant | R-25 | agree it holds today; the `(uint32_t)` hardening is a fair option |
| A12 successors inherit the root's flags | W-12 | agree |
| A13 unsynchronized RT-cap statics | R-36 | noted (STYLE) |
| B1 `CONFIG_WASM_DIAG` switch | §6(a) | adopted as the form for R-15 |
| B2 victim compare upstream | R-21 | agree |
| B3 notify budget upstream | R-13 | agree, with the `can_do_io` guard |
| B4 TCI fast paths upstream | §5 | agree, after R-07/R-08 |
| B5 `curr_cflags_fast` | R-17 | agree |
| B6 split the device work out | §9.6 | agree |
| B7 debug leftovers | R-33, R-36 | agree |
| B8 `tci_call_tag` per call, `tci_tbhdr` gating, resolve-for-RAM, unconditional aio wake, pixman image per blit | R-07, R-25, R-36 | agree; the pixman-image-per-blit note is trivial and not repeated here |

**Part 2 (`tcg/wasm64`)**

| GLM | Here | Outcome |
|---|---|---|
| A1 `deposit` i32 scratch | W-01 | agree |
| A2 prelude overflow family | W-04, W-13 | agree |
| A3 `n_labels` wrap | W-05 | agree |
| A4 epilogue never set | W-08 | agree |
| A5 `addFunction` signatures | W-24 | agree |
| A6 debug-only capacity checks | W-13 | agree |
| A7 batch-walk read, `w64_union_import`, tidx leak, `w64_landed_by_id` growth, `W64_NOBATCH` convention | W-15, W-27 | tidx agree; the rest recorded in W-27 (two not independently verified) |
| A8 "`tgen_sextract`, `tgen_bswap16/32/64` … are type-correct" | W-02, W-03 | **refuted:** both lowerings were validated with V8 and produce invalid modules (and `bswap32_i64` is semantically wrong even with the opcode fixed) |
| B1 `w64_out_desc_u32` dead | W-27 | added, verified |
| B2 `W64_DESC_ICOUNT` dead | W-20 | agree |
| B3/B4 forensic decode | W-18 | agree |
| B5/B9 duplicate and default `TCG_TARGET_HAS_*` | W-16, W-27 | agree |
| B6 `TCG_REG_R30` | W-25, W-28 | agree; the "enable it" option recorded as needs-measurement |
| B7 A/B-only knobs | W-19, W-20 | agree |
| B8/B10 `blk[].kind`, `memcpy(NULL, 0)` | W-27 | agree |
| B11 `tcg.c` hunks | W-22 | agree |
| B12 move lockstep to its own file | — | reasonable structure suggestion, no perf effect |
| C1 label-chain cost / `br_table` | W-28 | recorded as a perf opportunity needing measurement |
| C2–C5 accepted costs | verified-correct notes | agree |

Net effect: five small verified additions (R-34, R-35, R-36, W-27,
W-28), two GLM claims refuted (part 1 A4, part 2 A8), no change to the
severity ranking in §1.

## 12. Reproductions

The evidence behind the validated findings, so they can be recreated:

- **W-01/W-02/W-03:** the byte sequences `tgen_deposit` (I32),
  `tgen_sextract` (`ofs+len != 32`) and `tgen_bswap32` (I64) emit were
  hand-assembled into minimal modules (one function, the same locals
  layout) and run through `WebAssembly.validate` / `new
  WebAssembly.Module` in node 22 with memory64 enabled; V8 reports the
  type errors quoted in the findings. Fixing the `bswap32_i64` opcode and
  executing the module returns `0xee772211` for `0x1122334455667788`.
- **W-04:** a byte-count model of `tcg_out_tb_finalize`'s prelude
  (`21 + 7·min(n,10) + 8·max(n−10,0)` bytes for the import section) shows
  the 1-byte size slot overflowing at 15 imports and the 256-byte prelude
  at ~20.
- **R-01:** a 12-line emcc program (`-pthread -sPROXY_TO_PTHREAD`, emsdk
  4.0.10) timing `emscripten_futex_wait(&w, 0, 0)` on a pthread returns
  `-ETIMEDOUT` after 0.041 ms; with `50` it returns after 50.07 ms.

The review build dirs are `build/qemu-review-native` and
`build/qemu-review-tci`.
