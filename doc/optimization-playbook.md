# WASM performance optimization playbook

This documents the working method of the optimization sessions since
2026-09-07 so future sessions pick up the same loop: **profile →
hypothesize → small patch → measure → keep or revert → document**.
Read together with [performance-handoff.md](performance-handoff.md)
(current workstream: targets/plan/constraints) and the backend docs
below.  **Never cite the "~1.3–2.3x JIT" numbers in the rejected table
below as the wasm64 backend's** — they belong to the discarded
wasm32/ktock port; the wasm64 backend's numbers live only in its own
docs.

**Workstream history**: TCI patches 0007–0016 (2026-09-07/10, ~4×
guest throughput, idle screen ~500 → ~160 s) → **wasm64 TCG backend**
0017 (2026-09-10/11, [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md)
+ progress doc — performance-complete: boot at TCI parity, compute
7.4× TCI, all gates green) → **current workstream since 2026-09-11:
qemu-core device-path** — the dispatch/timer/main-loop tax that every
backend pays identically (~590 ns per MMIO access on wasm vs 224
native; boot ~55 MIPS vs 562 compute ceiling).  Its targets, plan and
constraints are [performance-handoff.md](performance-handoff.md); its
A/B meter is tcgbench's tax mirrors.

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
   idle screen screenshot, no `>>EXIT<<`).  Backend-only changes
   (`/dist-jit`): op-suite `scripts/run-tcg-isa.sh` + lockstep windows
   `tools/lockstep-wasm.mjs --insns 20e6|250e6|700e6` (full 2.5e9 gate
   at slice close).  **qemu-core changes touch every backend** — op-suite
   must stay byte-identical ×3 AND the native suite green AND lockstep
   windows clean, A/B'd on both dists.
   **Iteration loop (2026-09-11+): `tools/tcgbench.mjs` first** —
   per-phase backend A/B and the device-tax mirrors in ~10–60 s/leg
   (phone boots are final gates only — 80 s+ and device-bound; see
   [tests/tcgbench/README.md](../tests/tcgbench/README.md) for the
   tool ladder).

## The fast feedback loop

```bash
# 0. serve the current dists (keep running)
PORT=8080 HTTPS_PORT=6808 node serve.mjs &

# 1. edit sources in build/qemu (patches 0001..000N already applied there)

# 2. incremental rebuild + atomic deploy (~8 s)
#    qemu-core changes need BOTH dists rebuilt (they shift /dist too):
bash scripts/ninja-fast.sh                    # TCI  -> site/dist
bash scripts/ninja-wasm64.sh qemu-system-arm.js   # wasm64; deploy via
    # scripts/build-qemu-wasm64.sh (atomic tmp+rename — never a plain
    # cp over the live-served wasm, which can serve a torn 45 MB file)

# 3. fast A/B first: tcgbench (per-phase + device-tax mirrors, seconds)
node tools/tcgbench.mjs                     # native-jit + dist-jit
LEGS=dist,dist-jit ICOUNTS=0,1 node tools/tcgbench.mjs

# 4. phone-boot window (110 s; prints one JSON line) — both dists for
#    qemu-core changes:
DIST=dist-jit node tools/bootbench.mjs 110

# 5. profile when looking for the next target (~40 s; PROF_DELAY picks
#    the boot phase)
PORT=8080 node tools/wprof2.mjs 40 "" 100
PROF_FN=phys_page PORT=8080 node tools/wprof2.mjs 30 "" 100   # callers

# 6. capture the surviving change as the next patch (stacks on 0001..N)
bash scripts/capture-patch.sh my-change-name
# then prepend a Subject/description header WITH MEASUREMENTS to the
# generated patches/NNNN-my-change-name.patch (see 0007/0008/0009)

# 7. confirm nothing is left un-captured (must print "nothing to do")
bash scripts/capture-patch.sh verify-tmp
```

Native suite after landing: `node tests/run.mjs --label <patch> --timeout 240`.

### Boot verification (correctness bar)

- `tools/serialwatch.mjs <secs>` — WATCH lines (v/u/serial/insns/ex[]);
  check: no `>>EXIT<<`, v advances, LCD updates (u) grow.
