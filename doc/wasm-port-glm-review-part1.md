# Wasm port review, part 1 — everything outside `tcg/wasm64`

Scope: the `qemu` submodule branch `wasm-browser-port` (= `origin/wasm-patches`,
43 commits) vs `origin/master`, **excluding** `tcg/wasm64/` (reviewed in
[wasm-port-glm-review-part2.md](wasm-port-glm-review-part2.md)).  ~4,100 added
lines across 65 files were read in full (accel/tcg, system/, target/arm,
tcg/tci*, util/, ui/, hw/arm/pmb887x, include/, configs/meson, build glue),
plus targeted reads of unmodified upstream code (`cputlb.c` fill/resize paths,
`memory.c` dispatch/accessors, a native `prepare_host_addr`, `translator.c`
can_do_io handling, `cpsr_write`, emscripten's futex implementation) wherever
a change's correctness depends on an upstream contract.

Acceptance criteria applied: *best possible performance, correctness
preserved, minimal deviation from master.*

Severity legend: **[S1]** shipping correctness/perf bug, **[S2]** latent or
conditional bug / hardening, **[S3]** deviation-hygiene / debug leftovers,
**[OK‑V]** verified correct (see section D).

---

## A. Bugs and likely bugs

### A1. [S1] `qemu_futex_wait()` on wasm returns immediately — RCU thread and every `QemuEvent`/`lockcnt` waiter busy-spins

`include/qemu/futex.h:71-80`:

```c
static inline void qemu_futex_wait(void *f, unsigned val)
{
    /* 0 timeout = wait indefinitely; spurious wakes are allowed by design */
    emscripten_futex_wait(f, val, 0);
}
```

The comment is wrong for the emsdk this tree builds with (4.0.10, vendored at
`build/deps/emsdk`).  Verified in the SDK source
(`system/lib/pthread/emscripten_futex_wait.c:117-155`): only `INFINITY` is
"wait indefinitely"; any other value, **including 0**, is converted to
`max_wait_ns = 0` and passed to `__builtin_wasm_memory_atomic_wait32(...)`,
which polls once and returns `-ETIMEDOUT` at once.

The branch itself proves the point: `util/qemu-thread-posix.c`'s own comment
("emscripten_futex_wait treats 0 ms as 'return at once', which turned every
untimed cond wait — the vCPU's halt wait included — into a lock/unlock spin")
and its fix (`qemu_cond_wait_impl` passes `INFINITY`) know about this.  The
generic wrapper was missed.

Consequences (correctness is saved only because all callers loop on a
predicate):

* `util/rcu.c:304/317` — `call_rcu_thread` waits on `rcu_call_ready_event`
  via `qemu_event_wait` (`util/event.c:162` `qemu_futex_wait(ev, EV_BUSY)`).
  The RCU reclaimer worker **spins at 100 % CPU** whenever it is idle,
  burning a whole browser worker continuously.  (This may be the
  "profiling trap" mis-attributed in doc/wasm-threads-audit.md — worth
  re-checking that doc's conclusion once fixed.)
* `util/rcu.c:155` (`rcu_gp_event`), `accel-blocker.c`, `util/qemu-timer.c`,
  migration (not on wasm) — same spin under contention.
* `util/lockcnt.c:96` — AioContext lock contention spins instead of blocking.

Fix: pass `INFINITY` (matching `qemu_main_loop_wake`/`ml_futex` usage and the
cond implementation).  One-line change, high expected win (idle CPU on the
page drops by one spinning worker).

### A2. [S2] wasm main-loop wait erases wakes that arrive between iterations (level→edge conversion)

`util/main-loop.c:356-370`:

```c
    qatomic_set(&ml_futex_wake, 0);
    if (timeout < 0)      emscripten_futex_wait(&ml_futex_wake, 0, INFINITY);
    else if (timeout > 0) emscripten_futex_wait(&ml_futex_wake, 0, timeout/1e6);
```

`qemu_main_loop_wake()` (`util/main-loop.c:198-204`) sets the flag to 1 and
futex-wakes.  If a producer (vCPU scheduling a BH via `aio_notify`, or
`qemu_notify_event`) runs while the main loop is *outside* the wait — during
glib prepare, BH dispatch, timer runs — its `flag=1` is erased by the
unconditional `qatomic_set(..., 0)` at the top of the next wait, and the loop
then sleeps the full poll timeout with pending work.  Stock QEMU's eventfd is
level-triggered (the fd stays readable until read), so this is a regression
against both stock and the pre-change spin behavior.  The wake arriving in
the window *between* the `set(0)` and the `futex_wait` is fine (value check),
but the window *before* it is not.

Impact: BH/timer/notify latency up to the computed poll timeout whenever the
wake races the iteration boundary.  In practice bounded by the nearest timer
(display refresh ≈16 ms, DSP timers) — but it makes the "main loop takes the
BQL between iterations" assumption behind `rr_idle_advance*` occasionally
laggy for no reason.

Fix sketch (keep it level-triggered):

```c
    if (!qatomic_xchg(&ml_futex_wake, 0)) {   /* nothing pending: sleep */
        emscripten_futex_wait(&ml_futex_wake, 0, ms);
    }
```

or clear the flag at the *end* of `main_loop_wait` after all work has been
drained.  (With the xchg form, also make `qemu_bh_schedule`'s aio path set
the flag — it already does via `aio_notify`.)

### A3. [S2] `ui/wasm.c` key ring: no release ordering on the tail store

`ui/wasm.c:265-284`: producer (JS main thread) writes the slot then publishes
with `qatomic_set(&key_ring_tail, tail + 1)` (relaxed).  Consumer
(`wasm_key_bh`) does `qatomic_read(&key_ring_tail)` (relaxed) then reads the
slot.  Under the wasm/LLVM memory model, relaxed atomics do not order the
plain slot stores before the atomic tail store, so the consumer can in
principle observe the new tail with stale slot contents (a dropped or
duplicated keycode).  Also `key_ring_head` is read by the producer without
`qatomic_read`.  Practically hard to hit on current engines, but it is cheap
to make correct: `qatomic_set_mb` (release) on the tail, `qatomic_read` on
head, or an explicit `smp_wmb()` before publishing.

### A4. [S2] `qemu_timer_notify_cb` budget shortcut ignores realtime deadlines in non-wasm builds

`system/cpu-timers.c:252-266` (not gated by `__EMSCRIPTEN__`): under icount,
a vCPU-thread timer notify is skipped when
`icount_round(virtual_deadline) >= insns_left`.  That is provably safe for
QEMU_CLOCK_VIRTUAL deadlines (the budget ends first and the loop recomputes).
But non-wasm icount builds compute the budget from `min(virtual, realtime)`
deadlines (`tcg-accel-ops-icount.c` still includes REALTIME there), while
this shortcut tests only VIRTUAL — a newly armed *realtime* timer closer than
the budget end no longer kicks the vCPU, delaying input/realtime events by up
to one budget round.  On wasm this is intentional (the wasm
`icount_get_limit` deliberately drops realtime deadlines); for other hosts it
is a silent behavior change.  Either gate the shortcut on `__EMSCRIPTEN__`
or include the realtime deadline in the comparison.

### A5. [S2] `W64_GET_TB_CPU_STATE` hard-codes `arm_get_tb_cpu_state` for every emscripten target

`accel/tcg/cpu-exec.c:392-414`: under `__EMSCRIPTEN__` alone,
`helper_lookup_tb_ptr` calls `arm_get_tb_cpu_state(cpu)` directly and
declares it extern.  Any emscripten build of a non-ARM target fails to link
(cpu-exec.c is compiled per target, so `#if defined(__EMSCRIPTEN__) &&
defined(TARGET_ARM)` fixes it).  Same applies to the `STUB_DSP` flip's
environment assumptions elsewhere — but this is the only link-level
hardcoding.  Low risk for this product, one-line hardening.

### A6. [S3] Ungated `wasm_diag_stat[]` writes in all builds

The diagnostics are supposed to be wasm-only; most sites are behind
`#ifdef __EMSCRIPTEN__`, but these are not, and they run on hot paths of
**every** build (native x86_64 included):

| site | frequency |
|---|---|
| `accel/tcg/cputlb.c:1575` (`WASM_DIAG_TLB_FILL`) | every TLB fill |
| `accel/tcg/cputlb.c:2435` / `:2977` (`IO_LD`/`IO_ST`) | every MMIO dispatch |
| `system/memory.c:1337/1358` (`TOPO_COMMIT`), `:1312` (`TOPO_REUSED`), `:2528` (`ROMD_FLIP`) | every topology commit / romd flip |
| `tcg/tci.c:372` / `:490` (`LD_HELPER`/`ST_HELPER`) | every TCI ld/st slow path |

All other sites are correctly gated.  Gate these too (or see B1: compile the
whole diagnostics block out by default).

### A7. [S3] `dsp_hexdump` mixes byte and word units — dumps the wrong range

`hw/arm/pmb887x/dsp.c:168-196`: `const uint16_t *line = (uint16_t *)buf + b;`
adds the **byte** offset `b` to a `uint16_t *`, so each 16-"byte" line reads
32 bytes and the following line starts 32 bytes in; a call with
`size=0x1c` prints 56 bytes.  Also `if (i < len)` is tautological inside
`i < len` (stray trailing space).  Debug-only (DPRINTF), within RAM bounds,
but it logs the wrong data when debugging command buffers.  Fix the pointer
math (`(uint8_t *)buf + b`, read `len/2` words) or pass word counts.

### A8. [S3] Dead/contradictory items

* `include/qemu/wasm-diag.h`: `WASM_DIAG_TXN_NOEXIT` is declared ("raises
  converted to no-unwind exits") but no code writes it — that feature was
  evidently dropped; remove the entry.
* `util/coroutine-wasm.c:132`: `getenv("QEMU_COSTACK")` runs on **every**
  `qemu_coroutine_switch` (the main-loop block layer switches coroutines
  constantly).  Cache it in a static like every other env knob in this
  branch (`W64_TBLOG`, `W64_DEBUG`, `rewind_mode`).
* `accel/tcg/translate-all.c:634-653`: the wasm block in `cpu_io_recompile`
  duplicates the delay-slot comment block (the old comment is re-added
  verbatim below the new one) — diff hygiene.
* Uncommitted working-tree change in `qemu/meson.build` (re-enables
  `subdir('tests')` for emscripten against the in-tree comment that says
  tests need unsupported host features).  Either commit deliberately (and
  fix the comment) or discard; as-is the branch does not contain it and a
  fresh clone behaves differently from the workspace.

### A9. [S2] `STUB_DSP 1` is hard-flipped, making the whole LLE path (and most of this branch's DSP work) dead code

`hw/arm/pmb887x/dsp.c:49`.  Master had `// #define STUB_DSP 1` (LLE
Teak-lite worker enabled).  The branch unconditionally selects the HLE stub,
so:

* the substantial LLE-side changes in this branch (`dsp_wait_comm_clear`
  rendezvous, `comm_pending`, the AFE wall-clock timer `dsp_afe_timer_cb`,
  `dsp_runtime_pace_afe`, `dsp_bus_advance_afe/_timers`, the
  `DSP_COM_STATUS` warm/handshake composition) **cannot execute** in the
  shipping configuration and are effectively unreviewable at runtime;
* `include/qemu/coroutine-core.h`'s `qemu_coroutine_forbid_current_thread`
  abort-on-switch contract for the vCPU thread was motivated by the LLE
  worker's coroutine use — also dormant.

If the stub is the shipping mode, prefer a build option / machine property
(or keep the LLE tree at master and move the stub to its own small patch) so
the delta says what actually runs; if the LLE mode is still a supported
configuration, it needs its own runtime validation because none of the new
handshake paths have shipped.  Also `dsp_wait_comm_clear`'s stall diagnostics
dump `pmb887x`-specific mask-ROM addresses (0x2340, 0x7c54) — fine for this
port, unupstreamable.

### A10. [S2] Fill-time MMIO fast dispatch: trace and late-mutation caveats

`tlb_resolve_io_dispatch` (`accel/tcg/cputlb.c:1243-1315`) + the fast calls
in `int_ld_mmio_beN` / `int_st_mmio_leN` were verified equivalent to
`memory_region_dispatch_{read,write}` on every condition I could enumerate
(alias, `valid.accepts`, valid/impl size ranges, alignment, eventfds for
writes, `read`-only-ops fallback, re-entrancy guard condition — which matches
`access_with_adjusted_size` bit for bit — and endianness, where
`io_swap`'s host-relative `MO_BE/MO_LE` trick matches `adjust_endianness` on
any host).  Two deviations remain:

1. **Tracing**: fast hits bypass `memory_region_{read,write}_accessor`, so
   `trace_memory_region_ops_read/write` and the subpage traces are never
   emitted for them.  `-trace enable=memory_region_ops_*` silently changes
   behavior.  Gate the fast mask on the trace backends being inactive at
   fill time, or document.
2. **Late mutation**: `ops`, `opaque` and `ioeventfd_nb` are snapshotted at
   fill.  A device that swaps `mr->ops`/`mr->opaque` at runtime without a
   topology change would keep being called through the stale pointers (stock
   dispatches through `mr->ops` live).  No device on this board does that,
   and a topology change flushes entries by range — but a comment (or an
   assert in `memory_region_set_*` mutators) would make the contract
   explicit.

### A11. [S3] TCI immediate-form i32 ops rely on an unwritten "upper bits undefined" invariant

`tcg/tci.c` `tci_add_ri/and_ri/or_ri/xor_ri/andc_ri/setcond32_ri` write
`regs[r0] = regs[r1] ±op imm` **without** the `(uint32_t)` truncation that
every stock i32 op applies, and `tcg_target_const_match`
(`tcg/tci/tcg-target.c.inc:1371-1388`) deliberately accepts i32 constants
whose low 16 bits match a sign-extended imm (e.g. `0xFFFF8000` as `-32768`),
documented as "upper bits of a register are undefined in TCI (consumers
truncate)".  I verified every current i32 consumer in `tci.c` truncates
(compares, setcond/movcond, stores incl. the fast/slow qemu_st paths, env
`st_i32`, brcond, ext_i32_i64) — so it is correct *today*, but the invariant
is implicit and one new full-width consumer would break it silently, only on
64-bit-host TCI.  Cheapest hardening: wrap the `_ri` ALU results in
`(uint32_t)` for the I32 emission path (one `i32.wrap` on wasm64), or spell
the invariant out at the `DEF(...)`s and in `tci.c`'s header comment.

### A12. [OK-V, note] `w64_speculate` successor translation uses the root TB's flags

Speculatively translated successors inherit `s` (flags/cs_base) from the
*root* TB.  If a branch target requires different hflags (mode/EE change
across the branch), the speculative TB is dead weight — at runtime the
lookup honors current flags, so correctness is unaffected, only translation
budget is spent (`w64_nsucc`, capped by `W64_SPEC_N`).  Fine as a hint; the
`w64_explored` and flush-recheck logic is sound (verified: queue bounds,
`made`/`qt` invariants, flush-count check after each `tb_gen_code`, mmap
lock pairing, `w64_spec_active` reset on all paths, sign-extension fix for
I32 targets in `translator_note_succ`).

Note `w64_speculate`'s statics (`budget`, `st[]`, `dbg`) and the io-barrier
table are unlocked — fine under the single-vCPU RR model the port uses; a
future MTTCG-wasm would need them per-CPU.  Worth a one-line comment.

### A13. [OK-V, note] Cross-thread pacing state without atomics

`icount_rtcap_excess_ns`'s `rtcap_v0/rtcap_r0` (written by the vCPU in
strict mode, read by the vCPU; `icount_start_warp_timer` on the main loop
does not write them, only reads `rtcap_vcpu_waiting` atomically) and
`rr_rtcap_throttle`'s `static last_v` are unsynchronized — worst case a
moment of mis-pacing, no correctness impact.  Leave, or make them atomic for
tidiness.

---

## B. Things that can be removed / regrouped to get closer to upstream

Ordered by diff-size reduction per unit of risk.  None of these are needed
for the port's performance once regrouped as suggested.

### B1. The wasm diagnostics subsystem behind a compile switch (largest win, zero perf cost)

`include/qemu/wasm-diag.h`, ~35 counter increments across
cputlb/cpu-exec/translate-all/tb-maint/tcg-accel-ops-rr/tlb_helper/tci.c/
memory.c, the `wasm_memstat`/`wasm_tb_stats`/`wasm_tbs`/`wasm_insns` exports
in `ui/wasm.c`, the `W64_DEBUG`/`W64_TBLOG` env knobs and the
`wasm_diag_stat` definition in cputlb.c.  Put the whole thing behind
`#ifdef CONFIG_WASM_DIAG` (default off, on in the perf-debug builds), which
also fixes A4/A6 mechanically.  The counters are explicitly "cold-path …
cost is noise" — so nothing is lost by making them compile-time optional.
This single change removes ~400-500 lines from the default-visibility diff
and every unguarded-counter site.

### B2. `victim_tlb_hit` masking fix — split out and upstream

`cputlb.c:1711-1745` replaces the victim-TLB exact compare
(`cmp == page`, which never matched entries carrying `TLB_NOTDIRTY` /
`TLB_FORCE_SLOW` above the page bits) with `tlb_hit_page(cmp, page)`.  This
is a genuine all-builds perf fix (MMIO pages aliasing on one index previously
re-walked the guest MMU on every access) and does not need any wasm
machinery.  Submitting it upstream standalone both shrinks this branch and
gives it a proper review; keep it regardless.

### B3. `qemu_timer_notify_cb` budget check — same treatment (after A4 fix)

With the realtime caveat fixed (or the check gated to wasm), this is an
upstreamable icount optimization with the branch's measurements to back it.
Independent of everything else in the port.

### B4. TCI fast paths are all-builds improvements — consider upstreaming as a series

`tci_tlb_probe`/`tci_ld_fast`/`tci_st_fast`, the size-specialized
`tci_qemu_ld8..st32` ops, the `_ri` immediate forms, `tci_call_direct`, and
the `stack[]`-argument call convention are pure TCI work ("a win there too"
per the branch's own comments about native TCI) and touch no wasm concept.
`tcg/tci/tcg-target.c.inc`'s `tci_mop_specializes` comment is stale (it says
"a_mask == 0 (no MO_ALIGN bits)" while the code *requires* the exact
`MO_ALIGN|MO_ATOM_NONE` family — the `.h.inc` comment is the correct one);
fix the comment when splitting.  Upstreaming shrinks the port's TCI delta to
just `tci_tbhdr`.

### B5. `curr_cflags_fast` / `W64_GET_TB_CPU_STATE`

Small, measurable (per the comment: 2.9M indirect lookups/s), but the
`__EMSCRIPTEN__`-only extern decl is the ugliest part (A5).  Replace with a
`TARGET_ARM`-guarded direct call, or (nicer) hoist `get_tb_cpu_state` behind
a static inline that the compiler can devirtualize for single-accelerator
builds.  `curr_cflags_fast`'s reasoning ("no gdbstub, no -d nochain, no
one-insn-per-tb in a browser build") is wasm-marketing; the same shortcut is
valid anywhere those knobs are off — an upstreamable micro-fix if framed as
"inline the common case of curr_cflags".

### B6. hw/pmb887x device work is not wasm-specific — split it out

`vic.c` (asserted-lines bitmap + level dedup), `dif_v2.c` (mux byte-lane
tables, CS/DMAC pin level caching, `pmb887x_completion_clock`),
`dmac.c` (batched memory-source burst), `mod.c` (`srb_set_isr` ctz loop),
`rtc.c` (`cnt-format` property — this one even has its own standalone branch
per doc/upstream-branch.md), `dsp.c`/`afe.c` HLE audio, `flash-blk.c`
write-behind (wasm-gated already).  These are machine-emulation changes that
apply to native builds too; keeping them in the "wasm port" branch obscures
both reviews.  Suggested split: (i) pure perf device fixes (vic/dif/dmac/mod),
(ii) the AFE/HLE audio work, (iii) rtc format (already planned), leaving the
wasm branch with only the runtime/TCG/TLB changes.

### B7. Debug leftovers to delete

* `#if 0` blocks: `dsp.c` afe-timer debug, `dsp/runtime.c` afe-pace debug.
* `WASM_DIAG_TXN_NOEXIT` (A8).
* `util/coroutine-wasm.c` `wasm_costack_trace` + the per-switch `getenv`
  (A8) — or keep behind the B1 switch with a cached env lookup.
* `ui/wasm.c` diagnostics exports beyond the product's needs
  (`wasm_reg`, `wasm_irq_pending`, `wasm_peek`, `wasm_pc`, `wasm_vclock`,
  `wasm_fb_updates`) — fold into B1's switch; they read vCPU state from the
  JS thread with no synchronization (benign for diagnostics, but they
  shouldn't look like API).
* `qapi/ui.json` + `ui/meson.build` + `meson.build` wasm entries: minimal
  and needed — keep.

### B8. Small-perf cleanups worth doing in-tree (not removals)

* `tcg/tci.c` `tci_call_tag` is recomputed from the `ffi_cif` on **every**
  call op (loops over arg types).  Cache the tag next to the call descriptor
  (`new_pool_l2` already stores `func`/`cif`; add the tag word) — saves a
  loop + switch per helper call.
* `tci_tbhdr` executes on every TB entry even when icount2 is off (two
  calls, three atomics).  Emit it only when `icount2_enabled()` at
  translate time (icount2 is configured before any TB is generated).
* `tlb_resolve_io_dispatch` runs for RAM sections too (7 dead stores per
  RAM fill).  Early-out when `!mr->ops`.
* `aio_notify`'s wasm wake fires before the `ctx->notified` fast-path check
  (`util/async.c:464-472`) — every aio_notify unconditionally futex-wakes
  even when the main loop is already awake.  Wake only on the
  false→true `notified` transition (verify against A2's lost-wake analysis
  before changing).
* `ui/wasm.c` `wasm_fb_blit` creates and destroys a pixman image per blit;
  keep one static image per resize instead.

---

## C. Per-area notes (what was checked, non-obvious conclusions)

### accel/tcg/cpu-exec.c

* Pending-exception delivery in `cpu_handle_interrupt` (exception_index ≥ 0
  → clear the exit-kick word, return true) reproduces the `cpu_loop_exit`
  ordering for the no-unwind paths (SVC-via-`gen_exception_exit`, WFI): the
  TB always ends in `exit_tb(0)` right after the state stores, and
  `cpu_exec_loop`'s `cpu_handle_exception` consumes the exception exactly as
  the longjmp would have.  `check_for_breakpoints` in
  `helper_lookup_tb_ptr` runs *after* `can_do_io = true` — same as upstream.
* `gen_exception_exit` stores `exception.syndrome/target_el` matching
  `raise_exception`'s stores bit for bit (`op_helper.c:66-70`); guarded to
  no-EL2/EL3/M-profile A32 where `target_el == 1` and no HCR.TGE redirect —
  matches `arm_excp_exit_ok`.
* `tb_lookup`/`helper_lookup_tb_ptr` devirtualisation: see A5/B5.
* `w64_speculate`: verified (A12).  The `ldr pc,[pc,#-4]` trampoline
  heuristic reads through probe-validated host pointers and narrows the
  sign-extended literal to 32 bits (the KE800 fix) — correct; targets with
  bit 31 set are handled because the probe validates the *narrowed* target.

### accel/tcg/cputlb.c (the biggest single chunk)

* **tlb_flush_phys_ranges + phys summaries**: the summary is only ever
  *grown* on fill/promotion and never cleared on eviction, so it is a safe
  over-approximation; walked groups are rewritten exactly; the victim table
  is always walked fully; tables are powers of two ≥ 64 entries so
  `nr >> 6` covers every entry (no partial-group hole); `ngroup >
  TLB_PHYS_GROUPS` falls back to a full walk and disables summary use
  consistently (the aliased `tlb_phys_note` writes are then never consulted).
  `TLB_PHYS_BUCKET_BITS=25` (32 MB) matches the flash-bank granularity
  argument in the comment.
* **Fill-time growth**: setting `window_max_entries = n` before
  `tlb_flush_one_mmuidx_locked` yields rate = 100 → exactly one doubling by
  `tlb_mmu_resize_locked`, capped at `TLB_FILL_GROW_MAX_BITS=14`; the
  function re-reads `index`/`te` after the resize+realloc (required —
  `fast->table`/`desc->fulltlb` are freed and reallocated inside); the flush
  resets `n_used`, the window and the phys summaries; the in-progress fill's
  `n_fills++` is lost to the reset, which only delays the next growth check
  by one fill.  Growth memory bound: 16k entries × (32B CPUTLBEntry +
  ~96B CPUTLBEntryFull) per mmu_idx — acceptable, but note the fork's
  `CPUTLBEntryFull` grew by 40 bytes (the io_* block) for *every* entry,
  including RAM ones.
* **io_prepare's no-rewind paths**: with icount2, `wasm_io_advance(0)`
  re-checks the deadline so the upcoming callback sees due-timer effects
  (the TB header already advanced the clock past the deadline at TB entry);
  with stock icount, `gen_tb_start`'s subtract + `st16` (verified in
  `translator.c:43-88`) means the whole TB's count is already committed at
  TB start, so `can_do_io = true` + `icount_update` exposes a clock at most
  one TB ahead — same deviation class the branch accepts elsewhere, and in
  the safe (elapsed) direction.  ROM devices keep the stock rewind
  (`QEMU_IO_REWIND=1` forces it everywhere) — matches the documented
  flash-handshake requirement.
* **io barriers** (`translate-all.c` + `translator.c`): the barrier check
  happens before `num_insns++`/`insn_start`, so no phantom-instruction
  accounting; a barrier that is first in a TB forces single-insn via
  DISAS_TOO_MANY; `can_do_io` is set true before the (only) insn of a
  single-insn TB (`translator.c:272-284`), reproducing the rewind's clock
  semantics without the unwind.  The barrier table is 64 direct-mapped
  slots, never aged — a false positive only costs a TB split, never
  correctness.
* `victim_tlb_hit` masking: see B2.  The promoted entry's phys summary is
  noted at the destination index — consistent with the summary invariant.

### system/memory.c + system/physmem.c (romd FlatView variants + selective flush)

The most delicate part of the branch; the safety argument was checked
end-to-end:

* A TLB entry's `section` pointer has **no reference of its own** — upstream
  keeps it valid by flushing the whole TLB on every view replacement, and
  frees views via RCU (`flatview_unref` → `call_rcu(flatview_destroy)`).
  This branch keeps old views alive in the 16-slot romd stash (every
  `generate_memory_topology` records its output; `flatviews_update_romd`
  adopts stashed variants under `(root, topo_gen, romd_sig)` tags), so
  surviving TLB entries always point at a still-referenced view.
* Ring eviction drops the stash's (possibly last) reference:
  `romd_stash_evicted` is set inside `generate_memory_topology`, i.e.
  **before** the same transaction's `MEMORY_LISTENER_CALL_GLOBAL(commit)`,
  so every `tcg_commit` sees it and sets `pend_all` → full `tlb_flush`
  delivered via `run_on_cpu` (BQL-serialized with any concurrent commit's
  region callbacks) before the RCU grace period can free the view (vCPU TB
  execution holds `RCU_READ_LOCK_GUARD` in `cpu_exec`).
* The romd signature is an order-insensitive 64-bit hash of the MR-pointer
  set in command mode; `memory_region_finalize` removes finalized MRs, and
  any non-romd mutation bumps `topo_gen`, so pointer reuse cannot alias a
  tag.  Disabled-MR romd toggles only change the tag (render is fresh on
  first sight) — matches the enabled-gating semantics of master's
  `memory_region_update_pending |= mr->enabled`.
* `tcg_region_changed` accumulates ≤ 32 ranges (>32 or a recycled view ⇒
  `pend_all`); producer (commit thread, BQL) and consumer
  (`tcg_commit_cpu` on the vCPU via `run_on_cpu`, also BQL) are serialized;
  ranges accumulated by a later commit before an earlier commit's work runs
  are simply flushed together.  No path drops ranges.

### target/arm

* `cpsr_write` hflags skip: upstream `cpsr_write` already rebuilds only for
  `mask & (CPSR_M|CPSR_E|CPSR_IL)` (`helper.c:8273`), and all three
  live in `uncached_cpsr`; the outer `before != uncached_cpsr` gate is
  therefore equivalent-or-wider *and* still fires whenever the internal
  rebuild would.  The one theoretical gap — a write that changes only the
  cached T bit — cannot be produced by legal `MSR` masks (T is always
  written together with M in the c-field, and SPSR/eret writes carry M), and
  `cpsr_write`'s internal gate covers those.  Sound; worth a comment
  referencing `CACHED_CPSR_BITS`.
* `cpsr_write_check_irq` sets `icount_decr.u16.high = -1` when any
  interrupt is pending after the write — this is what makes
  `gen_set_psr`/`gen_rfe`/`do_ldm !^` switching from DISAS_EXIT to
  DISAS_JUMP safe (the next TB's entry check — emitted by `gen_tb_start`
  for every TB without CF_NOIRQ — unwinds to `cpu_handle_interrupt` exactly
  where the plain exit used to go).  `HELPER(cpsr_write_eret)` gets the same
  call.  This is an all-builds change; behaviorally verified equivalent.
* `gen_icount2_cycles` early-return and the per-insn
  `gen_helper_cycle_counter` removal on wasm: the TB header
  (`tci_tbhdr`/w64 prologue) accounts per TB with `tb->icount`, which is
  exact; verified `tb->icount` is final before `tcg_out_tb_start` runs
  (translator sets it before codegen).
* `trans_BL/BLX_i` `translator_note_succ` hints: only hints (A12); the
  I32-narrowing fix is correct and documented.

### tcg/tci.c + tcg/tci/*

* `tci_tlb_probe` matches the native aarch64 `prepare_host_addr` compare
  instruction-for-instruction (`a_mask >= s_mask ? addr : addr +
  s_mask-a_mask`, `& (TARGET_PAGE_MASK | a_mask)`, flags live above the
  alignment bits per `tlb-flags.h`); atom handling is conservative
  (anything but NONE/IFALIGN-aligned → slow path, which is always
  semantically correct for plain ld/st).
* `tci_probe_a`'s reduced compare is valid for the exact
  `MO_ALIGN|MO_ATOM_NONE|size(|sign)` family (`a_mask == s_mask`, no bswap —
  BE guests keep the generic path, so no bswap is lost); the slow-path
  reconstruction via `make_memop_idx(MO_ALIGN|MO_ATOM_NONE|…)` only makes
  unaligned accesses take the (data-correct) unaligned split path.
* `tci_call_direct` reads args from the interpreter's `stack[]` — verified
  this fork's TCI convention pre-stores integer args there (args are
  marshalled by explicit TCI stores to `TCG_REG_CALL_STACK`; the master call
  case only builds `call_slots` strides, which are 1 word per integer arg);
  the u32/u64/ptr classification of ffi types is complete; float/struct/6+
  arg cases fall back to libffi.  Result writeback to `stack[0]` matches the
  `len` switch.  Perf note in B8 (per-call tag recomputation).
* `tci_tbhdr` (see B8) and its emission (`tcg_out_tb_start` under
  `__EMSCRIPTEN__`) are consistent with the interpreter's `#ifdef`.

### accel/tcg/tcg-accel-ops-rr.c / icount-common.c / cpu-timers.c

* `rr_idle_advance`: BQL held throughout; waits are on
  `first_cpu->halt_cond` (broadcast by `qemu_cpu_kick`, verified), bounded
  loop (64) with a BQL handoff per iteration; rtcap wait is
  kick-interruptible and re-evaluates idleness; the `icount_sleep=on` arm
  (`icount_start_warp_timer` unchanged path + "deadline still > 0 ⇒ return")
  preserves stock pacing.  `rr_idle_advance_realtime` only moves *which
  thread* runs due QEMU_CLOCK_VIRTUAL timers (BQL-serialized with the main
  loop), never virtual time itself; the KE800 I2C-PIRQSS hang rationale is
  consistent with `main_loop_wait`'s icount deadline skip keeping the
  no-icount case on stock timing.
* rtcalcap: `icount_rtcap_excess_ns`'s strict re-anchor tests the *target*
  time (correct — re-anchoring on current vtime would livelock the wait);
  config gating (`sleep=off` only, wasm defaults to `banked`, env override)
  keeps non-wasm hosts stock.
* `qemu_timer_notify_cb`: see A4.

### util/ (threads, main loop, event notifier, coroutines)

* futex-based `QemuCond`: classic seq+futex protocol — seq snapshot under
  the user mutex, `-EWOULDBLOCK` treated as a wake (value changed), INFINITY
  for untimed waits (the comment documents the 0 ms trap — see A1 for the
  wrapper that still has it).  `qemu_cond_timedwait_ns` sub-ms precision via
  the double-ms futex parameter.
* `event_notifier` wasm flag pair (`wasm_pending` set/xchg): consistent
  set/test_and_clear; note nothing ever poll()s the fd on wasm (main loop is
  futex-only), so the only wake consumers are the flag readers — fine for
  the current thread census, would need revisiting if an aio worker thread
  ever appears.
* `coroutine-wasm`: the `co_forbidden_thread` abort guard is a good
  fail-loud contract for the Asyncify allowlist; the flash write-behind is
  the corresponding vCPU-side fix (verified `pmb887x_flash_blk_pread` only
  runs at realize time on the main thread, before the vCPU is forbidden).

### ui/wasm.c

Framebuffer staging copy + dirty flag is race-safe for the JS reader
(`qatomic_xchg` on take); adaptive refresh logic is self-contained.  A3
covers the input ring; B7/B8 cover the diag exports and per-blit pixman
image.  `qemu_bh_schedule` from the JS thread is safe (thread-safe BH +
`aio_notify` → wasm wake).

### hw/arm/pmb887x

* `vic.c`: bitmap kept in sync on every level write path (including the
  IO_BRIDGE ACK path) and reset; early-return on unchanged level is sound
  (level is the only external input to `vic_update_state`; MMIO writers call
  the update themselves).
* `dif_v2.c`: the mux table decomposition is algebraically exact
  (per-output-bit disjoint OR-form + XOR invert; tables built with the
  invert cancelled, constants extracted from the zero input; `bcsel > 1`
  rejected at write time); every mux-affecting register write calls
  `dif_update_mux` (incl. BCREG).  Pin-level caches are reset to -1 and
  consumers are level-idempotent per the comment.
* `dmac.c`: the batched memory-source burst is guarded to
  `is_src_memory && SI`, preserves per-word device-side writes and the
  endianness swap; `buffer[16K]` bounds hold (12-bit tx size × dword).
* `flash-blk.c`: write-behind coalescing preserves final content (rewrite
  inside a pending range is a no-op, appends flush in order); flush on
  vmstate change covers shutdown; `exit(1)` on pwrite failure is
  heavy-handed but matches the read-path's error handling.
* `rtc.c` / `mod.c` / `ssc.c` / `dif_v1.c`: straightforward; rtc's `unix`
  seed honors `-rtc base=` via `qemu_get_timedate`; `pmb887x_completion_clock`
  moving completions to QEMU_CLOCK_VIRTUAL (except under icount2) makes
  device completions deterministic and vCPU-thread-served — matches the rr
  idle-advance design.
* `dsp.c`/`afe.c`: see A7/A9; the AFE audio bridge (mutex FIFO + silence
  fill + re-entrancy of `afe_audio_set_format` under BQL) is sound; the
  stub's PCM handshake bits mirror the documented real-DSP protocol.

---

## D. Explicitly verified correct (spot-check log)

Condensed from section C; all verified against this tree's sources, not from
memory of upstream:

1. `tci_tlb_probe`/`tci_probe_a` compare semantics ≡ native
   `prepare_host_addr` (aarch64 backend, line-by-line).
2. `tci_mop_specializes` gating ⇒ no BE/bswap/64-bit/unaligned access ever
   takes a specialized op; slow-path reconstruction is data-equivalent.
3. `tci_call_direct` argument marshalling ≡ the fork's TCI call convention.
4. MMIO fast dispatch ≡ `memory_region_dispatch_{read,write}` for every
   guard condition incl. re-entrancy guard condition and endianness math
   (modulo A10's trace caveat).
5. Romd FlatView stash: refcount/RCU/flush-delivery invariant holds on all
   paths (render, adopt, evict, finalize, disabled-MR toggle, mixed
   transactions).
6. `tlb_flush_phys_ranges` summary invariants (monotone over-approximation,
   exact rewrite, victim walk, group coverage, oversize fallback).
7. Fill-time growth (window_max trick ⇒ exactly one doubling; index/te
   recompute after realloc; cap; n_fills/window/summary reset).
8. No-unwind exception paths (SVC store-equals, WFI exit fallback, pending
   delivery in `cpu_handle_interrupt`, kick-flag clearing).
9. CPSR hflags skip vs `cpsr_write`'s internal `mask & (M|E|IL)` gate.
10. `cpsr_write_check_irq` ⇒ TB-entry exit check reproduces the
    DISAS_EXIT→DISAS_JUMP conversion's interrupt delivery.
11. `rr_idle_advance*`/rtcap: locking, kick-interruptibility, bounds,
    sleep=on/off arms.
12. QemuCond futex protocol (no lost wake: seq bump before futex_wake,
    value-check wakeup, waiters counter).
13. vic bitmap / dif_v2 mux table / dmac burst / flash write-behind
    semantics.
14. `qemu_timer_notify_cb` budget logic for VIRTUAL deadlines (the REALTIME
    gap is A4).
15. emsdk futex semantics verified from the vendored SDK source (A1's
    premise).

---

## E. Prioritized action list

| # | item | severity | effort |
|---|---|---|---|
| 1 | A1 `qemu_futex_wait` timeout 0 → INFINITY | S1 perf | 1 line |
| 2 | A2 main-loop wake flag: xchg-check instead of clear-then-wait | S2 latency | small |
| 3 | A4 notify budget check: gate on wasm or include realtime deadline | S2 | small |
| 4 | B1 diagnostics behind `CONFIG_WASM_DIAG` (absorbs A6, A8-dead-enum, most `#ifdef __EMSCRIPTEN__` blocks) | S3, big diff cut | medium |
| 5 | A5 `W64_GET_TB_CPU_STATE` guard with `TARGET_ARM` (or B5 regrouping) | S2 fragility | 1 line |
| 6 | A3 key-ring release ordering | S2 hardening | small |
| 7 | A9 `STUB_DSP` build option + decide the shipping DSP mode | S2 process | small |
| 8 | B6 split pmb887x device perf fixes to their own branch | diff hygiene | mechanical |
| 9 | B2/B3/B4 extract upstreamable fixes (victim-TLB masking, notify budget, TCI fast paths) | diff hygiene | medium |
| 10 | B8 perf cleanups (call-tag caching, tbhdr gating, aio_notify wake dedup, pixman image reuse, getenv caching) | perf | small each |
| 11 | A7 dsp_hexdump units; A8 comment dupe + uncommitted meson.build | S3 | trivial |

The load-bearing pieces of the port — selective TLB flushing + romd view
recycling, the no-unwind exception/rewind machinery, the TCI fast paths, the
RR-thread idle/warp/timer work, and the wasm runtime shims — are, after this
review, believed correct (section D), with the exceptions called out in A.
The single must-fix before any further perf iteration is A1: it is a
one-line change with a whole-core payoff and it invalidates any idle-CPU
measurement taken before it.
