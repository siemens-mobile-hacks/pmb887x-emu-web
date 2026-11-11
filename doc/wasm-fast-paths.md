# WASM port fast paths in the QEMU fork

This lists the changes in `qemu/` (branch `wasm-browser-port`) that differ from
upstream only to make the emulator faster. Use it when rebasing onto a newer
upstream, or when deleting an optimization to bring a file back towards upstream.

- **Upstream reference:** `smh/master` (siemens-mobile-hacks/qemu-pmb887x),
  merged up to `9e5a6bbfd6` by merge `d7fab9092f` (2026-11-09). To see a
  file's divergence, run `git -C qemu diff 9e5a6bbfd6 -- <file>`.
- **State described:** fork `6b8a64baa5` (2026-11-09). Every identifier
  below was grepped in that tree; the 2026-11-10 review round
  (`db5ec3b899`) changed the A5, C2 and R2 rows and the list of correctness
  fixes, `8fcac1b334` added C8 and R8, and `58cb97caff` D12. The fork is at
  `472c44c938`: the two commits after D12 are in the backend and its DSP
  glue (a rebinder for Firefox's tiers, and evicted DSP blocks dropped in
  the middle of a slice), which are not itemized here.
- **Numbers** are quoted from the commit messages
  (`git -C qemu log -1 <sha>`) and from the A/Bs of their date; September
  figures were measured under icount. "Not measured" means no source gives
  a number. [performance.md](performance.md) has the current measuring
  method.

## What counts as a fast path

A fast path meets all three conditions:

1. It exists only for speed.
2. It does not change what the guest sees: the same instructions, values and
   virtual-time events.
3. Deleting it restores upstream code (or the plain fork code it short-cuts)
   without breaking anything else, apart from the dependencies listed below.

The following are **porting necessities, not fast paths**, and are not itemized:

- **The wasm64 TCG backend** `tcg/wasm64/*`, including its interpreter tier,
  batching and eviction. Also the shared-code glue it needs:
  - `HAVE_TCG_QEMU_TB_EXEC`
  - the `tcg.c` label and finalize hooks
  - the `w64_ra_*` return-address decode in `region.c` and `translate-all.c`
  - tagged table indexes in goto_tb slots and goto_ptr targets
    (`tb_set_jmp_target`, `w64_dispatch_target`, and the `fidx == 0` refusal in
    `tb_add_jump`)
  - batch unstage and retire (`tb_w64_retire`), and `w64_exec_unwound`
- **Emscripten threading:** the futex `QemuCond`/`QemuEvent`, the main-loop
  futex wait, event notifiers, `coroutine-wasm.c` and
  `qemu_coroutine_forbid_current_thread`, and the bottom half that starts
  the CFI flash writeback (`cfi_flash_writeback_timer` in
  `hw/block/cfi-flash/cfi-flash.c`; timer dispatch is not on the Asyncify
  onlylist).
- **Browser UI and audio:** `ui/wasm.c`, `audio/wasmaudio.c`, the exported
  counters (`wasm_vcpu_idle_count`, `wasm_guest_insns`, `w64_acct_*`),
  `configs/meson/asyncify-only.txt`, and the meson/configure glue.
- **Verification and timing options:** the lockstep fold (`W64_LOCKSTEP*`),
  `vcpu-timers-bank` and `vcpu-timers-idle-lead`. Both options change timing
  on purpose.
- **Correctness fixes:**
  - the instruction count handed back when a TB is unwound
    (`w64_acct_unwind` in `translate-all.c`)
  - 32-bit operands zero-extended when they sit in a 64-bit local
    (`w64_get_u32`: `mulu2`, `muluh`, the `qemu_ld`/`qemu_st` address)
  - DSP blocks dropped when their batch is evicted
    (`tcg_drop_evicted_blocks`, `w64_tc_evicted`)
  - `memory_region_set_readonly` on a region born read-only, and the read
    cycles the fused MMIO load did not charge under
    `PMB887X_MEMORY_TIMING`
  - the `a32.decode` compare-Rd fix
  - the LG fix in dif_v2.c (`dif_defer_tx_isr`)
  - the `ppm_save` row stride (`ui/ui-qmp-cmds.c`)
  - `gen_eret_end_tb`'s IRQ fix
  - the flag-masked victim-TLB compare

## Marking

Each entry's **Mark** column says how isolated the fast path is:

| Mark | Meaning |
|---|---|
| **FILE** | In its own file, which carries a `WASM PORT FAST PATH (removable)` comment |
| **MARK** | Inline in an upstream file, but carries the `WASM PORT FAST PATH (removable)` comment |
| **wasm** | Inline in an upstream file, unmarked, under `#ifdef CONFIG_TCG_WASM64` or `__EMSCRIPTEN__`. Native builds are unaffected |
| **all** | Inline in shared code, unmarked, and compiled into native builds too. Native lockstep and reference runs execute it |

Today R6, A9 and A10 carry the comment: each has its own file, plus MARK
comments on its hooks. D6's `dma_sink_write_block_mr`, D9's hunks in
`hw/lcd/lcd.c` and `hw/gpu/s1d13716/s1d13716.c`, and D11 are marked too.
Everything else is unmarked and inline. New fast paths should follow R6's
pattern: put the code in its own file, and give every hook in an upstream
file the comment.

## Removing one

1. Delete what the **Remove** column names. Afterwards,
   `git -C qemu diff 9e5a6bbfd6 -- <file>` should have lost exactly those hunks.
2. Rebuild with `scripts/ninja-fast.sh`, then run `scripts/gate.sh keep` and
   lockstep on S75 and EL71 (`tools/lockstep-wasm.mjs`, and the native
   `scripts/run-lockstep.sh`). Run `tools/lockstep-wasm.mjs` once more with
   `LS_QARGS="-rtc base=2000-01-01T00:00:00,clock=vm"`: its default arguments,
   which the gate uses, add `one-insn-per-tb=on`, and with one instruction per
   TB there are no superblocks and no io_recompile rewinds. Export
   `PLAYWRIGHT_BROWSERS_PATH=$PWD/tools/chrome` first, or every browser gate
   fails within about 60 s.
3. For DSP entries, also run the `pmb887x-dsp-tcg` unit test
   (`hw/arm/pmb887x/dsp/tests/tcg.c`).