- Long soak to the idle screen: screenshot + eyeball (wallpaper, clock,
  "Поиск сети"): see the `shot`-style script in git history of this doc
  or `tools/smoke.mjs` as a base.  Idle screen wall times by build:
  0007 ≈ 260 s, 0008 ≈ 235 s, 0009 ≈ 195 s, 0016 ≈ 160 s (all on
  `s75_working20060710172101.bin`).  The current end-to-end metric is
  `tools/idlebench.mjs` on S75v40lg1 (deterministic protocol: committed
  idle reference, bottom-139-rows compare, fresh browser per run,
  config + artifact hashes pinned to `tests/results/idlebench-latest.json`)
  — **current: /dist and /dist-jit at parity, median 76.4 s both**
  (9+9 interleaved runs; was +8–10 % before account-inline).
  **Different flash + protocol: idlebench seconds are NOT comparable to
  the soak times above.**

## Measurement methodology (and its traps)

- **Primary metrics by question** (2026-09-11+): *device-path work →
  the tcgbench mirrors* (`mmiopoll`/`rampoll`/`mmiow` ns/access — the
  dispatch tax directly, seconds per A/B, checksum cross-checked
  across every leg); *end-to-end phone work → the v-window below +
  `tools/idlebench.mjs`* (the human metric, deterministic protocol);
  *attribution → wprof2*.  Compute-phase speedups show on tcgbench
  phases first and may never show on the phone (device-bound) — that
  is not a failed patch, it is the boot's shape; the mirrors decide.
- **The v-window**: wall seconds between virtual time
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

