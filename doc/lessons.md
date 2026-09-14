# Lessons learned

The conclusions of the investigations that shaped the current design,
kept without the investigation records. Each item is a rule, the reason
for it, and how it was established. The live working rules for perf
work are in [optimization-playbook.md](optimization-playbook.md); this
file is the "why" behind them and behind the timing model.

## Timing model

- **Siemens firmware needs virtual time decoupled from wall time.** The
  L1↔DSP handshake and other firmware budgets are wall-clock budgets in
  guest terms; on a host slower than the phone, any model that locks
  virtual time to real time (no icount, or the fork's adaptive
  `precise-clocks=on`) starves the guest of instructions per virtual
  second and the phone aborts with `>>EXIT<< FILE: l1bbcsg`. Locking
  the clock to a fixed 104 MHz fixed it, and stock `-icount
  shift=3,sleep=off` does the same with no fork-specific code — that is
  the shipping model. Correctness must never depend on execution speed;
  the lockstep gates enforce it.
- **`sleep=off` is the indispensable half.** With `sleep=on` the vCPU
  parks in real time during every idle window while execution runs far
  slower than 1×, and the half-host-paced DSP handshake desyncs:
  `shift=3` and `shift=4` with `sleep=on` both die with the same L1
  abort, in the browser and natively. `sleep=off` makes idle
  deterministic (virtual time jumps to the next deadline).
- **The idle warp then needs a real-time cap** (0032, `banked`): with
  `sleep=off` a halted guest's clock and animations run ahead of wall
  (~3.7×). The cap sleeps only on idle overrun, never on the
  compute-bound boot. Native has no cap by default, so native and web
  agree on the timing model and disagree on pacing.
- **LG firmware needs no icount at all** and boots on the realtime
  clock; the page and `run-native.sh` omit `-icount` for `lg-*`. Those
  boards are therefore the only coverage of the non-icount timer/idle
  paths (0035/0037 were found that way) and are not deterministic
  enough for digest comparison.
- **Any `>>EXIT<<` on serial means the phone crashed.** Do not wait for
  recovery; stop there.
- **Virtual time outrunning instructions kills the boot** (BROM delay
  loops). Never "fix" pacing by pinning clock frequencies.

## Mid-TB MMIO and the io-recompile rewind

- **Skipping `cpu_io_recompile` changes virtual-clock visibility, not
  just cost.** The rewind's longjmp costs ~150 µs on wasm and the
  firmware's poll loops hit it constantly, but simply skipping it moved
  the clock a device callback sees mid-TB and the boot ROM's GPTU SRC7
  poll then read its timer as not yet expired → `>>EXIT<< FILE: flash
  0x0552` within seconds. The rework (0004) keeps the rewind's clock
  semantics and drops only its repeated cost: the k-th io access of a
  TB sees `T0 + (k-1)`, the remainder is credited at TB end including
  the partial-TB cycles the stock path loses. Acceptance test: SRC7's
  SRR sets at the same virtual instant as stock.
- **ROM-device (flash command) accesses must keep the stock rewind.**
  Flash commands toggle romd mode and invalidate the executing
  flash-backed TBs; without TB serialization the BROM's program/verify
  handshake aborts. Those accesses are rare, so the longjmp is free
  there. 0014/0036 keep barrier insns in single-insn TBs so the rewind
  stops recurring on status polls.
- **Dead ends, all reproduced the abort or worse**: splitting TBs at
  known io PCs (wedged the emscripten runtime ~120–165 M insns in),
  crediting mid-TB at the access (+34 µs ahead of stock by the flash
  phase → abort), prefix-drop crediting (loses per-io +1 visibility →
  abort), wall pacing per io access (not a wall-time race), a DSP core
  mutex (a real race in the fork, but not the cause).
- **The rewind's unwind data is only as good as the recorded retaddr.**
  The wasm64 backend recorded it before emitting the helper call, so
  every mid-TB unwind resolved one insn early; only EL71 (the only
  fullflash that programs flash during boot) reached the consequence
  (0034). `one-insn-per-tb` hides this class of bug, which is why the
  lockstep gate stayed green.

