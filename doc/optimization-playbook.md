# WASM performance optimization playbook

This documents the working method of the 2026-09-07/08 optimization
sessions (patches 0007–0009, ~2.4× guest throughput, boot to idle screen
~500 s → ~195 s) so future sessions can pick up the same loop:
**profile → hypothesize → small patch → measure → keep or revert →
document**.  Read together with [performance-handoff.md](performance-handoff.md)
(targets/constraints) and [wasm32-port-status.md](wasm32-port-status.md)
(the JIT port).

## The golden rules

1. **No change lands without a measurement.** If a patch does not
   measurably improve the A/B benchmark, it is reverted, and the
   negative result is written into the patch-series docs so it is not
   retried blind.
2. **Small, self-contained patches.** One mechanism per patch, stacked
   as `patches/NNNN-*.patch` via `scripts/capture-patch.sh`, each with
   measured numbers in its header.
3. **Every step stays under ~5 minutes.** Incremental builds (~8 s),
   benchmark runs (110 s), profiles (30–40 s).  Anything longer (full
   rebuilds, long soaks) runs in the background and is polled.
4. **Tests after every landed patch**: `node tests/run.mjs` (native
   suite, ~65 s, all PASS) plus a wasm boot verification (deep boot /
   idle screen screenshot, no `>>EXIT<<`).

## The fast feedback loop

```bash
# 0. serve the current dist (keep running)
PORT=8080 HTTPS_PORT=6808 node serve.mjs &

# 1. edit sources in build/qemu (patches 0001..000N already applied there)

# 2. incremental rebuild + deploy (~8 s)
bash scripts/ninja-fast.sh

# 3. A/B benchmark (110 s; prints one JSON line)
PORT=8080 node tools/bootbench.mjs 110
#   window = wall secs of deterministic guest work between v=LO and v=HI
#   (defaults LO=2 HI=7).  Lower is better.  Primary metric.

# 4. profile the workers when looking for the next target (~40 s)
PORT=8080 node tools/wprof2.mjs 40 "" 100          # per-worker self-time
PROF_FN=phys_page PORT=8080 node tools/wprof2.mjs 30 "" 100   # callers

# 5. capture the surviving change as the next patch (stacks on 0001..N)
bash scripts/capture-patch.sh my-change-name
# then prepend a Subject/description header WITH MEASUREMENTS to the
# generated patches/NNNN-my-change-name.patch (see 0007/0008/0009)

# 6. confirm nothing is left un-captured (must print "nothing to do")
bash scripts/capture-patch.sh verify-tmp
```

Native suite after landing: `node tests/run.mjs --label <patch> --timeout 240`.

### Boot verification (correctness bar)

- `tools/serialwatch.mjs <secs>` — WATCH lines (v/u/serial/insns/ex[]);
  check: no `>>EXIT<<`, v advances, LCD updates (u) grow.
- Long soak to the idle screen: screenshot + eyeball (wallpaper, clock,
  "Поиск сети"): see the `shot`-style script in git history of this doc
  or `tools/smoke.mjs` as a base.  Idle screen wall times by build:
  0007 ≈ 260 s, 0008 ≈ 235 s, 0009 ≈ 195 s.

## Measurement methodology (and its traps)

- **Primary metric — the v-window**: wall seconds between virtual time
  v=2.0 and v=7.0 (interpolated from 10 s WATCH samples).  Guest work is
  deterministic, so equal v-ranges are equal work; idle (WFI) stretches
  are real-time-gated for every build and dilute all builds equally.
  Use `tools/bootbench.mjs` — it implements this correctly.
- **TRAP (cost hours once)**: when post-processing serialwatch logs,
  align samples by *WATCH-line index*, never by raw file line number —
  interleaved `[qemu] warning:` lines corrupt line-based time math and
  produced a completely false "regression" reading once.  bootbench.mjs
  parses console events directly and is immune.
- **Run-to-run variance**: single-run windows vary ±5–8 % (V8 tier-up
  timing, host noise).  Always run a candidate **twice** and compare
  against **two** baseline runs; require both candidate runs to beat
  both baselines for changes < 10 %.