- Worker #0 is the vCPU (TCI interpreter on `/dist`, the wasm64
  dispatcher on `/dist-jit`).  Workers #1–#4: pool,
  io_dump/RCU, **main loop** (worker #2), DSP.  `PROF_DELAY=<s>` waits
  before `Profiler.start` — boot-phase selection (early vs the
  poll-heavy late window, the two behave differently).
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
| 0016 memory: romd FlatView variants + range-scoped tlb flush | romd toggle per flash command = full FlatView re-render of every root (~200 µs, 16k radix page inserts over the flash) + full tlb_flush + ~33-entry refill storm, ~18k flips per boot — (a) FlatViews tagged (topo_gen, romd_sig), romd-only commits adopt the recycled variant from a 16-slot stash (roots whose tag already matches are skipped); (b) tcg listener records region_add/del phys ranges, flush drops only entries translating into them (evicted-variant latch falls back to full flush; entries never dereference a dead view) | topo-commit time 3857→421 ms (−89 %), 30894 variant reuses; v-window 25.1–28.3 → 22.5–25.1 s (8/8 interleaved pairs, every candidate run beats every baseline); insns@110 s +4–9 %; idle screen ~160 s; run-to-run variance collapsed; native suite PASS ×4 (see § Session log: 2026-09-10 for the measurement traps this one surfaced) |
| 0015 wasm: diagnostics counters | txnF/tbGen/tbFlush/ioRewind/lookupTB cold-path counters (killed two wprof2 ghost theories — see session log) | zero hot-path cost; measurement infra — **dropped 2026-09-09**: isolation testing measured it neutral, no tool consumed its counters (see attic/README.md and § Patch-isolation testing) |
| 0017 wasm64 TCG backend | full backend: per-TB wasm modules → chaining → batching (128/B module) → inline TLB probe → inline TB accounting; `tcg/wasm64/` + small hooks | boot-to-idle at TCI parity (idlebench median 76.4 s both dists; was +8–10 %); compute 7.4× TCI on tcgbench (562 vs 53 MIPS; per-phase 7–18×); all gates green incl. full 2.5e9 lockstep — numbers and history in [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md) |
| 0018 cputlb: fill-time MMIO dispatch + victim-TLB masked compare | (a) `tlb_set_page_full` resolves `(callback, opaque, size-mask, swap, align, re-entrancy guard)` per iotlb entry — the MMIO access path becomes one mask test + indirect call instead of dispatch_read→access_valid→adjusted_size→accessor; (b) `victim_tlb_hit` compared `cmp == page` unmasked, but every MMIO entry carries TLB_FORCE_SLOW in addr_idx → the victim TLB *never hit for MMIO*, so two MMIO pages aliasing on one TLB index (sysctl 0x10000000 + VIC 0x10140000, both index 0 under ARMv5 1K target pages) re-walked the guest page tables on **every access** | tcgbench mirrors: mmiopoll **534→202 ns** (dist-jit), 606→252 (dist), mmiow 305→227; native parity (223).  bootbench finalV/insns@110 s up on every pair (windows noisy under host load); op-suite 1156/1156 byte-identical ×3, native suite 4/4 on the branch binary, lockstep 20e6+250e6 clean (see session log 2026-09-11 device-path) |

(The 0017 row is a pointer, not a summary — that patch's own docs are
authoritative for its numbers.)

## Patch-isolation testing (2026-09-09 session — is every patch required?)

Question: with the series at 0001–0015, is each patch actually load-bearing,
or is some of it dead weight?  Harness: `scripts/switch-test.sh` — resets
build/qemu to the pinned rev, applies `patches/*.patch` minus the target
(`MINUS:NNNN`), or applies all and reverse-applies the target plus its
dependents (`REVERT:N1,N2,...` — needed when later patches touch the same
hunks), then incremental rebuild + deploy, then `tools/bootbench.mjs 110`
×2 (vs ≥2 same-day baseline runs; both removal runs must be worse than
all baselines to prove a patch matters, and vice versa).

Dependency structure found (why some patches can only be group-tested):
0004/0007 build on 0002's icount2 accounting; 0008/0012/0014/0015 all
modify regions first touched by 0003/0007/0011 — a stack without them
cannot be expressed without rewriting later patches.

| Removed | Method | window (v=2→7 s) vs baseline 25.1–28.5 | Verdict |
|---|---|---|---|
| 0002 (condvar/futex half only — files surgically reverted to pristine, rest of stack intact) | surgical | 25.1–25.8 + serialwatch soak to v=166 with LCD updates growing, no EXIT | **redundant now** — 0009's futex wake path removed the livelock precondition (doc/livelock-postmortem.md no longer applies as written); the icount2 half of 0002 stays (0004/0007 require it), so the patch stays | 
| 0003 (+ its dependents 0008/0011/0012/0014/0015) | REVERT group | boot collapses ~25× (finalV 4.7/6.4 after 110 s) | required |
| 0007 (+ dependents 0008/0011/0012/0014/0015) | REVERT group | 33.3–33.6, finalV 78–118 | required |
| 0008 | MINUS | 29.9–32.3 (worse than every baseline run), finalV down | required | 
| 0009 | MINUS | 29.3–31.7, finalV halved (busy-spinning main loop starves the vCPU worker) | required |
| 0011 (+ dependents 0012/0014/0015) | REVERT group | 32.5–34.8, finalV 84–100 | required (also structurally: 0012 can't exist without it) |
| 0013 | MINUS | 34.6–41.2 — largest single regression | required |
| 0015 | MINUS | 25.8/25.9/25.8 (one 31.8 outlier under host load); no tool consumes its counters; junk whitespace hunk | **dropped** (see attic/README.md) |

Bottom line: the perf series is tight — every TCI/longjmp patch is
empirically required; the only removable surface was 0015.  0002's
threading half is a documented-redundant insurance policy (kept only
because the patch cannot be split without rebasing 0004/0007/0009).

Follow-up (2026-09-09, upstream-branch prep): building the series
natively surfaced a latent link error the wasm build can't see —
`wasm_diag_stat` was defined in `tcg/tci.c` (only compiled under
`--enable-tcg-interpreter`) but referenced from always-compiled
`cputlb.c`/`tlb_helper.c`, so every native build of the series since
0012 failed to link.  Fixed by moving the definition to `cputlb.c`
(see [upstream-branch.md](upstream-branch.md)); native suite now
passes 4/4 on the branch binary.

Follow-up (2026-09-09, slow-host re-verification): 0002's icount2
`MIN_FREQUENCY 1000` floor was retested (fast hosts: controller
converges 3–17 MHz, floor never binds, A/B identical).  Under 16x
CPU starvation (~2.5 kHz sustained — a phone, amplified) the floor is
decisive: 1 kHz → v=377 @420 s, slow-motion boot, no crash; stock
1 MHz → frequency pinned at 1.000 MHz, virtual clock frozen at
v=0.88 @420 s, boot dead.  Kept for slow devices; only the opt-in
precise-clocks mode is affected (the default stock-icount model has
no controller).  Numbers in [upstream-branch.md](upstream-branch.md).

## What was tried and REJECTED (do not retry without new ideas)

| Experiment | Result | Why |
|---|---|---|
| **wasm32 runtime-JIT TCG backend (0005, ktock port fully rebased)** (2026-09-09 session; see [wasm32-port-status.md](wasm32-port-status.md) + `patches/attic/wasm32-rebase/`) | v-window 2→7: JIT 18.7–20.1 s vs TCI 24.8–28.3 quiet / 45–46 loaded — **~1.3–2.3x ceiling**, and the boot deterministically hangs at v≈6 (BROM USART-RIS poll data divergence → watchdog reset → recovery loop forever; LG/no-icount boot fully dead) | per-TB dispatch protocol (instance return → C dispatcher → indirect instance call per chained TB) + per-new-TB JS `WebAssembly.Module` compile eat the codegen gains on this 3–4 insn/TB branchy firmware; ~4200-line surface; discarded — the draft and the full rebase live in `patches/attic/` |
| **tci.c interpreter stack as a parameter** (during the 0005 rebase: split `tcg_qemu_tb_exec` into a core + wrapper taking `uint64_t *call_stack`) | TCI v-window 25→45 s (**−60%**, 4/4 interleaved runs) | the pointer-select makes the interpreter stack alias every local array in LLVM's analysis; the TCI stack is per-TB scratch anyway — keep a single function with a local array |
|---|---|---|
| **MMIO dispatch fast path** (memory.c: direct `ops->read/write` call for exact-size aligned accesses, skipping valid-check + access_with_adjusted_size + accessor layers; reentrancy guard replicated; `__EMSCRIPTEN__`-gated) | window 24.9–25.2 → 25.1–25.3 s (**consistently 0.1–0.7 s WORSE on a quiet host**, 4/4 pairs); finalV ±noise; insns@110 s +0.1–5.8 % inconsistent; a late-window A/B (LO=30 HI=60) was flat too | the pre-dispatch condition chain (accepts/align/size/trace/ioeventfd checks) costs as much as the ~3 non-inlined calls it saves at ~90k dispatches/s; V8 already keeps the dispatch path hot. Reverted; don't retry a *runtime* cache without cross-TU inlining (LTO). **NOT the same as the current workstream's fill-time precompute** (store `(fn, opaque, attrs)` in the iotlb entry when it is filled — zero added per-access checks): that one is the plan in [performance-handoff.md](performance-handoff.md) slice 1 |
| **TLB table-base caching in the TCI interpreter** (cache `(fast->table, fast->mask)` per mmu_idx across ops, dropped after helper calls and ldst fallbacks — the only paths that can resize/flush the tlb on this single-cpu machine) | window 25.9/25.2/25.2/25.2 → 24.5/25.3/25.1/25.1 (flat, ±0.1); late-window LO=30 HI=60: 19.7/20.3 → 19.6/20.0 (flat); finalInsns won 4/4 (+1…5.7 %) but finalV-at-200 s varies ±45 v run-to-run — no reproducible win | the two saved loads are L1-hot; the memory-op path is at its practical floor for micro-tweaks (0011+0012 already removed the real work). Reverted; only a big lever (64-bit TCI encoding, wasm32 JIT) can move the interpreter now |
| Lazy flash romd restore (flip back to array mode on first array read, not eagerly on every `0xFF`) | 7.4× fewer topology flips but **32 % slower** in the flash-heavy window | keeping romd off during bursts turns array reads (incl. fetches) into MMIO dispatches, which costs more than the flips save |
| icount2_advance thread-local batching (single-writer mirror, publish every 256 calls) | no measurable change (±noise) | the per-TB atomics are cheap on wasm; reverted |
| TCI store-immediate ops (`tci_st32_ri`/`st8_ri`, incl. the `tcg_out_sti` constant-spill hook) | window 42.9→50.6–50.7 s, final insns −20 % — consistent regression across runs | not root-caused; suspected interaction with allocator behavior/stream size; documented in 0008's header |
| QemuCond-based main-loop wait (instead of the raw futex) | same early-window numbers but only ~half the end-to-end gain | qemu condvar waits truncate to whole milliseconds on wasm; the firmware's ~100 µs WFI windows each pay +1 ms |
| `-sSUPPORT_LONGJMP=wasm` (native unwinding for the SVC-exception longjmps) | binaryen's Asyncify pass crashes on it (verified with a standalone emcc test) | wasm-EH longjmp and `-sASYNCIFY` are incompatible in emsdk 4.0.10; ASYNCIFY is required (coroutine backend/condvar sleeps) |

## Remaining opportunities (ranked, 2026-09-11 rewrite — the plan lives in performance-handoff.md)

1. **MMIO dispatch path — LARGELY LANDED (0018, 2026-09-11).**  The
   590 ns/access was actually two stacked qemu-core costs: (a) the
   generic dispatch resolution chain per access, and (b) a victim-TLB
   miss bug — `victim_tlb_hit`'s unmasked compare never matched MMIO
   entries (TLB_FORCE_SLOW in addr_idx), so index-aliased MMIO pages
   (ARMv5 1K target pages alias easily) re-walked the page tables on
   every access.  0018 fixes both: mmiopoll 534→202 ns on `/dist-jit`
   (606→252 on `/dist`), mmiow −25 %, at native parity (223).  Remaining
   headroom in this path is small; re-measure before opening anything.
2. **Timer storms / main-loop wakeups — OPEN.**  ~8 % of the late
   window in mailbox/futex-wake/`_emscripten_get_now` + device timer
   callbacks nobody observes.  Coalesce icount deadlines, skip
   unchanged LCD composites, batch main-thread wakeups.  Meter: wprof
   main-thread self-time + idlebench.
3. **Backend tail — OPEN, small, `/dist-jit` only** (backend plan
   phase-3 leftovers): `lookup_tb_ref` direct import (~4 % of vCPU),
   dispatch-loop work (~9 % with `cpu_exec_loop`); tcgbench `branch`
   (4.55 s, weakest vs native) says chaining still has headroom.
   Few % end-to-end each — behind the qemu-core slices by an order of
   magnitude.
4. **AOT cache — OPEN, orthogonal** (backend plan phase 5): persist
   translated batches (Cache API/IndexedDB, keyed by flash hash) —
   zero-translation second boots, `/dist-jit` only.

Closed (do not reopen without new ideas): exception longjmps (0013/0014
— SVC inline exit + io barriers; the generic wasm-EH longjmp stays
blocked by asyncify); TCI interpreter dispatch (0007–0016 took it to its
micro-optimization floor; the wasm64 backend supersedes it, TCI remains
the reference/fallback tier); flash romd topology churn (0016); V8
warm-up (no in-window effect on this host); main-loop busy-wait (0009);
register-file expansion (measured worse); icount2 thread-local batching
(flat — the per-TB atomics are cheap on wasm; and the account is now
inline on wasm64 anyway).

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

1. `git log` / `ls patches/` — see where the series stands; read
   [performance-handoff.md](performance-handoff.md) for the current
   workstream's plan and where it left off.
2. Establish today's baseline: `node tools/tcgbench.mjs` (seconds;
   mirrors + phases) and `bootbench` ×2 (window; both dists for
   qemu-core work).
3. Profile, pick ONE target, check the rejected list first (note the
   MMIO nuance: the *runtime* cache is rejected, the *fill-time*
   precompute is the plan).
4. Patch → build (both dists if qemu-core) → A/B twice, pairwise →
   keep/revert → capture with a measured header.
5. Correctness bar for the change class: native suite always; op-suite
   ×3 + lockstep windows for anything touching TCG/memory/exec paths;
   full 2.5e9 gate at workstream close.
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
  lookupTB) — zero-cost, cold paths only.  (Dropped again on 2026-09-09:
  isolation testing showed no consumer and no measurable effect — see
  § Patch-isolation testing; the counter *infrastructure* from 0012/0014
  stays.)

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