4. Price the removal with a paired free-run A/B (`tools/perf/swab.sh`, which
   forces V8's bounds checks as on Android) on towerblox, stopwatch and
   bobby, plus video and midi for SL65 or DSP work. The whole candidate must
   not lose on any scene (performance.md, rule 5).

**Check column:** gate + lockstep apply to every entry. The column names any
extra checker. "Checker (not in repo)" means the commit message or the perf
notes describe a differential checker that was never committed. Rebuild it
before relying on it.

## 1. accel/tcg core

| ID | Where | What it does | Benefit | Remove | Check | Mark |
|---|---|---|---|---|---|---|
| A1 | `tb-jmp-cache.h` (`TB_JMP_CACHE_BITS 16`, `gen`, `tb_jmp_cache_key`), `tb-hash.h` (wasm64 `tb_jmp_cache_hash_func`), `translate-all.c` `tcg_flush_jmp_cache`, `cpu-exec.c` `tb_lookup` / `cpu_exec_loop` | Jump cache: 64K entries, one entry per halfword of a page with 2 TB-flag bits in the hash, and a full flush done as a generation bump | 16 bits: J2ME −5.6 % (3fb2c66465). Halfword hash: stopwatch qht lookups 60k → 6k per 2 s (5c8cf5bc65). Generation flush: neutral on S75, saves 1–10 % of CX70 idle with the 64K table (741597d60a) | Delete the wasm64 branches. The `(pc, flags)` signature of `tb_jmp_cache_hash_func` changed for all builds and can go back too | — | wasm (signature: all) |
| A2 | `cpu-exec.c` `HELPER(lookup_tb_ptr_lc)`, the pc-cache probe in `HELPER(lookup_tb_ptr)`, `w64_lookup_tb_ptr_miss`, `w64_lc_fill`, `w64_pcc[]`, `w64_pcc_hash`, `w64_pcc_get`, `w64_pcc_put`, `w64_pcc_shape`, `HELPER(tb_key_gen_bump)`; `translate-all.c` `cpu_tb_key_gen_bump`, `w64_lc` init; generation bumps in `tb-maint.c`, `hflags.c` `arm_set_hflags`, `vfp_fpscr.c`, `translate-vfp.c`, `gdbstub.c`; `hflags.c` `arm_w64_lc_key`, `arm_w64_lc_key_pc`, `arm_w64_lc_key_layout`; `translation-block.h` `w64_lc`, `W64PccEnt`, `W64PccShape`; `translate.c` `gen_goto_ptr`, `w64_key_static`, `w64_abs_base`; the backend's `w64_pcc_call` (`tcg-target.c.inc`), `w64_pcc_probe` and its `pb_*` emitters and patching (`wasm64.c`), `w64_hint.pcc_call` (`wasm64.h`) | Inline next-TB cache on every goto_ptr: a per-TB slot, then a global pc-keyed table that the lookup helpers probe and that every batch module probes in a function of its own, which the exits call in the helper's place (TurboFan inlines it). A generation counter retires both caches when TB-key inputs change | Per-TB slot: stopwatch +7..9 % (62bdab8192). pcc table: +6.8 % (c7a12330d9). The probe as a function of each batch module (`36e3b3cc4c`): EL71 boot burst −6.5 % (se 0.7) against an inline probe at every exit (`d4380167b9`), free-run within ±1 % on every scene. With the probe only in the helpers, video loses 3–5 % (performance.md, Closed ideas). `w64_abs_base`: towerblox +2.4 % / +2.0 % with bounds checks (2e70b8bed0, 305999f747) | Return `gen_goto_ptr` to the upstream `tcg_gen_lookup_and_goto_ptr`. Drop the two helpers, the pcc table, the module's probe function and its call sites, the generation and all its bumps, and `HELPER(lookup_tb_ptr)`'s probe and `w64_lookup_tb_ptr_miss` (with its `return tb->tc.ptr` in the log branch) | — | wasm |
| A3 | `translate.c`: `w64_back_edge`, `w64_defer_taken`, `w64_absorb`, `w64_abs_cross_page`, `w64_try_join`, `w64_inline_call`/`_return`, `w64_inl_*`, `w64_refund`, `w64_charge_cycles`, `w64_emit_deferred_taken`, `w64_emit_inline_misses` (the `#ifdef` span from `w64_acct_add` to `w64_key_static`, plus call sites in `gen_jmp_tb`, `trans_BX`, `trans_BL` and the insn loop); `translate.h` w64 fields; `translator.c` `w64_page1`, `w64_lin_end`, page-1 `translator_ld` and `translator_use_goto_tb`; `cpu-exec.c` `tb_lookup_cmp` `W64_INL_VPAGE1` probe, `tb_add_jump` inlined list, the `last_tb` keep; `tb-maint.c` `tb_page_span`, `w64_inl_cross_stream`, `tb_unlink_inlined`; `translate-all.c` `w64_inl_pending`, `w64_tb_insn_index`; `target/arm/cpu.c` CF_PCREL off and `pagebits ≥ 12`; `board.c` `minimum_page_bits = 12` | Superblocks (loops branch back inside the TB, short forward branches absorbed, join points) and inlining of BL/BX callees into the caller's TB, on 4 KB guest pages | Superblocks: stopwatch vratio 0.58 → 0.87, video −8 %, music −5 %, Bobby −4 % CPU (2ff4e374c3). Back-edge +7.65 %, join +6 %. Inlining + 4 KB pages: 18–19 % faster than inlining off; 4 KB beats 1 KB by ~8 % (September). Chaining to page 1: video +2.6 % (e149f370ff). Inlined-TB unlink list: up to 40 % of the vCPU in EL71 boot (99166ef386) | The entry points are the six functions called from `gen_jmp_tb`, `trans_BX`, `trans_BL` and the insn loop. With all six refusing, `tb->w64_inl` and `w64_lin_end` stay 0 and the accel hooks do nothing (inferred from the code; not tested). Then delete. CF_PCREL off exists only for inlining (unwind offsets). The 4 KB page can stay on its own. R6 depends on `w64_back_edge` | — | wasm |
| A4 | `tb-maint.c` `PageDesc.code_mask`, `tb_gmask_*`, `tb_page_granules`, `tb_page_covers`, `tb_store_misses_code` (declared in `tb-internal.h`) | Per-page bitmap of the 4-byte code granules, so that a store to a code page's data skips the TB-list walk | CX70 titles +2..15 % (2b8c359001). 4-byte granules: J2ME −6..−10 %, video −1.2 % (cb4dbe103f) | Delete the bitmap and `tb_page_covers`. C3's `do_ram_notdirty_1p` uses it and goes too | — | wasm |
| A5 | `translate-all.c` `wasm_add_io_barrier` / `wasm_is_io_barrier` (declared in `internal-common.h`) and the `cpu_io_recompile` hunk; the two `__EMSCRIPTEN__` blocks in the `translator.c` loop | A PC that needed an io_recompile becomes a single-instruction TB, so the next MMIO access there does not rewind again | Each rewind is an exception unwind, and a polling loop would pay it on every pass. Under icount, a 60M-instruction S75 lockstep leg takes 16 s without the barriers and 3 s with them (2026-11-10); no free-run A/B. It is speed only: the lockstep divergence once blamed on the rewind was the instruction count not being handed back on an unwind (`4fc6ac6dc7`), and with that fixed the `LS_QARGS` run is clean without A5 to 400M instructions on S75 and EL71 | Delete the blocks; `cpu_io_recompile` rewinds every time, as upstream does | Lockstep with `LS_QARGS` (see Removing one) | wasm |
| A6 | `translate-all.c` `setjmp_gen_code` (`w64_tb_env`), `translation-block.h`; `dsp/tcg.c` `tcg_prepare_block`; consumed by `tcg/wasm64` | With a single CPU, a TB addresses env fields as constants | towerblox +12.4 %, stopwatch +8 % with bounds checks (4dc162bbf6) | Never set `w64_tb_env` (leave it 0). The backend then falls back to env-relative addressing | — | wasm |
| A7 | `system/cpus.c` `bql_lock_mmio`, `bql_unlock_mmio`, `bql_release_lazy`, `bql_wanted_by_other`, and the adopt/wanted changes in `bql_lock_impl`; `include/qemu/main-loop.h`; callers in `cputlb.c` (MMIO paths), `helper.c`, `op_helper.c`, and the `cpu_exec_loop` check | Lean BQL pair for MMIO. The release is deferred while no other thread wants the lock | BQL 4.6 → 2.4 % of the S75 idle vCPU (3cc26447e4). Deferred release: S75 idle +4.0 %, KE800 boot −10 % (fa15ac991b). Both measured under icount/rr in September, not re-measured under vcpu-timers + mttcg | Return the callers to `bql_lock()` / `bql_unlock()` and drop the four functions and the `bql_lock_impl` changes | — | all |
| A8 | `configure`, the wasm64 `CPU_CFLAGS` (`-sSUPPORT_LONGJMP=wasm`, and `-sWASM_LEGACY_EXCEPTIONS=0 -mllvm -wasm-use-legacy-eh=0` for the standard exnref instructions); the guards in `scripts/ninja-fast.sh` and `scripts/build-qemu-wasm64.sh` | setjmp/longjmp as wasm exception handling instead of emscripten's JS mode, which routes every call a setjmp caller makes through a JS `invoke_*` trampoline (`cpu_exec` once per entry, `setjmp_gen_code` three times per translated TB). 15 trampolines → 0. It composes with ASYNCIFY only while no function on `configs/meson/asyncify-only.txt` calls setjmp (lessons.md, Emscripten runtime) | EL71 boot burst −4.4 / −7.6 % (bootab.sh, 2 × 4 pairs, against `36e3b3cc4c`). Free-run, 4 pairs each: towerblox +4.9 %, video +3.6 %, bobby +1.2 %, midi +1.2 %, stopwatch −0.4 % (se 1.8) and +1.1 to +3.2 % swapped | Drop the flags from `CPU_CFLAGS` (upstream's line is `-m64 -sMEMORY64=…`) and the two guards, then rebuild from a fresh build dir (configure fixes the compiler's argv when the dir is made) | Firefox boot (`close` tier) | wasm |
| A9 | `tcg/la-touched.c.inc`; its hooks in `tcg.c`: the `#include` after `la_cross_call`, six `if (LA_W64)` branches and three `la_w64_touch` calls in `liveness_pass_1`, the `LA_W64_RA` branches in `tcg_reg_alloc_bb_end` and `tcg_reg_alloc_cbranch` | Liveness walks only the globals, the TEMP_TB temps and the EBB/const temps an op read since the last reset, instead of every temp, at each block end, conditional branch and call-clobbering op. The register allocator saves only the TEMP_TB temps at a block end and skips the conditional branch's assert loop (non-debug builds). States, preferences and the generated code are as before | EL71 boot, 74k TBs: `liveness_pass_1` 543 → 377 ms (−30 %), register allocation and emission −14 %, `tcg_gen_code` 2.63 → 2.30 s (−12.5 %). Boot (bootab.sh, 2 × 4 pairs, against `42bb89c091`): burst −1.5 / −1.5 %, audioMs −2.1 / −2.8 %, lagMax −2.9 / −4.9 %. Free-run, 4 pairs each: stopwatch +5.9 % (4/4), towerblox −0.4 % and +2.8 % swapped (4/4), bobby +0.3 %, midi −0.1 %, video −0.3 % over 12 pairs (median −0.1 %) | Delete the file and its `#include`, keep the `else` arms of the `LA_W64` and `LA_W64_RA` branches, and drop the `la_w64_touch` calls | `#define LA_W64_CHECK` at the top of the file: every walk aborts if an EBB/const temp off the touched list is not dead with no preference (boot and the five scenes passed, 2026-11-06) | FILE |
| A10 | `tcg/const-table.c.inc`; its hooks in `tcg.c`: the `#include` before `tcg_func_start`, the `W64_CONSTS` branches in `tcg_func_start` and `tcg_constant_internal` | A TB's constant temps go in a per-thread open-addressed table per type (2 × `TCG_MAX_TEMPS` slots), emptied by a generation bump, in place of the per-type `GHashTable` that `tcg_func_start` empties for every TB (two indirect calls per lookup, and a grow and shrink per TB). Same temps in the same order | EL71 boot (bootab.sh, 2 × 4 pairs, against `328087aa34`): burst −1.0 % (se 1.2) / −2.1 % (se 0.5, 4/4), audioMs −0.9 / −5.3 %, lagMax −2.8 / −4.5 %. Free-run: stopwatch +1.3 %, towerblox +1.1 % (4 pairs each), midi −0.1 % (8), bobby 0.0 % (12), video −0.2 % (16, median −0.2 %) | Delete the file and its `#include`, and keep the `else` arm in `tcg_func_start` and the code after the branch in `tcg_constant_internal` | `#define W64C_CHECK` at the top of the file: the `GHashTable`s are kept as well, and every lookup aborts unless both give the same temp (boot and the five scenes passed, 2026-11-06) | FILE |

## 2. cputlb, memory, physmem

| ID | Where | What it does | Benefit | Remove | Check | Mark |
|---|---|---|---|---|---|---|
| C1 | `cputlb.c` `tlb_resolve_io_dispatch`, `tlb_resolve_io_subpage`, `CPUTLBEntryFull` `io_*` fields, `io_read_fn`/`io_write_fn` calls in `int_ld/st_mmio_*`; `physmem.c` / `memory.h` `memory_region_subpage_leaf` | Resolves MMIO dispatch, including subpage leaves, at TLB fill time. An access is then one mask test plus an indirect call | EL71 +10 %, S75 MIPS +22 %, S75 J2ME stopwatch +9..35 % (fc11bb2acb, 274a0e4c24) | Return accesses to `memory_region_dispatch_read/write` and drop `subpage_leaf`. C2 depends on C1 | — | all |
| C2 | `cputlb.c` `do_ld_mmio_1p`, `do_st_mmio_1p`, `io_fast_bswap`, `tlb_io_in_range`, and their call blocks at the top of `do_ld{1,2,4,8}_mmu` / `do_st{1,2,4,8}_mmu` | Fused single-piece MMIO load and store paths that skip `mmu_lookup` | Loads: EL71 MIPS +6.9 %, fps +41 % (24d4eb318d). Stores: cover 98.8 % of S75 stores, no separate clock number (0a24e4e53a) | Delete the call blocks and the functions. The fused load charges `memory_region_get_read_cycles()` under `CF_MEMORY_TIMING` itself, as `int_ld_mmio_beN` does (`a535019428`) | — | all |
| C3 | `cputlb.c` `do_ram_notdirty_1p` (the `#ifdef CONFIG_TCG_WASM64` block before the helpers) and the 4 `#ifdef` call blocks in `do_st{1,2,4,8}_mmu` | Stores to the data of a code page skip NOTDIRTY when A4 says the store misses code | J2ME game 5 −8.9 % (7538f05950). | Delete the block and the call blocks. Removing A4 forces it out too | — | wasm |
| C5 | `cputlb.c` `tlb_set_page_full` growth, `tlb_mmu_resize_locked` hunk; `tlb-bounds.h` `TLB_FILL_GROW_MAX_BITS` | Grows a TLB at fill time. Upstream resizes only at flush, and full flushes run at ~0/s here | Not measured (6aa4c4f0cd). Without it the tables stay at 256 entries; they reach 8192 / 2048–4096 / 64 here | Delete the hunks. Run an A/B before removing | — | all |
| C6 | `cputlb.c` `tlb_flush_phys_ranges`, `tlb_phys_note` / `_bit` / `_blk_bit` (16 MB buckets); `physmem.c` `tcg_region_changed`; `memory.c` `romd_stash_*`, `flatviews_update_romd`, `romd_off_mrs` / `ro_on_mrs`, `topo_gen`, `memory_topology_commit_full`, `memory_topology_views_recycled` | ROMD and readonly flips reuse cached FlatView variants, and the TLB is flushed only over the changed physical ranges | Topology commit 3857 → 421 ms per boot (529a995448). Readonly flip as a variant: fixed-work boot EL71 +55.6 %, CX70 +31.5 %, S75 +15.1 % (9970030816). Phys summary: ~4 % of the vCPU in KE970 boot (4b54517d3a, 95055ff451). Boot phase only | Return `memory.c` to full topology rebuilds and `physmem.c` to a full flush per commit. The correctness companions go with it: jump-cache flush on commit and the full commit on eventfd add/del (a0d035f4f0) | — | all |
| C7 | `cputlb.c` `tlb_watch_ram_dirty`, `tlb_reset_dirty_logged`, `tlb_ram_watch_note`, `tlb_set_ram_write_guard` + `ram_write_guard_hits` / `_trap` in `notdirty_write`; `include/exec/cputlb.h` | Targeted dirty resets inside a watched RAM range, plus a write-guard callback on stores to guarded RAM | `tlb_reset_dirty_range_all` 494 → 13 ms per 20 s, from 2.4 % of the vCPU (9692169830). The guard is what makes D1 correct (0c3c3c8c9b). | Only together with D1. Its only user is `dif_v2.c` | — | all |
| C8 | `include/exec/tlb-common.h` `CPUTLBEntry` (`addend_read`, `addend_write`, 32-bit `addr_read` / `addr_write`); `cputlb.c` `tlb_read_idx`, `tlb_set_compare`; the backend's `w64_tlb_probe`, `w64_tlb_haddr` and `W64_L_TLBW` (`tcg-target.c.inc`) | A TLB entry's read and write comparators each sit next to a copy of the addend's low half, and the generated probe takes the pair in one 64-bit load: two bounds-checked loads per guest access on Android where there were three | Free-run with bounds checks against `db5ec3b899`: stopwatch +2.4 % (6 pairs, −0.4 to +4.9), towerblox +1.1 % (14 pairs, se 1.0) (`33855e074b`) | Restore the two `uintptr_t` fields and the `addr_idx[]` accesses, and load the comparator at `cmp_ofs` and the addend at 24 in the probe. R8 reads the pair too | Lockstep with `LS_QARGS` (every guest access goes through it) | wasm |

## 3. target/arm translator and helpers

| ID | Where | What it does | Benefit | Remove | Check | Mark |
|---|---|---|---|---|---|---|
| R1 | `translate.c` `arm_excp_exit_ok` + DISAS_SWI in `arm_tr_tb_stop`; `op_helper.c` `HELPER(svc_inline)`; `helper-defs.h`; `helper.c` / `internals.h` `arm_take_svc_aarch32` | Takes an SVC inside the TB (cores without EL2/EL3), with no cpu_loop_exit unwind | Without it the boot window is −26 %; video +16.2 % (f5df8cb003). Dispatcher iterations 2387 → 28 /Mi | Return DISAS_SWI to `gen_exception` and drop the helper and `arm_take_svc_aarch32` | — | wasm |
| R2 | `op_helper.c` `HELPER(cpsr_write_eret)`; `translate.c` `gen_eret_end_tb` (wasm branch) | An exception return skips the BQL pairs around empty hook lists and continues through goto_ptr. The second `arm_rebuild_hflags` is dropped | Hook skip: video −5.7 % ± 1.5; `bql_lock` 1.29M/s → 6k/s (46d7aa3e64). Rebuild drop: ~0.7 % of the vCPU, below wall-clock resolution (addf630b8e) | Restore the upstream lock/unlock and drop the `#ifndef` around the `arm_rebuild_hflags(env)` line. Keep `cpsr_write_check_irq`, which R3 needs | — | wasm |
| R3 | `translate.c` `w64_psr_can_continue`, `w64_psr_continue`, `w64_psr_new_miss`, `w64_gen_irq_pending_br`, `w64_emit_psr_misses`, `w64_cpsr_write_inline`, `w64_gen_cpsr_read`, the wasm tail of `gen_set_psr` and the `#ifndef` around `gen_lookup_tb_after_cpsr_write`; `op_helper.c` `cpsr_write_check_irq` | `msr` / `mrs cpsr` inline, and CPSR/SPSR writes that do not end the TB | `msr` continuation + SPSR no-end: video +1.8 % (4d1a392927). Inline CPSR write: video −2.16 % ± 0.85 ms/Mi (e2976ebbfe). Inline `mrs`: −2.47 % ± 0.92 (4e60f930b2). Returning all of R3 to upstream on 2026-11-04: stopwatch −3.7 % ± 1.2, towerblox −1.0 % | Return `gen_set_psr`, `gen_rfe` and the `mrs` path to upstream | — | wasm |
| R4 | `translate.c` `gen_shift_cc_w64` and its `#ifdef` in `gen_arm_shift_reg` | Inline flag-setting register shifts | Video −1.09 % ± 0.52, J2ME −0.72 % ± 1.20 (c4919f185b). Without it on 2026-11-04, `helper_shr_cc` was the only stopwatch profile difference from the pre-cleanup build, and the cleanup candidate lost stopwatch −1.07 % over 8 pairs (8 negative) | Delete both `#ifdef` blocks | — | wasm |
| R5 | `hflags.c` `rebuild_hflags_a32_fast`, `rebuild_hflags_a32_el`, and the A32 shortcut in `rebuild_hflags_internal` | Short hflags rebuild for pre-v6 A-profile at EL0/EL1 | S75 idle +3.9 %, 4/4 pairs (90e45a1cec). Removing it on 2026-11-04: towerblox −2.6 % ± 0.9, bobby −1.6 % ± 0.7 | Return `rebuild_hflags_internal` to its upstream body and delete the two functions | — | all |
| R6 | `target/arm/tcg/w64-fill.c`/`.h`, `HELPER(w64_fill)` in `helper-defs.h`, the line in `target/arm/tcg/meson.build`; `translate.h` `w64_fill_words`, `w64_fill_desc`, `w64_rect_ft`, `w64_rect`; `translate.c` `w64_fill_match` (called from `w64_back_edge`), `w64_rect_match` and `w64_bcond_dest` (called from `arm_tr_tb_stop`), the recording in `thumb_tr_translate_insn` and `w64_emit_deferred_taken`, the copy into `tb->w64_rect` at the end of `arm_tr_tb_stop` and the init in `arm_tr_init_disas_context`; `include/exec/translation-block.h` `w64_rect` and `w64_interp_running` (in `tcg/wasm64/w64-interp.c`) | Runs more passes of the 6-instruction Thumb J2ME fill loop in C at the back-edge, charging icount, cycles and counters exactly as the generated code would. When the loop's TB goes on into the row tail and chains to a row-head TB that chains back (a fill rectangle), the same call also runs the following rows, up to 4096 passes, with the state in locals and one write-back | towerblox ~+1.5 % (7/10 pairs); stopwatch and bobby neutral (3116fa62be). Removing it on 2026-11-04: towerblox −1.4 % over 12 pairs (9 negative). Storing the colour 8 bytes at a time (2026-11-04) cut the helper's self time per guest second by ~15 % in paired profiles, ~0.2 % of towerblox. Rectangles (2026-11-05): towerblox +1.9 % over 16 pairs (se 0.7, 12 positive), the fill's share of V8 ticks 3.57 → ~2.0 %; the final source again +1.7 % over 8 pairs. Midi −0.25 % (8 pairs). Stopwatch −1.0 % over 16 pairs at sd ~3 % per pair, while it makes under 2^20 fill calls in 30 s. Bobby −1.4 % over four rounds (se 0.24) without reaching the fill: a control with the same function-index shift and no new code reproduced −0.8 % (performance.md, A/B pitfalls) | Delete the file pair, the meson line, the helper entry and the marked hooks | Lockstep is **blind** to it (framebuffer SDRAM is only soft-compared). Predict-and-compare checker (not in repo); for the 8-byte stores, a per-element reference copy with 8 bytes of margin matched over 23M towerblox calls, and a `pattern ^ 1` mutant aborted. Rectangles: two predictors, one row transition at a time and the fused loop over 1–4 rows with every store logged ([performance.md](performance.md), in-situ checkers); a `v ^ 1` store mutant and a one-cycle mutant were each caught at every prediction | FILE |
| R7 | `target/arm/tcg/w64-fill.c`/`.h` (the second half), `HELPER(w64_blit)` in `helper-defs.h`; `translate.c` `w64_blit_match` (called from `w64_back_edge`) and the join recording in `w64_try_join`; `translate.h` `w64_join`, `w64_join_n`, and `w64_fill_words` grown to 17 | Runs more passes of the firmware's 17-instruction colour-keyed blit loop (S75 `a0a05540`, EL71 `a0a16890`) in C at the back-edge, a page of source and destination at a time in guest order, charging each pass by its pixel class exactly as the generated code's branches and joins would | stopwatch +7.0 % over 7 pairs, all positive; towerblox +1.0 % over 6 (se 1.8), two pairs at a time against the same build with the matcher call disabled (`dcb799b05c`) | Delete the second half of the file, the helper entry and the marked hooks | Lockstep sees its registers and counts but not the pixels. Predict-and-compare against the generated code (checker not in repo): 1.07M rows on stopwatch, 3.2M on towerblox, no mismatch. `tests/tcg-isa/t_blit.c` carries the loop against a C model and the gate byte-compares it with native; two kernel mutants failed it | FILE |
| R8 | `translate.c` `w64_block_host`, `w64_block_fast`, `w64_stm_fast`, `w64_ldm_fast` and their hooks in `op_stm` / `do_ldm`; `include/tcg/tcg.h` `TCGLabel.cold`; the two `l->cold` hints in the backend's `w64_br_to_label` | One TLB probe for all the words of an LDM/STM of two or more registers, in TCG ops, keyed on the last word (the per-access probe's page-straddling trick); the words then go through the host pointer. A miss, MMIO, a clean or guarded page, a page boundary inside the block or a misaligned base take the per-word code, which is unchanged and hinted cold. The loaded pc and base are stored after the arms meet. User-bank and exception-return forms keep the per-word code only | Census, towerblox: 27 % of executed probes were the later words of a push or pop (531M of 1965M); the fast arm ran 98.7 % of the time. Free-run with bounds checks against C8 alone: towerblox +2.0 % (6 pairs), stopwatch +3.6 % (4 pairs, −2.6 to +7.6). C8 and R8 against `db5ec3b899`: towerblox +3.1 % (16 pairs), stopwatch +4.1 % (6), bobby +1.5 %, midi +1.2 %, video mips +0.5 % (4 each) (`8fcac1b334`) | Delete the four functions and the marked hooks; `TCGLabel.cold` and its two hints go with them | Lockstep with `LS_QARGS`. `tests/tcg-isa/t_block.c`: eight words at every split across a page boundary and the base in the list, repeated into compiled code | wasm (`TCGLabel.cold`: all) |