- **A direct-mapped fix-once cache can thrash into a fix-never loop**
  (0056, 2026-09-14).  The io-barrier set was 64 slots indexed by
  `(pc >> 2)`; on the LG boards, which take this path for *every* mid-TB
  MMIO because they run `icount=none`, two hot MMIO insns shared a slot
  and evicted each other on every pass.  Nothing was ever kept out of the
  middle of a TB, so each pass paid an unwind + `tb_phys_invalidate` +
  retranslation + a wasm module — ~800/s, which caps the board at about
  one TB per recompile (~1 MIPS) whenever it has work.  Two consequences
  worth carrying: `(pc >> 2)` aliases adjacent **Thumb** insns onto one
  slot, and a path with no counter is a path nobody can see — `ioRewind`
  counted only the ROM-device branch, so the LG branch was invisible for
  as long as it existed.  `ioRecomp`/`ioBarrierEvict`/`ioBarrierSplit`
  now cover it.

## The board you measure is the board you fix

- **Rounds 4–9 optimized the S75 because that is what the meters
  measured.**  When the user reported EL71 and KE800 "very much behind",
  both turned out to be mechanisms that no S75 meter could see: the LG's
  io-recompile thrash (0056) needs `icount=none`, and the EL71's subpage
  MMIO re-dispatch (0057) needs a *hot register in a region smaller than
  a target page* — the S75's hot register is in the TPU (`0x2000`, whole
  pages), the EL71's in the STM (`0x30`).  Nine rounds of S75 profiles
  contained no `subpage_*` symbol at all.
- **The display cost scales with the panel, and only two of the three
  boards are 240×320.**  S75 is 132×176 (ssd1286), EL71 (jbt6k71) and
  KE800 (r63400) are 240×320 — 3.3× the pixels through the same per-byte
  `ssi_transfer` → `lcd_transfer` chain, and the LCD data path is one
  byte per call regardless of panel.
- **`tools/uibench.mjs` is the per-board meter** (`--board s75|el71|ke800`,
  `--state idle|menu|both`).  Use `--settle <s>` rather than its rate
  detector whenever runs must be comparable: a boot has compile-bound
  stretches that read as "quiet" and end the wait 100 s early.
- **On an `icount=none` board v/wall is 1.0 by construction**, so MIPS and
  fps are the numbers; and a low idle MIPS there means the guest is
  halted, not starved — check `halts/s` and the recompile counters before
  reading it as a problem.

## Emscripten runtime

- **Asyncify breaks cross-worker `pthread_cond` wakeups**: signals from
  another worker are never delivered, waiters return only by timeout
  (20-line emcc reproducer). Every QemuCond/QemuEvent wake degenerated to
  a timeout. Fix: futex-based condvars on emscripten
  (`emscripten_futex_wait/wake` is Asyncify-safe). The untimed wait must
  really wait — a 0 ms timeout is an immediate return, and that spun the
  vCPU halt wait on the BQL for weeks (0021).
- **`poll()`/`ppoll()` never sleep** on the browser main thread (the
  timeout is ignored); the main loop busy-spun ~23k iterations/s through
  a proxied syscall until replaced by a futex wait (0009). Condvar timed
  waits are whole-ms; `emscripten_futex_wait` has ns precision and is
  the right sleep primitive.
- **Proxied syscalls are ~1 ms round trips**: event notifiers doing
  eventfd `write`/`read` paid that per icount deadline (0021). Realtime
  clock reads are JS imports (~3 µs) and do not belong in the vCPU's
  budget loop (0025).
- **wasm-EH longjmp and ASYNCIFY do not compose** (binaryen's Asyncify
  pass crashes on `-sSUPPORT_LONGJMP=wasm`); ASYNCIFY is required for
  the coroutine backend, so every `cpu_loop_exit` is a ~15 µs JS
  exception unwind. Hence SVC exceptions delivered without the longjmp
  (0013) and WFI without it (0025).
- **Asyncify instrumentation must be an allowlist on the wasm64
  backend**: `ASYNCIFY_REMOVE=tcg_qemu_tb_exec` instrumented ~21k
  functions through the `invoke_*` wrappers (~25 % of early-boot vCPU,
  17 MB). `ASYNCIFY_ONLY` of the functions seen on a real switch stack
  cut the wasm 45 → 28 MB and tIdle −18 % (0031). The TCI dist is the
  opposite: its hot path *is* the interpreter and the onlylist regressed
  it +26 %, so the override is wasm64-only. Prerequisite: no block
  coroutine may run on the vCPU thread (a vCPU-thread `blk_pwrite`
  cannot unwind a JIT frame — deferred to a main-loop BH).
