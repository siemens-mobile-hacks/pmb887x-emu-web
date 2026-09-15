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
197 MB of wasm is compiled per boot) → 2026-09-13 (no perf change
landed: four candidates measured flat or worse; the batcher
SOURCE-CORRUPT root-caused and fixed; a wprof2 profile that **replaced
the cost model this workstream was ranked on** — translation is 3–4 %
of the vCPU, not ~20 %, and emitted code volume is closed as a lever;
and the **phantom-win** baseline trap in § Measuring, which is the
session's most reusable result) → 0046 inline next-TB lookup cache
(2026-09-13: ~80 % of `helper_lookup_tb_ptr` calls gone, J2ME stopwatch
0.33 → 0.35 (+7..+9 %), boot milestones flat; and the discovery that
0044's devirtualisation had never been compiled in) → 0047–0051 the
display-DMA per-word chain (stopwatch 0.33 → ~0.58) → 0052 the per-TB
dispatch loop (+3.5 %) → 0053 the Firefox module-budget fix (a
regression nine commits old that no gate was watching for; Firefox boot
is now rung 7) → 0054 the per-word MMIO dispatch decision (~2 points of
non-guest work; both wall-clock meters flat) → 0055 the emitter
peephole (−3.7 % emitted bytes/TB, flat on all three speed meters) →
**open now**: the J2ME throughput target (§ Remaining 0, now ~0.58×),
the AOT cache now that it is costed (§ Remaining 5), and — the honest
read after 0054/0055 — **both cheap directions are now exhausted**.
The device chain is a long tail of ~1–3 % items with no single
removable piece (re-checked against a fresh profile in § Remaining 7,
three candidates sized and rejected without building), and the guest's
49 % is not reachable by codegen volume: it is smeared over thousands
of TBs (§ Remaining 0b) and four independent measurements now say
emitted bytes and op count are not what it is bound by.  So the next
*structural* win has to be a **design** change — § Remaining 5 (AOT
cache, ~21 % of the early vCPU, large and with a correctness surface
the gates do not cover today) or collapsing the per-word DMA
request/acknowledge dance (§ Remaining 7, changes what the guest could
observe between words) — not another peephole.  Round nine's real
product is arguably the negative results and the two new meters in
§ Measurement methodology, not the 0055 commit.

→ 0056/0057 round ten (the other two phones: the KE800's io-barrier
thrash was a 20× and the EL71's subpage MMIO dispatch a 10 %, neither
visible to any S75 meter) → **0058–0066 round eleven, the device access
path**: the profile said one device register read cost ~170 ns while a
guest instruction cost ~7 cycles, and that the MMIO path was ~66 % of
the S75's vCPU against ~24 % for the guest's own code.  Nine patches
took it apart — the redundant icount seqlock write per access (0058),
the six-frame load and store dispatch fused into one (0059/0061), a
cache line of its own for `qemu_icount` (0060), the TPU's 1.45 M
`timer_mod` calls a second (0062), the ~22-call BQL pair (0063), a
frame off the clock read (0064) and the duplicate clock notify per
idle round (0065) and the TPU's double advance per register write
(0066).  Two things generalise: **a store to a
line another thread touches costs 24× more than one to an uncontended
line**, and **the wasm tax is per *call*, so the win is in frames
removed, not instructions removed** — which is also why LTO looked
right and is not (it cannot inline the `noinline` coroutine-TLS
accessors, and function merging would break the `ASYNCIFY_ONLY` list).
What is left is now two things, both sized in the handoff: the main
loop being woken ~12 k times a second to do nothing (~21 % of the vCPU
at idle), and `icount_get` still costing ~50 ns/call.

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
| — counters | `node tools/diagall.mjs [secs] [interval]` | ~1 min | every `wasm_memstat` index by name + a per-second DELTA block (tbGen/tbFlush, module bytes by assemble source, lookups and jump-cache hits, MMIO, fills, warp buckets) | attribution to a function |
| 5 native suite | `node tests/run.mjs --label <patch> --timeout 240` | ~65 s | native boots of 4 phones | wasm-only paths |
| 6 lockstep | `tools/lockstep-wasm.mjs --insns 20e6\|250e6\|700e6`; full `2.5e9` at slice close | 1–15 min | cross-backend state equality over a boot | — |
| — uibench | `node tools/uibench.mjs --board s75\|el71\|ke800 --state both --settle <s>` | ~3 min per board | per-board steady-state: MIPS, v/wall, fps, halts/s and the display/dispatch counters, at the idle screen and while the menu is driven.  The only meter that sees a board-specific mechanism (rounds 4–9 measured the S75 only, and both round-ten findings were invisible there) | boot phases; and on `icount=none` boards v/wall is 1.0 by construction, so read MIPS/fps |
| 7 Firefox boot | `BROWSER=firefox node tools/ffboot.mjs dist-jit` (Playwright Firefox; `MAX=60` is enough) | ~1–3 min | the Firefox module budget: `temp=` (modules created − batch closes − compactions) must stay ~0 and `errors=0`; a "failed to allocate executable memory" at ~450 M insns is the budget (2026-09-13: nine commits shipped with ~20 % of TBs in throwaway modules because nobody ran this) | perf |

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

# baseline once per session.  REBUILD IT FIRST — build/qemu-wasm64 may
# have been left mid-state by the previous session, and an incremental
# build over that produced a 5 %-slow "baseline" on 2026-09-13 that
# faked a win for four invocations (§ Measuring, "phantom win").
bash scripts/ninja-fast.sh
cp -a site/dist-jit site/dist-jit-base            # + dist -> dist-base for qemu-core
node tools/tcgbench.mjs
PORT=8080 node tools/idlebench.mjs dist,dist-jit --quick
PORT=8080 node tools/idlebench.mjs dist-jit-base,dist-jit --quick   # null A/B:
                                                  # today's noise floor + position bias

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

# 5b. BEFORE believing a keep verdict: build both revisions pristinely
#     (own worktree, own build dir — no inherited objects) and re-A/B.
#     Hashes differ between build dirs for identical source (absolute
#     paths are embedded), so identify a dist by behaviour, not hash.
git -C qemu worktree add --detach build/wt-<rev> <rev>
#   configure that worktree into build/qemu-wasm64-<rev> exactly as
#   scripts/build-qemu-wasm64.sh does (it needs EM_PKG_CONFIG_PATH set
#   as well as PKG_CONFIG_PATH — the script only sets the latter and its
#   configure branch is untested), deploy to site/dist-pristine-<rev>
PORT=8080 node tools/idlebench.mjs dist-pristine-old,dist-pristine-new --quick --runs 4

# 6. FINAL GATE before the session's last commit (~6 min): all three
#    fullflashes must boot, native AND in the browser.
node tests/run.mjs --label <name>-final --timeout 240   # s75 el71 c81 ke800
node tools/bootcheck.mjs --dist dist-jit --secs 150     # s75 el71 ke800

# 7. the LG boot benchmark (no icount: tIdle is the number, ~2.5 min/run;
#    a change to timers, the main loop or the halt path needs it)
PORT=8080 node tools/idlebench.mjs dist-jit-base,dist-jit --board ke800 --runs 2 --max 240
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
- **When no speed meter can resolve a change, measure the mechanism
  instead (2026-09-14, 0055).**  `diagall`'s `tbBytes`/`tbGen` give
  emitted bytes per TB with a **0.04 % run-to-run spread** — three
  orders of magnitude tighter than any wall-clock meter here — so a
  codegen change can be shown to do exactly what it claims even when
  every timing meter says flat.  Use it to separate "the change did
  nothing" from "the change did what it said and that does not matter";
  0055 is the second (§ Remaining 0b).  `modBytes`/`modCount` do the
  same for what the browser compiles.
- **idlebench `--quick` can contradict itself, and says so if you let
  it (2026-09-14).**  Running the same pair in both orders gave "+6..8 %
  against the candidate" and then "+6..12 % against the baseline".  The
  tell is in its own output: the same-wasm lines read 12.5 s → 14.3 s
  (**+14 %**) for one dist between back-to-back invocations.  A single
  quick pair cannot resolve anything below ~15 % on this host — rule 5
  exists for exactly this, and the answer when the orders disagree is
  "undecided", never the flattering leg.
- **`insns` at a fixed wall time is bimodal on this boot — do not read
  it at n=2.**  Five runs per dist cluster around ~2440 M and ~2600 M
  for *both* builds; two samples landing in different clusters read as
  a clean +3.5 % that vanishes (to +1.0 % inside ±7.5 %) by n=5.
- **Ask `profjit.mjs` whether guest time is concentrated before
  optimizing guest code.**  On the stopwatch it is not: 25 % of jit
  time in the top 21 functions but 90 % needs 2389, top function 1.5 %
  of total.  That rules out hand-tuning hot TBs and says only uniform
  per-op overhead is worth touching — which is how 0055 was chosen (and
  why it was expected to be small).
- **`ps` `%CPU` is a lifetime average, not an instantaneous one.**  A
  just-finished benchmark's browser shows "54 %" in `ps -eo pcpu` after
  it has already exited; reading that as live contention produced a
  false "every leg leaks a browser" diagnosis on 2026-09-14.  Use
  `top -bn1` (or the `R`/`D` states) for what is running now.  Related:
  `load=` in the stopwatch line rises monotonically across a long A/B
  purely because the 1-minute average accumulates — on a 32-core host
  loadavg 4 is ~12 % utilisation and not contention.
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
- **The baseline dist must be built the same way as the candidate — the
  "phantom win" of 2026-09-13.**  That session's baseline was made the
  usual way: `ninja-fast.sh` on a clean tree at the pinned rev, then
  `cp -a site/dist-jit site/dist-jit-base`.  But `build/qemu-wasm64/`
  had been left mid-state by the *previous* session, so that
  incremental build produced a binary (`61f5d0ad`) roughly **5 %
  slower** than any clean build of the identical source.  Every A/B
  against it inherited the gap: a candidate measured −4 %, −2 %, −6 %,
  −6 % across four invocations **in both orders**, survived a swapped
  repeat, and was committed — and was flat when finally measured
  against a clean baseline.  Both-orders agreement does not detect a
  bad baseline; it only cancels position.
  So: before trusting any keep/revert, rebuild **both** sides the same
  way.  The cheap version is to rebuild the baseline source in the same
  build dir right before the candidate (the incremental build is ~10 s
  and is then symmetrical).  The authoritative version, and what
  decided this one, is a pristine build of each revision:
  `git -C qemu worktree add --detach build/wt-<rev> <rev>` plus its own
  fresh build dir, then `idlebench old,new --quick --runs 4`.  Note the
  hashes then differ between build dirs for the *same* source (the
  build embeds absolute paths), so compare behaviour, not hashes —
  e.g. a known behavioural signature such as the `-accel tcg,tb-size=8`
  SOURCE-CORRUPT control.
- **Run a null A/B first** (`idlebench <base>,<base-copy> --quick`, the
  same bytes in both legs).  It costs one invocation and calibrates two
  things at once: the day's noise floor, and the **positional bias** —
  on 2026-09-13 the leg listed *second* read +2..+3 % slower on every
  milestone with identical bytes.  Without that number, a candidate
  listed second that comes in at −3 % looks like a win and a candidate
  listed second at +3 % looks like a regression, and both are noise.
  This is why rule 5's swapped-order repeat exists; the null run tells
  you how big the swap has to beat.
- **Host load**: loadavg is not namespaced — interleave, never trust
  absolutes across time; on 2026-09-13 the *same bytes* moved 14 %
  between two invocations an hour apart as the host quietened from
  loadavg 5 to 2; a "flat" result on a noisy host can mean the
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
| 0077 icount: the real-time cap switches banked -> strict after `<n>` guest seconds (`QEMU_ICOUNT_RTCAP=banked:<n>`, wasm default `banked:30`) | `banked` lets a boot that fell behind catch up as fast as it can - and lets any *later* stall (a backgrounded tab, a host hiccup) be repaid the same way, by sprinting the phone's clock and animations.  So bank only for the boot: `banked` until the guest has run `<n>` seconds of its own clock, then re-anchor on lag forever.  Guest time, not wall time - the boot costs ~42 s of virtual time on every host but 39 s to minutes of wall, so a wall window would expire mid-boot on exactly the slow machines banked protects; it is also one compare against a constant on a path already handed a virtual-time value (no clock read) and is not consumed by a pause.  No re-anchor at the switch: `excess_strict <= excess_banked` always, so the flip can only shorten a sleep.  Plain `banked`/`strict` stay pinned, so the ladder above and every historical A/B keep their meaning; `RT=ship` is the new idlebench leg that takes the page's own default.  Page side: the pill's `slow` warning is suppressed while banking (v/wall is below 1 there by construction), and the HUD's `lag` re-anchors at the switch because strict forgives the debt rather than paying it back | switch lands at wall ~30.7 s with v=30.2 s, i.e. the guest is already pinned at the cap (it spent its bank through the display-DMA warp stretch: v 4.2 -> 30.2 in ten seconds, v/wall 2.58), so the flip is the no-op case and tIdle is unmoved; v/wall settles at 1.00 after it.  The boot no longer reads "Booting - slow" |
| 0033 pmb887x: RTC `CNT` seed layout per board (`cnt-format`) | the pinned rev seeds `CNT` as a packed calendar (sec/min/hour/yday fields, 964/4/40 reloads); LG firmware reads those fields, Siemens firmware treats `CNT` as one linear Unix-seconds counter (+ its own time-zone setting), so the packed value decoded to "Wed 02 May 2091" and each minute wrap (0x3FF → 0x7C4 = +965) jumped the shown clock +16 min.  Not wasm- or warp-related: identical on the pristine native build.  Board config `[rtc] format` (default unix; the LG configs set calendar — upstream in bsp `e6e73d1`); both honour `-rtc base=` | native S75 "Пт 11 Сен 21:22" / C81 "11.09.2026 20:22" / KE800 unchanged "17:20 11/9"; wasm dist-jit 21:23 → 21:24 over 60 s, dist 21:26 → 21:27 over 40 s (was 15:39 → 15:55 over 40 s); no perf change |
| 0039 pmb887x: display path per-word costs | a redrawing J2ME app (the stopwatch, ~57 fps) pushes every LCD word through DIF FIFO → DMAC request → VIC; that chain was 44 % of the vCPU: `vic_update_state` scanned all 170 lines on every level change (now an asserted bitmap + unchanged-level no-op), the DIF re-drove 6 GPIO pins per FIFO word and 8 DMAC request lines per event (level caches; every consumer is level-idempotent), `dif_mux` was a 32-iteration bit loop per word (byte-lane tables), DMAC read a memory source word by word (burst read once), `srb_set_isr` tested 32 bits.  Plus `-Dqom_cast_debug=false` for the wasm64 build (`OBJECT_CHECK` asserted per FIFO word) | `tools/stopwatch.mjs` vratio **0.19 → 0.33** (25 → 41 MIPS); QOM casts off: boot −3..−5 % every milestone, both orders; op-suite 1156/1156, native 4/4, bootcheck s75/el71/ke800, lockstep 250e6 |
| 0040 cputlb: fill-time TLB growth | QEMU's dynamic TLB resizes only at flush time; a phase with no flushes (the JVM: ARMv5 1 KB pages, ~6.2k-page working set) sat at 256 entries at 83k fills/s.  `tlb_set_page_full` doubles the table when fills since the last flush exceed 2× its size (cap 2^14); trap: index `f[]` through `cpu_tlb_fast()` (mmuidx_to_fast_index), not by mmu_idx | fills 83k/s → 35/s, table → 16384; boot (both orders, with 0039): t0.1G −18..−20 %, t0.5G −2..−3 %, t1.3G −1..−3 % |
| 0041 wasm diag: lookup / fill / flush / halt counters | cold counters behind `wasm_memstat`: tb_lookup calls, jump-cache/qht hits, jump-cache flushes, table clears, fill classification, halts — read by `tools/memstat.mjs` / `tools/stopwatch.mjs` | zero hot-path cost; decided 0039/0040 (78 M lookups per boot at 92 % jc hits; 83k fills/s with 0 flushes; halts/s = 0 in the stopwatch) |
| 0042 wasm diag: warp / module-economy / range-flush counters + compaction knobs | cold counters for the idle warp (ns + 7 size buckets), bytes handed to `WebAssembly.Module` split by assemble source (first close / compaction / re-ensure), emitted TB body bytes, and `tlb_flush_phys_ranges` calls/entries/drops; `W64_COMPACT_BATCHES`/`W64_COMPACT_MEMBERS` promoted from `#define` to env knobs | zero hot-path cost; decided 0043 and produced the module-economy and virtual-time numbers below |
| 0043 cputlb: physical-address summary for the range flush | 0016's topology-commit flush finds its victims by walking every entry of every mmu_idx; 0040 grew the table 256 → 16384, so each romd flip streamed 512 KB of table.  Per mmu_idx keep a 64-bit mask of the 32 MB physical blocks its entries translate into, one per 64-entry group plus an OR over groups and the victim table; a commit ANDs the requested blocks against it and skips whole tables and groups.  Masks are conservative (added on fill and victim promotion) and rewritten exactly by any commit that walks the group, so staleness self-heals.  Block size must divide the reported ranges — 64 MB blocks lumped the two 32 MB flash banks together and only got 280M → 107M | entries walked per boot **280,759,680 → 1,179,712 (237×)**, 1.16 groups walked per commit, entries dropped **22,007 → 22,007 (identical)**; boot effect on its own **FLAT** (t1.3G 29.7 vs 29.8, both orders) — the walk is a predictable streaming scan at ~0.3 ns/entry.  Kept for the scaling property and as part of the 0043–0045 stack |
| 0044 accel/tcg: devirtualise the TB-lookup helper on wasm | `helper_lookup_tb_ptr` runs per indirect jump (78 M/boot, 2.9 M/s, ~10 % of the vCPU) and reached `get_tb_cpu_state` through `cpu->cc->tcg_ops` — a wasm `call_indirect` — and `curr_cflags()` through a cross-TU call whose four debug-only conditions cannot be true in a browser build.  Both folded away under `__EMSCRIPTEN__`.  NOT the rejected per-TB inline cache: the key is still computed once, in the helper.  **Correction (2026-09-13, 0046): the `get_tb_cpu_state` half was guarded by `CONFIG_TARGET_ARM`, a macro no build defines, so it was never compiled in; measured on its own once switched on it is flat (−1..+2 %).  The numbers in the next column belong to the 0043–0045 stack, i.e. to `curr_cflags_fast` and 0045** | stack 0043–0045, interleaved `--runs 4`: window 14.2 → 13.7 s (−4 %), t0.5G 21.8 → 21.4 (−2 %), t0.75G 27.1 → 26.4 (−3 %), t1G −2 %, t1.3G −1 %; −2 % on t0.5G in both orders of two `--quick` pairs; helper self time 7.3 % → 6.5 % |
| 0045 target/arm: hflags rebuild on a CPSR write only when it can change them | upstream rebuilds unconditionally with a TODO saying not all cpsr bits matter; they do not, and 0027 made `msr CPSR_*` the boot's most frequent TB exit — those writes set I/F and the condition flags.  Every CPSR field hflags reads (mode → EL/mmu_idx/sctlr, E, IL, PAN) lives in `uncached_cpsr`; everything in `CACHED_CPSR_BITS` lives in dedicated env fields and is not an hflags input, so an unchanged `uncached_cpsr` means unchanged hflags | verified with a temporary build that recomputed and compared on every skip: **2,125,612 skips, 0 mismatches** over a full boot; ~2.1 M rebuilds saved (~0.2–0.4 s); measured as part of the 0043–0045 stack |

| 2026-09-13 prologue cleanup (`58bb2742`) | the shipped TB prologue carried two RMWs of the `wasm_tb_stats` diagnostic counters and a lockstep-armed test per TB entry (~5 M/s) plus a `w64_chain_stop` load per chained jump — ~70 of ~560 bytes per TB module.  Under icount `wasm_insns()` now derives the count from the icount state (exact), the counters are emitted only on non-icount boards or with `W64_TBSTATS=1`, and the lockstep probes only in a `W64_LOCKSTEP` process; `W64_NOACCTINLINE` is gone | **flat**: quick pairs −6 %/−1 % window, −7 %/−2 % t0.5G; full `--runs 2` pair +0 % tIdle, +3 % window, +3 % t0.5G, +1 % t1.3G; rt=banked quick −3 %/0 %.  Landed as a simplification (W-19), not as a win — the per-TB counters were cheaper than their byte count suggested |
| 2026-09-13 W-12 BLX speculation fix (`58f6f9c5`) | `trans_BLX_i`'s `gen_jmp` recorded the mode-switching target as a speculation successor; the wasm64 backend translated it with the caller's flags and the ARM translator emitted a PC-alignment-abort TB that a chained jump then ran → EL71 `Prefetch_Abort` in ~45 % of second-page boots.  `translator_unnote_succ()` withdraws the hint | correctness: 8/8 reproducer passes with the abort dump armed (`QEMU_LOG_PABT=1`) vs 5/11 failures before; no perf change expected (fewer dead speculated TBs) |
| 2026-09-13 batcher SOURCE-CORRUPT fix (`bf0b67d4`) | § Remaining 4, root-caused from the forensic dump: `encode_search()` overflowing the region highwater does `goto buffer_overflow` **without advancing `code_gen_ptr`**, after `tcg_gen_code()` already staged the module body in the open batch, so the next `tcg_tb_alloc()` carves `TranslationBlock`s out of the staged bytes (the dump showed seven, at the 192-byte `sizeof(TranslationBlock)` stride).  `w64_batch_unstage()` withdraws the member; the staged-source check is now shared with `w64_batch_ensure()`, which re-assembled evicted batches with no validation at all | positive control (`-accel tcg,tb-size=8` forces region overflows): **5 dropped batches per 60 s → 0**, same guest progress.  Stock rate was 1–2 per 60 s boot, not the "once in 285 s" the hand-off recorded.  Correctness only; no perf claim |
| 0046 wasm64: inline next-TB lookup cache on goto_ptr exits (+ 0044 actually switched on) | every `bx lr` / `pop {pc}` / `ldr pc` / `msr CPSR` ends in `helper_lookup_tb_ptr` (~130 M per boot, 2.75 M/s in the J2ME stopwatch).  The ARM translator now gives each TB's goto_ptr exit a slot in the TB (`w64_lc`: pc, generation, hflags/thumb/condexec words, target descriptor) and emits a test of only the words that can differ at that exit: pc, `cpu->neg.tb_key_gen` and thumb after a `gen_bx` — hflags cannot change without ending the TB, so they and condexec are **stamped statically by the translator** and checked once at fill time by `helper_lookup_tb_ptr_lc`; only an exit after a CPSR write compares all three.  The generation moves on every jump-cache invalidation (flush, page clear, TB invalidate) and on the rare key inputs nobody compares (hflags.flags2, FPSCR.Len/Stride, FPEXC.EN).  `W64_LC_VERIFY=1` routes every exit through the helper and cross-checks each would-be hit against the real lookup; `W64_NOLC=1` is the knob A/B.  **Found on the way**: 0044's `#if defined(CONFIG_TARGET_ARM)` guarded a macro no build defines (accel/tcg is target-independent, `TARGET_ARM` is poisoned there) — the devirtualised lookup was never compiled in until this patch keyed it on `CONFIG_TCG_WASM64` | verify: **101.3 M would-hits of 124.1 M helper calls (82 %), 0 mismatches** over a 40 s boot; normal: helper calls 26.1 M of ~126 M lookups, `keyGen` 1458 (= the jump-cache flushes).  **J2ME stopwatch vratio 0.328/0.329 → 0.350/0.358 (+7..+9 %, 40.9/41.1 → 43.7/44.7 MIPS), 4 alternating samples**, helper lookups 2.75 M/s → 0.43 M/s.  **Boot milestones flat**: `--quick --runs 2` both orders, the second-listed leg reads +3..+5 % slower whichever build it is (pair A jit second: t0.5G +5, t1.3G +4; pair B base second: every milestone −5 % for jit); three-leg runs with the `W64_NOLC=1` leg say the same, and the devirtualisation on its own is −1..+2 % (flat).  Emitted TB bytes 106.5 → 101.5 MB.  Gates: op-suite 1156/1156 ×2 identical, native 4/4, lockstep 250e6, bootcheck s75/el71/ke800 |
| 0047 pmb887x: DIF v2 lazy mux tables, DMAC in-callback re-arm, one-bit DMA acks | the J2ME stopwatch profile after 0046 (`tools/wprof2.mjs` attached to `stopwatch.mjs --devtools`): devices 46 % of the vCPU, guest code 30 %, top symbol `dif_update_mux` **12.7 %** — the DIF v2 rebuilt its byte-lane mux tables (0039's, 2 × 4 × 256 evaluations of the 32-bit mux) on every BMREG/BCSEL/BCREG/INVERT_BIT write, and the firmware writes those per LCD command.  Now a write that changes the register only marks the tables dirty, `dif_mux()` rebuilds on the next word (370 rebuilds/s), and the builder walks the 32 output bits once.  Same path, per word (the display DMA is one 4-byte word per request, ~500 k/s): `dmac_schedule` re-armed the DMAC timer from inside its own callback on every acknowledgement (`timer_mod` → deadline → `icount_get`, ~3 %) — a request raised while the loop runs now only sets the flag; the DIF's DMA-clear handler cleared all four request bits per ack and each already-clear bit re-ran the event handler — only the raised bits are cleared; `srb_set_icr` walks set bits like `set_isr` | `tools/stopwatch.mjs` alternating: vratio **0.360/0.333 → 0.482/0.533 (+34..+60 %)**, 45/41.6 → 60/66.6 MIPS; boot flat (`--quick --runs 2` both orders: one order −1..−4 %, the other +4..+8 % with one outlier run; the four t1.3G readings overlap the baseline's); op-suite 1156/1156, native 4/4, lockstep 250e6 clean against the *pre-change* native oracle, bootcheck s75/el71/ke800 |
| 0048 pmb887x: DMAC translation windows, VIC parent-line cache, `memory_region_topology_gen()` | after 0047 the stopwatch profile read guest 39 %, devices 33 %, memory API 10 %, top symbol `dmac_transfer_memory` — the display DMA is one 4-byte word per request (~475 k/s) and each word walked the flatview twice (`address_space_read` of its RAM source word, `address_space_write` to the FIFO).  Each channel now keeps a translated window for source and destination, keyed on a new memory-core counter that bumps on every committed transaction that installed flatviews (romd-only ones included); a RAM window is read through the host pointer, an MMIO window dispatches with the same `memory_access_size`/`prepare_mmio_access`/`memory_region_dispatch_write` step the API takes, RAM destinations keep the API for dirty tracking.  The window is the flat range (`memory_region_find`), not one access: the firmware walks the DIF's 16 KB FIFO window with an incrementing destination, and the first cut refilled on every word (`dmacXlatFill` = burst rate).  Second item: the DIF's TX request line is masked at the VIC but toggled twice per word, and every toggle re-drove the CPU line — `arm_cpu_set_irq` → `cpu_interrupt` forces the TB loop out per call; the VIC now drives the CPU lines only on a level change (0027's `cpsr_write_check_irq` re-checks on unmask, so nothing relied on the repeats).  Plus the DIF pin table's dead `name[32]` | `tools/stopwatch.mjs`, two alternating pairs: **0.503/0.514 & 0.489/0.498 vs 0.497/0.457 & 0.453/0.424** (≈ +9 %, host load moving between runs); `dmacXlatFill` 0/s in steady state (306 per boot).  Boot: **flat within a loaded host** — two both-order `--quick --runs 2` pairs under load 6–13 from other sessions (19 GB swapped) disagree in sign (+2..+9 % slower, then −4..−5 % faster / +2..+4 % slower), while 40 s counter samples show the new build warping 13 % more virtual time and moving 6 % more DMA words in the same wall time with identical per-work ratios.  Gates: op-suite 1156/1156 native JIT + TCI identical, native 4/4, lockstep 250e6 clean vs the pre-0047 oracle, bootcheck s75/el71 PASS (ke800: the pre-existing first-page stall, § Remaining 8) |

| 0049 pmb887x: GPTU T0/T1 QEMU timer armed for observable overflows only | the ke800 first-page "stall" (§ Remaining 8): the LG firmware chains GPTU T1A..T1D into one 32-bit timer clocked at 26 MHz (T1A bypass, B/C/D concatenated, reload from the top byte, SR10 on the T1D overflow) and the model armed its QEMU timer at every **8-bit overflow of the free-running byte** — ~100 k main-loop callbacks per second on wall time (no icount), each ~10 µs of `emscripten_get_now` and friends in wasm and each under the BQL.  Profile of the stalled page: main-loop worker 100 % busy (`_emscripten_get_now` 37 %, `futex_wake` 9 %, `gptu_t2_sync_timer`, `gptu_t01_add_ticks`, `timer_mod_ns`), vCPU worker 94 % `futex_wait`, guest ~40 k insns/s.  Now `gptu_sync_timer` walks the carry tree of each free-running timer (`gptu_t01_ticks_to_boundary`): the sync steps to each overflow that *reloads other timers* (the interval after it counts from the reloaded values — everything else `gptu_t01_add_ticks` reproduces exactly from an overflow count, output toggles included, by parity) and the QEMU timer is armed only for the next overflow somebody can *observe* — a service request, or a T2 trigger that T2 is actually listening to (reload/capture mode or a masked RLCP event).  Counter `gptuTimer` (QEMU-timer callbacks, T01 + T2) | **ke800 booted alone: idle screen at tIdle 64–77 s** (cold page, host load 2–8; native 31 s), insns@idle 1.8–2.0 G, where 0048 crawled: `idlebench --board ke800 dist-jit-0048` NOIDLE at 420 s, t1G 255.6 s / t1.5G 377.5 s (0049: 44.5 / 64.4 s), and the plain bootcheck page sat at 590 M for 300 s.  Native ke800 timeline unchanged (logo 18 s, idle 31 s).  **S75 boot −4..−5 % in both orders** (`--quick --runs 2`: pair A t0.5G 22.5→21.7, t1.3G 29.6→28.3; pair B 0049 listed first, t1.3G 33→31.3, every milestone in the same direction) — the storm taxed the icount boot too.  Gates: native 4/4, op-suite 1156/1156 JIT + TCI identical, lockstep 250e6 clean vs the 0049 native oracle, bootcheck s75 1717 M / el71 1608 M / ke800 1945 M (≥ 1.5 G) |

| 0050 pmb887x: no 16 KB zero-fill per DMA word, no checked casts per LCD byte | the J2ME stopwatch profile on 0049 (`prof-stopwatch-0049`, 20 s): guest code 46 %, devices 34 %, other 8 %, lookup 4 %, memory 3.5 %; top device symbol `dmac_transfer_memory` **7.5 % self time for moving one 4-byte word** — QEMU's meson adds `-ftrivial-auto-var-init=zero` and the function's `uint8_t buffer[16 * 1024]` was cleared on every call (`memory.fill 16384` in the wasm asm, ~480 k × 16 KB per second, ~150 ns per word on this host).  `QEMU_UNINITIALIZED` on the buffer (every path writes the bytes it reads).  Second: `object_dynamic_cast_assert` 1.7 % — `SSI_PERIPHERAL()` in `ssi_transfer` and `PMB887X_LCD()` in `lcd_transfer` run per LCD byte and still call the assert for its trace point with `qom_cast_debug=false`; both are plain casts now (the bus type and the class guarantee the type) | `tools/stopwatch.mjs`, four pairs both orders: **0.542/0.545/0.541/0.547 vs 0.483/0.533/0.509/0.458** (new build ahead in every pair, +2..+19 %, means 0.544 vs 0.496 = **+10 %**; the profile share predicted ~+7 %; note the old build's spread is 5× wider — a 16 KB memset per word is sensitive to whatever else the host runs, which is also why this meter drifted with load in earlier rounds).  **Boot flat**: `--quick --runs 2` both orders read the *second-listed* leg 2–4 % faster whichever build it is (pair A 0049 first: t1.3G 29.5 → 28.3; pair B 0050 first: 29.6 vs 28.3) — the boot moves few display words, so nothing was expected.  Gates: native 4/4, lockstep 250e6 clean vs the 0050 native oracle, bootcheck s75 1718 M / el71 1608 M / ke800 1988 M.  **The phone question, answered on the desktop** (no `/dev/kvm` in the container, so no Android emulator): the running app is one busy thread (vCPU worker 98 %, page thread 3.5 %, main-loop worker 2.3 %; the S75 boot reaches idle at 40–41 s whether Chrome has 32 cores or is pinned to one), so a Pixel's single big core is the whole budget; V8's tier is not the gap (`--no-liftoff` = TurboFan only: stopwatch +3 %, boot 75 s instead of 40; `--liftoff-only` = baseline only: boot 54 s, +35 %, and the keypad navigation then drops presses — `--no-wasm-tier-up` is a no-op in Chrome 153); `?hud=1` puts MIPS / v/wall / lag on the page so the device can report its own number |
| 0051 pmb887x: DIF pin rebuild skipped on unchanged inputs, FIFO index without modulo, no checked bus cast per SSI transfer | the stopwatch profile of 0050 (`prof-stopwatch-0050`): guest 48 %, devices 32 %, other 7 %; the checked casts were not all gone — `BUS()` in `ssi_transfer` still called `object_dynamic_cast_assert` once per LCD byte (119 ms/20 s, attributed to `dif_tx_from_fifo` by the profiler); `dif_update_gpio_state` runs twice per word (tx_csreg active/inactive) and rebuilt six pin levels from unchanged inputs (235 ms); `pmb887x_fifo_base_push/pop` took a modulo per index step.  Plain cast, an input key that skips the pin pass, compare-and-wrap.  **Tried and dropped**: the same key on `dif_trigger_dma` — it blanked the Siemens displays (the function re-enters itself through the DMAC's CLR handler; the outer pass finished with stale levels after the nested pass had stored the fresh key — the native suite caught it) and, once guarded, the profile showed it never hits (self 299 → 462 ms: the inputs differ on every call of a word's raise/acknowledge/release sequence) | profile candidate vs 0050: **"other" 1416 → 1056 ms** of 20.3 s, `dif_update_gpio_state` 235 → 142, the cast gone, cpu-loop+devices flat (6435 → 6391).  `tools/stopwatch.mjs`: loaded host three candidate legs 0.547/0.554/0.540 vs 0050 0.486/0.530 (two 0050 legs failed at app navigation under load — a flake, the same snapshot then ran); quiet pair after the gates **0.584 vs 0.562 (+4 %)**.  The meter's ±5 % drift cannot resolve a change this size; the profile deltas are the evidence.  Gates: native 4/4, lockstep 250e6 clean vs the 0051 native oracle, bootcheck s75 1717 M / el71 1608 M / ke800 2030 M |
| 0052 tcg/wasm64: labels as nested blocks instead of the dispatch loop | the per-TB structure, sized first: the stopwatch does ~17 M TB entries/s (4.24 insns/TB with `EXTRA_Q="env=W64_TBSTATS=1"`, 73.6 MIPS), i.e. ~28 ns per TB entry of which the guest's four instructions are only part; a native `-d op_opt` dump of 25 s of S75 boot: 132 k TBs, 4.0 insns / 26 ops / 1.5 labels per TB, 200 k `brcond`, **0 backward branches**, max 54 labels in one TB.  Every TB body was a `loop` around sibling `if (bp <= k)` regions (a branch set `$bp` and re-entered the loop; each label cost a compare on fall-through; V8 adds a loop stack check and loop phis for every live local — the likely reason the `$tlb` hoist regressed).  Now `w64_scan_labels` numbers the labels at TB start and, when no branch is backward, opens them as nested blocks (last label outermost); `set_label` closes the innermost, `br`/`brcond` become `br`/`br_if depth`.  A backward branch keeps the loop scheme.  `W64_MAX_BLK` 32 → 128 | `tools/stopwatch.mjs` quiet host: **0.603 / 0.628 / 0.605 / 0.592 vs 0051 0.584 / 0.589 / 0.582 (+3.5 %)**, every new leg above every old one (a 0051 leg under a load spike read 0.523).  Profile 20 s: jit-guest 50.9 → 49.5 %, cpu-loop+devices 31.4 → 31.6 % (flat), tb-lookup 4.5 → 4.8.  Boot: bootcheck s75 1718 M / el71 1608 M / ke800 2242 M (0051: 1717 / 1608 / 2030); idlebench `--runs 2` both orders tIdle 28.2/29.8 (−5 %) with the new build second, 29.1/29.9 (+3 %) with it first — the usual order bias, boot flat.  Gates: lockstep 250e6 identical vs the native oracle, op-suite 1156/1156.  wasm +1.6 KB.  **Not gated on Firefox — see 0053** |
| 0053 tcg/wasm64: open the batch at TB start (Firefox module budget) | Firefox on the Pixel stalled at the Siemens logo (0.76 G insns, MIPS 0); local Playwright Firefox reproduced it on every snapshot back to 0046 ("failed to allocate executable memory for module", the vCPU worker dies at ~450 M insns) while 0022 booted.  Six bisect builds (the first two were invalid — pre-AFE, the Siemens boot never reaches the phase) pinned it to the prologue cleanup `58bb2742` (2026-09-13 review session, "measured flat").  Mechanism: the open batch is created lazily inside `w64_union_type`; until the cleanup every prologue registered a lockstep import type, which opened a batch as a side effect.  After it, a TB translated right after a batch close — no helper call, so no type registration — was never staged and ran from a throwaway per-TB module: Firefox counters at the crash read modules 27.6 k vs closes + compactions 21.8 k (5.9 k temp modules, ~20 % of TBs), the good build 27.4 k vs 27.4 k.  Temp modules are never evicted, so Firefox's ~16 k-module budget runs out; Chrome has no such budget and never showed it.  Fix: `w64_batch_begin_tb()` at `tcg_out_tb_start` opens the batch explicitly; `ffboot.mjs` now prints `temp=` so the invariant is visible | Firefox: boots to idle again (v 58.9 at 60 s, 1.62 G insns, `temp=0`, errors 0).  Chrome: lockstep 250e6 identical, op-suite 1156/1156, bootcheck s75 1718 M / el71 1608 M / ke800 2408 M.  Stopwatch 0.605 vs 0052 0.596 (flat).  idlebench `--runs 2` both orders: tIdle **28.6 vs 29.6 (−3 %) with the fix listed second, 28.7 vs 29.5 (−3 %) listed first** — faster in both orders, against the order bias: a temp module is a `Module` compile per TB |
| 0054 memory/pmb887x: MMIO write dispatch decision cached per DMAC window | after 0053 the stopwatch profile read guest 47.2 %, devices 33.8 %, memory 4.2 %, other 5.8 %.  The display DMA is one 4-byte word per request (~570 k/s) and 0048's translation window already keeps it off the flatview, but every word still paid `memory_region_dispatch_write`'s own per-access work for a window that had not changed: alias resolution, `memory_region_access_valid`, the endianness-swap test, the ioeventfd match, and `access_with_adjusted_size`'s split loop with its MAX/MIN/mask/shift arithmetic (`access_with_adjusted_size` 270 ms + `memory_access_size` 92 ms of 20.3 s).  Whether all of it can be skipped depends only on the region and the width, so `memory_region_write_direct_ok()` decides it once per window and `memory_region_dispatch_write_direct()` runs the tail — reentrancy guard, trace point and the device's write callback all kept, since all three are observable.  The DMAC caches the predicate in `pmb887x_dmac_xlat_t` (cleared on refill) and checks only the per-access alignment; whatever the predicate rejects falls through to the unchanged path.  **Closed by inspection on the way** (§ Remaining 7): a same-batch direct `return_call` for chained TBs is not possible as written — the chain slot is patched by `tb_add_jump` at runtime, long after the module is compiled, so the target is unknown at emission; and the per-exit `fidx` load is not removable, because `w64_batch_evict_oldest()` makes eviction real even though a boot shows `ensureN 0` | profile: `access_with_adjusted_size` and `memory_access_size` **gone from the profile entirely**, memory 4.2 → 3.5 %, other 5.8 → 4.1 %, the freed share moving to guest code (47.2 → 49.0 %) — ~2.1 points of non-guest work.  **Both end-to-end meters read flat**, as in 0051: stopwatch 10 alternating samples, candidate mean 0.601 (0.618/0.563/0.604/0.608/0.612) vs 0.593 (0.635/0.603/0.578/0.536/0.612) inside a baseline spread of 0.536–0.635; idlebench `--runs 2` both orders puts the *second-listed* leg 4–6 % slower whichever build it is (the order bias), so the boot is flat.  Gates: op-suite 1156/1156 three backends identical, native 4/4 displays PASS, lockstep 250e6 identical, bootcheck s75 1718 M / el71 1608 M / ke800 2198 M, Firefox boot `temp=0` errors=0 |
| 0055 tcg/wasm64: `local.tee` for set+get pairs, no scratch local in the TLB probe | picked from the 0054 profile by asking where the *uniform* cost is rather than the biggest symbol: `tools/profjit.mjs` says guest time is smeared (25 % of jit time in the top 21 functions, 50 % in 272, 90 % needs 2389, top function 1.5 % of total), so there is no hot TB to hand-tune and only per-op overhead is worth touching.  The emitter wrote `local.set $x; local.get $x` in eight places — that is what `local.tee` is for — and the inline probe additionally round-tripped `tlb_addr` through `$scr1` although nothing reads it after the compare.  The probe runs on **every** guest memory access (`qemu_ld/st` = 37 % of emitted bytes) and drops from seven local ops to three; `tcg_out_goto_tb` and `tcg_out_goto_ptr` lose one each at ~17 M TB entries/s.  Net −3 lines | **mechanism proven, speed flat.**  `diagall` 45 s boot, 2 runs per dist, run-to-run spread **0.04 %**: emitted bytes per TB 530.6 → 511.0 (**−3.7 %**), `modBytes` 194.2 → 189.1 MB (−2.6 %).  Speed: idlebench `--quick` **contradicts itself** in the two orders (the same wasm read 12.5 s then 14.3 s, +14 %); stopwatch 10 ABBA legs 0.545 vs 0.535 with per-pair ratios +9.2/+1.3/+22/−16.7/−6.7 %; insns at a fixed 45 s wall time, 5 runs each, 2550 vs 2524 M (+1.0 %) inside a ±7.5 % spread on both sides (an n=2 read of +3.5 % did not survive n=5 — the samples are bimodal at ~2440 and ~2600 for *both* dists).  Landed as a simplification on the byte evidence, not as a speed win.  Gates: op-suite 1156/1156 three backends byte-identical, native 4/4 displays PASS, lockstep 250e6 serial + 29 SRAM digests + 20 SDRAM + 20 epoch reg sets identical, Firefox idle `temp=0` errors=0 |
| 0056 accel/tcg: io-barrier set no longer thrashes | the LG boards run `icount=none`, so **every** mid-TB MMIO access takes the stock `cpu_io_recompile()`: JS-exception unwind + `tb_phys_invalidate` (a full jump-cache flush — the TB is CF_PCREL) + retranslation + a fresh `WebAssembly.Module`.  The io-barrier set (0014) exists to make that once-per-insn, but it was 64 slots, direct-mapped on `(pc >> 2)` — two hot MMIO insns in one slot evict each other every pass, so neither is ever kept out of the middle of a TB and the recompile repeats forever.  The KE800 sat at ~800 recompiles/s at a standing idle screen with the same ~800 retranslations, jump-cache flushes and modules per second, which capped it at ~1 MIPS whenever it had work.  Now indexed by `(pc >> 1)` (Thumb insns are 2 bytes apart; `>> 2` aliased every adjacent pair), 4096 slots × 2 ways; `W64_IO_BARRIERS=<n>` caps the usable slots for a same-wasm A/B.  New counters `ioRecomp` / `ioBarrierEvict` / `ioBarrierSplit` — the existing `ioRewind` counted only the ROM-device branch, so this whole path was invisible | `uibench --board ke800 --state menu`, two interleaved pairs vs 0055: **MIPS 42.6 / 25.1 vs 1.3 / 1.8, fps 9.8 / 4.9 vs 0.0 / 0.0**, `tbGen/s` 56 / 505 vs 836 / 750, `mod/s` 22 / 85 vs 816 / 697, `jcFlush/s` 1 vs ~800.  fps 0 is not a slow UI — on 0055 the menu key does nothing at all.  `ioRecomp` 1/s after, `barrierEvict` 0/s.  The idle screen is ~1 MIPS on both (an idle LG guest is halted; that number was never the churn).  Gates: op-suite 1156/1156 JIT+TCI identical, native 4/4, lockstep 250e6 identical, bootcheck s75/el71/ke800 PASS, Firefox `temp=0` errors=0 |
| 0057 accel/tcg + memory: subpage MMIO dispatch resolved at TLB fill | a page shared by several regions is represented by a *subpage container*, and the TLB fills with the container (its translate passes `resolve_subpage = false`).  The container re-enters the flatview per access (`subpage_read` → `address_space_read` → translate + validity walk + dispatch) **and** its `valid.accepts` callback stops `tlb_resolve_io_dispatch()` from installing any direct call — two translations and two dispatches per access.  Every pmb887x device under the 1 KB page is one: STM `0x30`, GPTU `0x100`, SCU `0x200`, VIC `0x2d8`.  The EL71 polls the STM and spent ~22 % of its vCPU there (`subpage_read`, `subpage_accepts`, `flatview_read`, `flatview_read_continue_step`, `flatview_translate`, `flatview_access_valid`, `address_space_translate_internal`, `memory_region_dispatch_read`, `memory_region_access_valid`, `access_with_adjusted_size`, both read accessors) — none of which the S75 profile shows, because its hot register is in the TPU (`0x2000`, whole pages).  `memory_region_subpage_leaf()` resolves one level and reports the run of offsets that share the leaf; `tlb_set_page_full()` resolves the leaf's direct dispatch for the faulting offset and records the run plus an offset delta, and the access path adds the delta and range-checks (a leaf entry gets `io_lo = 0`, `io_len = UINT32_MAX`, delta 0, so the check always passes).  Anything outside the run keeps the container's stock path | `uibench --state menu`, two interleaved pairs per board vs 0055 (shared host, external load 8–11): **EL71 v/wall 7.29 / 7.14 vs 6.51 / 6.59 (+10 %)**, MIPS +10/+12 %; **S75 MIPS 29.1 / 30.8 vs 24.6 / 24.4 (+22 %)**; S75 J2ME stopwatch vratio 0.363 / 0.479 vs 0.332 / 0.355 (+9 / +35 %, noisy under that load).  Mechanism: every symbol listed opposite is **gone** from the EL71 vCPU profile, `int_ld_mmio_beN` grows 1.8 → 4.1 % (it now does the dispatch) and `stm_io_read` is unchanged at 1.5 %.  Gates: as 0056 |
| 0058 accel/tcg + system: the icount seqlock is no longer paid twice per MMIO access | a guest that polls a device register reaches `io_prepare()` with `can_do_io` false on every access, and the stock-icount branch committed the running slice with `icount_update()` before dispatching.  That commit is redundant — `icount_get_raw_locked()` calls `icount_update_locked()` itself on every virtual-clock read, so a callback that reads the clock gets the identical value either way — and it is the expensive half, because `icount_update()` publishes under the vm_clock seqlock *write* lock: a spinlock acquire plus the write-side barriers, on a line every other thread reads.  Keep `can_do_io` (without it `icount_get_raw_locked()` aborts with "Bad icount read"), drop the commit.  Also calls the virtual-clock hooks directly in `cpus_get_virtual_clock()` instead of through `cpus_accel` | EL71 busy state (driven menu, 700 ms key period): `io_prepare` **7.1 % → 0.9 %** of the vCPU worker, `cpus_get_virtual_clock` 1.4 % → 0.7 %, v/wall 3.93 / 4.04 → 4.30.  Flat on the *free-running* menu state, which is not MMIO-bound — this is why the busy state is the one to measure |
| 0059 accel/tcg: fused single-piece MMIO **load** dispatch | the route from a guest load to a device callback is six frames that re-derive from each other (`do_ldN_mmu` → `mmu_lookup`/`mmu_lookup1` → `do_ld_N` → `do_ld_mmio_beN` → `io_prepare` → `int_ld_mmio_beN`), taken 1.2 M/s on the EL71 and 4.0 M/s on the S75.  Every one of those accesses has the same shape: TLB hit on an I/O entry whose dispatch `tlb_set_page_full()` already resolved (0054/0057), naturally aligned, one page, `TLB_MMIO` as its only slow flag.  `do_ld_mmio_1p()` does that shape in one frame; anything else returns false and takes the generic path unchanged.  `io_prepare()`'s rare `!can_do_io` half is split out (`io_open_clock_window`) and must stay ahead of the BQL guard, because `cpu_io_recompile()` longjmps and would leak the lock | new counter `ioLdFast` says the fused path takes **99.1 %** of MMIO loads.  EL71 busy, interleaved vs 0058, two pairs: MIPS 49.1 / 50.1 vs 45.7 / 47.1 (**+6.9 %**), fps 6.4 / 5.6 vs 4.2 / 4.3 (**+41 %**), v/wall +3.6 % — and it wins carrying two counter increments the baseline does not have |
| 0060 cpu-timers: `timers_state.qemu_icount` on its own cache line | `icount_get_raw_locked()` commits the running slice on every virtual-clock read, so a polling guest writes that field 1.5 M/s (EL71) to 4.5 M/s (S75), and every other `TimersState` field is read by other threads — the seqlock and spin lock above all, since that is how any thread reads a clock.  An emscripten microbenchmark of the exact shape: **2.2 ns/iter alone, 52 ns/iter with one reader on another core, 0.5 ns/iter read-only** — which is the ~50 ns/call the profiler attributes to `icount_get`.  56 bytes of padding, no semantic change | S75 driven menu (the highest clock-read rate, 4.5 M/s), three interleaved pairs: MIPS 53.2 / 54.2 / 55.2 vs 50.6 / 52.3 / 51.2 (**+5.5 %, 3/3**), ioLd/s +8.6 % 3/3.  On the EL71 (1.5 M/s) the same change is +5.7 % and −0.2 %, i.e. inside that board's noise — settled on the S75 |
| 0061 accel/tcg: fused single-piece MMIO **store** dispatch | the mirror of 0059.  The S75 leans on this side hardest: at idle it issues ~815 k MMIO stores/s against ~500 k loads (the TPU event RAM), so fusing only loads left half of that board's device traffic on the generic route.  The value is byte-swapped to little-endian at the call site exactly as `do_st_N()` does | `ioStFast` covers **98.8 %** of the S75's idle stores and 98.7 % of its menu stores |
| 0062 hw/pmb887x: the TPU no longer re-arms its QEMU timer on every register write | `tpu_io_write()` ends in `tpu_update_state()` for *every* TPU register including the event RAM, and that called `tpu_update_timer()` **twice** — the first arm overwritten by the second before the guest could observe it.  New counters said the S75 at a standing idle screen was making **1,449,833 `timer_mod` calls a second** against 26,674 actual TPU timer callbacks: the same "deadline = next hardware tick" storm 0049 found in the GPTU, driven by writes instead of by the timer.  Split `tpu_advance()` (counter, frame, interrupts, events) out of `tpu_update_timer()` (advance + arm), have the leading call only advance, and skip `timer_mod()` when the deadline has not moved and the timer is still pending | `tpuRearm/s` **1,449,833 → 82,882** (−94 %) idle, 524,357 → 18,491 (−96 %) menu.  Interleaved vs 0061: S75 idle MIPS 24.0 / 23.7 vs 21.0 / 22.0 (**+11 %, 2/2**), ioSt/s +12 % 2/2; EL71 menu v/wall 2.97 / 2.61 vs 2.29 / 2.34 (**+21 %, 2/2**).  Native suite 4/4 is the gate that matters here — the TPU drives GSM frame timing |
| 0063 system/cpus + accel/tcg: a lean BQL pair for the MMIO path | `BQL_LOCK_GUARD()` is ~22 calls no compiler may inline: `bql_locked()` and its coroutine-TLS accessor are `noinline` **by design** (`QEMU_DEFINE_STATIC_CO_TLS` puts an asm barrier in it), three `g_assert`s call them again, `bql_lock_impl()` reaches pthread through the lock-profiling function pointer, and `qemu_mutex_post_lock()` calls `mutex_is_bql()` and `bql_update_status()` — which calls the accessor twice more.  ~41 ns per lock/unlock pair, a quarter of a device register read.  `bql_lock_mmio()`/`bql_unlock_mmio()` read the flag once, take the mutex directly, write the flag once; they give up the three mutex trace points, the `-enable-sync-profile` hook and `CONFIG_DEBUG_MUTEX` bookkeeping **on this path only**.  Also forces `io_fast_bswap` inline — a four-line switch the size heuristic had left out of line as its own 0.5 % symbol | back-to-back profiles of the same S75 idle state (the host was at external load ~35 and the wall meters could not resolve it): BQL symbols **4.6 % → 2.4 %** of the vCPU.  The same symbols were 15.8 % in the driven-menu state, where MMIO is 4 M accesses/s |
| 0073 system/cpus: do not give the BQL back after every device access | `bql_lock_mmio()`/`bql_unlock_mmio()` were already the lean pair (0063), but an idle S75 runs them **3M times a second** and an uncontended musl mutex is still a locked compare-exchange plus a locked exchange — while the main loop, since 0067, is parked 99.4 % of the time and wakes ~90 times a second.  `bql_unlock_mmio()` on a vCPU thread now leaves the thread-local flag set and keeps the mutex; the next `bql_lock_mmio()` finds it set and does nothing at all.  Ended by: an explicit `bql_lock()` on this thread (adopts it), `bql_lock_impl()` counting itself into `bql_wanted` before blocking with `cpu_exec_loop()` releasing on that count, and `bql_lock_mmio()` handing over directly.  Safe rather than merely fast because the rr loop unlocks the BQL for real before every `tcg_cpu_exec()`: a missed release is bounded by one icount slice, not a deadlock | `__pthread_mutex_lock` 1.5 %→0.6 %, `__pthread_mutex_unlock` 1.7 %→0.7 % (back-to-back profiles; the wall meter was wrecked by orphaned browsers at load 8–19).  S75 idle MIPS 45.8→47.6 (+4.0 %, 2/3 pairs); the profile pair's own MIPS 49.0→51.7.  KE800 boot (icount=none, main loop owns its timers — the board at risk) tIdle 52.4→47.2 s, −10 %.  All gates green |
| 0072 wasm: four fixed costs on the per-access and per-TB paths | (a) `io_open_clock_window()` under stock icount is just "set can_do_io", but was a noinline call on every mid-TB device access, 3M/s — decide `QEMU_IO_REWIND` and the icount mode once, precompute the region's `rom_device` bit in `CPUTLBEntryFull`, inline the rest; (b) `tpu_ram_write()` wrote the word byte by byte, read it back, masked it and wrote all four bytes again — fourteen byte accesses per 32-bit store, 1.5M/s — which for the word-aligned 2/4-byte case reduces exactly to one masked half plus a zeroed half; (c) `cpu_exec_loop()` still reached `get_tb_cpu_state` through `cpu->cc->tcg_ops`; (d) `cpu_handle_interrupt()` cleared the kick flag with `qatomic_set_mb()` every pass — a seq_cst store plus a full fence — whether or not there was anything to clear | measured together: S75 idle MIPS and v/wall **+1.2 %**, 3/4 pairs.  Profile: `io_open_clock_window` 0.9 %→0.4 %.  (d) turned out to be nearly free — the barrier was not the cost |
| 0071 target/arm: a short hflags rebuild for a pre-v6 A-profile CPU | a counter said an idle S75 rebuilds AArch32 hflags **814k times a second**, one per 57 guest instructions (EL71: 1.0M).  On a CPU with none of M / AARCH64 / EL2 / EL3 / PMSA / V6 every question `rebuild_hflags_a32()` asks is constant or a two-load one, and five of the calls it makes cannot be inlined by the backend — `arm_sctlr`, `arm_mmu_idx_el`, `fp_exception_el`, `arm_singlestep_active`, `access_secure_reg`.  One test of `env->features` picks a path that computes the same flags from `sctlr_el[1]` and four CPSR bits (CPSR.PAN checked, not assumed).  **Verified, not argued**: `-DHFLAGS_FAST_VERIFY` takes the short path, computes the generic answer anyway, counts disagreements and returns the generic one | S75 idle MIPS **+3.9 %**, v/wall +4.1 %, 4/4 pairs.  Profile cluster (`rebuild_hflags_a32` + `arm_rebuild_hflags` + `arm_mmu_idx_el` + `fp_exception_el` + `arm_fgt_active` + …) 4.3 %→1.5 %.  Verification: 3 boards × idle and menu, ~59M rebuilds, **hflagsBad=0** in all six windows |
| 0070 accel/tcg/icount: read the virtual clock without the wasm fence pair | `icount_get()` was the top symbol at 4.3 % for ~1.2M reads/s, and almost none of it was arithmetic: two `atomic.fence` (the seqlock's `smp_rmb()` pair), one `i64.atomic.store` (publishing `qemu_icount`), four atomic loads.  wasm has no relaxed atomics and no acquire fence, so every `qatomic_set` is seq_cst and every `__atomic_thread_fence` is a locked operation.  A local seqlock pair whose barrier is a compiler `barrier()` — justified *for this section only*, because every shared location it touches is reached through `qatomic_*` and is therefore already seq_cst — plus a plain publish store (single writer, `QEMU_ALIGNED(64)`, readers already tolerate staleness) and an early return when nothing has executed | ceiling probed first (all atomics stripped: **+5.0 %**, 3/3); the patch gets **+5.2 %** MIPS and v/wall, 4/4 pairs, i.e. all of it.  `icount_get` 4.3 %→0.6 %.  The fences-only first cut was +1.8 % — the locked *store* was more than half the cost |
| 0079 pmb887x: run DIF v1 transfers inline instead of from a timer | every word went through `timer_mod(transfer_timer, 0)` and its callback — an instant deadline bought only a list removal, a sorted insert and a dispatch, ~84k/s on a CX70; worse, the DIF's `breq` then reached the DMAC from outside its run loop so the DMAC's `in_run` guard never applied and it armed *its* timer per burst (`dmacSchedTimer` 10.87M vs 10.86M bursts, against an S75's 99/s vs 11660/s). Run the queued words behind a re-entrancy guard, as `dif_v2.c` always has (v2 never calls `timer_mod`); the loop still stops on a raised request, so the resume points — next FIFO write, RX read, event handler on a cleared request, and `CON` read for a CPU spinning on BSY — carry the held word | CX70 fixed-work +7.3 % (4/4 interleaved pairs, host load 2.8–5.8); screenshot at a fixed instruction count byte-identical; menu navigation renders correctly |
| 0080 wasm-diag: counters that price speculation, the jump cache and hflags | instrumentation only, all of it under `CONFIG_TCG_WASM64` / `__EMSCRIPTEN__` so native builds are untouched.  `SPEC_MISS/NOSUCC/EXISTS/NOTRAM/MADE` (80-84) price the speculative successor walk; `HFLAGS_CALLS` (85) prices `arm_rebuild_hflags`; `LOOKUP_CONFL` (86) splits jump-cache misses into capacity vs flush | they exist because this round found the wasm profile's per-function self-time is wrong by ~100x (see § REJECTED, `arm_rebuild_hflags` as an 11 % target).  Immediate results: **module count == miss count** (`closeN` 34922 == `specMiss` 34922 on an EL71 boot window, `temp` 0), which killed return-address speculation; `arm_rebuild_hflags` is called 11,606/s, not 11 % of the vCPU; and every idle-CX70 jump-cache miss is capacity, not a flush.  Gates: native op-suite 1156/1156 both backends serial-identical, native lockstep 3/3 clean at 2.5 G (the browser gate and native `boot-init` were unrunnable — host at 23 GB swap — and fail identically on the pre-change revision) |
| 0081 ui/wasm: a key event before the display exists must not trap the module | `wasm_send_key()` is exported at instantiation; `wasm_display_init()` creates the bottom half it schedules much later; the page's keypad is live from its first render.  `qemu_bh_schedule(NULL)` does not fault where the mistake is -- the atomic on `bh->flags` lands on address 40, a valid wasm address, and succeeds -- so `bh->ctx` reads address 0 and the list insert at ctx+184 leaves the 2 GB memory.  Publish a readiness flag with a release store, take it with an acquire, drop events before it; and stop the page sending a release for a key that was never pressed | **CX70 bootcheck 203M insns (trap) -> 13442M with 2443 fb updates**, its best boot here; bootcheck 4/4 after failing 4/4 on every dist.  Regression test `tools/earlykey.mjs`: PASS on all four boards, FAIL on the build before.  Not a perf patch -- but it was failing the gate that every perf patch is measured through, and it masqueraded as host memory pressure for an afternoon |
| 0082 wasm-diag: phase timers, and delete a heuristic that never ran | three things, all instrumentation or removal. (1) The `ldr pc, [pc, #-4]` trampoline block in `w64_speculate` is **deleted** — see § REJECTED; it had been guarded on `!CF_PCREL` since birth and had never executed. (2) Phase timers: `MOD_NS` around `w64_batch_instantiate` (always on, ~1k/s), `TB_GEN_NS` and `FILL_NS` behind a new `WASM_DIAG_TIME_PHASES`, plus `TB_ICOUNT` for mean TB length. Charged in **C**, because the EM_JS body's own `__w64t*` globals live in a vCPU worker that never yields and a page-side `evaluate()` on it hangs. (3) `W64_NOGENBUMP`, an unsound ceiling probe for the inline cache | no throughput change is claimed or intended; the value is what the timers said. The translate+compile pipeline is **19.5 % of EL71 boot wall at its densest, 8 % late** — so *the early boot is not compile-bound*, which this document had asserted since round nine, and tiering's whole prize is capped at the ~10 % compile slice. MMIO, `hflags`, TLB fills, TB length and the inline-cache generation were each measured and closed (§ REJECTED and the hand-off). Gates: browser bootcheck 4/4 + earlykey 4/4; native op-suite, lockstep and suite as below |
| 0078 pmb887x: give DIF v1 the two things v2 already has | `dif_mux()` looped over `p->bits` (16) with two divisions and two modulos per output bit, once per transferred word — v2 resolves the same mapping through a 4×256 byte-lane table rebuilt only when `bmreg`/`bcsel`/`bcreg`/`bits` change; and `dif_trigger_dma()` drove both DMA request lines on every `srb_set_isr`/`set_icr` (~4×/word) although the level almost never changes and `dmac_handle_signal()` drops the repeat one indirect call later, exactly what v2's `dif_set_dmac_req()` filters at source | CX70 fixed-work: mux table +3.1 % (3/3), request filter a further +3.0 %, together +6.2 % (3/3); mux table proved equivalent over 4.6M random configurations across every bits width |
| 0076 wasm-diag: gate the hot-path counters | `wasm_diag_stat[]` began as cold-path diagnostics (its header still said "hot paths deliberately carry no counters") but `IO_LD`, `IO_ST`, both `*_FAST`, `VCLOCK_READ`, `HFLAGS`, `HFLAGS_FAST`, `TPU_RAM_W`, `TPU_RAM_SKIP`, `LC_CALL`, `LC_FILL` had all migrated onto it — ~**14M read-modify-writes a second** on an idle S75, spread over four cache lines. `WASM_DIAG_HOT()` compiles those out unless `WASM_DIAG_HOT_COUNTERS` is defined; cold counters unchanged, so tb/flush/fill/warp diagnostics still work in the shipping build | below this meter's ~3 % floor at host load 4–7, so carried in the round's end-to-end number rather than measured alone. **A `WASM_DIAG_HOT_COUNTERS` build reports real rates and must never be used for a wall-clock A/B** |
| 0075 accel/tcg: fold the MMIO fast path into its callers, one bswap instead of two | `helper_ld*_mmu` already assert the size, so each `do_ld?_mmu` passes it to an `always_inline` `do_ld_mmio_1p()` as a literal: the size-mask test, both alignment tests, `MAKE_64BIT_MASK` and the swap all fold. The swap was the real find — the fast path applied the device's byte order and the caller then applied the op's, and for a LE device read by a LE guest (every hot MMIO register on these boards) those were two real `bswap32`s that cancelled, one through out-of-line `io_fast_bswap()` and its `br_table`. Now the single leftover swap, `((io_swap & 1) != 0) ^ caller_le` | S75 idle **+4.1 % MIPS and +4.1 % v/wall, 3/4 pairwise** vs the round-thirteen tip. *Most of that is 0074's mechanism*: inlining moved the MMIO body into hosts the onlylist did not name, which un-instrumented it. The same patch **with** those hosts added to the onlylist measured **−2.5 %, 0/4** |
| 0074 wasm: trim the Asyncify onlylist to the frames a coroutine switch can reach | `rr_cpu_thread_fn()` calls `qemu_coroutine_forbid_current_thread()` and `qemu_coroutine_switch()` *aborts* on the vCPU thread, because the JIT'd TB frame and the `invoke_*` wrapper under a helper cannot be instrumented at all — so a switch under guest execution is impossible by construction and 18 vCPU-only entries (`cpu_exec*`, `cpu_tb_exec`, `tcg_qemu_tb_exec`, `tcg_cpu_exec`, `rr_cpu_thread_fn`, `do_ld_*`, `do_st_*`, `helper_*_mmu`, `int_ld_*`, `int_st_*`, `io_read/writex`) were paying for an unwind that can never happen. They are the stack of a vCPU flash write — the case `flash-blk.c` had already moved to a main-loop bottom half; the fix deleted the stack, nothing deleted the entries | instrumentation cost measured directly by the inverse experiment: **adding** 7 hot cputlb functions to the list was **−6.6 percentage points** (a +4.1 % patch became −2.5 %, 4/4 pairwise either way). Verified with `QEMU_COSTACK=1` + new `tools/asyncify-audit.mjs`: 67 distinct frames on a 120 s S75 boot, all block-layer/realize/main-loop/monitor, all still covered, none of the 18 present. Build 28.6 KB smaller |
| 0069 target/arm: no double hflags rebuild per CPSR write | `cpsr_write()` rebuilds hflags at its own tail whenever the write is not Raw and the mask covers `CPSR_M/E/IL` — after every bit of `uncached_cpsr` is written.  Both TCG helpers then rebuild *again*: `HELPER(cpsr_write)`'s "did uncached_cpsr change" guard is true precisely when `cpsr_write()` also rebuilt, so it never saves the duplicate, and `HELPER(cpsr_write_eret)` is unguarded (the only thing between the two is masking the low bits of `regs[15]`, and the PC is not an hflags input).  Skip the second pass when the mask covered those bits — the test must be the mask, not "did anything change", because a write that moves PAN alone leaves `cpsr_write()`'s condition false and still needs this rebuild | verified before measured: a build that took the skip but rebuilt anyway and compared against the hflags already in `env` ran all three boards through idle and driven — **51.8M skips, 0 disagreements**.  Back-to-back S75 idle profiles: `rebuild_hflags_a32` **2.4 % → 2.0 %**, `arm_rebuild_hflags` **1.5 % → 1.2 %**, controls unmoved (`icount_get` 4.2/4.2, `do_st_mmio_1p` 3.6/3.6).  ~0.7 % of the vCPU — below the wall-clock meter (three pairs: +2.4/−4.4/+8.1 %), reported as a mechanism result.  Gates: op-suite 1156/1156 (the one that matters here), native 4/4, bootcheck 3/3, wasm lockstep 2/2, Firefox clean |
| 0068 hw/pmb887x: no TPU advance for an event-RAM write that cannot move the deadline | every TPU register write ends in `tpu_update_state()` → `tpu_update_timer()` → `tpu_advance()`, which reads the virtual clock.  A counter said the S75 idle screen does that **1.48M times a second** and that **96 %** of those writes are to the *event RAM* — 84 % of every MMIO store the board makes; caller stacks put **76 % of `icount_get()`** (then the top symbol at 7.7 %) under that one path.  The event RAM is plain memory — `tpu_run_events()` re-reads it every scan and caches nothing — so a word can only change `p->next` while it is inside `[ceap, eapt)`, the part of the current frame's list still to be scanned.  The RF half, consumed entries, entries past `eapt` and everything once the list has finished are read no earlier than the next frame, where `tpu_advance()` runs anyway because the QEMU timer is armed for it.  Nothing else in `tpu_update_state()` reads the RAM | **77 %** of event-RAM writes take the early return; `vclock/s` **2.02M → 1.17M (−42 %)** on the S75, 1.08M → 0.56M on the EL71.  S75 idle MIPS +20/+7/+10 % (3/3); EL71 +8/+3/−0.4 % (its gain is smaller because 0067 left it less MMIO-bound); KE800 neutral by construction (3.4k event-RAM writes/s).  Verification is the story — see § the 1 ns residue.  Gates: op-suite 1156/1156, native 4/4 with every LCD milestone unmoved, bootcheck 3/3 (ke800 fb=186, its best), wasm lockstep 2/2 clean with serial identical, Firefox clean |
| 0067 util/qemu-timer: no virtual-clock notify for an empty timerlist | `qemu_clock_notify()` fans a notify out to every timerlist on the clock, and `qemu_aio_context`'s QEMU_CLOCK_VIRTUAL list is empty for this machine's whole life (every pmb887x device arms on `main_loop_tlg`).  A notify means "recompute your deadline"; an empty list has none — but `aio_timerlist_notify()` still woke the parked main-loop thread through a futex.  No timer can be missed: the thread that arms one calls `timerlist_rearm()` → `timerlist_notify()` itself after the insert, and that is the only other caller, where the list is non-empty by construction.  Gated on icount: without it the *main loop* runs the virtual timers and the notify is the kick that keeps it iterating | main-loop wakes **38,481/s → 66/s**; the main-loop worker goes from 91.2 % to **99.4 % parked**.  S75 idle MIPS **+41/+40/+31 %** (3/3), EL71 **+25/+21/+27 %** (3/3).  The lesson is the magnitude: the futex call is not the cost, the BQL round trip behind it is — see § what a cross-thread wake really costs.  Gates: op-suite 1156/1156, native 4/4, bootcheck 3/3, native lockstep 3/3, wasm lockstep 2/2 clean at the full 2.5G window, Firefox clean |
| 0066 hw/pmb887x: no double TPU advance per register write | `tpu_update_state()` opened with `tpu_advance()` and closed with `tpu_update_timer()`, which advances again — same virtual instant, same frequency, `elapsed_ticks` 0, same numbers recomputed.  `tpu_io_write()` reaches it for *every* TPU register (~815 k/s on the S75 idle screen) and `tpu_advance()` is a virtual-clock read, two `muldiv64`s, the frame loop, the interrupt test and a scan of the event list.  The leading advance only matters when something consumes a counter brought up to date at the *old* rate — a frequency/enable change or the TINI reset — and everything computed before that point (`ftpu`, the GSMCLK K/L reload, `new_freq`, the new enabled state) is a pure function of the registers.  Hoist that above the advance, take the advance only when consumed | back-to-back profiles of the same S75 idle state: `tpu_advance` **5.8 % → 2.9 %**, and `icount_get` **6.4 % → 4.5 %** with it (the TPU advance was a large share of the virtual-clock reads — `vclock/s` per MMIO access 3.5 → 2.1).  Gates: op-suite 1156/1156, native 4/4, browser bootcheck 3/3 |
| 0065 accel/tcg: one clock notify per idle round, not two | `rr_idle_advance()` warps and then runs the deadline, and both halves called `qemu_clock_notify(QEMU_CLOCK_VIRTUAL)` — a cross-thread wake of a parked main loop, thousands of rounds a second.  The first is always redundant *here*: with `sleep=off` the warp moves `qemu_icount_bias` by exactly the `~QEMU_TIMER_ATTR_EXTERNAL` deadline, so that deadline is 0 on return, and `icount_handle_deadline()` tests the `QEMU_TIMER_ATTR_ALL` deadline — over a superset of the timers, therefore never larger — so it is 0 too and it always notifies, on this thread, a few instructions later.  `icount_start_warp_timer_full(false)` suppresses the first; the `sleep=on` branch, which returns before running the deadline, notifies explicitly | `PROF_FN=emscripten_futex_wake` caller stacks, S75 idle, 25 s: the `icount_start_warp_timer` stack (1185 ms) is **gone**, `icount_handle_deadline` 449 → 1260 ms, wake callers in total **4303 → 3127 ms (−27 %)**, and the BQL handoff on the same path fell 2472 → 1525 ms with it.  Gates: op-suite 1156/1156, native 4/4, browser bootcheck 3/3 |
| 0064 util/qemu-timer: the icount clock without the `cpus_accel` frame | `qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL)` reached the clock through `cpus_get_virtual_clock()`, which makes exactly the two tests `tcg_accel_ops_init()` installs hooks for, in the same order, then calls the same function.  One more non-inlinable frame in front of a call a polled device model makes 4 M times a second.  `stubs/icount.c` gains `icount_get()` so tools that enable `CONFIG_TCG` without linking `accel/tcg` still link | `qemu_clock_get_ns` + `cpus_get_virtual_clock` were 1.9 % + 2.0 % of the S75 menu vCPU |

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
| **`arm_rebuild_hflags` as an 11 % target** (the profile's single largest vCPU entry on an idle CX70, apparently contradicting round fifteen's rejection of the `cpsr_write` hflags skip) (2026-09-15) | Not a target and never was: an unconditional entry counter (`hflagsCalls`, index 85) puts the call rate at **11,606/s**, so 11.0 % of a 30 s profile would be **9.5 us per call** for a function priced at ~76 ns.  A 10,000-iteration volatile spin placed in it took the board 113 MIPS -> **0.7 MIPS**, confirming both the rate and that the knob reaches the code | **The profiler names the wrong function.**  Profiling the spin build -- where all the work provably sits in `arm_rebuild_hflags` and calls nothing -- reported `rebuild_hflags_a32` **67.3 %**, `arm_rebuild_hflags` 20.3 %, `arm_security_space` 9.5 %, `cpsr_write` 1.0 %.  A name in a wprof2 profile identifies a neighbourhood, not a function.  Round fifteen's A/B was right and its profile was not.  Price a function from a counter times a per-call cost, or by a volatile-spin probe -- never from self-time; and see doc/lessons.md for the two ways a cost probe silently measures nothing |
| **Speculate along call return points** (after the goto_tb walk, translate each walked TB's fall-through `pc + size` on a budget of its own; that address is the return point of a `bl` and of an indirect `blx rN`, neither of which the frontend records as a successor) (2026-09-15) | EL71 boot window (100M-1500M, fixed guest work, 4 interleaved pairs): **+0.8 %, 2/4 wins** -- a tie -- for **+15 % more TBs translated** (160.4k -> 184.6k) and **no change in module count at all** (34669 -> 34436, within run-to-run noise).  It does work on an interactive path: on the EL71's second key press it cut modules 456 -> 339 (-26 %), and keylag's `madePerMiss` rose 0.33 -> 0.43 | **Module count is miss count.**  A batch is opened by a lookup miss and closed the moment that miss's TB executes, so on the EL71 boot window `close` (34922) equals `specMiss` (34922) exactly, with `temp` = 0.  Speculating *more* therefore cannot reduce modules; only speculating the TBs the guest misses on *next* can, and fall-throughs are that only on interactive paths, not during boot -- where the wall time is.  The boot already gets 5.3 TBs per module from the goto_tb graph alone.  Retry only with a predictor that lowers `specMiss`, and measure that counter, not `tbGen`.  Note also that the first attempt read `specRet=0` on every press because it copied the `CF_PCREL` guard from the trampoline heuristic beside it -- see the lessons entry on counting the fast path |
| **Raising `W64_SPEC_N` above its default 32** (the speculative successor budget; 64 looked like a free win) (2026-09-15) | **A tie on the meter that counts.** An insns-at-fixed-wall sweep read a clean inverted-U peaking at 64 — el71 boot 753M -> 799M insns (+3-6 %), modules down, pipeline share down — and `workbench.mjs` then read **27.88 vs 27.95 MIPS over 4 interleaved pairs, 2/4 wins each**. Cross-board was already mixed (cx70 +0.7 %, s75 +1.0 %, **ke800 -3.5 %**) | The mechanism works and cancels: at 64 the modules fall 4.8 % (33 846 -> 32 213) and the TBs translated rise 6.5 % (162 726 -> 173 295), which is **module count is miss count** seen from the other side — you buy compile time with translate time at roughly par. Past 64 it inverts outright (at 512, translate 12.50 % vs compile 10.01 %). Two lessons: the knob is already at a flat optimum, and **insns-at-fixed-wall found a shape that the fixed-guest-work meter refused to confirm** — use the first to explore, never to decide |
| **`W64_NOGENBUMP` — the inline cache's global generation** (every `tcg_flush_jmp_cache` bumps one global `tb_key_gen`, retiring *every* `w64_lc` slot at once; at 1920 bumps/s an epoch is 0.5 ms, so the hypothesis was that slots die before they are reused) (2026-09-15) | **17 %, and no time in it.** The ceiling probe (skip the bump entirely — unsound, stale targets survive) moved `lcCall` only 14 644 -> 12 112 per Mi on an EL71 boot, with MIPS unchanged (28.7 vs 28.5) | So ~83 % of inline-cache misses are genuine: the target really does differ, exactly the megamorphic return sites 0047's note predicted. 420 k helper calls/s at any believable per-call cost is ~1 % of wall, so a sound per-page or per-ASID generation scheme would buy a fraction of that. **The probe is worth keeping** (`W64_NOGENBUMP=1`, clearly marked unsound) — it prices a perfect inline cache in one run. Retry only with a way to make *megamorphic* sites cheap, which a generation scheme is not |
| **The `ldr pc, [pc, #-4]` trampoline heuristic** (a TB ending in that insn jumps to the literal immediately after it — an edge `goto_tb` cannot record, since it is an indirect branch; read the literal through the speculation walk's non-faulting probe and queue it as an extra successor) (2026-09-15) | **The pattern is not there.** With the guard lifted and each queued TB's guest pc carried alongside the walk, the tail probe succeeds on **141 nodes per Mi** (EL71) — i.e. on essentially every node walked — and of those the pattern matches **0.004 per Mi**: about one node in 35,000, against 6.5–17.6 lookup misses per Mi. Four boards, same answer (`specTramp` per Mi: el71 0.004, ke800 0.02, cx70 0.00, s75 0.00) | It had **never once run**: it was guarded on `!CF_PCREL`, which `arm_cpu_realizefn` sets on every system-mode ARM TB, and both the code and the guard arrived in the same commit (2ad6330fdf). Two rounds read it as a live optimization. The ~35,000:1 gap means no timing A/B was needed or run — a mechanism that fires four times in a boot cannot move a wall clock. **Deleted rather than shipped behind a knob** (−26 lines): dead code that looks live costs more than it saves. Note the measurement order that made this cheap — point the counter at the *probe* first, so "the pattern is rare" is distinguishable from "the probe never ran"; the two look identical from a zero |
| **`cpsr_write` hflags skip** (rebuild only when a bit hflags actually reads changed, not merely when the instruction's field mask names one) (2026-09-15) | CX70 fixed-work **+0.6 %, 2/6 pairwise** — a tie — although it removes **93.7 %** of the rebuilds `cpsr_write` asks for (74.8M of 79.8M on a CX70 boot; 90 % of all 82.6M hflags rebuilds) and 52 % on an S75 | The mechanism is real and the change is sound — a `CPSR_HFLAGS_SKIP_VERIFY` build (take the skip, rebuild anyway, compare) found **zero** disagreements over 74.8M skips — but the time is not there to recover. The post-0071 fast path is already close to free, so `arm_rebuild_hflags`'s 3.3 % profile self-time on a CX70 is not 3.3 % of recoverable work: treat a self-time share for a small leaf function as an upper bound, not a budget. Retry only with a profile showing where that 3.3 % actually goes, and note it costs an invariant (`CPSR_HF_BITS` must stay a superset of every CPSR bit any hflags path reads) |
| **`dacr_write` value guard** (skip the full TLB flush when DACR is rewritten with the value it already holds, the guard `fcse_write`/`contextidr_write` beside it already have) (2026-09-15) | **No effect at all**: over an identical 5.1G-instruction CX70 window, `tlbFlush` 15636 → 15635 and `jcFlush` 13793 → 13795 | This firmware does not write DACR idempotently, so the flushes come from somewhere else — most likely an explicit `TLBIALL` per context switch, which QEMU must honour. The guard is still correct and costs one compare, but nothing here pays for it. If the jump-cache flushes are attacked again, **find the caller first** (they are boot-time only: `jcFlush/s` is 0 at idle) rather than guessing at candidates |
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
| **Widening the TB jump-cache entry** to hold cs_base/flags/cflags/tc_ptr so a hit never dereferences the TB (2026-09-12 rejected by inspection; **built and measured 2026-09-13 — still rejected**) | **flat.** Ground truth was two *pristine* builds (git worktrees at the two revisions, each in its own fresh build dir), interleaved `--quick --runs 4` on a quiet host: t0.5G 21.2 vs 21.3, t0.75G 26.2 vs 26.4, t1.3G 28.7 vs 28.7 — **−0..−1 %**.  The J2ME stopwatch agrees (8 alternating samples, means 0.3005 vs 0.3005) | the 2026-09-12 inspection ("a hit already touches exactly one TB cache line") was right, for the reason it gave.  The theory that the *residency* of that line differs — one of ~175k TB structs over ~100 MB against a 160 KB jump cache — predicts a win that does not appear: the hot TB set is small enough to stay resident.  **Read the four-pairs-in-both-orders −4..−6 % that this change appeared to win in the § "phantom win" note below before re-opening it — that number was a stale baseline, not this patch.**  Implementation kept in the reflog if anyone wants it: the copies must come from the TB, not the requested `TCGTBCPUState`, because `tb_gen_code()` can return a one-shot `CF_COUNT_MASK=1` TB |
| **wasm64: hoist `env + fast_ofs` into a per-TB local** (2026-09-13; `$tlb` set once per label region instead of once per memory op, invalidated at each `tcg_out_set_label` because regions are sibling `if (bp <= k)` blocks a branch can enter directly — the hand-off's own § Remaining 0b candidate) | `--quick --runs 2` in **both** orders: **+3 % and +10 % slower** on t0.5G..t1.3G; reverting it recovered −6..−10 % in a third pair | it removes ~8 emitted bytes *and* a load+add+store per memory access and is still a clear regression — a local kept live across a whole label region evidently costs more in Liftoff's register allocation than the arithmetic it saves.  Third independent measurement (after the prologue cleanup and compaction-off) that **emitted-byte count is not the early-phase lever** |
| **TB jump cache 4k → 8k entries** (`TB_JMP_CACHE_BITS` 13, 2026-09-13, on top of the wide entry) | `--quick --runs 2`: +1..+4 % — no gain, and the entry is now 40 B so the cache would be 320 KB | 7.2 % of lookups miss and `qht_lookup_custom` is 3 % of the vCPU, but more slots do not convert those misses.  Second size that fails (15 bits was +4..9 % in 2026-09-11) — **stop resizing this cache; attack the key instead** |
| **`W64_NOCLOSEEXEC=1`** — stop closing the open batch when its first member executes, let it fill to `W64_BATCH_N` (2026-09-13, knob A/B: same wasm both legs) | **12–17 % slower on every milestone** (t0.5G 26.7 vs 22.5, t1.3G 35.1 vs 30.8) | the batch close is what makes speculation pay: one module covers the executing TB *and* its ~5 staged successors.  Deferring it needs a temp module per first execution — the pre-0019 design — and there are ~32k such executions per boot either way, so nothing is saved and the free successors are lost.  Module count is bounded by "how often a not-yet-compiled TB runs", not by `W64_BATCH_N` |
| **Inline lookup cache keyed on an hflags generation** (2026-09-13, first design of 0046: `env` generation bumped on every hflags change, compared with pc) | never hit: hflags change **3.5 M times per 40 s boot (88 k/s, one per ~36 lookups)** on this firmware, so a generation that tracks them retires every slot before it is reused | hflags alternate between a few values (mode switches) rather than drifting; a cache must compare or stamp the value, not count changes.  The generation is only usable for events that are rare (jump-cache flushes: 1.4 k per boot) |
| **Inline lookup cache comparing every key word** (2026-09-13, second design of 0046: pc, gen, hflags.flags, flags2, thumb, condexec — 12 loads, 6 branches) | **+2..+4 % slower on every milestone in both orders** at an **84 % hit rate** (verify mode: 107 M of 128 M) | Liftoff code for a dozen loads and six branches costs more than the TurboFan-compiled helper's jump-cache hit (~25 ns), exactly the 2026-09-11 lesson in a new coat.  The landed version compares 2–3 words and stamps the rest statically |
| `-sSUPPORT_LONGJMP=wasm` (native unwinding for the SVC-exception longjmps) | binaryen's Asyncify pass crashes on it (verified with a standalone emcc test) | wasm-EH longjmp and `-sASYNCIFY` are incompatible in emsdk 4.0.10; ASYNCIFY is required (coroutine backend/condvar sleeps) |
| **TPU event RAM as its own MemoryRegion** (2026-09-15; `memory_region_add_subregion` at TPU_RAM0, one page, page-aligned, with its own tiny `ram_ops` so `full->io_write_fn` points straight at the RAM handler instead of `tpu_io_write`'s ~40-case switch; plus `disable_reentrancy_guard` on both TPU regions, which drops the `io_guard` load and the two `engaged_in_io` stores from every access) | S75 idle **−2.3 % MIPS and v/wall, 1/4 pairwise wins** vs the same tree without it. Not a dispatch regression: `ioStFast/ioSt` stayed 98.8 % on both legs, so the fast path still resolved to a leaf | the switch was not what the RAM write was paying for — 1.7M writes/s reach it through a range compare clang puts early — and the extra flatview section costs more than that compare. Same shape as the rejected **MMIO dispatch fast path** row above: the per-access work removed was smaller than the structure added. The `disable_reentrancy_guard` half was never measured alone; it is ~3 memory ops on 3.3M accesses/s ≈ 0.3 %, under this meter's ~2–3 % floor, so it needs a profile, not a wall A/B |

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
   **2026-09-13**: still ~0.30 (37–39 MIPS, 2.5 M lookups/s).  The wide
   jump-cache entry measured **exactly flat here** — 8 samples
   alternating the builds in both orders, means 0.3005 vs 0.3005 — at a
   time when the boot ladder was (wrongly) showing it at −4..−6 %.  This
   meter was right and the boot ladder's baseline was bad; when two
   meters disagree, suspect the baseline before believing the flattering
   one.  **This meter drifts** — the
   first four samples fell monotonically 0.313 → 0.281 as host loadavg
   went 1.97 → 2.77, which on its own read as a 4 % regression.
   Alternate the builds and require both orders, exactly as for
   idlebench.
   **2026-09-13 (later)**: 0046 → 0.35, then **0047 → 0.48–0.53** (60–67
   MIPS) from the device side — the profile of the running app (attach
   `wprof2.mjs` to `stopwatch.mjs --devtools <port> --hold <s>`) is the
   map here, not the boot profile: devices were 46 % of the vCPU, and
   the top symbol was a table rebuild on a register write, not a
   per-word cost.  What is left is the per-word chain itself
   (§ Remaining 7).

0b. **Emitted code volume — CLOSED as a lever (2026-09-13, reconfirmed
   2026-09-14).**  Four independent measurements now say the
   emitted-byte count is not what the early phase is bound by: the
   prologue cleanup (−12 % bytes/TB, flat), compaction off (−49 %
   compiled bytes, a wash), the inline TLB-probe hoist (fewer bytes
   *and* fewer executed ops per access, **+3..+10 % slower**,
   § REJECTED), and **0055** (−3.7 % bytes/TB and four fewer wasm ops
   per memory access, **flat on all three speed meters**).  0055 is the
   one that settles the mechanism question the hoist left open: the
   hoist could be blamed on register pressure, because it kept a local
   live across a whole label region; `local.tee` only ever *shortens* a
   live range, so it cannot disturb Liftoff's allocation — and it still
   buys nothing.  The cost is not in the bytes or in the op count.
   Do not spend more here; the byte histogram below is kept only as
   reference.
   Per TCG opcode (temporary histogram in `tcg_gen_code`, first 1.5 M
   ops): `qemu_ld` 83.9 B/op and `qemu_st` 86.9 B/op = 37 % of all
   emitted bytes (the inline TLB probe), `add` 12.0 B × 4.2/TB,
   `goto_tb` 57 B, `goto_ptr` 65 B, `mov` 5.0 B × 6.3/TB, `brcond` 18.9 B.

0c. **Where the vCPU actually goes (2026-09-13 wprof2, the measurement
   that replaced the estimate above).**  The hand-off's cost model —
   "~176k TBs × 38 µs translation ≈ 6.7 s of a boot" — is wrong by a
   large factor.  Self-time of the vCPU worker, `rt=off` (the profiled
   build carried the jump-cache patch that was later measured flat and
   dropped, which does not move these shares):

   | | early (insns 0.24 G →, 8 s) | mid (0.28 G → 1.6 G, 16 s) |
   |---|---|---|
   | guest code (`tcg_qemu_tb_exec` + JIT-module frames) | 23.4 % | ~17.5 % |
   | `Module` (browser wasm compile) | **14.1 %** | 7.7 % |
   | TB lookup (`helper_lookup_tb_ptr` + qht + `arm_get_tb_cpu_state`) | 8.4 % | **12.6 %** |
   | instantiate (`w64_batch_instantiate` + `Instance`) | 2.8 % | 1.5 % |
   | translate (`tcg_gen_code` + liveness + optimize) | **3.9 %** | 2.9 % |
   | clock/timers (`icount_get`, `tpu_update_timer`, `timer_mod_ns`) | ~1 % | ~2.5 % |

   So translation is ~3–4 %, not ~20 %, and the two real cost centres
   are the **TB lookup path** and **`Module`**.  `tcg_qemu_tb_exec`'s
   self time is guest code: 0026's `return_call_indirect` reuses the
   caller's frame, so V8 attributes every chained TB to the dispatcher
   frame that started the chain (and JIT-module frames resolve to
   nonsense names — `input_barrier_get_name`, `hmp_object_del` — because
   the `.symbols` sidecar maps the *main* module's indices).

   Counters for the same boot (`tools/diagall.mjs`, new this session —
   prints every `wasm_memstat` index by name): tbGen 175,158 with
   **tbFlush 0** (every translation is unique; no flush cycles to
   remove), tbBytes 86.1 MB, modCount 41,437 / modBytes 180.2 MB
   (closeN 32,085 / 89.4 MB, compactN 191 / 85.7 MB, ensureN 0),
   lookup 153.4 M at 92.8 % jump-cache hits, ioLd+ioSt 12.7 M,
   tlbFill 128,812, halt 73,045.  **Batches average 5.5 members, not
   the 128 of `W64_BATCH_N`** — `w64_batch_close_pending()` closes on
   first execution, and that is right (§ REJECTED `W64_NOCLOSEEXEC`).

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
4. **wasm64 batcher `SOURCE-CORRUPT` — CLOSED 2026-09-13** (`bf0b67d4`,
   see the landed table): `encode_search()`'s overflow path abandoned a
   TB without advancing `code_gen_ptr`, so `tcg_tb_alloc()` carved
   `TranslationBlock`s out of the staged member's bytes.  Not
   `w64_speculate()`, which was the standing hypothesis.  It was also
   far more frequent than recorded — 1–2 per 60 s S75 boot.
5. **AOT cache — OPEN, and now costed.**  Persist translated batches
   (Cache API/IndexedDB, keyed by flash hash) for zero-translation
   second boots.  What it can actually buy, from § Remaining 0c:
   `Module` 14.1 % + instantiate 2.8 % + translate 3.9 % ≈ **21 % of the
   vCPU in the early phase**, ~12 % mid — call it 3–5 s of a 30 s
   `rt=off` boot, and since only the first ~0.75 G instructions move
   under the shipping cap, ~3–4 s of a 39 s `rt=banked` boot.  Real, but
   an order of magnitude smaller than "removes the whole 197 MB"
   suggests, against a large implementation (serialise the TB set + code
   buffer, restore the qht/chain table, invalidate on flash change) and
   a correctness surface the gates do not cover today.  Decide on those
   numbers, not on the byte count.
6. **Backend tail — the TB lookup path: 0046 landed the inline cache
   (2026-09-13).**  It was ~12.6 % of the vCPU mid-boot by profile:
   `helper_lookup_tb_ptr` 7.4 %, `qht_lookup_custom` 3.0 %,
   `arm_get_tb_cpu_state` 1.3 %, `tb_htable_lookup` 0.5 %; 153.4 M
   lookups per boot because every `bx lr` / `pop {pc}` / `ldr pc` and
   (since 0027) every `msr CPSR_*` goes through it.  0046 serves ~80 %
   of them from a per-TB slot without the helper — and the boot
   milestones did not move (the J2ME stopwatch did, +7..+9 %).  Read
   that as: the profile's 12.6 % was not 12.6 % of *boot wall time*
   removable by skipping the helper; the boot's early phase is
   compile-bound and its late phase is short at `rt=off`.  What is left:
   - The hflags-generation idea as written here was **wrong** (hflags
     change 88 k/s — § REJECTED); the version that landed stamps hflags
     statically per exit and compares only pc/gen(/thumb).
   - The remaining helper calls (26 M per boot) are real misses: the
     ~20 % of exits whose target alternates (return sites shared by
     several callers).  A 2-way slot would need a second compare on the
     hit path, which the two rejected designs say is not free — measure
     on the stopwatch, not the boot, if anyone tries.
   - Two `wasm_diag_stat` RMWs still run on every helper lookup (now
     ~52 M per boot, <0.5 %); `LC_CALL` is a third.  Not worth a commit.
   - Resizing the jump cache is closed: 8k and 32k both measured worse
     (§ REJECTED).  The misses are not a capacity problem.
7. **The display DMA per-word chain — OPEN, the stopwatch's top item
   after 0047.**  The firmware programs the display channel as 4095-word
   transfers moved **one 4-byte word per request** (`[4x1] -> [4x1]` in
   the `PMB887X_TRACE_LOG=dmac` trace; ~500 k requests/s at 60 fps), so
   every word runs the whole chain: `dmac_timer_reset` → 8 × channel run
   → `address_space_read` (RAM word) → `address_space_write` → flatview
   → dispatch → `dif_io_write` → FIFO push → `dif_schedule` → `dif_work`
   → `dif_tx_from_fifo` (2 × `dif_update_gpio_state`, mux, 4 ×
   `ssi_transfer` → `lcd_transfer` with three QOM casts each) → ack →
   CLR/BREQ level dance (`srb_set_icr` → event → `dif_schedule` again →
   `dif_tx_fifo_req` → `set_isr` → `dif_trigger_dma` → `qemu_set_irq`
   ×2 → `dmac_handle_signal` ×2).  Do not change what a request moves
   (device semantics); what can move is per-word overhead.  **0048 took
   the first three**: per-channel translation windows keyed on
   `memory_region_topology_gen()` (the memory-API layers were ~10 % of
   the vCPU after 0047; `dmacXlatFill` reads 0/s once the window covers
   the flat range), the VIC driving the CPU lines only on a level change
   (the masked TX request line cost a `cpu_interrupt` per toggle), and
   the pin table's dead `name[32]`.  Still open: the three QOM casts per
   LCD byte (`OBJECT_CHECK` calls `object_dynamic_cast_assert` for its
   trace point even with `qom_cast_debug=false`; ~1.6 %), the no-op
   passes of the level dance (`dif_trigger_dma` ×5 and `dif_schedule`
   ×2 per word), `qemu_set_irq` fan-out, and — the largest — the guest's
   own ~40 %.  Meter: `tools/stopwatch.mjs` (`per-s` line: `difTxWord`,
   `dmacBurst`, `dmacSchedTimer`, `dmacXlatFill`, `difMuxRebuild`).
   **0050 took two more**: the 16 KB zero-fill `-ftrivial-auto-var-init`
   put into `dmac_transfer_memory` per word (7.5 % of the vCPU — the
   function's whole self time) and the two checked casts per LCD byte.
   **0051 took three small ones** (the `BUS()` cast per SSI byte, the
   pin rebuild skipped on unchanged inputs, the FIFO modulo); the input
   cache on `dif_trigger_dma` was tried and dropped — it re-enters
   itself through the DMAC and never hits anyway (lessons.md).
   Still open after 0051 (profile `prof-stopwatch-0051`, per word):
   `dif_tx_from_fifo` 5 % self (1800 lines of wasm asm for the loop —
   a fat body, no single call to remove), `pmb887x_srb_set_event`
   2.5 %, `dmac_write` 2.6 %, `dif_trigger_dma` 2.3 % (four passes per
   word, each necessary in turn), `qemu_set_irq` 2.1 %,
   `dmac_timer_reset` 1.6 %, `lcd_transfer` 1.2 %, `dmac_handle_signal`
   1 %; on the guest side the IRQ entry/exit (`rebuild_hflags_a32` +
   `arm_rebuild_hflags` + `cpsr_write` + `switch_mode` +
   `arm_cpu_do_interrupt`, ~3.5 %) — a per-mode cache of the hflags
   would need every cp15 write to invalidate it, not attempted.
   **0052 took the per-TB dispatch loop** (row 0052, +3.5 %).  What a
   TB entry still pays, at ~17 M entries/s: the icount decrement (load,
   sub, brcond, store — the timing model), the chain jump (three loads,
   two compares, `return_call_indirect` through the shared table with
   V8's signature check), and the guest register loads/stores from
   `env` (TCG's design).  **Both chain-jump ideas are closed by
   inspection (2026-09-14), do not retry them blind**: a direct
   `return_call` for same-batch targets cannot be emitted, because the
   chain slot is patched by `tb_add_jump` at *runtime*, long after the
   module is compiled — the target is simply not known at emission (it
   would take a fixup of the staged member bytes at batch-assembly
   time, a much larger design); and the per-exit `fidx` load cannot be
   dropped in favour of the `reset_addr` compare alone, because
   `w64_batch_evict_oldest()` makes eviction real — a boot reads
   `ensureN 0`, but a long run (the phone's 177 s stopwatch) is exactly
   where the cap bites.
   **0054 took the per-word MMIO dispatch decision** (row 0054): the
   destination write's validity/endianness/ioeventfd/split work is a
   function of the region and the width only, so it is now decided once
   per translation window.  Bigger TBs are not
   available: the firmware branches every four instructions.
   **2026-09-14, re-checked on the 0054 profile and nothing new found
   — three candidates sized and all rejected before building.**
   `dif_tx_from_fifo` is still the largest single non-guest symbol
   (1152 ms of 20.3 s, 5.7 %) but its `while` runs **once per call** in
   the display path (one word per request), so hoisting to the loop
   head buys nothing, and the per-word decodes it inlines are cheap
   ANDs/shifts whose one real candidate (`dif_get_bsconf_word_count`)
   keys on `tx_csreg`, popped from a parallel FIFO *per word* — a cache
   would need a config generation plus a `tx_csreg` compare for maybe
   half of 5.7 %.  `dif_mux` is already 0047's table lookup (four loads
   + ORs).  `dmac_timer_reset`'s "8 channel passes per word" overstates
   it: seven are two bit tests each (`ch->config`/`p->config` ENABLE),
   so most of its 1.9 % is the *active* channel's real work and a
   channel bitmask would buy a fraction of it.  The chain really is a
   tail of 1–3 % items with no single removable piece — the 0051 note
   below said so and a fresh profile agrees.
   Earlier list (profile `prof-stopwatch-0049`, per word):
   `dif_tx_from_fifo` 4 % self, `pmb887x_srb_set_event` 2.3 % (two
   events per word — the TXBREQ set from `dif_tx_fifo_req` and its clear
   from the DMA acknowledgement, each through the `irq_router` and
   `event_handler` indirect calls), `dmac_write` 2.1 %, `qemu_set_irq`
   1.8 % (~8 calls per word), `dif_trigger_dma` 1.7 % (5 passes per
   word), `dmac_timer_reset` 1.4 % (8 channel passes per word),
   `ssi_transfer_raw_default` 1.3 % and `lcd_transfer` 1 % (two indirect
   calls per byte), `access_with_adjusted_size` 1.1 %.  Each is small;
   the sum is the ~30 % that is left of the chain.  A structural cut
   would have to collapse the per-word request/acknowledge dance into
   one pass per burst without changing what the guest can observe
   between words (the request bits in `RIS`, the VIC line, the FIFO
   level) — not attempted.
8. **ke800 stalls at the LG logo when booted as the first page of a
   browser — CLOSED by 0049 (2026-09-13).**  It was not a guest wait:
   the profile of the stalled page (`ke800probe` + `wprof2.mjs
   PROF_ATTACH`) showed the vCPU thread 94 % in `futex_wait` and the
   main-loop thread 100 % busy in `gptu_t2_sync_timer` /
   `gptu_t01_add_ticks` / `timer_mod` / `emscripten_get_now`.  The LG
   firmware chains GPTU T1A..T1D into one 32-bit timer clocked at 26 MHz
   and the GPTU model armed its QEMU timer at every 8-bit overflow of the
   free-running byte — ~100 k main-loop callbacks per second, each ~10 µs
   of JS clock imports, each holding the BQL.  Natively that is a few
   percent of one core; in wasm it saturates the main-loop worker and the
   vCPU starves (~40 k guest insns/s).  Why a warm third page usually
   survived the same storm is not established (a warm JIT needs fewer
   vCPU cycles per phase, and host load moved between runs); what is
   measured is the storm itself and that 0049 removes it (`gptuTimer`
   counter).  0049 steps the chain lazily and arms the
   timer for the next *observable* overflow only (§ What landed).
   `bootcheck` now requires ke800 to reach 1.5 G, and `idlebench --board
   ke800` measures its boot to the idle screen.

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
- **wasm64 batching invariant**: every translated TB must be staged in
  an open batch (`w64_batch_begin_tb` at TB start, 0053).  A TB that
  runs from a per-TB temp module works in Chrome and silently eats
  Firefox's ~16 k-module budget; `ffboot.mjs` prints the surplus as
  `temp=` and `diagall.mjs` has it as MOD_COUNT − CLOSE_N − COMPACT_N.
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
redraws, and is healthy there.  KE800 additionally has to reach 1.5 G
instructions by the deadline (added 2026-09-13): a guest parked at the
LG logo by the pre-0049 GPTU timer storm still executed ~10 k
instructions per second, which the "no progress" rule read as progress,
and the gate said PASS at 590 M for a whole session.  The LG logo is a
~15 s real-time wait (the firmware busy-polls the system timer), so the
count at the logo scales with engine speed — ~0.6 G on a cold wasm page,
2.5 G natively — and the idle screen follows ~1.3 G later.

Post-mortem material (added 2026-09-13): a firmware `>>EXIT<<` now leaves
the serial tail in `tests/results/bootcheck-<dist>-<board>-serial.txt`
(the panic text trails the marker and arrives a moment later, so the
gate waits for it), and `--query "trace=dsp,scu&tracebuf=1"` saves the
page's buffered device trace per board next to it — a trace diff between
a failing and a passing boot is how a timing-sensitive panic is pinned
down. Boards run as consecutive pages of ONE browser in `--flash` order,
which is itself a test condition: the second page loads the wasm from
the cache and starts at full optimized speed, so a race can show up in
the s75→el71 order that never shows with el71 alone. Repeat a
single-sample result before believing it — the 2026-09-13 EL71
`Prefetch_Abort` reproduced 3/3 on one build and then 0/2 on the same
bytes.

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
**`RT=ship`** goes one better: it omits `&rt=` from the URL entirely, so
the page picks its own built-in default and the tool cannot go stale the
next time that default changes — which it since has (`banked:30`).
Spelling the default out in the benchmark invocation would have
reintroduced exactly the blind spot this section is about.  `RT=banked`
stays the *stable* leg to A/B engine work against, because `RT=ship`
numbers straddle the banked→strict switch.
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

## The cap now has two phases: `banked:30` (2026-09-15)

`banked` is the right mode *during* a boot and the wrong one after it.
The credit that lets a compute-bound boot catch up as fast as it can is
the same credit that lets a later stall — a backgrounded tab, a host
hiccup — be repaid by sprinting the phone's clock and animations.  So the
shipping default became **`banked:30`**: banked until the guest has run
30 seconds of its own clock, then strict for the rest of the run.  Plain
`banked` and `strict` stay pinned, so the ladder above and every
historical A/B keep their meaning.

Two things worth keeping:

- **The window is guest time, not wall time.**  The boot costs ~42 s of
  virtual time on every host, but 39 s of wall on the reference machine
  and minutes on a phone.  A wall window would therefore expire mid-boot
  on exactly the slow machines banked exists to protect, forfeiting a
  large unspent bank.  A guest window also costs nothing to implement —
  `icount_rtcap_excess_ns` is already handed a virtual-time value, so the
  test is one compare against a constant with no extra clock read — and
  it is not consumed by a pause.
- **The switch needs no re-anchor.**  strict's branch only fires when
  `vtarget < allowed - SLACK` and then sets `allowed = vtarget`, so
  strict's `allowed` is never greater than banked's:
  `excess_strict <= excess_banked` in every state.  Flipping can only
  shorten a sleep, never lengthen one.  Either the guest is lagging and
  the branch discards the bank on the same call, or it is inside the
  slack band and the flip is a literal no-op.

Measured on the reference host (`dist-jit`, S75v40lg1): the switch lands
at wall ≈30.7 s with `v = 30.2 s` — the guest is pinned at the cap by
then, having just spent its bank through the display-DMA warp stretch
(`v` 4.2 → 30.2 in ten seconds, v/wall 2.58), so the flip is the no-op
case and `tIdle` is unmoved.  Afterwards v/wall settles at 1.00.

The page side: the status pill's `slow` warning is suppressed while the
cap is banking, because v/wall is below 1 there *by construction* — the
guest is behind and allowed to catch up, so the warning fired on every
boot and meant nothing.  The HUD strip keeps its real colours.  The HUD's
`lag` also re-anchors at the switch: strict *forgives* the debt instead
of paying it back, so carrying the boot's 16 s of lag past the switch
would show an amber token for a debt that no longer exists.

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
4. Patch → rungs 0–2 → keep/revert → gates (**every rung 3–7 for a
   backend change — Firefox included; Chrome hides module-budget bugs**)
   → commit on the qemu branch with the measured numbers, push, bump the
   pin.
5. Update the tables here (landed/rejected/remaining), the commit
   list in upstream-branch.md, and lessons.md when something was
   learned the hard way.