## 4. pmb887x devices

All of these are plain C in upstream device files, with no `#ifdef`
(**all**), and unmarked except where the row says "marked". The DIF v2 lazy
and fed paths run only under vcpu-timers (runtime check
`qemu_virtual_timers_on_vcpu`). `dif_v2.c` is about 620 lines from upstream.

| ID | Where | What it does | Benefit | Remove | Check |
|---|---|---|---|---|---|
| D1 | `dif_v2.c` `dif_tx_bus_go_lazy`, `_lazy_wake`, `_catch_up`, `_leave_lazy`, `_write_trap`, `_dmac_catch_up`, `dif_get_guarded_tx_source`; uses T5, C7 and `pmb887x_dmac_set_catch_up` | Display-bus wakes go lazy while the vCPU runs. A guard and catch-up run them before anything can observe the bus | Stopwatch vratio under contention 0.466 → 0.569 and 0.567 → 0.686 (0c3c3c8c9b) | Delete these and the lazy branch of the wake path, together with T5's only user and C7's guard | Wake and store differential checkers (not in repo) |
| D2 | `dif_v2.c` `dif_run_fed_tx_bus`, `dif_plan_fed_tx_bus`, `dif_count_fed_tx_wakes`, `dif_get_fed_tx_bus_words`, `dif_skip_fed_tx_wakes`, `is_mux_shifts` / `mux_*shift*` in `dif_update_mux` + `dif_mux_entries`; `dmac.c` `pmb887x_dmac_count_bulk_bursts`, `_get_bulk_source`, `_serve_bulk_bursts` | Runs the bus wakes of a halted CPU in one callback, with a planned batch, a closed-form plan and a shift-based mux | Bobby 0.860 → 0.762, −11 % (62b16312dd). Batch cap 512: +1.3/+4.2/+1.6/+1.7 % (0d749b0fd6). Word hoist: 2.1 → 1.5 % of busy ticks (3867c78042). Closed-form plan: 1.02 → 0.25 % (78b8a15418). Shift mux: 1.59 → 1.01 % (b51a7c5b18). The last two are profile shares only | Delete the fed branch. It needs D3 and `vcpu-timers-idle-lead` > 0 (`cpu_clock_owner_idle_reaches`) | Differential checks (`dif_v2.c.chk*`, not in repo) |
| D3 | `dif_v2.c` `dif_serve_tx_burst`, `dif_raise_tx_burst_request`, coalesced `dif_clear_dma_requests`; `dmac.c` `pmb887x_dmac_serve_burst`, `dmac_get_served_channel` | Serves a display TX burst without the DMA request handshake | Bobby 0.812 → 0.796 → 0.771 (a85157e75b). Load-bearing for D2 | Delete together with D2 | Native lockstep, base vs fast path |
| D4 | `dif_v2.c` `dif_occupy_tx_bus(..., now_ps)` | Reads the clock once per TX FIFO pass | Stopwatch +1.7 % under parbench, biased (d5ac642584). Reverting D2's plan and shift mux + this clock cache + D10's baseband together cost stopwatch 3–7 % (2026-11-02). | Restore the per-entry clock reads | — |
| D6 | `dmac.c` `dmac_translate`, `dmac_memory_commit` (MemoryListener), `dmac_read_bytes`; `hw/dma/dma-sink.c` `dma_sink_write_block_mr` (marked) | Caches the FIFO's bus translations and hands the sink the translated region. The sink lookup itself is upstream's `DMASinkCache` | Stopwatch +1.8 % (d7590ed13c). Bobby −1.7 % (e576fc3017) | Delete the translation cache and call upstream's `dma_sink_write_block` with the bus address; drop `dma_sink_write_block_mr` | — |
| D7 | `tpu.c` `tpu_update_timer` (re-arm only on a moved deadline), `tpu_advance` (single advance), `tpu_ram_write_moves_deadline` | Cuts TPU timer re-arms and advances per register or event-RAM write | Re-arm: S75 idle MIPS +11 %, EL71 +21 % (0662edf94c). Single advance: `tpu_advance` 5.8 → 2.9 % (5797540d62). Event-RAM early return: S75 +7..20 % (de7cdf5fd0). One-event window: not claimed (3b2d98faed) | Restore upstream `tpu.c` (the window then reverts to 0068's fork test, not to upstream) | — |
| D8 | `gptu.c` `gptu_t01_observable`, `_matters`, `_free_running`, `_ticks_to_boundary`, `_advance`, `gptu_ev_wants_timer` | Arms the GPTU T0/T1 QEMU timer only for overflows the guest can observe | KE800 went from never reaching idle to booting; S75 boot −4..5 % (a2b52c7c77; the 474bff9dbe syncs are its correctness fixes) | Restore upstream `gptu.c` | — |
| D9 | `hw/lcd/lcd.c` (GRAM drain in place, polling writer, `lcd_transfer_bytes`, `lcd_queue_ram_byte_run`; marked); `hw/gpu/s1d13716/s1d13716.c` `s1d13716_transfer_block` / `_bytes` and the plain cast in `s1d13716_transfer` (marked); `hw/ssi/ssi.c` `ssi_transfer_bytes` + `transfer_bytes` hook and the plain casts in `ssi_transfer` | Moves display bytes to the LCD in runs, with no per-byte transfer calls or condvar wakes. The per-byte paths that remain skip the checked QOM casts and their trace point | Drain in place: stopwatch vratio 0.892 → 0.943 (3a4052ddc7). Polling: futex wakes 2.13 → 0.29 % (43c24bb03d). Byte runs: ~1.3 % profile (2f09e9c30f). s1d13716 pass-through: +12 % J2ME window, September (ed6a5daa97). Plain casts: with the checked ones back on 2026-11-04, `object_dynamic_cast_assert` rose 0.33 → 0.41 % of midi and 0.04 → 0.09 % of stopwatch, and midi leaned −0.6 % over three rounds | Restore upstream `hw/lcd/lcd.c`, `include/hw/lcd/lcd.h`, `ssi.c` / `ssi.h` and `s1d13716.c`. D2 calls `ssi_transfer_bytes` | — |
| D10 | `dsp/peripheral/baseband.c` `baseband_publish_range`; `hw/audio/i2s.c` class cache | Small per-call cuts: stepped ring indices, cached QOM class | Baseband: 3.09 → 2.49 % profile (ce4d3f684a). i2s: Bobby 0.919 → 0.909 (01c6acb0bb) | Restore upstream | — |
| D11 | `hw/audio/audio-line.c` `audio_line_write`, `audio_line_sink_port_init`; `include/hw/audio/audio-line.h` `AudioLineSinkPort.klass` (marked) | Holds the sink's interface class in the port and walks the bus without checked casts, as upstream's `i2s_tx_write` does. The AFE and the PMIC router write one sample frame per call | Without it the 2026-11-09 merge lost towerblox −4.2 % and midi −1.4 % (4/4 pairs); the class lookup alone was ~0.3 % of towerblox and ~0.6 % of midi (3486f1e2b7) | Call `AUDIO_LINE_SINK_GET_CLASS` per write again and drop the field | — |
| D12 | `dsp/peripheral.c` `dsp_bus_advance` (the walk is now `dsp_bus_advance_devices`), `dsp_bus_flush`, `dsp_bus_get_horizon`, `dsp_bus_device_takes_cycles`, the flushes in the clock, CODON and external-register entry points and the subtraction in `dsp_bus_get_cycles_until_event`; `peripheral/internal.h` `dsp_bus_access`, `dsp_device_t.timed`, `pending_cycles` / `horizon_cycles` / `horizon_max`; `peripheral/i2s.c` `dsp_i2s_get_cycles_until_frame`; `peripheral/timer2.c` `timer2_get_cycles_until_interrupt`; `tests/peripheral.c` `test_bus_horizon` (marked) | The bus adds cycles up while the sum is below the first cycle at which an active device does more than count (an I2S frame, timer 2 reaching its maximum) and hands the devices the sum then, or before an access to a device that takes cycles. Only the I2S ports and timer 2 have a horizon: any other active device, or a peripheral type the bus does not know, holds it at zero, which is upstream's behaviour. The baseband is asked on every call | bobby +2.2 % (6 pairs), towerblox +1.2 % (12), midi +0.6 % (6), stopwatch and video ±0; towerblox profile `dsp_bus_advance` 3.05 → 2.4 % with callees; 86 % of the calls return after the add (`58cb97caff`) | Revert `58cb97caff`. To switch it off for a comparison, return 0 from `dsp_bus_get_horizon` | `tools/perf/busdigest.py`: identical digests against the undeferred bus over 35M bus events of the S75 and EL71 boots; `test_bus_horizon` in the `pmb887x-dsp-peripheral` unit test. Both catch a horizon late by 50 cycles. **After a merge:** a device upstream adds to the walk holds the horizon at zero by itself (the count in `dsp_bus_create`), but if `dsp_i2s_advance` or `timer2_advance` come to do anything between frames, or before the counter reaches its maximum, the two horizon functions must follow: rerun the digest |

## 5. DSP translator (`hw/arm/pmb887x/dsp/tcg.c`)

All of these are inline in the upstream file, unmarked, and compiled natively
(**all**). The exceptions are the wasm64 parts of P10 and A6.

| ID | Where | What it does | Benefit | Remove | Check |
|---|---|---|---|---|---|
| P1 | The kernel section from `tcg_fast_loop_35be[]` to `tcg_execute_fast()` (contiguous, after `tcg_execute_prepared_block`; ~1600 lines: `tcg_fast_run_35be` / `tcg_fast_iterate_35be` via `TEAK_FAST_LOOP` / `TEAK_FAST_RUNNER`, 643F/6489/64A9, `tcg_fast_discover`, `_relocate`, `_lookup`, `_invalidate`, `_verify`); hooks in `tcg_prepare_block`, the program-write paths, `HELPER(teak_tcg_chain)` and the slice runners; forward declarations near the top; `core.h` `fast_runs` | Hot GSM correlator loops run as C kernels instead of chained TCG blocks | All loops on vs off: SL65 MIDI 0.566 vs 0.632 cores, EL71 AAC 0.610 vs 0.682 (4d7343564d / 90f3562467). 35BE also saves 0.7 s of boot. 35BE's usual shape on guest memory itself, `tcg_fast_iterate_35be_flat` (6b8a64baa5): stopwatch +6.3 %, midi +6.0 %, bobby +4.3 %, towerblox +3.8 %, video +2.1 %. Follow-ups: 8fe212e31d (video 35BE 24.4 → 18.9 % of vCPU), 13c43bfff0 (video +3.8 %), d0b6cad865 (+7.6 %), a2fc4f3414 (MIDI 0.508 → 0.484), fefdb61f9d (SL65 0.594 → 0.531), 2ba75a9b95 (~0.8 %) | Delete the section and its hooks. There is no runtime switch | Unit tests `35be-iterations` (ring modes at shift 0 and 1 since 6b8a64baa5, four mutants caught), `relocated-fast-loop`; differential checkers (not in repo) |
| P2 | Temp pool (near the top of the file) | Reuses TCG temps so that 64-instruction blocks fit TCG_MAX_TEMPS | Not measured. Load-bearing: without it blocks are halved | Restore upstream temp allocation | — |
| P4 | `tcg_remove_dead_state_stores`, `tcg_call_hides_state`; `dsp.c` + `runtime.c` / `.h` `dsp_runtime_get_trace_pc` | Removes flag, pc and state stores that the next instruction overwrites | State stores: −0.6 / −0.9 % (4c84885f3c). pc stores: Bobby −0.85 % (37b179e59c). Flags not measured. Removing it on 2026-11-04: bobby −1.5 %, towerblox −1.2 % | Drop the pass and return `dsp.c` to `dsp_runtime_get_pc`. P6 relies on the pass | — |
| P5 | `tcg_demote_label_dead_temps` | Demotes temps that are dead across labels | Bobby 1.079 → 1.034 (4ace13cbc9) | Delete the call and the function | — |
| P6 | `tcg_emit_inline_register_read`, `tcg_emit_inline_mov_accumulator_write`, `tcg_emit_inline_alb_register` | Inline register reads, mov to accumulator halves and register ALB ops | Bobby 0.949 → 0.927 (b2e3e17771). Bobby vratio +3.0..3.8 %, video +0.5..3.3 % (6a18783ada) | Restore the helper calls | Checkers `albchk.py` / `movchk.py` (not in repo) |
| P7 | `tcg_emit_shift_by_value` and its use in `tcg_emit_shift_conditional` | Inline accumulator shift by the shift-value register | Bobby +1.8 %, MIDI +0.5 %, noisy; ceiling ~1 % (bdae25233c) | Revert bdae25233c | Checker `shchk.py` (not in repo) |
| P8 | `tcg_emit_shifted_product` (branchless); `tcg_emit_accumulator_value_flags` fz/fe reuse | Product-shift arithmetic instead of 4 labels, and flag temp reuse | Not measured (4d7343564d). The flag reuse is load-bearing for P4 | Restore the upstream function bodies | — |
| P9 | Batching of loops that write, repeat bodies and inline plain registers (7a1e2d1106); `level_free` (ab1b086728) | Runs more loop iterations per block entry | Music 0.686 → 0.602 (7a1e2d1106). Music 0.783 → 0.699 (ab1b086728) | Revert those hunks | Unit tests `batched-loop-exit-after-write`, `block-repeat-body-exit-after-write` |
| P10 | `HELPER(teak_tcg_chain)` with `core.h` `chain_prev` and `succ[]` in the cache entry, keyed on `tcg_block_cache_epoch` / `succ_epoch`; the wasm64 `target` / `evict_epoch` fields (also in `teak_tcg_chain_link_t`) | Chain-link entry caches. The epoch moves only when entries are added or freed, so the caches survive program-bank switches (about 34k a second on S75). On wasm64, the chain also returns the tagged table index | Video vratio +2.8..3.4 %, Bobby +2.5..3.1 % (3488724de2). Epoch: towerblox +2.4 % (f8612575ce) | Restore the upstream lookup in the chain helper | — |
| P11 | `HELPER(teak_tcg_chain)`: the branch that prepares a repeat-headed or over-budget block; `core.h` `chain_slice_limit`, set in `tcg_execute_cached_slice` and cleared in `teak_tcg_execute_slice` / `teak_tcg_execute_block`; the `dynamic_cycles` test in `tcg_chain_exit_link` | The chain helper enters a block that starts with a repeat, or is longer than the remaining budget, as the cached slice loop would on the way back in, instead of stopping for it | towerblox +1.2 % (8 pairs), video +2.5 % (4), midi +0.9 % (8), bobby +0.4 %, stopwatch +0.2 % (`455f756d82`). 2M of 3.5M block entries on SL65 MIDI were such stops | Restore the two stops in the helper and drop the field | Old-vs-new native lockstep, 1.5e9 instructions: S75, EL71, SL65 identical |
| P12 | `tcg_emit_branch_if_any_flag`, `tcg_emit_branch_if_link_field_differs_u16` and their use in `tcg_emit_linked_chain` / `tcg_emit_branch_if_link_mismatch` | The inline chain test reads four byte flags with one load and compares `lp`/`bcn` as one 16-bit value | midi +0.8 % (4 pairs), video +0.9 % (6), bobby +1.0 % (4), towerblox +3.2 % (2), stopwatch +0.5 % (2) (`9e7d3d4ce5`) | Revert to one `tcg_emit_branch_if_nonzero_u8` per flag | Old-vs-new native lockstep as P11 |

## 6. Timers and clock

All of these sit in upstream's vcpu-timers code and work only under
vcpu-timers.

| ID | Where | What it does | Benefit | Remove | Mark |
|---|---|---|---|---|---|
| T1 | `cpu-exec.c` `cpu_cycle_budget_exit`; `tcg-accel-ops.c` `tcg_vcpu_timers_next_budget`; `tcg-accel-ops.h` | Renews a spent budget inside `cpu_exec`, without leaving the loop | Stopwatch 0.907 → 0.975 (23593204f5) | Return to `cpu_cycle_budget_expired` in `cpu_handle_interrupt` | all |
| T2 | `cpu-timers.c` `cpu_clock_owner_raw` (`CPU_CLOCK_OWNER_REREAD_NS`), `cpu_clock_owner_limit_lag`; `tcg-accel-ops.c` `tcg_vcpu_timers_wait_for_clock(…, realp)` | Reuses a host-clock reading (a JS call on wasm) for up to 10 ms | Stopwatch 0.70 → ~0.85; host reads per budget 3 → 1 (23593204f5) | Read the host clock at each use, as upstream does | all |
| T3 | `cpu-timers.c` `cpu_clock_owner_idle` (`cpu_clock_owner_idle_raw`) | Re-reads the host clock in owner idle only when the thread would sleep | Bobby 0.928 → 0.817 cores (afe23d9974) | Delete the cache | all |
| T4 | `cpu-timers.c` `cpu_clock_owner_shorten_budget_at` | A newly armed timer shortens the budget without a host read | `timer_mod_ns` 1.03 → 0.32 s per 20 s (11699de202) | Return to the host-reading path | all |
| T5 | `include/qemu/timer.h` `QEMU_TIMER_ATTR_LAZY`; `qemu-timer.c` `timer_first_eager`, `timer_others_expire_time_ns` | Timers that neither cap the clock nor end the budget | Mechanism of D1 (0c3c3c8c9b) | Only with D1 | all |
| B1 | `meson.build`: `-ftrivial-auto-var-init=zero` left out on emscripten | Avoids zeroing every uninitialized local | Video 4.19 % ± 2.88, J2ME 1.45 % ± 1.18 (0a3e5f2ce3) | Move the flag back into `hardening_flags` unconditionally | wasm (meson condition) |

## Dependencies between entries

- R6 and R7 need A3 (`w64_back_edge`; R7 also its joins). Its rectangles also need A3's deferred
  exits and the absorbed `b`, the backend's `goto_tb` slots (`jmp_dest`, and
  the table index a chained slot holds), and the interpreter tier's
  `w64_interp_running`, because an interpreted TB never chains.
  A2's pc cache emits A1's hash shape.