## Session log: 2026-09-10 (patch 0016 — romd FlatView variants, range-scoped TLB flush)

Target chosen by the loop (profile → counters → patch → interleave), but
this session's main lessons are about **measurement traps** — the patch
measured "flat" twice before a methodology bug was found and it won 8/8.

### What was measured first (counters, not profile shares)

- wprof2 (45 s) showed ~4.5 % of vCPU in generate_memory_topology stacks
  under flash command writes (`flash_lock_command` is an adjacent-symbol
  ghost for `flash_io_write`).
- New cold counters (wasm-diag.h): **romdFlip = 18–20k flips per boot**,
  all inside v≈2.5–4.4 (the v-window's burst phase); topoCommit ≈ flip.
- Temporary ns-accumulator (since removed — it cost ~10 µs × 2 clock
  reads per commit ≈ 0.36 s per boot!): **3857 ms of wall time inside
  topology commits** for the baseline vs **421 ms** with the variant
  stash.
- TLB fills: 1.48M→2.14M across the burst (**~33 fills per flip**) —
  each flip's full tlb_flush() nuked the running code's translations
  (S75 = 8×8 MB flash parts; the polled part's own page churn is
  semantically required, the *code-page* churn was not).

### The three-way interaction (why the patch has two mechanisms)

1. Stash alone (views recycled): commit time −89 %, but the v-window
   measured FLAT — the refill storm remained (stock full flush per
   commit).
2. Selective flush by FlatView identity: wrong tool — entries installed
   against the *other* variant are still dropped every flip (the code
   pages refill regardless), and identity alone cannot drop a stale
   mapping of a protected view.
3. The correct rule is **physical-range based**: the tcg listener's
   region_add/region_del callbacks give the exact changed sections, the
   flush drops only entries translating into them.  Entries outside the
   changed ranges translate to identical section content — including
   entries against a recycled variant — so they survive the toggle.
   Lifetime safety: every view reachable from TLB entries is current or
   stash-resident; eviction happens only inside a commit whose listener
   phase latches "variant evicted" and falls back to the full flush;
   the flush memsets entries and never dereferences their sections.

### Measurement traps that cost this session real time

- **Stale A/B baseline dists**: an early "baseline" site copy actually
  contained an intermediate build (verified via the topoReuse counter
  signature: a true baseline shows reuse=0, a stash build shows
  reuse>0 — always signature-check both ends before believing a flat
  result).  Two full A/B rounds were wasted on it.
- **Missing index.html in the site copy**: a copied site root without
  the page files still boots nothing but can produce plausible-looking
  console output from a previously-open page; curl the root and check
  #fullflash resolves before running benchmarks against a copied dist.
- **Host-load bimodality hides real wins**: the baseline's re-render
  bursts (0.2 ms × 180/s) are exactly the work that collapses under
  host contention — baseline windows spread 25.1–28.3 s while the
  candidate held 22.5–25.1 s.  A "flat" result on a noisy host can
  mean "the candidate removed the work that was making the baseline
  *unstable*", not "no improvement" — look at variance too.
- **Diag-counter overhead is not free at commit rates**: the temporary
  per-commit wall-clock accumulation (2 × g_get_monotonic_time, a JS
  roundtrip on wasm) cost ~0.4 s per boot and initially masked part of
  the win (24.8–25.1 → 22.5–23.2 after removing it).  Measurement
  scaffolding must be removed before the final A/B.

### Landed

- **0016 memory: romd FlatView variants + range-scoped tlb flush**
  (system/memory.c, system/physmem.c, accel/tcg/cputlb.c +
  headers): v-window 25.1–28.3 → 22.5–25.1 s (8/8 pairs; strict
  criterion "every candidate beats every baseline" holds), insns@110 s
  +4–9 %, idle screen (v=245) at ~160 s (was ~185 s), topo-commit
  time −89 %, native suite 4/4, wasm soak to v=827 no EXIT, LCD
  pixel-diff vs reference equal to the previous build (clock + auto
  keyboard-lock drift only).

### Rejected along the way (do not retry blind)

- **FlatView-identity TLB flush** (`full->section->fv != current`):
  implemented, then discarded on the whiteboard — keeps dropping the
  other variant's entries every flip (no refill win) and cannot
  invalidate a stale-but-protected mapping.  Range-based is the only
  correct granularity.
- **fv pointer cached in CPUTLBEntryFull for a deref-free identity
  flush**: also discarded with the above (kept entries would need the
  protected-set argument; ranges subsume it).

## Session log: 2026-09-11 device-path (patch 0018 — MMIO dispatch + victim TLB)

Slice 0 (attribute the ~590 ns) done first, and it rewrote the plan's
assumptions — two findings the profile+counters loop took to find:

- **wprof2 needed a suite-mode guard** (`query` containing `suite=`
  must skip the fullflash upload + `#btn-start` click — the suite
  auto-boots) and a one-purpose MMIO-only bench image
  (`/tmp`-built `mmiobench.bin` from the tcgbench sources: only the
  mmiopoll loop ×8) so a whole-run profile is pure dispatch path.
- **The vCPU is not always worker #0** — its index moves between runs;
  find it by its self-time shape (mttcg_cpu_thread_fn/interpreter
  frames), not by number.
- **Stale `.symbols` sidecars poison whole profiles**: wprof2 prefers
  `site/<dist>/qemu-system-arm.js.symbols` over the build dir's, and
  `build-qemu-wasm64.sh` deploys the wasm without refreshing the
  sidecar — one whole profile round was garbage (io_failed ghost at
  6.9 %).  Always `cp build/qemu-wasm64/qemu-system-arm.js.symbols
  site/dist-jit/` after a deploy.  (Fixed the deploy script.)

Slice-0 attribution (mmiobench, dist-jit): TLB-fill path (mmu_lookup →
arm_cpu_tlb_fill_align → get_phys_addr* → tlb_set_page_full) ≈ 40 % of
vCPU; generic dispatch chain (do_ld_mmio_beN → access_valid →
adjusted_size → accessor) ≈ 25 %.  Cold counters (per-page fill
counts, temporarily in `wasm_diag_pages`) then showed **2 of the 4
mirror pages refill on every single access** — the walk was not
incidental.

Root cause chain (three wrong theories died on the way):
1. "tiny-page TLB_INVALID refills" — wrong: ARMv5 has
   `TARGET_PAGE_BITS 10` (page-vary), so the 1K pages are *normal*
   TLB pages.  (A sub-page fill cache built on the lg<12 theory
   measured flat/none — removed.)
2. The real mechanism: sysctl 0x10000000 and VIC 0x10140000 **hash to
   the same TLB index** under 1K pages (both index 0) and evict each
   other every loop iteration; the victim TLB should absorb that, but
3. `victim_tlb_hit` compares `cmp == page` **unmasked** — every MMIO
   entry's addr_idx carries TLB_FORCE_SLOW above the page bits, so the
   victim TLB can *never* hit an MMIO entry → full page-table walk +
   tlb_set_page_full per access, on every backend, forever.  One-line
   fix: compare with `tlb_hit_page()` masking like the main probe.
   (Phone boot relevance: confirmed fills ≈ 50 % of ioLd on the
   versatilepb mirror; on the phone the same mechanism bites wherever
   firmware MMIO pages alias — finalV/insns improved on every pair.)

Landed as **0018** together with the plan's slice-1 headline (fill-time
`(callback, opaque, mask, swap, align, guard)` resolution in
`CPUTLBEntryFull`; zero per-access added checks — the mask bit is the
fast/slow discriminator; re-entrancy guard + endianness + accepts/
ioeventfd/with-attrs/impl-range cases all fall back to the stock path).
NOT the rejected memory.c runtime cache.