- **Emscripten exit from deep vCPU context trips "function signature
  mismatch"** — use the dispatcher's stop path (return-code unwind, then
  exit); never `exit()` from inside a chain. `mod.FS` on the browser
  main thread sees files the proxied program thread created (how the
  drivers poll `/serial.log`).
- **Firefox caps live wasm modules (~16k)** and does not treat code
  memory as GC pressure; a periodic throwaway allocation keeps its
  worker GC collecting dropped modules (0019).

## TCG / backend design

- **A wasm JIT only pays off if TB-to-TB control flow never leaves
  wasm.** The first attempt (a port of the ktock/qemu-wasm wasm32
  design: TCG regs as wasm globals, one `WebAssembly.Module`+`Instance`
  per TB, a C dispatch loop between instances) measured a ~1.3–2.3×
  ceiling over TCI on this 3–4 insn/TB busy-polling firmware and was
  discarded. The redesign that shipped (tail-call chaining through a
  funcref table, regs as locals, batched modules) is
  [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md); its §1 records
  what the failed attempt proved.
- **Value-level correctness needs its own harness.** The wasm32
  attempt's killer bug was a data divergence with an identical PC
  stream for 470k+ TBs; PC tracing cannot see that class. Hence the
  guest op-suite (byte-identical dumps across backends) and the lockstep
  digests, built *before* the backend.
- **TCI's `goto_tb` slot holds a code pointer, not a TB pointer.**
  Returning it to `cpu_exec` made `tb_add_jump` cmpxchg into the
  bytecode buffer → unaligned-access trap at TB #6.
- **Speculative translation must probe non-faulting.** The first
  speculative build recorded a Thumb `blx` target as a successor;
  `tb_htable_lookup` calls the faulting `get_page_addr_code`, ARM's
  tlb_fill flags a `pc & 3` fetch as an alignment fault, and the guest
  got a prefetch abort at the miss pc. Probe target + next page before
  any lookup; a miss skips the target.
- **Inline code is Liftoff code; a helper is TurboFan code.**  An
  inline TB-lookup test of a dozen loads and six branches lost to the
  helper it replaced (+2..+4 % at an 84 % hit rate); the same cache
  comparing two or three words wins.  Anything moved from a C helper
  into emitted wasm must be a handful of ops to break even, and a key
  the translator can stamp statically (hflags cannot change without
  ending the TB) should not be compared at run time at all.
- **Per-TB overheads amortize over almost nothing** on this workload
  (3–4 insns/TB, ~90k MMIO dispatches/s in poll phases). Per-access and
  per-wake costs are the ones that scale; any per-access condition added
  to a hot path must pay for itself at that rate (this is how a
  memory.c runtime dispatch cache was rejected while fill-time
  resolution in the iotlb entry, 0018, reached native parity).
- **A generation-agnostic interpreter tier is not free either**: TCI
  micro-optimization reached its floor with 0007–0016; the wasm64
  backend supersedes it and TCI stays as the reference/oracle tier.
- **Native builds of the series must link**: `wasm_diag_stat` defined
  in `tcg/tci.c` (TCI-only) but referenced from always-compiled cputlb
  broke every native build for days. Build natively before publishing.
- **qemu-11 outop machinery**: backends get immediates via
  `tcg_target_const_match` + `out_rri`/`out_ri`/`out_i`; a bare const
  constraint letter with no register class trips
  `get_constraint_priority`'s assert at boot. TCI extra opcodes are
  appended per patch; `#ifdef __EMSCRIPTEN__` blocks in
  `tcg-target-opc.h.inc` shift numbering between builds.
- **The TCI TB layout**: every TB starts with `tci_tbhdr`; anything that
  jumps into a TB must land on the header.

## Measuring

- **Read the milestones, not tIdle.** tIdle sums phases with opposite
  signs: the JIT once lost ~9 s early and won ~11 s late, and "parity"
  was reported for a day while users saw 86 vs 78 s. Decide on
  t0.5G + window for boot work, ns/access mirrors for device-path work.
- **The benchmark must measure what ships.** idlebench hardcoded
  `rt=off` for a week while the page shipped `rt=banked`; the two are
  identical through t0.75G and then +33 % apart. If the page has a knob,
  the benchmark must be able to set it, and a knob A/B must be
  interleaved in one invocation (`<dir>@<query>`).
