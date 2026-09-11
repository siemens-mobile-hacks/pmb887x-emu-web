# WASM performance optimization playbook

The working method of the optimization sessions since 2026-09-07:
**profile → hypothesize → small patch → measure → keep or revert →
document**, tuned for the shortest loop that can still reject a bad
change.  Read with [performance-handoff.md](performance-handoff.md)
(current targets/plan) and [tests/tcgbench/README.md](../tests/tcgbench/README.md)
(tool ladder).  Per-session narratives, measurement forensics and the
patch-isolation study live in [optimization-sessions.md](optimization-sessions.md)
— consult them when a table row here says "see sessions".

**Workstream history**: TCI patches 0007–0016 (~4× guest throughput) →
wasm64 TCG backend 0017 (compute 7.4× TCI; boot early phase still ~27 %
behind TCI, see § Remaining) → qemu-core device path (0018: MMIO
dispatch at native parity) → wasm64 module economy 0019 (compile-once
batching + compaction: tIdle −15 %, Firefox OOM fixed) → **open now**:
the real-time-paced device stretch and the remaining translation cost
(§ Remaining).

## The iteration ladder (cheapest reject first)

Every candidate climbs this ladder and stops at the first rung that
rejects it.  Costs are wall-clock on this host (32 cores, quiet).

| rung | command | cost | detects | cannot see |
|---|---|---|---|---|
| 0 build | `scripts/ninja-fast.sh` (TCI) / `scripts/ninja-wasm64.sh qemu-system-arm.js` + deploy via `scripts/build-qemu-wasm64.sh` | ~8 s each | compile errors | — |
| 1 tcgbench | `node tools/tcgbench.mjs` (native-jit + dist-jit); `LEGS=dist,dist-jit` for qemu-core; `ICOUNTS=0,1` for icount; `SUITE=quick` = ÷4 iterations smoke image | ~15 s per wasm64 leg, TCI leg 100 s (`SUITE=quick`: ~3 s / ~25 s) | per-op-class compute + MMIO/RAM dispatch tax (ns/access), value bugs (checksum) | **boot regressions** — hot loops amortize translation |
| 2 quick boot | `node tools/idlebench.mjs <base>,<cand> --quick` | ~1 min per dist | window v=2..7, t0.1G/t0.25G/t0.5G, A/B ratios, REGRESSION verdict vs previous run | late-phase and idle (cap 60 s) |
| 3 op-suite | `scripts/run-tcg-isa.sh` | ~30 s | any TCG/memory/exec value divergence, 3 backends byte-identical | perf |
| 4 full boot | `node tools/idlebench.mjs --runs 2` | ~2.5 min per dist | tIdle, t1.3G, LCD idle screen, crash/stall classes | — |
| 5 native suite | `node tests/run.mjs --label <patch> --timeout 240` | ~65 s | native boots of 4 phones | wasm-only paths |
| 6 lockstep | `tools/lockstep-wasm.mjs --insns 20e6\|250e6\|700e6`; full `2.5e9` at slice close | 1–15 min | cross-backend state equality over a boot | — |

Rules that keep the ladder honest:

1. **No change lands without a measurement**; a rejected change gets
   a row in § REJECTED with its numbers so it is not retried blind.
2. **One mechanism per patch**, stacked as `patches/NNNN-*.patch` via
   `scripts/capture-patch.sh`, header WITH the measured numbers.
3. **A/B against a saved dist in one invocation.**  Before the first
   candidate deploy: `cp -a site/dist-jit site/dist-jit-base` (and
   `dist`→`dist-base` for qemu-core work).  Then
   `idlebench dist-jit-base,dist-jit --quick` — same invocation, same
   host state, ratios printed.  Never compare against yesterday's
   absolute numbers on this shared host.