- C2 needs C1. C3 needs A4. R8 needs C8 (it loads the same packed word).
- D1 needs C7's write guard, T5 and the DMAC catch-up.
- D2 needs D3 and `vcpu-timers-idle-lead` > 0. D9's `ssi_transfer_bytes` is
  D2's output path.
- R3 needs `cpsr_write_check_irq`. R1 and R2 use A7's `bql_lock_mmio` /
  `bql_release_lazy`.
- P6 and P8's flag reuse rely on P4. `dsp_runtime_get_trace_pc` exists only
  because of P4's pc-store drop.
- A3's CF_PCREL-off exists only for inlining.

## Returned to upstream

These were fork code once. Each was removed because the removal measured
neutral, or because upstream gained its own form. Do not re-add one without
a new measurement.

- **`3de1546af5`** (dead code): memory `write_run` / `write_direct`, the
  dead DSP chain lookup and `tcg_fast_run` parameters, the native
  `qemu_cond_timedwait_ns`, backend leftovers.
- **`b12dea95f2`:** `arm_rebuild_hflags_mode_change` and the `cpsr_read`
  test in `cpsr_write`, the WFI no-longjmp, the EXITTB fast path without
  the BQL, the lean BQL pair in `cpu_handle_exception`, the kick-flag
  barrier skip.