- **A/B in one invocation against a saved dist**, never against
  yesterday's absolute numbers on a shared host; ratios inside ±10 %
  need the pair repeated with the order swapped; below ~3 % go straight
  to n=4 — intermediate answers change sign.
- **Spend the first invocation on a null A/B** (the same bytes in both
  legs).  On 2026-09-13 it showed the leg listed *second* reading
  +2..+3 % slower on every milestone with identical wasm, and the same
  bytes moving 14 % between two invocations an hour apart as the host
  quietened.  A candidate at ±3 % in one position is indistinguishable
  from that bias; knowing its size is what makes the swapped-order
  repeat conclusive instead of another coin flip.
- **Rebuild both sides of an A/B the same way, or the baseline lies.**
  2026-09-13: the session baseline was built by `ninja-fast.sh` on a
  clean tree at the pinned rev — but over a `build/qemu-wasm64/` left
  mid-state by the previous session.  That binary ran ~5 % slower than
  any clean build of the same source, and a candidate measured −4 %,
  −2 %, −6 %, −6 % against it across four invocations **in both
  orders**.  It was flat against a clean baseline.  Swapping the order
  cancels position, not a bad baseline; nothing in the ladder catches
  this except building both sides symmetrically.  For a keep/revert
  that matters, build each revision in a pristine `git worktree` with
  its own build dir and run `--runs 4`.  Hashes will differ between
  build dirs for identical source (absolute paths are embedded), so
  confirm *which code* a dist contains from behaviour — a known
  signature like the `-accel tcg,tb-size=8` SOURCE-CORRUPT control —
  not from the hash.
- **An inspection-only rejection is a hypothesis** — but it can also be
  right.  "Widening the TB jump-cache entry" was rejected by inspection
  in 2026-09-12, looked wrong (the argument counted cache *lines* and
  ignored *residency*), was built in 2026-09-13 — and measured flat, as
  originally claimed.  Re-opening it was still correct; the cost of
  being wrong was one patch, and the run is what found the phantom-win
  trap above.  Mark inspection-only rejections as such, and re-measure
  rather than argue.
- **A profile share is CPU time, not removable wall time.**  The
  lookup path was 12.6 % of the vCPU mid-boot; 0046 removed ~80 % of
  the helper calls and the boot milestones did not move, while the
  lookup-bound J2ME workload gained 7–9 %.  Measure a change on the
  meter whose workload is bound by the thing you removed, and expect
  the boot — compile-bound early, virtual-time-bound late — to shrug.
- **Prove a new fast path ran before measuring it.**  0044's
  devirtualised lookup was guarded by `CONFIG_TARGET_ARM`, a macro no
  build defines (accel/tcg is target-independent and poisons
  `TARGET_*`), and was never compiled in; a counter (`lcFill` staying
  0) is what exposed it two days later.  A `#if defined(...)` typo
  produces no warning, no test failure and a plausible A/B.
- **The second-listed idlebench leg read +3..+5 % slower whichever
  build it was** on 2026-09-13 (t0.1G +27..31 %), larger than the
  +2..+3 % recorded earlier that day.  A single pair cannot see a ±5 %
  effect; both orders are the minimum, and a knob leg in the same
  invocation (`dist@env=...`) shows the bias directly.
- **Beware a cost model built from per-unit costs × counts.**  "176k
  TBs × 38 µs translation" put translation at ~20 % of a boot and drove
  the whole "emitted code volume" workstream; the profiler says 3–4 %.
  Per-unit microbenchmarks do not compose with counts when the work
  overlaps other work or the counts came from a different build.
- **Counters over profiles.** The profiler attributed 30 % to a halt
  wait the counters showed was reached <1k times; `tcg_qemu_tb_exec`
  self time is misattributed guest code; `io_failed ← cpu_io_recompile`
  stacks had zero transaction failures; `helper_lookup_tb_ptr` self
  time covered inlined `tb_lookup`; parked workers show
  `emscripten_fiber_init_from_current_context` when they are in
  `emscripten_futex_wait`; sample counts are not CPU for parked threads
  and V8 function indices include imports
  ([wasm-threads-audit.md](wasm-threads-audit.md)). Add a cold counter
  before chasing a frame.