4. **Read the milestones, not tIdle.**  tIdle sums phases with
   opposite signs (the JIT loses ~9 s early, wins ~11 s late — equal
   tIdle, 27 % early-phase regression).  Keep/revert is decided on
   t0.5G + window (rung 2) for boot work, on the ns/access mirrors
   (rung 1) for device-path work, on t1.3G/tIdle (rung 4) as the
   human cross-check.  Both dists for qemu-core changes.
5. **Repeat only what is close.**  Ratios beyond ±10 % on a quiet host
   (loadavg < 4) are decided by one pair; inside ±10 % run the pair
   again with the order swapped and require both pairs to agree.
   Run-to-run spread is ±3–5 % on t0.5G, ±5–8 % on the window.
6. **Gate by change class** — rung 3 for anything touching
   TCG/memory/exec; rungs 4–6 at slice close only; rung 5 always
   before capture.  Backend-only (`/dist-jit`) changes skip the `dist`
   legs.

## The loop, as commands

```bash
# 0. serve the dists (keep running)
PORT=8080 HTTPS_PORT=6808 node serve.mjs &

# baseline once per session: save the dists, get today's numbers
cp -a site/dist-jit site/dist-jit-base            # + dist -> dist-base for qemu-core
node tools/tcgbench.mjs
PORT=8080 node tools/idlebench.mjs dist,dist-jit --quick

# 1. edit build/qemu (patches 0001..N applied) → 2. rebuild + deploy (~8 s)
bash scripts/ninja-wasm64.sh qemu-system-arm.js && bash scripts/build-qemu-wasm64.sh
bash scripts/ninja-fast.sh                        # TCI, qemu-core changes only

# 3. rung 1–2: ~1.5 min total
node tools/tcgbench.mjs
PORT=8080 node tools/idlebench.mjs dist-jit-base,dist-jit --quick

# 4. profile only when choosing the next target (~40 s)
PORT=8080 node tools/wprof2.mjs 40 "" 100                 # PROF_DELAY=<s> picks the phase
PROF_FN=<symbol> PORT=8080 node tools/wprof2.mjs 30 "" 100  # caller stacks

# 5. gates for a keeper, then capture
scripts/run-tcg-isa.sh
PORT=8080 node tools/idlebench.mjs dist-jit-base,dist-jit --runs 2
node tests/run.mjs --label <name> --timeout 240
bash scripts/capture-patch.sh <name>              # then add the measured header
bash scripts/capture-patch.sh verify-tmp          # must print "nothing to do"
```

Deploy hygiene: never plain-`cp` over a live-served wasm (a torn 45 MB
file gets served) — the deploy scripts do tmp+rename; and refresh the
`.symbols` sidecar in `site/<dist>/` after a deploy or wprof2 profiles
garbage.

## Measurement methodology (and its traps)

- **Metric by question.**  Device-path work → tcgbench mirrors
  (`mmiopoll`/`rampoll`/`mmiow` ns/access; checksum cross-checked).
  Boot speed → idlebench guest-work milestones: the S75v40lg1 boot
  executes a fixed ~1.345e9 guest insns to the idle screen (±0.3 %
  across builds/hosts/load), so `tNG` = wall s until N insns is a
  deterministic per-phase speed number with no LCD, no grid and no
  real-time gating; `window` = wall s between v=2 and v=7
  (interpolated).  Attribution → wprof2.
- **The boot has three phases** (per-second MIPS in the idlebench
  JSON `samples`): translation/flash-command heavy to ~0.75 G insns
  (JIT 3–10 MIPS vs TCI 11–20 at v 2→3.5), a ~9 s real-time-paced
  stretch (v 4.7→23.5, ~3 MIPS both — device timers on
  `QEMU_CLOCK_REALTIME`/`HOST`), then compute (TCI 45 MIPS, JIT
  120).  A change can move one phase and leave tIdle flat.
- **tcgbench and idlebench are complementary, not substitutes**:
  tcgbench cannot see translation cost (hot loops), idlebench `--quick`
  cannot attribute to an op class.  A compute win on tcgbench that does
  not move t0.5G is not a boot win; a boot regression that tcgbench
  calls flat is still a regression.
