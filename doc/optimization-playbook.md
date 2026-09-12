# WASM performance optimization playbook

The working method of the optimization sessions since 2026-09-07:
**profile → hypothesize → small patch → measure → keep or revert →
document**, tuned for the shortest loop that can still reject a bad
change.  Read with [performance-handoff.md](performance-handoff.md)
(current targets/plan) and [tests/tcgbench/README.md](../tests/tcgbench/README.md)
(tool ladder).  The conclusions behind these rules — timing model,
io-recompile accounting, emscripten traps, measurement traps — are in
[lessons.md](lessons.md).

**Workstream history**: TCI patches 0007–0016 (~4× guest throughput) →
wasm64 TCG backend 0017 (compute 7.4× TCI; boot early phase still ~27 %
behind TCI, see § Remaining) → qemu-core device path (0018: MMIO
dispatch at native parity) → wasm64 module economy 0019 (compile-once
batching + compaction: tIdle −15 %, Firefox OOM fixed) → halt path
0023–0029 (idle warp on the vCPU thread, virtual-clock device
completions, goto_ptr for indirect jumps and CPSR writes, budget-aware
timer kicks, no icount2 accounting under stock icount: dist-jit
tIdle 50.1→43.9 s, dist 63.4→57.0 s in one interleaved `--runs 2`) →
Asyncify onlylist + real-time cap 0031/0032 (instrument only the
coroutine-switch stack, not everything the invoke_* wrappers reach:
dist-jit 45→28 MB, tIdle 40.3→33.2 s / −18 %, wasm64-only; and a
sleep=off real-time cap so the idle clock/animations stop running ahead
of wall) → RTC seed layout 0033 (the too-fast clock and the 2091 date
were one bug, not a rate issue) → EL71/KE800 on the wasm builds
0034–0038 (every board now boots on the wasm64 backend, which became
the page default for all of them) → display path + fill-time TLB growth
0039–0041 (stopwatch vratio 0.19 → 0.33) → TB lookup / hflags /
range-flush 0042–0045 (−2..−4 % on the milestones; the counters that
showed the shipping boot is virtual-time-bound after t0.75G and that
197 MB of wasm is compiled per boot) → **open now**: emitted code volume
(§ Remaining 0b), the J2ME throughput target (§ Remaining 0), the
batcher's rare SOURCE-CORRUPT (§ Remaining 4), the AOT cache.

Since 2026-09-12 the qemu tree is the `qemu/` submodule: a "patch" is
a commit on its branch (numbering continues as before), and
`versions.env` pins the tip — see [upstream-branch.md](upstream-branch.md).

## The iteration ladder (cheapest reject first)

Every candidate climbs this ladder and stops at the first rung that
rejects it.  Costs are wall-clock on this host (32 cores, quiet).

| rung | command | cost | detects | cannot see |
|---|---|---|---|---|
| 0 build | `scripts/ninja-fast.sh` (**wasm64 → site/dist-jit by default**; `TCI=1 scripts/ninja-fast.sh` for the interpreter → site/dist) | ~8 s wasm64, ~70 s TCI | compile errors | — |
| 1 tcgbench | `node tools/tcgbench.mjs` (native-jit + dist-jit); `LEGS=dist,dist-jit` for qemu-core; `ICOUNTS=0,1` for icount; `SUITE=quick` = ÷4 iterations smoke image | ~15 s per wasm64 leg, TCI leg 100 s (`SUITE=quick`: ~3 s / ~25 s) | per-op-class compute + MMIO/RAM dispatch tax (ns/access), value bugs (checksum) | **boot regressions** — hot loops amortize translation |
| 2 quick boot | `node tools/idlebench.mjs <base>,<cand> --quick` | ~1 min per dist | window v=2..7, t0.1G/t0.25G/t0.5G, A/B ratios, REGRESSION verdict vs previous run | late-phase and idle (cap 60 s) |
| 3 op-suite | `scripts/run-tcg-isa.sh` | ~30 s | any TCG/memory/exec value divergence, 3 backends byte-identical | perf |
| 4 full boot | `node tools/idlebench.mjs --runs 2` | ~2.5 min per dist | tIdle, t1.3G, LCD idle screen, crash/stall classes | — |
| 5 native suite | `node tests/run.mjs --label <patch> --timeout 240` | ~65 s | native boots of 4 phones | wasm-only paths |
| 6 lockstep | `tools/lockstep-wasm.mjs --insns 20e6\|250e6\|700e6`; full `2.5e9` at slice close | 1–15 min | cross-backend state equality over a boot | — |

Rules that keep the ladder honest:

1. **No change lands without a measurement**; a rejected change gets
   a row in § REJECTED with its numbers so it is not retried blind.
2. **One mechanism per commit** on the `qemu/` submodule branch, the
   commit message WITH the measured numbers; bump `QEMU_PMB887X_REV`
   in `versions.env` when it lands.
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

# 1. edit qemu/ (the submodule, all patches committed) → 2. rebuild + deploy (~8 s)
bash scripts/ninja-fast.sh                        # wasm64 -> site/dist-jit
TCI=1 bash scripts/ninja-fast.sh                  # interpreter -> site/dist (qemu-core changes)

# 3. rung 1–2: ~1.5 min total
node tools/tcgbench.mjs
PORT=8080 node tools/idlebench.mjs dist-jit-base,dist-jit --quick

# 4. profile only when choosing the next target (~40 s)
PORT=8080 node tools/wprof2.mjs 40 "" 100                 # PROF_DELAY=<s> picks the phase
PROF_FN=<symbol> PORT=8080 node tools/wprof2.mjs 30 "" 100  # caller stacks

# 5. gates for a keeper, then commit
scripts/run-tcg-isa.sh
PORT=8080 node tools/idlebench.mjs dist-jit-base,dist-jit --runs 2
node tests/run.mjs --label <name> --timeout 240
git -C qemu commit -a                             # measured numbers in the message
git -C qemu push origin wasm-browser-port:wasm-patches
# then set QEMU_PMB887X_REV in versions.env to the new tip (fetch-qemu.sh
# resets the checkout to the pin on the next full build)