- **Remove measurement scaffolding before the final A/B**: two
  `g_get_monotonic_time` calls per commit (JS round trips) cost ~0.4 s
  per boot and masked part of a win.
- **Signature-check both ends of an A/B**: a "baseline" dist that was
  really an intermediate build cost two full rounds; a copied site root
  without the page files boots nothing but prints plausible console
  output from a previously open page.
- **Host-load bimodality hides wins**: a candidate that removes the work
  that made the baseline *unstable* reads as "flat" on a noisy host —
  look at variance too.
- **Stale `.symbols` sidecars poison wprof2 profiles**; refresh them
  with every deploy (the deploy scripts do). Never plain-`cp` over a
  live-served wasm — a torn file gets served.
- **Diag counter indices are positional**; re-derive them from the
  header after every enum edit (two measurements were read against a
  stale mapping).
- **Single-run knob sweeps on this host are noise at ±5 %**; only
  interleaved pairs decide. The compaction threshold has failed to move
  twice — stop sweeping it.
- **Every TCI/longjmp patch of the early series was individually
  removal-tested** (2026-09-09): each costs 15–40 % of the window or
  collapses the boot when removed; the only removable surface was the
  diagnostics-counter patch, which was dropped. Removal testing is
  worth the day.
- **Profile the workload the meter measures, in the state it measures**
  (2026-09-13, 0047): the boot profile ranked the lookup path first and
  it moved the stopwatch +8 %; a profile of the *running stopwatch*
  (`stopwatch.mjs --devtools --hold` + `wprof2.mjs PROF_ATTACH=`) put
  a device table rebuild first at 12.7 % and that batch moved it
  +34..+60 %.  On a device path, look for work redone on every register
  write before work done per word — a per-write rebuild the firmware
  triggers per LCD command out-costs the whole per-word chain.
- **Check `uptime` and swap before every A/B, and again after** (2026-09-13,
  0048): a both-orders boot pair read the new build 2..9 % slower while
  the host's load average sat at 6–7 with 19 GB in swap from other
  sessions; the 40 s counter samples taken minutes later showed the same
  build doing 13 % *more* guest work than the baseline in the same wall
  time.  Both-orders agreement cancels position, not a load that moves
  during the pair.  Also: `ps` %CPU of a zombie is its lifetime average —
  six "busy" headless Chromes were all state Z; use `top`/STAT before
  blaming leaked browsers.
- **A gate that reports PASS at a fraction of the usual progress is not
  a gate**: ke800 passed bootcheck at 590 M instructions where the same
  build normally reaches 1.9 G.  Read the numbers in the table, not the
  verdict column.  (Fixed 2026-09-13: the gate now needs 1.5 G from
  ke800, and `idlebench --board ke800` measures that boot.)
- **A "stalled" guest may be a starved one — profile every thread, not
  the vCPU** (2026-09-13, 0049): the ke800 first-page stall looked like
  a firmware wait (pc cycling through a small loop, ~40 k insns/s, no
  serial), and every guest-side theory (keys, DSP, a real-time timeout)
  was wrong.  The attached profile showed the vCPU worker 94 % in
  `futex_wait` and the *main-loop* worker 100 % busy running one device's
  timer at ~100 kHz under the BQL.  A device model that is cheap natively
  (a QEMU timer per 8-bit counter overflow) can be a denial of service in
  wasm, where a timer callback costs ~10 µs of JS clock imports; the
  price of one QEMU timer firing is ~200× higher than native, so any
  model whose deadline is "the next hardware tick" rather than "the next
  event somebody can observe" needs the lazy-stepping treatment
  (`gptu.c`, `gptu_t01_ticks_to_boundary`).
- **A trivial function with a big self time: read the compile line before
  the code** (2026-09-13, 0050): `dmac_transfer_memory` read 7.5 % of
  the vCPU in the J2ME profile for moving one 4-byte word.  QEMU's
  meson adds `-ftrivial-auto-var-init=zero`, so its 16 KB stack buffer
  was zeroed on every call — ~480 k × 16 KB per second, all of that self
  time.  `QEMU_UNINITIALIZED` exists for exactly this; any large local
  array in a per-word or per-access path needs it (grep the device
  models for `[N * 1024]`-sized locals when a function's self time does
  not match its source).  Native pays the same memset, only faster.
  Second lesson from the same profile: `OBJECT_CHECK` casts still call
  `object_dynamic_cast_assert` for their trace point with
  `qom_cast_debug=false`, so a checked cast per transferred byte
  (`ssi_transfer`, `lcd_transfer`) is a real call — a plain cast where
  the type is guaranteed by construction.