- **Verdict lines.**  idlebench prints `A/B <cand> vs <base>` ratios
  per metric and diffs against the previous run (`idlebench-latest.json`
  / `idlebench-quick-latest.json`, or `--baseline`), tagging ±5 %
  (`--regress`) REGRESSION / IMPROVEMENT with the wasm hashes.  A dist
  whose hash changed with no runs since is unmeasured — measure before
  quoting a number for it.  Knob runs (`JS_FLAGS`/`EXTRA_Q`) never
  become a baseline.
- **Host load**: loadavg is not namespaced — interleave, never trust
  absolutes across time; a "flat" result on a noisy host can mean the
  candidate removed the work that made the baseline *unstable* (look
  at spread, not just medians).  Parallel dists (`--parallel`) pace
  each other — smoke only.
- **Cross-checks** for any claimed win: insns@end (must stay ~1.34 G on
  a full run), the per-phase MIPS curve, and a wprof2 self-time shift
  in the optimized function.  Counters beat profiles: ≥1 % leaf
  self-time with implausible callers is symbol-map garbage until a cold
  counter confirms it (`include/qemu/wasm-diag.h`; the ghost catalogue
  is in the sessions doc).  Remove measurement scaffolding before the
  final A/B (a per-commit clock read once cost 0.4 s per boot).
- **Signature-check both ends of an A/B** (hash lines in the summary;
  a counter such as topoReuse for behavioral patches) — two full
  rounds were once wasted on a stale "baseline" dist.

## Profiling recipe

`tools/wprof2.mjs` attaches the CDP Profiler to the emscripten pthread
workers.  The vCPU worker's index moves between runs — identify it by
its self-time shape (`mttcg_cpu_thread_fn`/interpreter/dispatcher
frames), not by number; the main loop is the mailbox/futex worker.
`PROF_DELAY=<s>` picks the boot phase (10–40 s = the translation-heavy
early phase, 50+ = compute).  wasm functions resolve via the
`qemu-system-arm.js.symbols` sidecar (`--emit-symbol-map` is hacked into
`build/qemu-wasm*/build.ninja` LINK_ARGS; a fresh reconfigure drops it).
`PROF_FN=<substr>` prints caller stacks.  Suite mode (`?suite=`) skips
the fullflash upload automatically.  A one-purpose bench image (e.g.
mmiopoll only) makes a whole-run profile pure — see the sessions doc,
2026-09-11 device-path.

## What landed (with numbers)