# 6. FINAL GATE before the session's last commit (~6 min): all three
#    fullflashes must boot, native AND in the browser.
node tests/run.mjs --label <name>-final --timeout 240   # s75 el71 c81 ke800
node tools/bootcheck.mjs --dist dist-jit --secs 150     # s75 el71 ke800
```

Deploy hygiene: never plain-`cp` over a live-served wasm (a torn file
gets served) — the deploy scripts do tmp+rename; and refresh the
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
  JSON `samples`): new-code heavy to ~0.5 G insns (JIT 7–20 MIPS in
  2 s intervals with 5–10k new TBs/s, 30–45 MIPS when translation
  drops below 2k/s — the early phase is bound by translation + module
  compile, ~11 s of a 41 s boot after 0030), the display-DMA stretch
  (v 4.7→23.5, ~7 s at 10–20 MIPS: one IRQ + WFI per word, no
  main-loop handoffs since 0023/0024), then compute (TCI 45 MIPS, JIT
  190).  A change can move one phase and leave tIdle flat.
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
  is in [lessons.md](lessons.md) § Measuring).  Remove measurement scaffolding before the
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
mmiopoll only) makes a whole-run profile pure.

## What landed (with numbers)

| Patch | Mechanism | Measured effect |
|---|---|---|
| 0007 TCI TB chaining | restore `goto_tb` chaining; per-TB icount2 accounting moved into the interpreter via a `tci_tbhdr` header op executed at every TB entry; the old 0004-era session io accounting collapses to a deadline-sync | +84–113 % insns at fixed wall time; `cpu_exec_loop` 9.3 %→0.8 % of vCPU; boot to idle ~260 s |
| 0008 TCI immediate forms | `tci_add/and/or/xor/andc_ri`, `tci_setcond32_ri` + constraint letters + `tcg_target_const_match` + outop `out_rri`/`out_ri` wiring — constants stop materializing through `tci_movi` (18.9 %→12.8 % of ops; `add` 7.4 %→1.0 %) | window 46.7→42.9–43.7 s (+8 %); idle screen ~235 s |
| 0009 futex main-loop wait | emscripten `poll()` cannot sleep (it ignores the timeout — the browser main thread must not block), so the main loop busy-spun ~23k iterations/s through a proxied syscall, 2 BQL handoffs each, and the aio eventfd wake never worked at all.  Replaced with a worker-local ns-precision futex wait woken by `qemu_notify_event`/`aio_notify`; main-loop wait no longer times out on virtual deadlines (the vCPU runs those) | window 43.7→40.1–40.4 s (+8 %); +22 % boot progress @110 s; idle screen ~195 s |
| 0012 tci size-specialized ldst | eight appended opcodes (tci_qemu_ld8..st32) for the exact mop family MO_ALIGN\|MO_ATOM_NONE\|size\|sign — every plain pmb887x data access: the generic probe reduces to `(addr & (page_mask\|size-1)) == tlb_addr`, baked in as constants, no mask math/atom branch/size switch, mmu_idx-only stream word; tci_qemu_ld/st dead re-probe removed (0 hits in >1M calls); cold-path diag counters (wasm-diag.h + tools/memstat.mjs) | window wins all 4 interleaved pairs (34.1/33.9/34.0/34.0 vs 40.6/34.4/34.9/34.5; −1.4…−16 %, bigger under host load); boot progress @110 s v 91–102 → 114–121 (+18–25 %); native suite PASS ×4 |
| 0013 wasm: SVC inline exception exit | ARM frontend stores exception_index/syndrome/target_el + `exit_tb(0)` instead of the `helper_exception_with_syndrome` call (its `cpu_loop_exit` longjmp = ~15 µs JS-exception unwind × ~9.4k SWIs/s); new early-return in `cpu_handle_interrupt` delivers a pending exception_index before running/chaining any other TB — exactly the longjmp outcome, incl. IRQ-vs-exception ordering. Gated `__EMSCRIPTEN__` + !EL2/EL3/!M/!AA64 (target_el fixed 1, no TGE redirect); ss_active keeps the helper | window 34→25 s (−26 % quiet, −39 % loaded; 3/3 interleaved pairs); finalV@110 s +30…77 % (92–126 → 164); insns@110 s +6–10 %; `__emscripten_throw_longjmp` 18.5 %→2.6 % of vCPU; idle screen v=245 in ~185 s; native suite PASS ×4 |
| 0014 wasm: io barriers | recurring ROM-device io_recompile (0010 kept the stock rewind for flash-command accesses; the unsplit cached TB re-paid the ~17 µs unwind on every status-poll iteration, 1.67k/s) — on rewind, record the faulting insn pc (64-entry direct-mapped set) + `tb_phys_invalidate` the TB; the translator keeps barrier insns in single-insn TBs (stop before mid-TB / after at TB start), so `can_do_io` is true and the access completes with stock 1-insn-clock precision — no further unwinding | ioRewind 1.67k/s → ~0; window wins 3/3 pairs (25.2–24.8 vs 25.3–27.5); insns@110 s +3–5 % on all pairs; soak v=373 @330 s, keypad works; native suite PASS ×4 |
| 0016 memory: romd FlatView variants + range-scoped tlb flush | romd toggle per flash command = full FlatView re-render of every root (~200 µs, 16k radix page inserts over the flash) + full tlb_flush + ~33-entry refill storm, ~18k flips per boot — (a) FlatViews tagged (topo_gen, romd_sig), romd-only commits adopt the recycled variant from a 16-slot stash (roots whose tag already matches are skipped); (b) tcg listener records region_add/del phys ranges, flush drops only entries translating into them (evicted-variant latch falls back to full flush; entries never dereference a dead view) | topo-commit time 3857→421 ms (−89 %), 30894 variant reuses; v-window 25.1–28.3 → 22.5–25.1 s (8/8 interleaved pairs, every candidate run beats every baseline); insns@110 s +4–9 %; idle screen ~160 s; run-to-run variance collapsed; native suite PASS ×4 |
| 0017 wasm64 TCG backend | full backend: per-TB wasm modules → chaining → batching (128/B module) → inline TLB probe → inline TB accounting; `tcg/wasm64/` + small hooks | compute 7.4× TCI on tcgbench; boot: early phase (first 0.75 G insns) ~27 % SLOWER than TCI, last 0.55 G 2.7× faster — tIdle equal by cancellation only (562 vs 53 MIPS; per-phase 7–18×); all gates green incl. full 2.5e9 lockstep — numbers and history in [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md) |
| 0019 wasm64: speculative successor translation + compile-once batching + compaction | goto_tb destinations recorded per TB; on a lookup miss the successors are translated breadth-first into the open batch (non-faulting probes before any lookup — the faulting `get_page_addr_code` delivered a spurious prefetch abort for a blx Thumb target); the batch is compiled when its first member runs (no per-TB temp module); landed batches keep re-assemblable records, live FIFO cap + on-demand re-ensure, and every 256 small batches are compacted into one module; a 32 MB throwaway allocation per 256 instantiations keeps Firefox's worker GC collecting dropped modules (Firefox: ~16.3k live modules max, code memory is not GC pressure) | idlebench `--runs 2` interleaved: tIdle 76.2/71.5 → 65.0/64.9 s (−15 %), window 30.4/28.7 → 26.0/25.7, t0.25G −13 %, t0.5G −14 %, t1.3G −15 %, RSS −4..−12 %; vCPU `Module` self-time 21 % → ~3 % early boot; Firefox boots to idle (was OOM at 10 s); op-suite 1156/1156 ×4, lockstep 20e6+250e6 clean, native suite 4/4 |
| 0020 wasm64: call-return + `ldr pc,[pc,#-4]` trampoline successors, W64_SPEC_N 32 | ARM `bl`/`blx` record the return address via `translator_note_succ`; a TB ending in the firmware's `ldr pc,[pc,#-4]` thunk contributes its literal | batches 29.5k → 11.3k per 25 s, 3.1 → 12.7 members, misses −60 %; idlebench `--quick` vs 0019, both orders: t0.5G −8 %/−5 %, window −5 %/−5 %; gates green (op-suite, lockstep 250e6, Firefox idle, native 4/4) |
| 0021 wasm: untimed cond waits + atomic event notifiers | `qemu_cond_wait_impl` passed 0 ms to `emscripten_futex_wait` = immediate "timeout" → every untimed wait (vCPU halt, RCU, io-dump threads) was a BQL lock/unlock spin; `event_notifier_set/test_and_clear` did proxied eventfd `write`/`read` (~1 ms sync round trip to the main thread, per icount deadline via `qemu_clock_notify`) → atomic flag | idlebench both orders: dist-jit tIdle 66→62.6 / 68→58.9 s, dist 76→73 / 73.5→64.7 s; gain from t0.75G on (the display-DMA stretch); op-suite ×4, lockstep 250e6, Firefox idle |
| 0022 wasm64: goto_ptr handoff slot offset | `tcg_out_goto_ptr` stores the next TB at `[sp-8]` = frame+8; the dispatcher read frame+0 (always 0) → every indirect jump was a "miss" that unwound to `cpu_exec_loop` (exit-kind counters: 14.9M misses, 0 hits of 16.8M exits in 30 s) | idlebench `--quick` vs 0021 both orders: window −10 %/−8 %, t0.5G −4 %/−4 %, t1.3G −5 %/−2 %; op-suite, lockstep 250e6, Firefox idle |
| 0023 icount rr: idle warp on the vCPU thread | stock icount routes every idle virtual deadline through the main loop (notify → `icount_start_warp_timer` → `async_run_on_cpu(do_nothing)` kick → `icount_handle_deadline` on the vCPU): two cross-thread hops per deadline; `rr_idle_advance` does the warp + `QEMU_CLOCK_VIRTUAL` timer run on the vCPU thread under the BQL (≤64 iterations, BQL released between them) before the cond wait | counters: ~50k halts/boot, ~5 deadlines per halt, the halt cond wait is never reached; alone: dist-jit t0.75G..t1.3G −5 %, dist −2 %; stack 0023–0027 (`--runs 2`): dist-jit tIdle 51.9→46.2 s (−11 %), t1.3G 50.7→44.3 (−13 %); dist tIdle 62.2→58.2 (−6 %), t1.3G 60.1→55.8 (−7 %) |
| 0024 pmb887x: dmac/dif/ssc completion timers on QEMU_CLOCK_VIRTUAL | the display-DMA word completed from a REALTIME "now" timer on the main loop; on the virtual clock the vCPU runs it at the next TB boundary or in the first 0023 warp — deterministic and hop-free (the same change was neutral before 0023: REJECTED row superseded) | on top of 0023: display stretch (0.5G→0.75G) dist 15.2→12.5 s, dist-jit 11.1→9.1 s; t1.2G dist −4 %, t1.3G dist-jit −2 % |
| 0025 wasm: halt-path costs | `icount_get_limit` read the REALTIME deadline (a ~3 µs JS clock import) twice per vCPU loop round — 8 % of the vCPU in the halt-dense stretch (dropped on wasm: the main-loop worker paces its own wait); `icount_start_warp_timer`'s VIRTUAL_RT read moved into the sleep=on branch; `helper_wfi` returns instead of `cpu_loop_exit` (WFI ends its TB, the 0013 early return delivers EXCP_HLT) — no ~15 µs JS unwind per halt | with 0026 on 0023+0024: dist-jit t0.75G −7 %, t1.3G 47.9→43.8 (−9 %) |
| 0026 wasm64: goto_ptr in-wasm tail call | `tcg_out_goto_ptr` return_call_indirect's an instantiated target through the chain table (same fidx / chain-stop guards as goto_tb) instead of returning to the C dispatcher; handoff slot kept as the fallback | goto_ptr dispatcher exits 14.9M/30 s → 17k per boot (true misses); measured only in the stack above |
| 0027 target/arm: CPSR writes / exception returns via goto_ptr | exit_tb(0) was the most frequent exit (~190k/s, 4.2M in 33 s from 230 TBs): `msr CPSR_*` in the firmware's critical sections and `ldm {..pc}^`; a plain exit only buys `cpu_handle_interrupt`, so the helpers set `icount_decr.u16.high` when `interrupt_request` is pending (the next TB start unwinds exactly as before) and the TB ends with `DISAS_JUMP` | on top of 0023–0026, `--quick`: window −7 %, t0.25G −7 %, t0.5G −4 %, t1.3G 46.8→42.2 (−11 %); op-suite ×4 identical, native 4/4, lockstep 250e6 |
| 0028 icount: timer re-arms beyond the running budget don't kick the vCPU | `qemu_timer_notify_cb` did `cpu_exit` on every vCPU-thread `timer_mod` (37k/s: device callbacks + the idle warp's own re-arms); only 1.2 % moved the deadline inside the remaining budget (`icount_decr.u16.low + icount_extra`); each needless kick = an empty `cpu_exec` round + a `TB_EXIT_REQUESTED` unwind | `TB_EXIT_REQUESTED` exits 554k → 75k per boot; inside noise on its own (t1.3G 42.8 vs the 0023–0027 stack's 42.2–43.8) |
| 0029 wasm64: no icount2 accounting in TB prologues under stock icount | the prologue mirrored `icount2_advance` per TB entry: atomic i64 load+store of `icount2_ticks` + atomic load/compare of the deadline — ~5M TB entries/s for a clock that is opt-in (`?icount=precise-clocks`, decided at command-line parse); emitted only when `icount2_enabled()` | `--quick` one pair on top of 0023–0028: t0.25G −7 %, t0.5G 32.1→30.4 (−5 %), t1.3G 42.8→40.5 (−5 %); session base 48.4→40.5 (−16 %) |
| 0030 wasm64: speculation explored flag | the BFS through already-translated TBs re-probed and re-looked-up every edge of a fully translated neighbourhood on each miss inside it; `tb->w64_explored` marks a node whose expansion found every successor present | host-time counters: speculation walk overhead 0.87 → 0.29 s per boot (translations unchanged); stack 0023–0030 `--quick`: t1.3G 48.4→40.3 (−17 %) |
| 0018 cputlb: fill-time MMIO dispatch + victim-TLB masked compare | (a) `tlb_set_page_full` resolves `(callback, opaque, size-mask, swap, align, re-entrancy guard)` per iotlb entry — the MMIO access path becomes one mask test + indirect call instead of dispatch_read→access_valid→adjusted_size→accessor; (b) `victim_tlb_hit` compared `cmp == page` unmasked, but every MMIO entry carries TLB_FORCE_SLOW in addr_idx → the victim TLB *never hit for MMIO*, so two MMIO pages aliasing on one TLB index (sysctl 0x10000000 + VIC 0x10140000, both index 0 under ARMv5 1K target pages) re-walked the guest page tables on **every access** | tcgbench mirrors: mmiopoll **534→202 ns** (dist-jit), 606→252 (dist), mmiow 305→227; native parity (223).  bootbench finalV/insns@110 s up on every pair (windows noisy under host load); op-suite 1156/1156 byte-identical ×3, native suite 4/4 on the branch binary, lockstep 20e6+250e6 clean (sessions doc, 2026-09-11 device-path) |
| 0031 wasm64: Asyncify instrumentation allowlist (`-sASYNCIFY_ONLY`) | the emscripten fiber backend unwinds the whole C stack at a switch, so the old `-sASYNCIFY_REMOVE=tcg_qemu_tb_exec` instrumented ~everything the `invoke_*` longjmp wrappers reach (~21k fns / 17 MB / ~25 % of early-boot vCPU).  The wasm64 backend runs guest code as JIT'd modules, not `tcg_qemu_tb_exec`, so instrument ONLY the functions seen on a real switch stack (`configs/meson/asyncify-only.txt`, captured with `QEMU_COSTACK=1` over boot/rw-flash/shutdown + name families).  Prereqs: flash `blk_pwrite` deferred to a main-loop BH (a vCPU-thread block coroutine can't unwind a JIT frame); vCPU thread marked `qemu_coroutine_forbid_current_thread` (abort, not derail).  **wasm64-only** (`build-qemu-wasm64.sh` overrides the shared cross file): the TCI dist's hot path IS the interpreter, onlylist **regressed dist +26 %** | dist-jit wasm **45.1→27.8 MB**; idlebench `--runs 2`: **tIdle 40.3→33.2 s (−18 %)**, t0.5G 29.6→24.0 (−19 %), t0.1G 5.4→3.3 (−39 %); op-suite native JIT+TCI 1156/1156 identical, lockstep 250e6 serial+regs identical, Chromium idle |
| 0032 icount: real-time cap for sleep=off (`QEMU_ICOUNT_RTCAP`, wasm default banked) | sleep=off warps the virtual clock straight to the next deadline (0023, on the vCPU), so a halted guest advances virtual time as fast as the host runs deadlines → the idle clock/animations run ahead of wall (~3.7× at t≈45 s; a regression vs native's RT-paced warp).  The vCPU sleeps (kick-interruptible, sub-ms `qemu_cond_timedwait_ns`) before a warp / after a budget round until wall reaches the virtual target.  "banked" measures allowed time from VM start, so the compute-bound boot (virtual *behind* wall) is never throttled and only idle overrun is paced; "strict" re-anchors on lag (paces the boot too — not the default).  Virtual time stays instruction-deterministic (lockstep/op-suite unaffected) | at t=45 s: virtual v=166 s (off) → **44.8 s (banked) ≈ wall**; boot-to-idle unchanged (insns@30 s 1.13 G banked vs 1.19 G off); default off on non-emscripten.  **Residual:** the phone's displayed digital clock still advances too fast per virtual second — an RTC/timer decode issue separate from the virtual-time rate, resolved by 0033 |
| 0033 pmb887x: RTC `CNT` seed layout per board (`cnt-format`) | the pinned rev seeds `CNT` as a packed calendar (sec/min/hour/yday fields, 964/4/40 reloads); LG firmware reads those fields, Siemens firmware treats `CNT` as one linear Unix-seconds counter (+ its own time-zone setting), so the packed value decoded to "Wed 02 May 2091" and each minute wrap (0x3FF → 0x7C4 = +965) jumped the shown clock +16 min.  Not wasm- or warp-related: identical on the pristine native build.  Board config `[rtc] format` (default unix; the LG configs set calendar — upstream in bsp `e6e73d1`); both honour `-rtc base=` | native S75 "Пт 11 Сен 21:22" / C81 "11.09.2026 20:22" / KE800 unchanged "17:20 11/9"; wasm dist-jit 21:23 → 21:24 over 60 s, dist 21:26 → 21:27 over 40 s (was 15:39 → 15:55 over 40 s); no perf change |
| 0039 pmb887x: display path per-word costs | a redrawing J2ME app (the stopwatch, ~57 fps) pushes every LCD word through DIF FIFO → DMAC request → VIC; that chain was 44 % of the vCPU: `vic_update_state` scanned all 170 lines on every level change (now an asserted bitmap + unchanged-level no-op), the DIF re-drove 6 GPIO pins per FIFO word and 8 DMAC request lines per event (level caches; every consumer is level-idempotent), `dif_mux` was a 32-iteration bit loop per word (byte-lane tables), DMAC read a memory source word by word (burst read once), `srb_set_isr` tested 32 bits.  Plus `-Dqom_cast_debug=false` for the wasm64 build (`OBJECT_CHECK` asserted per FIFO word) | `tools/stopwatch.mjs` vratio **0.19 → 0.33** (25 → 41 MIPS); QOM casts off: boot −3..−5 % every milestone, both orders; op-suite 1156/1156, native 4/4, bootcheck s75/el71/ke800, lockstep 250e6 |
| 0040 cputlb: fill-time TLB growth | QEMU's dynamic TLB resizes only at flush time; a phase with no flushes (the JVM: ARMv5 1 KB pages, ~6.2k-page working set) sat at 256 entries at 83k fills/s.  `tlb_set_page_full` doubles the table when fills since the last flush exceed 2× its size (cap 2^14); trap: index `f[]` through `cpu_tlb_fast()` (mmuidx_to_fast_index), not by mmu_idx | fills 83k/s → 35/s, table → 16384; boot (both orders, with 0039): t0.1G −18..−20 %, t0.5G −2..−3 %, t1.3G −1..−3 % |
| 0041 wasm diag: lookup / fill / flush / halt counters | cold counters behind `wasm_memstat`: tb_lookup calls, jump-cache/qht hits, jump-cache flushes, table clears, fill classification, halts — read by `tools/memstat.mjs` / `tools/stopwatch.mjs` | zero hot-path cost; decided 0039/0040 (78 M lookups per boot at 92 % jc hits; 83k fills/s with 0 flushes; halts/s = 0 in the stopwatch) |
| 0042 wasm diag: warp / module-economy / range-flush counters + compaction knobs | cold counters for the idle warp (ns + 7 size buckets), bytes handed to `WebAssembly.Module` split by assemble source (first close / compaction / re-ensure), emitted TB body bytes, and `tlb_flush_phys_ranges` calls/entries/drops; `W64_COMPACT_BATCHES`/`W64_COMPACT_MEMBERS` promoted from `#define` to env knobs | zero hot-path cost; decided 0043 and produced the module-economy and virtual-time numbers below |
| 0043 cputlb: physical-address summary for the range flush | 0016's topology-commit flush finds its victims by walking every entry of every mmu_idx; 0040 grew the table 256 → 16384, so each romd flip streamed 512 KB of table.  Per mmu_idx keep a 64-bit mask of the 32 MB physical blocks its entries translate into, one per 64-entry group plus an OR over groups and the victim table; a commit ANDs the requested blocks against it and skips whole tables and groups.  Masks are conservative (added on fill and victim promotion) and rewritten exactly by any commit that walks the group, so staleness self-heals.  Block size must divide the reported ranges — 64 MB blocks lumped the two 32 MB flash banks together and only got 280M → 107M | entries walked per boot **280,759,680 → 1,179,712 (237×)**, 1.16 groups walked per commit, entries dropped **22,007 → 22,007 (identical)**; boot effect on its own **FLAT** (t1.3G 29.7 vs 29.8, both orders) — the walk is a predictable streaming scan at ~0.3 ns/entry.  Kept for the scaling property and as part of the 0043–0045 stack |
| 0044 accel/tcg: devirtualise the TB-lookup helper on wasm | `helper_lookup_tb_ptr` runs per indirect jump (78 M/boot, 2.9 M/s, ~10 % of the vCPU) and reached `get_tb_cpu_state` through `cpu->cc->tcg_ops` — a wasm `call_indirect` — and `curr_cflags()` through a cross-TU call whose four debug-only conditions cannot be true in a browser build.  Both folded away under `__EMSCRIPTEN__`.  NOT the rejected per-TB inline cache: the key is still computed once, in the helper | stack 0043–0045, interleaved `--runs 4`: window 14.2 → 13.7 s (−4 %), t0.5G 21.8 → 21.4 (−2 %), t0.75G 27.1 → 26.4 (−3 %), t1G −2 %, t1.3G −1 %; −2 % on t0.5G in both orders of two `--quick` pairs; helper self time 7.3 % → 6.5 % |
| 0045 target/arm: hflags rebuild on a CPSR write only when it can change them | upstream rebuilds unconditionally with a TODO saying not all cpsr bits matter; they do not, and 0027 made `msr CPSR_*` the boot's most frequent TB exit — those writes set I/F and the condition flags.  Every CPSR field hflags reads (mode → EL/mmu_idx/sctlr, E, IL, PAN) lives in `uncached_cpsr`; everything in `CACHED_CPSR_BITS` lives in dedicated env fields and is not an hflags input, so an unchanged `uncached_cpsr` means unchanged hflags | verified with a temporary build that recomputed and compared on every skip: **2,125,612 skips, 0 mismatches** over a full boot; ~2.1 M rebuilds saved (~0.2–0.4 s); measured as part of the 0043–0045 stack |

(The 0017 row is a pointer — that patch's own docs are authoritative for
its compute numbers; its boot numbers are idlebench's.)

## Patch-isolation study (2026-09-09, summary)

Every TCI/longjmp patch in 0001–0014 is empirically load-bearing
(removal costs 15–40 % of the window or collapses the boot); 0002's
condvar half is redundant since 0009 but cannot be split out without
rebasing 0004/0007/0009.  Method today: `git -C qemu revert` of the
commit, then `ninja-fast.sh` and the ladder.

## What was tried and REJECTED (do not retry without new ideas)

| Experiment | Result | Why |
|---|---|---|
| **wasm32 runtime-JIT TCG backend (0005, ktock port fully rebased)** (2026-09-09) | v-window 2→7: JIT 18.7–20.1 s vs TCI 24.8–28.3 quiet / 45–46 loaded — **~1.3–2.3x ceiling**, and the boot deterministically hangs at v≈6 (BROM USART-RIS poll data divergence → watchdog reset → recovery loop forever; LG/no-icount boot fully dead) | per-TB dispatch protocol (instance return → C dispatcher → indirect instance call per chained TB) + per-new-TB JS `WebAssembly.Module` compile eat the codegen gains on this 3–4 insn/TB branchy firmware; ~4200-line surface; discarded |
| **tci.c interpreter stack as a parameter** (split `tcg_qemu_tb_exec` into a core + wrapper taking `uint64_t *call_stack`) | TCI v-window 25→45 s (**−60%**, 4/4 interleaved runs) | the pointer-select makes the interpreter stack alias every local array in LLVM's analysis; the TCI stack is per-TB scratch anyway — keep a single function with a local array |
| **MMIO dispatch fast path** (memory.c: direct `ops->read/write` call for exact-size aligned accesses, skipping valid-check + access_with_adjusted_size + accessor layers; reentrancy guard replicated; `__EMSCRIPTEN__`-gated) | window 24.9–25.2 → 25.1–25.3 s (**consistently 0.1–0.7 s WORSE on a quiet host**, 4/4 pairs); finalV ±noise; insns@110 s +0.1–5.8 % inconsistent; a late-window A/B (LO=30 HI=60) was flat too | the pre-dispatch condition chain (accepts/align/size/trace/ioeventfd checks) costs as much as the ~3 non-inlined calls it saves at ~90k dispatches/s; V8 already keeps the dispatch path hot. Reverted; don't retry a *runtime* cache without cross-TU inlining (LTO). **NOT the same as the current workstream's fill-time precompute** (store `(fn, opaque, attrs)` in the iotlb entry when it is filled — zero added per-access checks): that one is the plan in [performance-handoff.md](performance-handoff.md) slice 1 |
| **TLB table-base caching in the TCI interpreter** (cache `(fast->table, fast->mask)` per mmu_idx across ops, dropped after helper calls and ldst fallbacks — the only paths that can resize/flush the tlb on this single-cpu machine) | window 25.9/25.2/25.2/25.2 → 24.5/25.3/25.1/25.1 (flat, ±0.1); late-window LO=30 HI=60: 19.7/20.3 → 19.6/20.0 (flat); finalInsns won 4/4 (+1…5.7 %) but finalV-at-200 s varies ±45 v run-to-run — no reproducible win | the two saved loads are L1-hot; the memory-op path is at its practical floor for micro-tweaks (0011+0012 already removed the real work). Reverted; only a big lever (64-bit TCI encoding, wasm32 JIT) can move the interpreter now |
| **Device completion timers on QEMU_CLOCK_VIRTUAL** (dmac/dif_v1/dif_v2/ssc `timer_new_ns(QEMU_CLOCK_REALTIME, …)` → VIRTUAL, 2026-09-11) — **SUPERSEDED, landed as 0024** | tIdle 66 → 65 (dist-jit) / 70.5 → 71.9 (dist): flat *before 0023* | the hop chain was the same for both clocks then; once the vCPU thread warps and runs VIRTUAL timers itself (0023) the virtual-clock completion is hop-free: display stretch −2..−3 s |
| **wasm64 goto_ptr per-TB inline cache** (2026-09-11) | 80 % hit rate (57.8M/72.7M lookups per boot) but `--quick` both orders: t1.3G ratios 0.824/0.864 with, 0.823/0.844 without — flat | the inline ARM key computation (pc, hflags, flags2 + 5 deposited fields, ~10 loads + 4 compares) costs what `helper_lookup_tb_ptr`'s jump-cache hit path saves; the helper is ~40–50 ns, not the 150 ns assumed.  Only a cheaper key (e.g. a hflags generation counter maintained by the target) would change this |
| **TB jump cache 4k → 32k entries on wasm** (`TB_JMP_CACHE_BITS` 15, 2026-09-11) | quick A/B vs 0022: +4..+9 % slower / flat (pairs disagree) | `qht_lookup` behind indirect jumps is 2.5 % of vCPU, but the 512 KB clears and cache footprint cost as much; reverted |
| **Compaction threshold sweep** (`W64_COMPACT_BATCHES` 16/32/64/256/1024, 2026-09-11) | single quick runs suggested 16 (t1.3G 52.2 vs 56.9 s) but the interleaved pairs vs 0022 said +3 % slower in both orders; 1024 is +19 % at t0.5G | single-run sweeps on this host are noise at the ±5 % level — only interleaved pairs decide; 256 kept |
| **wasm64: declare only the wasm locals a TB uses** (2026-09-12; every TB function declared 2×32 register locals + 5, and Liftoff zero-fills them per entry at ~4–6 M entries/s; layout with the register pairs last, trailing runs set to count 0) | `--quick` both orders: 0 % / ±1 % on every milestone — flat | Liftoff's zero-fill is not a measurable cost and the 129 extra header bytes per module are; reverted (hash-identical rebuild verified) |
| **V8 wasm flags as bounds** (`JS_FLAGS`, 2026-09-12, one quick run each — not shippable) | `--no-liftoff` (TurboFan-only): t0.25G 12 → 31.8 s (2.5× slower); `--wasm-lazy-compilation` +3 %; `--no-wasm-lazy-compilation` +1 %; `--wasm-tiering-budget=100000` −6 % | the early phase is compile-bound cold code (90 % of JIT time over ~5,400 TB functions), not code quality: eager TurboFan is far worse, faster tier-up buys ≤6 %.  Do not chase Liftoff code quality |
| Lazy flash romd restore (flip back to array mode on first array read, not eagerly on every `0xFF`) | 7.4× fewer topology flips but **32 % slower** in the flash-heavy window | keeping romd off during bursts turns array reads (incl. fetches) into MMIO dispatches, which costs more than the flips save |
| icount2_advance thread-local batching (single-writer mirror, publish every 256 calls) | no measurable change (±noise) | the per-TB atomics are cheap on wasm; reverted |
| TCI store-immediate ops (`tci_st32_ri`/`st8_ri`, incl. the `tcg_out_sti` constant-spill hook) | window 42.9→50.6–50.7 s, final insns −20 % — consistent regression across runs | not root-caused; suspected interaction with allocator behavior/stream size; documented in 0008's header |
| QemuCond-based main-loop wait (instead of the raw futex) | same early-window numbers but only ~half the end-to-end gain | qemu condvar waits truncate to whole milliseconds on wasm; the firmware's ~100 µs WFI windows each pay +1 ms |
| **Turning wasm64 batch compaction off** (2026-09-12; `W64_COMPACT_*` huge, `W64_LIVE_MAX=200000`) | bytes compiled per boot **197 MB → 100 MB** and re-ensures stay 0, but interleaved `--quick`: −3 % in one invocation and **0 %** in the next, at **RSS 1837 → 2179 MB (+18 %)**.  With the live cap left at its 6144 default it is **+8 % SLOWER** (t1.3G 31.3 vs 28.8) — eviction then re-ensure just recompiles the same bodies on demand | compaction is ~49 % of everything the browser compiles (96 MB in 198 modules), and halving the compile bytes buys nothing: merging ~1000 TB functions into one module buys back in execution locality what it costs in compile time.  Do not reopen without a way to compact *without* recompiling — e.g. compiling the merged module off the vCPU thread, which needs the vCPU to reach a JS event loop and so is blocked by the same constraint as everything else that waits |
| **Compaction threshold sweep, take 2** (`W64_COMPACT_MEMBERS` 4096 / 16384 vs the 1024 default, interleaved 3-leg) | 4096: t1.3G −2 %; 16384: 0 %; the baseline leg of that invocation was itself an outlier (t0.1G 3.4 vs the usual 2.5) | inside the noise of a 3-leg run; 1024/256 kept.  Second time this knob has failed to move — stop sweeping it |
| **Widening the TB jump-cache entry** to hold flags/cs_base/cflags/tc_ptr so a hit never dereferences the TB (2026-09-12, rejected by inspection, not built) | `TranslationBlock` has pc@0, cs_base@8, flags@16, cflags@20 and `tc.ptr`@32 — a jump-cache hit already touches exactly **one** 64-byte TB cache line | there is no second miss to remove; widening the entry would only move the same line into a 2–3× larger jump cache, and enlarging that cache was already measured worse (32k entries row above) |
| `-sSUPPORT_LONGJMP=wasm` (native unwinding for the SVC-exception longjmps) | binaryen's Asyncify pass crashes on it (verified with a standalone emcc test) | wasm-EH longjmp and `-sASYNCIFY` are incompatible in emsdk 4.0.10; ASYNCIFY is required (coroutine backend/condvar sleeps) |

## Remaining opportunities (ranked; the plan lives in performance-handoff.md)

0. **The displayed digital clock — CLOSED by 0033** (RTC `CNT` seed
   layout; native seconds clock and idle clock verified 1.0×).
   **The J2ME stopwatch pacing — OPEN, a throughput target with a
   meter.**  `node tools/stopwatch.mjs` boots, walks the keypad to
   Секундомер, starts it and prints `vratio` (virtual s per wall s;
   1.0 = real time).  While it runs the guest never halts (halts/s = 0,
   warp share 0 — 2026-09-12 counters), so the shown rate is exactly
   guest MIPS / 125 (icount shift=3).  Native: 150+ MIPS, paced by the
   RT cap.  wasm: 0.19× at session start → **0.33×** after the display
   path fixes (VIC bitmap, DIF pin/request caches, mux tables, DMAC
   burst reads, QOM casts off) and fill-time TLB growth.  What is left
   in that state (profile, `PROF_ATTACH`): devices 33 % (DIF FIFO
   word loop, DMAC per-word MMIO writes, SRB events), guest code 33 %,
   `helper_lookup_tb_ptr` 12 % (2.9 M lookups/s — the JVM's indirect
   dispatch), MMIO 6 %.  Reaching 1.0× needs ~3× on this workload.
   **Not a regression**: the same meter on the saved `dist-jit-0022`
   build reads **0.12× (15.1 MIPS)** vs 0.29–0.33× now — the earlier
   build was 2.4× *slower* at this, so whatever ran correctly before was
   not that build (native, paced by the RT cap, is the other candidate).

0b. **Emitted code volume — OPEN, now measured, the biggest lever left.**
   The browser compiles **197 MB of wasm per boot** across 35k modules
   (0042 counters), which is essentially all of the `compile-Module`
   10 % of the vCPU; 94 MB of that is unique TB bodies, i.e. **563 bytes
   of wasm per 4.85-insn TB**, and the other half is compaction
   recompiling the same bodies (turning that off is a wash — see
   § REJECTED).  Cold execution of that code, not its compilation, is the
   dominant cost: the first 0.5 G instructions run at ~20 MIPS and take
   21 s of a 29 s boot while the last 0.55 G run at ~220 MIPS.  Where the
   bytes go, per TCG opcode (temporary histogram in `tcg_gen_code`, first
   1.5 M ops): **`qemu_ld` 83.9 B/op and `qemu_st` 86.9 B/op = 37 % of all
   emitted bytes** (the inline TLB probe), `add` 12.0 B × 4.2/TB,
   `goto_tb` 57 B, `goto_ptr` 65 B, `mov` 5.0 B × 6.3/TB, `brcond` 18.9 B.
   Candidates: shrink the inline probe (hoisting `env + fast_ofs` into a
   per-TB local saves ~8 B per access for ~8 B per TB); the AOT cache (#5),
   which removes the whole 197 MB on a second boot.  Meter: the 0042
   counters + `idlebench --quick` t0.25G/t0.5G.

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
2. **The display-DMA stretch (v 4.7→23.5) — MOSTLY CLOSED by
   0021/0023/0024/0025, ~7 s left (was ~12 s, then ~9 s).**  ~12k
   single-word DMA transfers, one IRQ + WFI per word; the halt/wake
   handoffs are gone (vCPU futex wait 31 % → 4 % of the stretch), the
   remaining time is guest work at 10–20 MIPS: ~100 M insns of IRQ
   entry/exit + DMA setup, TPU/VIC device work (`tpu_update_timer`,
   `qemu_set_irq`), `cpu_exec` re-entry per halt (~4k/s).  Meter: the
   per-second MIPS/v curve (`samples`) between v 4.6 and 23.5, then
   tIdle.
3. **Timer storms / main-loop wakeups — OPEN, smaller.**  The vCPU now
   runs virtual timers itself; what is left is the main loop's own
   realtime timers (gui refresh, DSP AFE 1 ms tick, PCM refill) and
   `qemu_notify_event` wakes.  Meter: wprof main-thread self-time +
   idlebench t1.3G.  Exit-kind counters (2026-09-11, after 0027): the
   remaining dispatcher exits are `TB_EXIT_REQUESTED` (~25k/s early —
   icount budget ends at every virtual deadline) and goto_tb first
   links (~3k/s).
4. **wasm64 batcher: `SOURCE-CORRUPT` on an open batch — OPEN, rare,
   diagnostic.**  Seen once in a 285 s KE800 boot (2026-09-12): a staged
   member's body-size LEB differed at `w64_batch_close()`, so the batch
   was abandoned and its members stayed on temp modules (correctness is
   safe — the detector exists for exactly this — but those members never
   merge or compact).  `tb_flush` teardown and `w64_instantiate` are
   ruled out; the only writer of that LEB is the emitter's
   end-of-codegen patch, so the leading hypothesis is a code-buffer
   position handed out twice, most likely around `w64_speculate()`'s
   `tb_gen_code()` calls into an open batch.  The forensic dump
   (`/w64bad-<n>.bin`) must be pulled out of MEMFS by the driver
   (`m.FS.readFile`, as `tools/conlog.mjs SAVE_FS=` does) and compared
   against the staged record: a valid, different TB body there confirms
   the double hand-out, and the question becomes which path advanced
   `code_gen_ptr` twice.  Add `W64_DEBUG=1` for the batch histogram.
   One occurrence in 285 s on KE800, none in the shorter S75/EL71 runs —
   do not assume it is LG-specific.
5. **AOT cache — OPEN, orthogonal** (backend plan phase 5): persist
   translated batches (Cache API/IndexedDB, keyed by flash hash) —
   zero-translation second boots; would also attack #1.
6. **Backend tail — `/dist-jit` only**: 0022 fixed the dead goto_ptr
   fast path, 0026 keeps indirect jumps inside wasm, 0027 turned the
   CPSR-write exits into goto_ptr.  Left: `helper_lookup_tb_ptr`
   (~5–7 % of vCPU: a C helper + `arm_get_tb_cpu_state` + jmp-cache
   probe per indirect jump, now also per CPSR write — an inline
   jmp-cache probe in the emitted goto_ptr would skip the import for
   hits), qht misses (~3 %), `tcg_qemu_tb_exec` self time (~15 %,
   partly guest code misattributed by the profiler — verify with
   counters before chasing).  The per-TB inline cache for the lookup
   was tried and is flat (§ REJECTED): `helper_lookup_tb_ptr` is ~40–50
   ns per call at 1.75M calls/s, and the inline key costs the same.
   Meter: temporary exit-kind counters in `tcg_qemu_tb_exec`.

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
- **fetch-qemu.sh resets the submodule checkout to the pin** whenever
  HEAD differs from `QEMU_PMB887X_REV` — `build-qemu.sh` runs it, so
  commit *and pin* before a full rebuild (`ninja-fast.sh` never touches
  the tree).
- **The TCI TB layout (`/dist`)**: `tb->tc.ptr` points at the TCI stream;
  every TB starts with `tci_tbhdr` (icount) — chain jumps and
  `lookup_tb_ptr` targets all pass through it.  Anything that jumps
  into a TB must land on the header.

## The three-fullflash final gate (added 2026-09-12)

Run this before the session's last commit, not just `tests/run.mjs`:

```
node tests/run.mjs --label <name>-final --timeout 240
node tools/bootcheck.mjs --dist dist-jit --secs 150
```

Why both, and why three devices:

- **The native suite is blind to every wasm patch.**  S75 on the wasm
  builds was the only browser boot anyone watched for the whole 0019-0032
  run, and two board-specific breakages survived it: EL71 aborted with
  `>>EXIT<< FILE: flash` ~4 s in on the wasm64 backend (patch 0034 — S75
  and C81 never program flash during boot, so only EL71 reached the bug),
  and KE800 never got past a device poll on either wasm engine (0035 /
  0037).  Both were green natively the whole time.
- **EL71** is the only fullflash that writes its flash file system while
  booting, i.e. the only one that exercises the MMIO rewind / io-barrier
  path on a ROM device.
- **KE800** is the only board that boots *without* icount (site/app.js
  turns it off for LG), so it is the only coverage of the non-icount
  halt/idle/timer paths — the ones 0023-0032 rewrote.
- Only native + dist-jit, by design: the two together cover the patch set
  and cost ~6 min.  The interpreter dist rides along in the periodic
  lockstep runs; add `--dist dist` when a patch is TCI-specific.

`bootcheck.mjs` judges progress in executed instructions, not framebuffer
updates: EL71 finishes at a "set time and date?" wizard that never
redraws, and is healthy there.

KE800 on `dist-jit` was the last holdout (it stopped early in the GSM
L1 loop and tripped translator_ld's page assertion); 0038 (narrowed
speculated successor addresses) fixed it, and since 2026-09-12 every
board runs on `dist-jit` by default — the gate is green only when all
three PASS.

## The benchmark measured a configuration nobody ships (2026-09-12)

`idlebench` hardcoded `&rt=off` in the page URL from the day 0032 landed
("the real-time cap would pace a faster-than-realtime boot" — true, and
the right default for a *milestone* number), but `site/app.js` ships
`rt=banked`.  So for the whole 0032→0038 stretch **no rung of the ladder
ever measured what a user gets**, and a regression that existed only
under the cap could not have been caught by any of them.

Now an env knob: `RT=banked node tools/idlebench.mjs …` (default stays
`off`; an `RT!=off` run is a knob run and never becomes a baseline).
`EXTRA_Q`/`RT` still apply to every dist of an invocation, so they can only
compare *across* invocations — the comparison rule 3 forbids.  A dist may
therefore be written **`<dir>@<query>`**
(`idlebench "dist-jit@rt=off,dist-jit@rt=banked"`, or
`"dist-jit@env=W64_COMPACT_MEMBERS=4096"`) to give one leg its own query and
interleave a *knob* A/B the way a two-build A/B is interleaved.  Such a run
never becomes a baseline either.
**Run it whenever a patch touches icount, the halt path or timers.**

Measured cost of the cap itself (same wasm, S75v40lg1, quiet host):
tIdle 34.8 → 40.6 s, t0.5G 25.8 → 28.2, every milestone +9…13 %.  That
is not a bug — the cap is what stops the phone's clock and animations
running ahead of wall — but it is a real user-visible price that was
invisible here, and it belongs in any future "boot takes N seconds"
claim.

Generally: **if the page has a knob, the benchmark must be able to set
it.**  A hardcoded query parameter in a measurement tool is a permanent
blind spot, not a default.

## The shipping boot is virtual-time-bound after t0.75G (2026-09-12)

The `RT=banked` price in the section above ("+9…13 % on every milestone")
is stale, and it was stale in a way that matters: it was measured when the
engine was slower.  Interleaved, same invocation, current build:

| | t0.5G | t0.75G | t1G | t1.2G | t1.3G |
|---|---|---|---|---|---|
| `rt=off` | 22.0 | 27.2 | 28.1 | 28.8 | 29.3 |
| `rt=banked` (shipping) | 21.1 | 26.7 | **32.3** | **36.8** | **38.9** |

The two are **identical through t0.75G and then diverge completely**: the
last 0.55 G instructions take 2.1 s at `rt=off` and 12.2 s under the cap.
Nothing about the engine changed between those columns — the cap is paying
out virtual time the guest already banked.

Where that virtual time comes from (warp counters + the idlebench `samples`
series, `rt=off`): the boot reaches idle having consumed **~42 s of virtual
time, ~31.5 s of it idle warp**.  Up to t≈22 s of wall there is essentially
none (0.28 s of warp, 291 halts, virtual time *is* instruction time); then
the display-DMA stretch warps **~18 s of virtual time in ~4 s of wall**
(9.2k halts, 36k warps, ~3.2k of them in the 1–10 ms bucket), and the phase
after it adds ~13 s more.  The guest is genuinely halted across those warps
— it is waiting on millisecond-scale device timers, which is what a real
phone's boot does too, so `sleep=off` + the cap is reproducing stock QEMU's
`sleep=on` pacing without giving up a deterministic instruction stream.

Two consequences for this workstream:

1. **Engine work can only move the first ~0.75 G instructions of the
   shipping boot** — about 27 s of the 39 s.  The remaining 12 s is the
   guest's own timeline and no amount of MIPS will shorten it.  Quote boot
   improvements against `rt=banked` as well as `rt=off`, or they read as
   larger than a user will see.
2. The only lever on the other 12 s is the *model*: whether ~31.5 s of idle
   warp is the right amount.  That is a fidelity question (does a real
   S75v40lg1 take ~42 s of its own clock to boot?), not a performance one,
   and it needs a reference measurement against hardware before anyone
   touches a device's timer periods.

Note also that **native does not have the cap** (0032 defaults it off on
non-emscripten), so native runs `sleep=off` unpaced and fast-forwards the
phone's clock exactly as `rt=off` does.  Native and the web build therefore
disagree about wall-clock pacing while agreeing about the timing model
(`-icount shift=3,sleep=off` on both, `scripts/run-native.sh` and
`site/app.js`).  Aligning them means defaulting `QEMU_ICOUNT_RTCAP=banked`
natively too — which would take a native S75 boot from ~15 s to ~40 s and
needs `tests/run.mjs` timeouts revisited first.

## Gates added 2026-09-11

- **precise-clocks smoke** (any change near timers/halt/rr):
  `cd tools && PORT=8080 DIST=dist-jit MATCH=WATCH EXTRA_Q=icount=precise-clocks=on node conlog.mjs 40`
  must show v advancing to ≈45 by 40 s (a stall reads as a frozen
  `v=`/`insns=` — 0024's first build froze at v=7.2).
- **gzip sidecar warm-up** before any idlebench:
  `curl -s -o /dev/null -H 'Accept-Encoding: gzip' http://localhost:8080/<dist>/qemu-system-arm.wasm`
  for every dist in the run (serve.mjs regenerates the sidecar on the
  first request after a deploy — ~1.3 s inside `tModule`, i.e. on every
  milestone of the fresh candidate).

## Session checklist

1. `git log` here and `git -C qemu log origin/master..` (the series);
   read performance-handoff.md for where the workstream stands.
2. Save baseline dists aside; `tcgbench` + `idlebench --quick` for
   today's numbers (≈3 min).
3. Profile (step 4 of the command list), pick ONE target from § Remaining, check
   § REJECTED first.
4. Patch → rungs 0–2 → keep/revert → gates → commit on the qemu branch
   with the measured numbers, push, bump the pin.
5. Update the tables here (landed/rejected/remaining), the commit
   list in upstream-branch.md, and lessons.md when something was
   learned the hard way.