- **Memoising a device callback: check re-entrancy first, then check
  the profile, not the meter** (2026-09-13, 0051).  Two "skip if the
  inputs are unchanged" caches went into the DIF's per-word path.  The
  one on `dif_trigger_dma` blanked the display on all three Siemens
  boards (native suite caught it): driving a request line re-enters the
  function through the DMAC's CLR handler, the nested call drove the
  lines from the fresh inputs, then the outer pass finished driving them
  from the stale ones — with the fresh key already stored, the next call
  was skipped and the lines stayed wrong.  Before this the redundant
  trailing calls were what repaired it.  A re-entrancy guard fixed the
  bug, and the profile then showed the cache never hits anyway (the key
  differs on every call of a word's raise / acknowledge / release
  sequence; self time went up 299 → 462 ms), so it was dropped.  The
  cache on `dif_update_gpio_state` (no re-entrant consumers) halved that
  function.  The stopwatch meter cannot resolve a 1–2 % change (±5 %
  drift); a 20 s profile can — compare the touched symbols' self time
  and the category totals.
- **On the JIT side the shape of the control flow moved the meter where
  byte counts never did** (2026-09-13, 0052).  Three earlier backend
  experiments that removed emitted bytes or memory ops per TB (prologue
  counters, the `$tlb` hoist, compaction) were flat or regressed.
  Replacing the per-TB dispatch `loop` + sibling-`if` label regions with
  nested forward blocks (no `$bp`, no per-label compare, no loop phis or
  loop stack check for V8) read +3.5 % on the stopwatch with the JIT
  share of the profile down and the device share flat.  Before changing
  what a TB emits, dump the ops (`-d op_opt` on the native build) and
  count: the S75 firmware is 4.0 insns / 26 ops / 1.5 labels per TB with
  no backward branch, which is what made the nested scheme possible.
- **A gate that exists but is not in the ladder does not run** (2026-09-13,
  0053).  `tools/ffboot.mjs` (the Firefox boot) had existed since 0019 and
  was in diagnostics.md, but not in the playbook's gate table or the
  session checklist, so nine commits — the whole review session and rounds
  two to six of the perf sessions — shipped with Firefox dying at the
  Siemens logo.  The user found it on the phone.  Every browser the page
  claims to support is a gate rung; a backend change runs all of them.
- **A side effect nobody wrote down was load-bearing** (2026-09-13, 0053).
  The open batch was created lazily inside the union-type registration;
  the only unconditional caller was the lockstep import in every TB
  prologue.  The prologue cleanup removed that import ("measured flat")
  and from then on ~20 % of TBs — those without a helper call translated
  right after a batch close — ran from throwaway per-TB modules.  Chrome
  did not care.  Firefox's module budget did.  When removing "measurement
  scaffolding", list what else the removed call did; and make invariants
  explicit calls (`w64_batch_begin_tb`) rather than consequences of
  something else.  Corollary for the numbers: the cleanup's own "flat"
  verdict compared a build with temp modules against one without, so the
  bytes it removed were worth more than measured; the JIT-side
  experiments after it (the `$tlb` hoist, compaction-off, 0052) had the
  temp modules in both legs and stand as measured.
- **A counter that would have shown the bug existed and nobody compared
  it**: `MOD_COUNT` vs `CLOSE_N + COMPACT_N` was in every `diagall` dump
  since 0019.  Invariants between counters belong in a tool's output as
  one derived number (`ffboot` now prints `temp=`), not as two columns a
  reader has to subtract.
- **Counter indices come from the enum with its `= 0` first entry**:
  a `grep -c` of trailing-comma entries undercounts by one and the
  first readings then carry the wrong labels (a "500 k mux rebuilds/s"
  that was really the DMA burst count).  Cross-check a new counter's
  rate against something already known before believing it.