- **Cross-checks**: final `v` and `insns` after a fixed duration (same
  run length only!), the per-sample insns deltas matched by v, and the
  wprof2 self-time profile (a real speedup shrinks the optimized
  function's share or the wall time around it).
- The WATCH console spam also floods the page console; keep runs
  single-purpose (don't reuse a browser tab across builds).

## Profiling recipe

`tools/wprof2.mjs` (repaired in this session — it never collected
profiles before) attaches the CDP Profiler to the emscripten pthread
workers:

- Worker #0 is the vCPU (TCI interpreter).  Workers #1–#4: pool,
  io_dump/RCU, **main loop** (worker #2), DSP.
- wasm functions show up as `wasm-function[N]`; wprof2 maps them via the
  `qemu-system-arm.js.symbols` sidecar.  That sidecar exists because
  `--emit-symbol-map` is hacked into `build/qemu-wasm/build.ninja`
  LINK_ARGS (measurement-only, a fresh `build-qemu.sh` reconfigure drops
  it — re-add it there if needed).  The map is also handy to resolve
  symbols by hand: `grep -m1 "^NNNN:" qemu-system-arm.js.symbols`.
- `PROF_FN=<substr>` prints caller stacks for a hot function — this
  found the io-recompile storm (previous session) and the flash-romd /
  poll-storm root causes in this one.

## What landed (with numbers)

| Patch | Mechanism | Measured effect |
|---|---|---|
| 0007 TCI TB chaining | restore `goto_tb` chaining; per-TB icount2 accounting moved into the interpreter via a `tci_tbhdr` header op executed at every TB entry; the old 0004-era session io accounting collapses to a deadline-sync | +84–113 % insns at fixed wall time; `cpu_exec_loop` 9.3 %→0.8 % of vCPU; boot to idle ~260 s |
| 0008 TCI immediate forms | `tci_add/and/or/xor/andc_ri`, `tci_setcond32_ri` + constraint letters + `tcg_target_const_match` + outop `out_rri`/`out_ri` wiring — constants stop materializing through `tci_movi` (18.9 %→12.8 % of ops; `add` 7.4 %→1.0 %) | window 46.7→42.9–43.7 s (+8 %); idle screen ~235 s |
| 0009 futex main-loop wait | emscripten `poll()` cannot sleep (it ignores the timeout — the browser main thread must not block), so the main loop busy-spun ~23k iterations/s through a proxied syscall, 2 BQL handoffs each, and the aio eventfd wake never worked at all.  Replaced with a worker-local ns-precision futex wait woken by `qemu_notify_event`/`aio_notify`; main-loop wait no longer times out on virtual deadlines (the vCPU runs those) | window 43.7→40.1–40.4 s (+8 %); +22 % boot progress @110 s; idle screen ~195 s |
| 0012 tci size-specialized ldst | eight appended opcodes (tci_qemu_ld8..st32) for the exact mop family MO_ALIGN\|MO_ATOM_NONE\|size\|sign — every plain pmb887x data access: the generic probe reduces to `(addr & (page_mask\|size-1)) == tlb_addr`, baked in as constants, no mask math/atom branch/size switch, mmu_idx-only stream word; tci_qemu_ld/st dead re-probe removed (0 hits in >1M calls); cold-path diag counters (wasm-diag.h + tools/memstat.mjs) | window wins all 4 interleaved pairs (34.1/33.9/34.0/34.0 vs 40.6/34.4/34.9/34.5; −1.4…−16 %, bigger under host load); boot progress @110 s v 91–102 → 114–121 (+18–25 %); native suite PASS ×4 |
| 0013 wasm: SVC inline exception exit | ARM frontend stores exception_index/syndrome/target_el + `exit_tb(0)` instead of the `helper_exception_with_syndrome` call (its `cpu_loop_exit` longjmp = ~15 µs JS-exception unwind × ~9.4k SWIs/s); new early-return in `cpu_handle_interrupt` delivers a pending exception_index before running/chaining any other TB — exactly the longjmp outcome, incl. IRQ-vs-exception ordering. Gated `__EMSCRIPTEN__` + !EL2/EL3/!M/!AA64 (target_el fixed 1, no TGE redirect); ss_active keeps the helper | window 34→25 s (−26 % quiet, −39 % loaded; 3/3 interleaved pairs); finalV@110 s +30…77 % (92–126 → 164); insns@110 s +6–10 %; `__emscripten_throw_longjmp` 18.5 %→2.6 % of vCPU; idle screen v=245 in ~185 s; native suite PASS ×4 |
| 0014 wasm: io barriers | recurring ROM-device io_recompile (0010 kept the stock rewind for flash-command accesses; the unsplit cached TB re-paid the ~17 µs unwind on every status-poll iteration, 1.67k/s) — on rewind, record the faulting insn pc (64-entry direct-mapped set) + `tb_phys_invalidate` the TB; the translator keeps barrier insns in single-insn TBs (stop before mid-TB / after at TB start), so `can_do_io` is true and the access completes with stock 1-insn-clock precision — no further unwinding | ioRewind 1.67k/s → ~0; window wins 3/3 pairs (25.2–24.8 vs 25.3–27.5); insns@110 s +3–5 % on all pairs; soak v=373 @330 s, keypad works; native suite PASS ×4 |
| 0015 wasm: diagnostics counters | txnF/tbGen/tbFlush/ioRewind/lookupTB cold-path counters (killed two wprof2 ghost theories — see session log) | zero hot-path cost; measurement infra |

## What was tried and REJECTED (do not retry without new ideas)

| Experiment | Result | Why |
|---|---|---|
| **wasm32 runtime-JIT TCG backend (0005, ktock port fully rebased)** (2026-09-09 session; see [wasm32-port-status.md](wasm32-port-status.md) + `patches/attic/wasm32-rebase/`) | v-window 2→7: JIT 18.7–20.1 s vs TCI 24.8–28.3 quiet / 45–46 loaded — **~1.3–2.3x ceiling**, and the boot deterministically hangs at v≈6 (BROM USART-RIS poll data divergence → watchdog reset → recovery loop forever; LG/no-icount boot fully dead) | per-TB dispatch protocol (instance return → C dispatcher → indirect instance call per chained TB) + per-new-TB JS `WebAssembly.Module` compile eat the codegen gains on this 3–4 insn/TB branchy firmware; ~4200-line surface; discarded — the draft and the full rebase live in `patches/attic/` |
| **tci.c interpreter stack as a parameter** (during the 0005 rebase: split `tcg_qemu_tb_exec` into a core + wrapper taking `uint64_t *call_stack`) | TCI v-window 25→45 s (**−60%**, 4/4 interleaved runs) | the pointer-select makes the interpreter stack alias every local array in LLVM's analysis; the TCI stack is per-TB scratch anyway — keep a single function with a local array |
|---|---|---|
| **MMIO dispatch fast path** (memory.c: direct `ops->read/write` call for exact-size aligned accesses, skipping valid-check + access_with_adjusted_size + accessor layers; reentrancy guard replicated; `__EMSCRIPTEN__`-gated) | window 24.9–25.2 → 25.1–25.3 s (**consistently 0.1–0.7 s WORSE on a quiet host**, 4/4 pairs); finalV ±noise; insns@110 s +0.1–5.8 % inconsistent; a late-window A/B (LO=30 HI=60) was flat too | the pre-dispatch condition chain (accepts/align/size/trace/ioeventfd checks) costs as much as the ~3 non-inlined calls it saves at ~90k dispatches/s; V8 already keeps the dispatch path hot. Reverted; don't retry without cross-TU inlining (LTO) |
| **TLB table-base caching in the TCI interpreter** (cache `(fast->table, fast->mask)` per mmu_idx across ops, dropped after helper calls and ldst fallbacks — the only paths that can resize/flush the tlb on this single-cpu machine) | window 25.9/25.2/25.2/25.2 → 24.5/25.3/25.1/25.1 (flat, ±0.1); late-window LO=30 HI=60: 19.7/20.3 → 19.6/20.0 (flat); finalInsns won 4/4 (+1…5.7 %) but finalV-at-200 s varies ±45 v run-to-run — no reproducible win | the two saved loads are L1-hot; the memory-op path is at its practical floor for micro-tweaks (0011+0012 already removed the real work). Reverted; only a big lever (64-bit TCI encoding, wasm32 JIT) can move the interpreter now |
| Lazy flash romd restore (flip back to array mode on first array read, not eagerly on every `0xFF`) | 7.4× fewer topology flips but **32 % slower** in the flash-heavy window | keeping romd off during bursts turns array reads (incl. fetches) into MMIO dispatches, which costs more than the flips save |
| icount2_advance thread-local batching (single-writer mirror, publish every 256 calls) | no measurable change (±noise) | the per-TB atomics are cheap on wasm; reverted |
| TCI store-immediate ops (`tci_st32_ri`/`st8_ri`, incl. the `tcg_out_sti` constant-spill hook) | window 42.9→50.6–50.7 s, final insns −20 % — consistent regression across runs | not root-caused; suspected interaction with allocator behavior/stream size; documented in 0008's header |
| QemuCond-based main-loop wait (instead of the raw futex) | same early-window numbers but only ~half the end-to-end gain | qemu condvar waits truncate to whole milliseconds on wasm; the firmware's ~100 µs WFI windows each pay +1 ms |
| `-sSUPPORT_LONGJMP=wasm` (native unwinding for the SVC-exception longjmps) | binaryen's Asyncify pass crashes on it (verified with a standalone emcc test) | wasm-EH longjmp and `-sASYNCIFY` are incompatible in emsdk 4.0.10; ASYNCIFY is required (coroutine backend/condvar sleeps) |

## Remaining opportunities (ranked, with the analysis already done)

1. **Exception longjmps — mostly CLOSED by 0013/0014.** SVC (the bulk,
   ~15 % of vCPU) is gone; the recurring ROM-device io_recompile rewind
   (~2.8 %) is gone. What remains of `__emscripten_throw_longjmp` is
   ~2.6 % and falling (the one-shot io_recompile per barrier pc,
   interrupt exits, rare traps) — no longer worth chasing. The generic
   wasm-EH longjmp replacement stays blocked (asyncify/fiber conflict,
   see rejected table).
2. **TCI interpreter dispatch, ~57 % of vCPU** — 0012 specialized the
   memory ops; the TLB table-base caching and MMIO dispatch fast-path
   experiments (session 2026-09-08/09 evening) both measured FLAT and
   were reverted — this path is at its micro-optimization floor.
   Remaining levers are the big ones: the 64-bit TCI encoding (est.
   8–15 %, 2–4 h, see regfile experiment below for why 5-bit regs
   alone lost) or the 0005 wasm32 runtime JIT (10–100× ceiling,
   porting effort, separate session).
3. **Flash romd topology churn, ~4–5 % of vCPU** — still open. The
   measured flip cost is ~0.4 ms × ~2/s per poll loop (status polls at
   ~7k/s, 2 flips each). All device-level fixes failed (rejected
   table). The qemu-core fix sketched in the 2026-09-09 session log
   (alternating FlatView+dispatch stash keyed by (root, romd-signature,
   non-romd-generation)) is ~100–150 lines in system/memory.c with RCU
   lifetime care — genuinely upstream-relevant, but the biggest-risk
   patch of the series; do it as its own session with the interleave
   loop and a full soak.
4. **V8 tier-up warm-up — measured 2026-09-08, no in-window effect (closed).**
   `--no-wasm-lazy-compilation`, `--wasm-tiering-budget=100000`, and both
   together leave the v-window at 33.9–34.1 s vs 34.2 s baseline (flags
   verified live: `--no-liftoff` stalls boot, so the plumbing works).  The
   12→44 M insns/s rate ramp across samples is guest-phase behavior — it is
   identical with tier-up triggered 130× earlier.  On a 32-core host the
   45 MB module streams/Liftoff-compiles in ~80 ms, so there is nothing to
   warm up.  The warm-up cost is real only on *slow devices*; the page-side
   lever for those is delivery-path (see the session log below) and, some
   day, the browser's wasm code cache (not observed to engage in headless
   Chromium 153, possibly disabled there — revisit on real hardware).
5. **Main-loop residuals** — after 0009 the main loop sleeps properly;
   remaining cost is per-wake glib iteration + BQL handoffs (measured
   2026-09-09 evening: vCPU `qemu_cond_timedwait_bql` ≈ 0.8 % — not a
   target anymore).

## Gotchas cheat-sheet

- **emscripten**: `poll`/`ppoll` never sleep; condvar timed waits are
  whole-ms; `emscripten_futex_wait(ptr, val, double max_wait_ms)` has
  ns precision and is the right sleep primitive; wasm-EH longjmp and
  ASYNCIFY don't compose.
- **qemu-11 outop machinery**: backends get immediates via
  `tcg_target_const_match` + `out_rri`/`out_ri`/`out_i` hooks
  (TCGOutOpBinary/Brcond/Store); constraint operands combining a
  register class **and** a const letter are required (`rS`, `ri`) — a
  bare const letter with no register class trips
  `get_constraint_priority`'s `n > 1` assert at boot.
- **Per-build opcode numbering**: TCI extra opcodes are appended per
  patch (0007's `tci_tbhdr`, 0008's `_ri` forms); keep new DEFs appended
  so numbering stays stable, and remember `#ifdef __EMSCRIPTEN__` blocks
  in `tcg-target-opc.h.inc` shift numbering between builds.
- **capture-patch.sh** diffs against pinned-rev+applied-patches via a
  throwaway worktree; it refuses nothing except tree-state mismatches,
  and its numbering now uses base-10 (`10#`) — octal `0008` used to
  crash it.
- **The wasm TB layout**: `tb->tc.ptr` points at the TCI stream;
  every TB starts with `tci_tbhdr` (icount) — chain jumps and
  `lookup_tb_ptr` targets all pass through it.  Anything that jumps
  into a TB must land on the header.

## Session checklist

1. `git log` / `ls patches/` — see where the series stands.
2. Serve dist, run `bootbench` twice — establish today's baseline.
3. Profile, pick ONE target, check the rejected list first.
4. Patch → build → bench twice → keep/revert → capture with a measured
   header.
5. `node tests/run.mjs --label <name> --timeout 240` + wasm boot soak.
6. Update this playbook's tables (landed/rejected/remaining) and the
   README patch list.

## Session log: 2026-09-08 (patches 0010–0011, upstream review follow-up)

Started from the 0009-era build (v-window ~40–43 s on a quiet host).  Two
patches landed, several hypotheses measured and rejected.  **The host is
shared: loadavg is not namespaced — always interleave A/B pairs against
saved binaries (cp the dist aside) and distrust absolute numbers across
time.**  A profiler self-time of ≥1% in a leaf symbol whose caller stacks
look insane (wav_enable_out under qemu_coroutine_new etc.) is symbol-map
garbage; verify with counters before acting.  Note for diagnostics:
`fprintf(stderr)` does NOT reach the page console — use
`emscripten_console_error()` (and remember to click `#btn-start` in any
hand-rolled playwright script; an unbooted page measures zero of
everything).

### Landed

- **0010 wasm: skip the io-recompile rewind under stock icount** — the
  0004 skip was icount2-gated, but the default timing model is stock
  `-icount shift=3`: every mid-TB MMIO access still paid the ~150 µs
  emscripten longjmp (wprof: 46.6% of vCPU in __emscripten_throw_longjmp,
  callers cpu_io_recompile ← tci_qemu_ld).  Fix: commit the
  pre-decremented TB budget (icount_update) + re-open the clock window
  (can_do_io) instead of rewinding — the callback sees a clock at most
  one TB ahead, the same deviation chained-icount2 accepts.  Measured:
  v-window 51.5/53.4 → 42.3/41.8 s (interleaved, −19%); insns@110s
  +102% (811M → 1.64G); 180 s soak v=168 @2.38B insns.
- **0011 tci: inline TLB fast path in the interpreter loop** — the 0003
  probe lived behind a per-access call to tci_qemu_ld/st; now
  tci_ld_fast/tci_st_fast (QEMU_ALWAYS_INLINE) run at the four
  interpreter call sites with the helper path as fallback.  Measured
  (interleaved vs 0010): 41.2/41.5 → 38.5/36.5 s (−10–12%).

### Measured and rejected (do not retry blind)

- **Link-time binaryen -O3** (`-O3` in c_link_args): consistent
  regression (41.4/40.9 vs 38.9/37.3 interleaved) — binaryen's rewrites
  beat V8's own codegen.  Kept: no link -O flag.
- **Single-call tbhdr accounting + icount2_advance fast-out** (one call
  per TB instead of two, early-out when !use_icount2): no win (42.5/38.5
  vs 41.4/36.6) — V8 already makes the uncontended atomics nearly free.
- **wasm-EH longjmp** (`-sSUPPORT_LONGJMP=wasm` + `-mexception-handling`):
  the linker never provides `emscripten_longjmp` while `-sASYNCIFY=1` is
  on (JS-mode setjmp objects from the prebuilt sysroot want
  `_emscripten_throw_longjmp`), and emscripten 4.0.10 has no
  SUPPORT_LONGJMP=mixed.  Blocked by the asyncify requirement of
  coroutine-wasm (emscripten/fiber.h).  Measured longjmp load: 12.8k
  cpu_loop_exit/s (~9.4k guest SWIs + 1.6k interrupt exits, ~17% of
  vCPU) — the prize stays behind the fiber/asyncify dependency.
- **gthread coroutines + no asyncify**: no coroutine-gthread.c exists in
  this qemu (backend was removed upstream); resurrecting it is the
  prerequisite path for dropping asyncify.
- **Console-print cost**: 74 console messages in 30 s — printing is a
  non-issue (the unknown-reg warnings are rate-benign).
- **Diagnostics that measured ZERO** (all real, via counters):
  transaction-failed aborts, unaligned aborts, coroutine creations
  (<1024/30 s).  The `emscripten_fiber_init`/`mtree_expand_owner`/
  `qht_reset_size` profile entries are symbolization ghosts.

### Measured facts for the next session

- TCI op mix (histogram via interpreter counter, 2.55G ops sample):
  st32 19.4%, tci_movi 12.7%, ld32u 12.3%, tci_add_ri 9.0%, brcond
  6.2%, st8 6.0%, extract 4.9%, tci_setcond32_ri 4.0% … — **~31% of all
  ops are register↔stack traffic** (middle-end spills + env-relative
  globals) and tci_movi feeds stores.
- TCI register budget: 16 regs − TMP − CALL_STACK = 14 allocatable; the
  ARM frontend alone needs ~20 (cpu_R[16] + flags) → structural spills.
- **5-bit register fields do not fit the 32-bit TCI word** (qemu_ld needs
  op8+r0+r1+memop16 = 32 bits exactly).  Reducing the spill traffic
  therefore requires the **64-bit TCI encoding** (8-byte insn units:
  generous uniform fields, 32 regs, room for wider immediates and fused
  brcond-vs-imm).  Estimated win: 8–15% (spills mostly vanish; decode
  gets cheaper as a side effect).  Touches every tcg_out_op_* emitter /
  tci_args_* decoder (~50+66 sites), tcg_insn_unit, code_gen buffer
  sizing, pool alignment; invalidates the 0005 wasm32 draft's emitter
  assumptions.  Effort ~2–4 h, best done as its own session with the
  histogram + interleaved-bootbench loop from this one.

### Register-file expansion experiment (measured, rejected — 2026-09-08)

Motivated by the op-mix (~31% of TCI ops are register↔stack traffic with
only 14 allocatable registers vs ~20 ARM globals), a full 5-bit register
encoding was implemented and measured: 32 virtual registers (28
allocatable), all decoders/emitters re-laid-out (uniform reg slots at
bits 8/13/18/23), 19-bit labels, 24-bit bare-label/payload forms,
`qemu_ld/st`/`deposit`/5-reg ops taking a trailing word for the fields
that no longer fit, immediate forms narrowed S16→S14 / S12→S10.

Mechanically it worked (built, booted, no crash).  Measured
(interleaved, headless Chromium):

  v=2..7 window   0011: 36.5 s   +28regs: 43.2 / 43.6 s  (~+18% worse)
  @110 s          0011: v=92, 1670M insns   +28regs: v=48, 1616M insns
  @50 s           both nearly identical (127M vs 130M TBs, 502M vs 516M
                  insns, v 4.3 vs 4.4) — no TB-size change, spills were
                  NOT the bottleneck

Conclusions: (a) the env/stack ld/st ops are already single-memory-op
cheap — register pressure is not the limiter on this workload;
(b) the 2-word `qemu_ld/st` encoding cost (~30% of ops) plus
whole-TB-icount timing drift (the v-stall at ~48 suggests a longer
firmware busy phase from shifted MMIO-in-TB positions) makes the
encoding change a net loss as implemented.  A 64-bit single-word
encoding would avoid (b)'s word-count overhead, but given (a) the
expected upside is small.  Patch preserved at
`/tmp/regfile-expansion-attempt.diff` (574 lines) if anyone wants to
re-try with the 64-bit word form.

Tooling note: `capture-patch.sh`'s verify only compares files that
appear in `git status` of build/qemu — a file reverted to pristine HEAD
silently escapes detection (bit us once; always also cmp the
backend/*.h.inc files against the stack when doing surgery there).

## Session log: 2026-09-08 evening (page-side session — delivery path)

Picked remaining-opportunity #4 (V8 tier-up warm-up) and measured it
properly (bootbench grew `JS_FLAGS` for browser flags + `RATES=1` for
per-sample insns/s):

- `--no-wasm-lazy-compilation`: window 33.9 vs 34.2/34.2 baseline.
- `--wasm-tiering-budget=100000` (default 13M): 34.1.
- both: 34.1.  Plumbing verified with `--no-liftoff --no-wasm-dynamic-tiering`
  (finalV 3.1 @45 s — eager TurboFan of the whole module dominates).
- Conclusion: V8 compilation tiers are NOT a factor in the v-window on this
  host (streaming Liftoff of the 45 MB module: 80 ms).  Closed as #4 above.

Pivoted to the page-side delivery path, where real wall-clock sits for the
README's phone/LAN use case.  New tool `tools/loadbench.mjs`: a
time-to-guest-work benchmark (t_module / t_v05 / t_v2 from page load,
resource timing for the wasm, `instantiateStreaming` timing via an
init-script wrapper, `PROFILE=` persistent browser profile for cache
experiments, `NET=`/`LAT_MS=` CDP network emulation).  Primary page metric:
**t_v05** (wall s until guest v crosses 0.5).

Landed (serve.mjs + site/app.js, no qemu changes → no patch in the series):

- **serve.mjs: strong ETag + 304 revalidation, and a lazily (re)generated
  `qemu-system-arm.wasm.gz` sidecar** (44.8 MB → 11.2 MB, ~1.2 s to build,
  `GZIP=0` disables, tmp+rename so a partial sidecar is never served,
  auto-refreshed when the wasm is newer — ninja-fast already `rm -f`s it on
  deploy).  `no-cache` kept: every visit revalidates, so redeploys are
  always picked up, but unchanged files come back from the HTTP cache (and
  stay eligible for Chromium's wasm code cache — which did not measurably
  engage in headless; the measured warm win is HTTP-cache only).
- **site/app.js: slow-link device-inference race fixed.**  `loadBoards()`
  populates the `<select>` asynchronously; a fullflash picked before
  boards.tar arrived silently lost device inference → booted
  generic-pmb8875 → qemu hardware-error abort ("Invalid fullflash
  size").  Found by loadbench under NET=20 emulation (localhost is too
  fast to ever hit it).  Fix: deferred `pendingDevice` applied when the
  options exist + `boot()` awaits `boardsReady` (also removes a latent
  `boardsBuf` null-deref in preRun).

Measured (loadbench, S75, 2 runs each, all within ±0.3 s):

| visit | t_v05 localhost | t_v05 @20 Mbps+30 ms | t_v2 @20 Mbps | wasm transfer |
|---|---|---|---|---|
| before (raw, no validators) | 7.0–7.2 | 26.2 | 35.0 | 44.8 MB |
| after, cold (gz) | 7.0–7.2 | 12.1–12.4 | 21.2 | 11.2 MB |
| after, warm (304) | **6.2** | **6.3** | **15.1–15.3** | **300 B** |

i.e. −54 % time-to-first-guest-work for a cold visit on wifi, −76 % for a
revisit (revisits become link-independent), zero cold-visit regression, and
the v-window is untouched (34.3 vs 34.2).  Boot soak after the app.js fix:
v 1.2→4.7 over 40 s, LCD updates growing, ex=[0,0,0,0], no `>>EXIT<<`.

## Session log: 2026-09-09 (patch 0012 — interpreter memory ops, counters)

Target chosen by the playbook loop (profile → counters → ONE patch).
Findings worth keeping:

- **The page main thread is 98.5 % idle during emulation** (wprof2 now
  profiles it too — page session first in its list).  Client-side
  main-thread work (LCD repaint, serial poll, console) is irrelevant for
  emulation speed on a many-core host; the "client-side" levers all live
  in the wasm the client executes.
- **Symbol-map ghosts re-confirmed**: `tci_qemu_ld` showed 45 % vCPU
  self-time, but counters proved the slow path runs only ~20k calls/s
  (MMIO/unmapped ≈ 2k/s, tlb_fill ≈ 20k/s in-window).  The 45 % was the
  *inlined* fast-path code (tci_ld_fast/tci_st_fast inside the
  interpreter) mislabeled — and it is genuinely the hot path:
  ~5.9M loads + ~2.4M stores per wall second.  Always verify ≥1 % leaf
  self-time with counters (the 0010/0011 sessions' rule holds).
- **tci_qemu_ld/st re-probe was dead code** — the inline fast path probes
  with identical inputs one call earlier; 1.1M+ calls, 0 second-probe
  hits.  Removed in 0012.
- **mop reality on this target**: every plain data access is
  `MO_ALIGN|MO_ATOM_NONE|size|sign` (ARMv5 requires alignment, so
  `memop` never fits the old 16-bit rrm stream word — that is why the
  0011-era `oi & ~0xffff` fallback exists).  This is what makes
  exact-mop specialization (0012) work: the opcode reconstructs the
  whole mop, the stream word only carries mmu_idx.
- **Benchmark discipline**: interleave against a *rebuilt* baseline
  (cp the dist aside, one server per dist — a scoped server per run
  survives the sandbox: see `/tmp/ab-one.sh` pattern in this session's
  shell history).  Baseline windows are bimodal under shared-host load
  (34.4–42.3 s); the candidate stayed 33.6–35.4 s across 6 runs and won
  every pair.  finalV@110s (+18–25 % guest-seconds, all pairs) is the
  most stable cross-check; insns@110s stays ~equal because the window
  metric only covers v=2..7 while the big gains sit in later,
  memory-op-dense phases.
- **capture-patch.sh new-file handling was broken** (its sed mapped a new
  file's `+++` line to `/dev/null`; first exercised by 0012's new header
  file).  Fixed: the new/deleted branches now emit their own `---/+++`
  headers and keep the diff body from the first `@@`.
- **Lesson (cost ~30 min)**: the diagnostics enum and hard-coded indices
  drifted apart twice while iterating — one round of "rejections" was
  actually reading the wrong counter, which briefly pointed at a
  big-endian-guest theory (wrong: the guest is LE; the mops carry
  MO_ALIGN).  When adding counter slots mid-enum, re-check every consumer
  (JS tools included) or use named indices everywhere (0012 ships
  include/qemu/wasm-diag.h with named enum entries for exactly this).

0012 measured headers are in `patches/0012-tci-size-specialized-ldst.patch`;
correctness bar: native suite PASS ×4 (s75/el71/c81/ke800), wasm soak to
v=245 with growing LCD updates, idle-screen screenshot verified (wallpaper,
clock, «Поиск сети»), no `>>EXIT<<` anywhere.

## Session log: 2026-09-09 evening (patches 0013–0015 — killing the longjmp tax)

Followed the loop strictly: baseline → profile → counters → ONE patch →
interleaved A/B → keep/revert → capture with measured header → native
suite + soak.  Two landed, one tiny diagnostics patch, two measured-flat
reverts.  Net: **v-window 34.3–34.6 → 24.5–25.4 s (−26 %), finalV@110 s
97–126 → 164 (+30–77 %), idle screen (v=245) at ~185 s, 2.82G insns
@190 s, no `>>EXIT<<` anywhere, native suite PASS ×4.**

### Landed

- **0013 wasm: SVC inline exception exit** (−26 % window, the big one).
  wprof2 caller stacks showed 79 % of `__emscripten_throw_longjmp` under
  `helper_exception_with_syndrome(_el)` — guest SWIs.  Instead of
  fighting the asyncify/wasm-EH blockage (rejected table), the ARM
  frontend now emits the exception state stores + `exit_tb(0)` for
  translate-time-fully-known exceptions on EL2/EL3-less cores; a new
  early-return in `cpu_handle_interrupt` delivers a pending
  exception_index before running or chaining any other TB.  Key
  equivalence arguments (all verified in code before writing the patch):
  the helper only writes exception_index/syndrome/target_el; the
  longjmp lands in the same `cpu_handle_exception` → `do_interrupt`;
  icount budget for the SVC TB is spent identically (whole-TB at TB
  start, either path); the early-return also *prevents* `tb_add_jump`
  from chaining the SVC TB (the interpreter would otherwise execute the
  post-SVC PC — that check is what makes the whole scheme correct);
  IRQ-vs-exception ordering preserved (exception first, like the
  longjmp); `ss_active` single-step keeps the helper path.
- **0014 wasm: io barriers.**  Counter ioRewind proved the remaining
  longjmps were the recurring ROM-flash io_recompile (1.67k/s): the
  unsplit cached TB re-rewinds every poll iteration.  On rewind we now
  record the faulting insn pc and invalidate the TB; the translator
  gives barrier insns single-insn TBs, where `can_do_io` is true
  throughout → no rewind, identical 1-insn clock precision.  (The direct
  no-unwind conversion of io_recompile itself was REJECTED before
  implementation: cpu_io_recompile runs *before* the access completes, so
  returning normally would double-execute non-idempotent flash program
  commands; the barrier keeps stock semantics for the one recording
  occurrence.)
- **0015 wasm: diagnostics counters** (txnF/tbGen/tbFlush/ioRewind/
  lookupTB) — zero-cost, cold paths only.

### Measured and rejected this session (do not retry blind)

- **MMIO dispatch fast path** (memory.c direct-call for exact-size
  aligned accesses): window consistently 0.1–0.7 s WORSE on a quiet host
  (4/4 pairs); the saved ~3 non-inlined calls ≈ the added condition
  chain at 90k dispatches/s.  Reverted.
- **TLB table-base caching in the TCI interpreter** (table/mask cached
  per mmu_idx, dropped on helper calls + ldst fallbacks): flat on both
  the v=2..7 window (±0.1 s) and a late LO=30 HI=60 window; finalInsns
  won 4/4 (+1…5.7 %) but is inside its run-to-run spread at 200 s
  (finalV varies ±45 v between identical builds).  Reverted.  The
  memory-op fast path is done — only big levers remain.

### wprof2 ghost catalogue (verified by counters, never trust these
frames again without a counter)

- `io_failed ← cpu_io_recompile` stacks: **txnF = 0.00M/60 s** — no
  transaction failures exist; the frames are mislabeled.
- `helper_lookup_tb_ptr` 3 % self-time: **lookupTB = 0 calls** — the
  symbol covers inlined `tb_lookup` in cpu_exec_loop + tb_gen bits.
- `emscripten_fiber_init_from_current_context` on parked workers
  (82–98 %): actually `emscripten_futex_wait`.
- `qemu_mutex_lock_ramlist` self-time: real, but the repeated
  same-symbol caller frames are inflate — the stack shape
  (`flash_io_read → address_space_set_flatview`) is what matters.

### Facts for the next session

- Post-0013/0014 vCPU profile: interpreter ~57 % (tci_qemu_ld/st ghost),
  romd churn ~4–5 % (ramlist + flatview_translate + mtree ghosts),
  tb_gen ~3 % (2k new TBs/s while boot explores code, tbFlush = 0),
  MMIO dispatch ~2–4 %, BQL waits 0.8 %, futex/idle ~8 %.
- MMIO dispatch rate measured 48–66k/s early, ~94k/s (4.3M ioLd + 4.2M
  ioSt per 90 s) in later phases.
- The romd fix sketch (not attempted this session, too big for the
  remaining budget): stash the last ~4 generated FlatViews per root with
  their (non-romd-generation, romd-signature) tags; `generate_memory_topology`
  reuses a stashed view when the tag matches, skipping render + dispatch
  rebuild.  Needs: a global generation counter bumped only by non-romd
  commits (a `romd_only_pending` flag beside `memory_region_update_pending`),
  a romd-MR registry for the signature, and RCU-safe stash eviction
  (~100–150 lines in system/memory.c).
- Tools added: `tools/compare-lcd.mjs` (pixel-diff of the live LCD vs
  `tools/final-lcd.png` with a 16×16 block map; note the live canvas is
  132×176 vs the reference's 133×177 — the comparison now tolerates ±2 px
  and crops to the overlap).  A/B harness pattern: `/tmp/ab-one.sh`
  (scoped server per dist, alternating runs; recreate as needed).