| Patch | Mechanism | Measured effect |
|---|---|---|
| 0007 TCI TB chaining | restore `goto_tb` chaining; per-TB icount2 accounting moved into the interpreter via a `tci_tbhdr` header op executed at every TB entry; the old 0004-era session io accounting collapses to a deadline-sync | +84–113 % insns at fixed wall time; `cpu_exec_loop` 9.3 %→0.8 % of vCPU; boot to idle ~260 s |
| 0008 TCI immediate forms | `tci_add/and/or/xor/andc_ri`, `tci_setcond32_ri` + constraint letters + `tcg_target_const_match` + outop `out_rri`/`out_ri` wiring — constants stop materializing through `tci_movi` (18.9 %→12.8 % of ops; `add` 7.4 %→1.0 %) | window 46.7→42.9–43.7 s (+8 %); idle screen ~235 s |
| 0009 futex main-loop wait | emscripten `poll()` cannot sleep (it ignores the timeout — the browser main thread must not block), so the main loop busy-spun ~23k iterations/s through a proxied syscall, 2 BQL handoffs each, and the aio eventfd wake never worked at all.  Replaced with a worker-local ns-precision futex wait woken by `qemu_notify_event`/`aio_notify`; main-loop wait no longer times out on virtual deadlines (the vCPU runs those) | window 43.7→40.1–40.4 s (+8 %); +22 % boot progress @110 s; idle screen ~195 s |
| 0012 tci size-specialized ldst | eight appended opcodes (tci_qemu_ld8..st32) for the exact mop family MO_ALIGN\|MO_ATOM_NONE\|size\|sign — every plain pmb887x data access: the generic probe reduces to `(addr & (page_mask\|size-1)) == tlb_addr`, baked in as constants, no mask math/atom branch/size switch, mmu_idx-only stream word; tci_qemu_ld/st dead re-probe removed (0 hits in >1M calls); cold-path diag counters (wasm-diag.h + tools/memstat.mjs) | window wins all 4 interleaved pairs (34.1/33.9/34.0/34.0 vs 40.6/34.4/34.9/34.5; −1.4…−16 %, bigger under host load); boot progress @110 s v 91–102 → 114–121 (+18–25 %); native suite PASS ×4 |
| 0013 wasm: SVC inline exception exit | ARM frontend stores exception_index/syndrome/target_el + `exit_tb(0)` instead of the `helper_exception_with_syndrome` call (its `cpu_loop_exit` longjmp = ~15 µs JS-exception unwind × ~9.4k SWIs/s); new early-return in `cpu_handle_interrupt` delivers a pending exception_index before running/chaining any other TB — exactly the longjmp outcome, incl. IRQ-vs-exception ordering. Gated `__EMSCRIPTEN__` + !EL2/EL3/!M/!AA64 (target_el fixed 1, no TGE redirect); ss_active keeps the helper | window 34→25 s (−26 % quiet, −39 % loaded; 3/3 interleaved pairs); finalV@110 s +30…77 % (92–126 → 164); insns@110 s +6–10 %; `__emscripten_throw_longjmp` 18.5 %→2.6 % of vCPU; idle screen v=245 in ~185 s; native suite PASS ×4 |
| 0014 wasm: io barriers | recurring ROM-device io_recompile (0010 kept the stock rewind for flash-command accesses; the unsplit cached TB re-paid the ~17 µs unwind on every status-poll iteration, 1.67k/s) — on rewind, record the faulting insn pc (64-entry direct-mapped set) + `tb_phys_invalidate` the TB; the translator keeps barrier insns in single-insn TBs (stop before mid-TB / after at TB start), so `can_do_io` is true and the access completes with stock 1-insn-clock precision — no further unwinding | ioRewind 1.67k/s → ~0; window wins 3/3 pairs (25.2–24.8 vs 25.3–27.5); insns@110 s +3–5 % on all pairs; soak v=373 @330 s, keypad works; native suite PASS ×4 |
| 0016 memory: romd FlatView variants + range-scoped tlb flush | romd toggle per flash command = full FlatView re-render of every root (~200 µs, 16k radix page inserts over the flash) + full tlb_flush + ~33-entry refill storm, ~18k flips per boot — (a) FlatViews tagged (topo_gen, romd_sig), romd-only commits adopt the recycled variant from a 16-slot stash (roots whose tag already matches are skipped); (b) tcg listener records region_add/del phys ranges, flush drops only entries translating into them (evicted-variant latch falls back to full flush; entries never dereference a dead view) | topo-commit time 3857→421 ms (−89 %), 30894 variant reuses; v-window 25.1–28.3 → 22.5–25.1 s (8/8 interleaved pairs, every candidate run beats every baseline); insns@110 s +4–9 %; idle screen ~160 s; run-to-run variance collapsed; native suite PASS ×4 (measurement traps in [optimization-sessions.md](optimization-sessions.md), 2026-09-10) |
| 0015 wasm: diagnostics counters | txnF/tbGen/tbFlush/ioRewind/lookupTB cold-path counters (killed two wprof2 ghost theories — sessions doc) | zero hot-path cost; measurement infra — **dropped 2026-09-09**: isolation testing measured it neutral, no tool consumed its counters (see patches/attic/README.md and § Patch-isolation study) |
| 0017 wasm64 TCG backend | full backend: per-TB wasm modules → chaining → batching (128/B module) → inline TLB probe → inline TB accounting; `tcg/wasm64/` + small hooks | compute 7.4× TCI on tcgbench; boot: early phase (first 0.75 G insns) ~27 % SLOWER than TCI, last 0.55 G 2.7× faster — tIdle equal by cancellation only (2026-09-11 benchmark audit in [optimization-sessions.md](optimization-sessions.md)) (562 vs 53 MIPS; per-phase 7–18×); all gates green incl. full 2.5e9 lockstep — numbers and history in [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md) |
| 0019 wasm64: speculative successor translation + compile-once batching + compaction | goto_tb destinations recorded per TB; on a lookup miss the successors are translated breadth-first into the open batch (non-faulting probes before any lookup — the faulting `get_page_addr_code` delivered a spurious prefetch abort for a blx Thumb target); the batch is compiled when its first member runs (no per-TB temp module); landed batches keep re-assemblable records, live FIFO cap + on-demand re-ensure, and every 256 small batches are compacted into one module; a 32 MB throwaway allocation per 256 instantiations keeps Firefox's worker GC collecting dropped modules (Firefox: ~16.3k live modules max, code memory is not GC pressure) | idlebench `--runs 2` interleaved: tIdle 76.2/71.5 → 65.0/64.9 s (−15 %), window 30.4/28.7 → 26.0/25.7, t0.25G −13 %, t0.5G −14 %, t1.3G −15 %, RSS −4..−12 %; vCPU `Module` self-time 21 % → ~3 % early boot; Firefox boots to idle (was OOM at 10 s); op-suite 1156/1156 ×4, lockstep 20e6+250e6 clean, native suite 4/4 |
| 0020 wasm64: call-return + `ldr pc,[pc,#-4]` trampoline successors, W64_SPEC_N 32 | ARM `bl`/`blx` record the return address via `translator_note_succ`; a TB ending in the firmware's `ldr pc,[pc,#-4]` thunk contributes its literal | batches 29.5k → 11.3k per 25 s, 3.1 → 12.7 members, misses −60 %; idlebench `--quick` vs 0019, both orders: t0.5G −8 %/−5 %, window −5 %/−5 %; gates green (op-suite, lockstep 250e6, Firefox idle, native 4/4) |
| 0018 cputlb: fill-time MMIO dispatch + victim-TLB masked compare | (a) `tlb_set_page_full` resolves `(callback, opaque, size-mask, swap, align, re-entrancy guard)` per iotlb entry — the MMIO access path becomes one mask test + indirect call instead of dispatch_read→access_valid→adjusted_size→accessor; (b) `victim_tlb_hit` compared `cmp == page` unmasked, but every MMIO entry carries TLB_FORCE_SLOW in addr_idx → the victim TLB *never hit for MMIO*, so two MMIO pages aliasing on one TLB index (sysctl 0x10000000 + VIC 0x10140000, both index 0 under ARMv5 1K target pages) re-walked the guest page tables on **every access** | tcgbench mirrors: mmiopoll **534→202 ns** (dist-jit), 606→252 (dist), mmiow 305→227; native parity (223).  bootbench finalV/insns@110 s up on every pair (windows noisy under host load); op-suite 1156/1156 byte-identical ×3, native suite 4/4 on the branch binary, lockstep 20e6+250e6 clean (sessions doc, 2026-09-11 device-path) |