- **A change can be right and unmeasurable.**  0054 removed two symbols
  from the profile outright and moved ~2 points of vCPU share, and both
  wall-clock meters read flat — ten alternating stopwatch samples inside
  a baseline spread three times the effect, idlebench showing only the
  order bias.  That is a legitimate keep (0051 set the precedent), but
  it has to be *reported* as flat: the +1.4 % in the sample means is not
  a result, and writing it up as one is how a "win" that is really noise
  gets into the record.  When the profile and the meter disagree at this
  size, the profile is the finer instrument and the meter is the veto —
  neither is the headline on its own.
- **Know when a tail is finished.**  After 0047–0054 the device chain is
  a list of 1–3 % items, each under the meters' resolution.  Grinding
  further down it buys less than it costs to verify; say so in the
  hand-off rather than leaving the list looking like open work.
- **When the speed meters cannot resolve it, measure the mechanism.**
  0055 was flat on all three timing meters, but `diagall`'s
  `tbBytes`/`tbGen` gave emitted bytes per TB with a **0.04 %**
  run-to-run spread — tight enough to prove the change did exactly what
  it claimed (−3.7 %) while saying nothing about speed.  That is the
  honest shape of the result and it is worth landing on, but only if
  you write both halves down.  A mechanism meter answers "did my change
  happen"; it never answers "did it help".
- **A negative result that closes a direction is worth a round.**  0055
  removed bytes *and* executed ops and bought nothing.  That matters
  more than the commit: the 2026-09-13 hoist had removed bytes and cost
  +3..+10 %, which left "maybe it was register pressure" open.
  `local.tee` only shortens a live range, so it cannot be that — and it
  is still flat.  Two experiments pointing opposite ways at the same
  hypothesis are what actually closes it.  Size a candidate before
  building it: three device items were rejected on the profile alone
  this round, which cost minutes instead of hours.
- **Check the tool's units before you diagnose with it.**  `ps`'s
  `%CPU` is a lifetime average; a benchmark browser that has already
  exited still shows "54 %", and reading that as live contention
  produced a confident, wrong "every leg leaks a browser" claim that
  had to be retracted a minute later.  `top -bn1` or the `R`/`D` states
  say what is running *now*.  Same trap one line over: loadavg rising
  through a long A/B is the 1-minute average accumulating, and on a
  32-core host loadavg 4 is ~12 % utilisation, not contention.

## Gates

- **Boot one fullflash per class, not one fullflash.** S75 was the only
  browser boot anyone watched for the whole 0019–0032 run; EL71 (the
  only one that programs flash during boot) and KE800 (the only one
  without icount) each hid a distinct bug the whole time while the
  native suite stayed 4/4. The three-fullflash browser gate
  (`tools/bootcheck.mjs`) is part of every final gate.
- **The native suite is blind to every emscripten-gated change**, and a
  lockstep gate that forces `one-insn-per-tb` cannot see multi-insn-TB
  bugs. The TCI dist is the oracle for JIT-only failures: diff the same
  device trace between the two engines.
- **A stale `boards.tar` looks exactly like a qemu-side regression**
  (board settings such as `[rtc] format` silently revert); every deploy
  path repacks it.
- **Any change near timers/halt/rr** also needs the precise-clocks smoke
  (`?icount=precise-clocks=on` must keep v advancing) — icount2 runs
  due timers synchronously inside `timer_mod`, and virtual-clock device
  completions stalled it once.

## pmb887x facts worth knowing

- The RTC `CNT` register is one linear Unix-seconds counter to Siemens
  firmware and a packed calendar to LG firmware; seeding the wrong layout
  produced a 2091 date and a clock jumping +16 min per minute. The board
  config's `[rtc] format` selects it (0033). It was never a wasm or warp
  issue — the pristine native build showed the same.
- The bsp main branch defines an RF peripheral (`hd155153np`) the
  emulator does not implement; `bsp-patches/0001` re-points it at the
  `pmb6272` stub.
- qemu-pmb887x master alone aborts every Siemens fullflash in L1 GSM
  frame handling; the "hacky AFE (LLE+HLE)" DSP commit is required.
- The boot consumes ~42 s of virtual time, ~31.5 s of it idle warp on
  millisecond device timers — after t0.75G the shipping boot is
  virtual-time-bound and no engine speed shortens it; whether that warp
  is the right amount is a fidelity question needing a hardware
  reference.
- The J2ME stopwatch running slow is throughput (the guest never halts
  there: `vratio` = guest MIPS / 125), not pacing.