- **`092f67eff7`:** `io_clock_window` / `io_open_clock_window`
  (icount-only) and the `mod.c` ctz loops.
- **`e227c7e9a3`:** `timer_notify_main_loop` / `qemu_in_main_loop_thread`,
  and the `rtc.c` negative-interval guard.
- **2026-11-04 cleanup, after merge `6cd424cdb5`:**
  - the link flags in `configs/meson/emscripten.txt`
    (`scripts/build-qemu-wasm64.sh` passes its own), the stale-mux rebuild
    in `dif_is_pbc_selection_valid`, and the fork's DSP `mov` control
    register fix, which upstream's `tcg_emit_mov_register_read` replaced;
  - C3's load side (`do_ram_1p`);
  - C4 (`get_page_addr_code_hostp` from the TLB entry) and `io_rom_device`;
  - C7's dirty-mode skip in `tlb_reset_dirty`;
  - D7's word path in `tpu_ram_write`.

  Every other removal was tried and put back, because the whole candidate
  lost without it ([performance.md](performance.md), 2026-11-04 deviation
  cleanup). P4, R3, R4, R5, R6 and D9's plain casts were measured and kept
  (their rows give the cost of removing them). A5 stayed because the
  pinned-RTC lockstep diverged without it; that was the fold's instruction
  count (see its row), and A5 stays for its speed.
- **2026-11-09 merge of `9e5a6bbfd6`**, where upstream has its own form:
  - the flash-blk write-behind: the CFI flash writes dirty pages back from
    a timer. Upstream starts every dirty run at once, where the fork kept
    one request in flight; a KE970 boot issues 219 at once and passes;
  - D5 (the `dif_v1.c` burst path), gone since merge `6e41e38a16`;
  - D6's `__thread` sink owner/class cache: `DMASinkCache`;
  - D10's `fifo.h` and the `audio/buffer.c` push counter: core
    `Fifo8`/`Fifo32`, and a prefill threshold that reads no clock;
  - P3 (branchless data layout, inline high store): upstream's emitters;
  - D4's lazy DIF mux rebuild;
  - the `PMB887X_TRACE_*` and `PMB887X_SIM*` environment: `-debug-channels`
    and `-device gsm-sim`.