(The 0017 row is a pointer — that patch's own docs are authoritative for
its compute numbers; its boot numbers are idlebench's.)

## Patch-isolation study (2026-09-09, summary)

Every TCI/longjmp patch in 0001–0014 is empirically load-bearing
(removal costs 15–40 % of the window or collapses the boot); 0015
(diagnostics counters) was the only removable surface and was dropped;
0002's condvar half is redundant since 0009 but cannot be split out
without rebasing 0004/0007/0009.  Harness: `scripts/switch-test.sh`
(`MINUS:NNNN` / `REVERT:N1,N2`).  Table and dependency structure in
[optimization-sessions.md](optimization-sessions.md).

## What was tried and REJECTED (do not retry without new ideas)

| Experiment | Result | Why |
|---|---|---|
| **wasm32 runtime-JIT TCG backend (0005, ktock port fully rebased)** (2026-09-09 session; see [wasm32-port-status.md](wasm32-port-status.md) + `patches/attic/wasm32-rebase/`) | v-window 2→7: JIT 18.7–20.1 s vs TCI 24.8–28.3 quiet / 45–46 loaded — **~1.3–2.3x ceiling**, and the boot deterministically hangs at v≈6 (BROM USART-RIS poll data divergence → watchdog reset → recovery loop forever; LG/no-icount boot fully dead) | per-TB dispatch protocol (instance return → C dispatcher → indirect instance call per chained TB) + per-new-TB JS `WebAssembly.Module` compile eat the codegen gains on this 3–4 insn/TB branchy firmware; ~4200-line surface; discarded — the draft and the full rebase live in `patches/attic/` |
| **tci.c interpreter stack as a parameter** (during the 0005 rebase: split `tcg_qemu_tb_exec` into a core + wrapper taking `uint64_t *call_stack`) | TCI v-window 25→45 s (**−60%**, 4/4 interleaved runs) | the pointer-select makes the interpreter stack alias every local array in LLVM's analysis; the TCI stack is per-TB scratch anyway — keep a single function with a local array |
| **MMIO dispatch fast path** (memory.c: direct `ops->read/write` call for exact-size aligned accesses, skipping valid-check + access_with_adjusted_size + accessor layers; reentrancy guard replicated; `__EMSCRIPTEN__`-gated) | window 24.9–25.2 → 25.1–25.3 s (**consistently 0.1–0.7 s WORSE on a quiet host**, 4/4 pairs); finalV ±noise; insns@110 s +0.1–5.8 % inconsistent; a late-window A/B (LO=30 HI=60) was flat too | the pre-dispatch condition chain (accepts/align/size/trace/ioeventfd checks) costs as much as the ~3 non-inlined calls it saves at ~90k dispatches/s; V8 already keeps the dispatch path hot. Reverted; don't retry a *runtime* cache without cross-TU inlining (LTO). **NOT the same as the current workstream's fill-time precompute** (store `(fn, opaque, attrs)` in the iotlb entry when it is filled — zero added per-access checks): that one is the plan in [performance-handoff.md](performance-handoff.md) slice 1 |
| **TLB table-base caching in the TCI interpreter** (cache `(fast->table, fast->mask)` per mmu_idx across ops, dropped after helper calls and ldst fallbacks — the only paths that can resize/flush the tlb on this single-cpu machine) | window 25.9/25.2/25.2/25.2 → 24.5/25.3/25.1/25.1 (flat, ±0.1); late-window LO=30 HI=60: 19.7/20.3 → 19.6/20.0 (flat); finalInsns won 4/4 (+1…5.7 %) but finalV-at-200 s varies ±45 v run-to-run — no reproducible win | the two saved loads are L1-hot; the memory-op path is at its practical floor for micro-tweaks (0011+0012 already removed the real work). Reverted; only a big lever (64-bit TCI encoding, wasm32 JIT) can move the interpreter now |
| Lazy flash romd restore (flip back to array mode on first array read, not eagerly on every `0xFF`) | 7.4× fewer topology flips but **32 % slower** in the flash-heavy window | keeping romd off during bursts turns array reads (incl. fetches) into MMIO dispatches, which costs more than the flips save |
| icount2_advance thread-local batching (single-writer mirror, publish every 256 calls) | no measurable change (±noise) | the per-TB atomics are cheap on wasm; reverted |
| TCI store-immediate ops (`tci_st32_ri`/`st8_ri`, incl. the `tcg_out_sti` constant-spill hook) | window 42.9→50.6–50.7 s, final insns −20 % — consistent regression across runs | not root-caused; suspected interaction with allocator behavior/stream size; documented in 0008's header |
| QemuCond-based main-loop wait (instead of the raw futex) | same early-window numbers but only ~half the end-to-end gain | qemu condvar waits truncate to whole milliseconds on wasm; the firmware's ~100 µs WFI windows each pay +1 ms |
| `-sSUPPORT_LONGJMP=wasm` (native unwinding for the SVC-exception longjmps) | binaryen's Asyncify pass crashes on it (verified with a standalone emcc test) | wasm-EH longjmp and `-sASYNCIFY` are incompatible in emsdk 4.0.10; ASYNCIFY is required (coroutine backend/condvar sleeps) |

## Remaining opportunities (ranked; the plan lives in performance-handoff.md)

1. **wasm64 early-boot deficit — REDUCED by 0019, still open.**  Was
   ~27 % behind TCI on the first 0.75 G insns (per-TB module compile =
   21 % of vCPU); 0019 took t0.5G 48.7 → 41.7 s on this host.  What is
   left: batches still average ~3 members (60 % of misses find every
   goto_tb successor already translated; indirect targets are not
   followed), so ~1.2k small modules/s are still compiled (~120 µs each
   in Firefox, ~25 µs in V8) before compaction.  0020 added
   call-return and `ldr pc` trampoline successors (batches 3 → 13
   members, misses −60 %, t0.5G −5..−8 %); still ~450 small modules/s,
   65 % of them single-member (indirect `bx lr`/`ldr pc,[rN]` targets,
   mode switches).  Candidates: cheaper first execution, AOT cache (#4).  Meter: `idlebench --quick` t0.25G/t0.5G + `W64_DEBUG=1` batch
   histogram (`tools/iotrace.mjs`).
2. **The ~9 s real-time-paced stretch (v 4.7→23.5, both engines at
   ~3 MIPS) — OPEN, qemu-core, helps every backend.**  Device transfer
   timers on `QEMU_CLOCK_REALTIME`/`HOST` (dif/ssc/dmac, DSP AFE) are
   the candidates; making them virtual-time paced would cut every
   boot by up to ~9 s.  Meter: per-second MIPS/v curve in the
   idlebench JSON (`samples`), then tIdle.
3. **Timer storms / main-loop wakeups — OPEN.**  ~8 % of the late
   window in mailbox/futex-wake/`_emscripten_get_now` + device timer
   callbacks nobody observes.  Meter: wprof main-thread self-time +
   idlebench t1.3G.
4. **AOT cache — OPEN, orthogonal** (backend plan phase 5): persist
   translated batches (Cache API/IndexedDB, keyed by flash hash) —
   zero-translation second boots; would also attack #1.
5. **Backend tail — small, `/dist-jit` only**: `lookup_tb_ref` direct
   import (~4 % of vCPU), dispatch-loop work (~9 %).  Few % each.

Landed/closed since the last ranking: MMIO dispatch path (0018 —
mmiopoll 534→202 ns, native parity; re-measure before reopening).

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
- **The TCI TB layout (`/dist`)**: `tb->tc.ptr` points at the TCI stream;
  every TB starts with `tci_tbhdr` (icount) — chain jumps and
  `lookup_tb_ptr` targets all pass through it.  Anything that jumps
  into a TB must land on the header.

## Session checklist

1. `git log` / `ls patches/`; read performance-handoff.md for where the
   workstream stands.
2. Save baseline dists aside; `tcgbench` + `idlebench --quick` for
   today's numbers (≈3 min).
3. Profile (step 4 of the command list), pick ONE target from § Remaining, check
   § REJECTED first.
4. Patch → rungs 0–2 → keep/revert → gates → capture with a measured
   header.
5. Update the tables here (landed/rejected/remaining) and the README
   patch list; put the narrative in optimization-sessions.md.