Measured (interleaved legs, RUNS=2-3, checksums identical everywhere):

  mmiopoll ns/access: dist 606→252, dist-jit 534→202 (native 223; the
                      ≤300 intermediate gate is passed at ~parity)
  mmiow ns/access:    dist 454→378, dist-jit 305→227
  bootbench:          finalV/insns@110 s up on every pair both dists
                      (v-window pairs 32.2→28.9 / flat-flat under host
                      load — windows too noisy on this shared host to
                      satisfy the strict pairwise rule, mirrors decide)
  gates: op-suite 1156/1156 byte-identical ×3; native suite 4/4 on the
         branch binary (qemu-upstream + 0018); lockstep 20e6 + 250e6 +
         the FULL 2.5e9 gate clean; idlebench medians (n=3, both dists
         improved): dist 76.5→74.4 s, dist-jit 72.4→70.4 s — the
         remaining gap to the ≤55–60 s goal is slice 3 (timer storms /
         main-loop wakeups), not the dispatch path.

Measurement notes: keep A/B legs to `dist,dist-jit` pairs when the host
is loaded (the 4-leg RUNS=2 sweep took 15 min and was bimodal); save
baseline dists as `site/dist-base`/`site/dist-jit-base` legs before the
first candidate deploy — reconstructing a baseline later costs two
rebuilds.
