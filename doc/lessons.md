# Lessons learned

Platform facts and rules that the design and the measuring method rest on.
Each one was paid for at least once. Figures carry the date they were
measured; the investigations behind them are in this file's git history.
Current methods and numbers are in [performance.md](performance.md).

## Timing model

- **Siemens firmware needs virtual time decoupled from wall time.** The
  L1↔DSP handshake and other firmware budgets are wall-clock budgets in
  guest terms. On a host slower than the phone, a clock locked to real
  time starves the guest of instructions per virtual second and the phone
  aborts with `>>EXIT<< FILE: l1bbcsg`. The page's `vcpu-timers` clock
  counts guest CPU cycles and is paced to wall time, so a slow host slows
  the clock instead. `-icount shift=3,sleep=off` has the same property
  unpaced, and is what lockstep and `scripts/run-native.sh` use.
- **Under icount, `sleep=off` is the indispensable half.** With `sleep=on`
  the vCPU parks in real time during every idle window and the DSP
  handshake desyncs: `shift=3` and `shift=4` both die with the L1 abort,
  in the browser and natively.
- **A catch-up bank must be windowed in guest time.** A guest that fell
  behind during the boot must be allowed to catch up, but the same credit
  later lets a stall be repaid by sprinting the phone's clock.
  `vcpu-timers-bank` is therefore limited to the guest's first 30 s. The
  window is in guest time because the boot costs the same virtual time on
  every host, while its wall time ranges from under 30 s to minutes.
- **LG firmware used to boot on the realtime clock.** Since the DSP LLE its
  DSP boot-ROM poll loop runs on the vCPU thread and starves the ARM in
  real time, so every board runs the same clock.
- **Virtual time outrunning instructions kills the boot** (BROM delay
  loops). Never fix pacing by pinning clock frequencies.
- **Any `>>EXIT<<` on serial means the phone crashed.** Stop there; it does
  not recover.

## Mid-TB MMIO and the io-recompile rewind

- **The rewind is clock semantics, not only cost.** A device callback must
  see the clock of exactly the accessing instruction. Skipping
  `cpu_io_recompile` moved that clock, the boot ROM's GPTU poll read its
  timer as not yet expired, and the phone died with `>>EXIT<< FILE: flash`
  within seconds. Splitting TBs at known io PCs, crediting at the access
  and pacing per access all reproduced the abort.
- **What the port does instead:** the rewind happens once per instruction.
  The PC becomes an io barrier and is retranslated as a single-instruction
  TB (`wasm_add_io_barrier`, A5 in
  [wasm-fast-paths.md](wasm-fast-paths.md)).
- **Whatever a prologue counts, an unwind has to hand back.** The wasm64
  prologue adds the TB's instructions to the page's counter and the
  lockstep fold; only `icount_decr` and the cycle counter were rewound.
  The fold then sampled early by the unrun instructions of every rewind,
  which read as a wasm-only divergence in internal SRAM for a week
  (`w64_acct_unwind`, 2026-11-10).
- **A 32-bit TCG value has no defined upper half in its host register.**
  With `TCG_TARGET_HAS_extr_i64_i32` 0, `extrl_i64_i32` is a move and the
  I32 temp may simply take over the i64 temp's register. A backend
  emitter that widens an I32 operand must extend it itself
  (`w64_get_u32`, 2026-11-10).
- **An op-suite case whose operands are constants tests the optimizer.**
  Superblocks inline the shim into its caller, and the shift under test
  folds away; and while NF/ZF still hold copies of a result, later uses
  read those copies. The case that failed loads its operands from
  volatile memory and overwrites the flags before the use.
- **An op-suite shim that is one TB must not straddle a page.** Adding
  code moved `smc_slot` onto a page boundary and the same-TB SMC canary
  "failed" on the native JIT (`.balign 16`).
- **A fallback that "has not been observed to run" has not been tested.**
  Lowering `W64_LIVE_MAX` to 48 ran batch eviction within seconds and
  aborted in the DSP at 61M instructions. The fix of that day dropped the
  evicted DSP blocks when a slice starts, and a second case stayed: a batch
  that lands in the middle of a slice (the dispatcher closes the open
  batch when a staged block first runs) evicts a block the same slice then
  runs, and DSP blocks are not in TCG's TB tree, so the dispatcher cannot
  retire them (`w64: evicted TB … is not known`; a Firefox boot at a cap of
  128 showed it, 2026-11-10). A boot uses ~450–900 of the 6144 batches,
  but Tower Bloxx adds two or three a second, so a long game gets there.
  Test eviction with a temporary cap of 256 under
  `tools/lockstep-wasm.mjs --insns 1e9`; below ~512 a scene cannot be
  walked, the guest thrashes and drops the keys.
- **A direct-mapped fix-once cache can thrash into a fix-never loop.** The
  barrier set was once 64 slots indexed by `pc >> 2`: two hot MMIO
  instructions shared a slot and evicted each other on every pass (~800
  rewinds/s, ~1 MIPS), and `pc >> 2` aliased adjacent Thumb instructions.
  It is two-way and indexed by `pc >> 1` for that reason.
- **`one-insn-per-tb` hides this whole class of bug**, including a wrong
  recorded return address for the unwind. That is why the default lockstep
  is blind to it (performance.md, Lockstep).

## Emscripten runtime

- **Asyncify breaks cross-worker `pthread_cond` wake-ups.** Signals from
  another worker are never delivered and waiters return only by timeout.
  `QemuCond` and `QemuEvent` are futex-based on emscripten
  (`emscripten_futex_wait/wake` is Asyncify-safe). An untimed wait must
  pass an infinite timeout: 0 ms returns at once and spins.
- **`poll()`/`ppoll()` never sleep** on the proxied main thread, so the
  main loop sleeps in `emscripten_futex_wait` on a sequence word
  (`ml_futex_seq`, `util/main-loop.c`). Condvar timed waits round to whole
  milliseconds; `emscripten_futex_wait` has ns precision and is the right
  sleep primitive.
- **A wake must be published after the work it advertises, and the
  sequence word is an atomic counter.** A non-atomic increment lets one
  waker erase another's wake. A wake issued before
  `qatomic_set(&ctx->notified, true)` in `aio_notify()` is spent on an
  empty look. Either loses an edge, and where the main loop runs the
  virtual timers (`?icount=none`) a lost edge is a dead guest: KE800 froze
  on its splash screen on Android. A race like this cannot be A/B'd on a
  clock. Build a knob that widens the window until the failure is certain.
- **Who runs the timers decides whether a wake is waste.** Under
  `vcpu-timers` and icount the vCPU thread runs virtual timers, and waking
  the main loop for them is pure loss. `qemu_timer_notify_cb` tests
  `qemu_virtual_timers_on_vcpu`.
- **A cross-thread wake costs the BQL round trip behind it**, on the other
  thread: the woken thread takes the lock, finds nothing and parks.
  Deleting 38k useless wakes/s was worth +37 % MIPS on the S75
  (September), which no self-time profile predicted. Size such a fix by the
  wake count.
- **Proxied syscalls take ~1 ms**, and realtime clock reads are JS imports
  (~1.5–3 µs). Neither belongs on a per-timer or per-budget path.
- **Asyncify instrumentation is an allowlist**
  (`configs/meson/asyncify-only.txt`), and it is not free: a state test at
  entry and around every call, plus spilled locals. Seven hot cputlb
  functions on the list turned a +4.1 % patch into −2.5 %. A vCPU thread is
  never on a coroutine switch stack (`qemu_coroutine_forbid_current_thread`;
  `qemu_coroutine_switch` aborts there), so nothing reachable only from the
  vCPU belongs on the list, and no block-layer coroutine may run on the
  vCPU thread (the CFI flash writeback starts from a bottom half).
  `?env=QEMU_COSTACK=1` logs every distinct stack at a switch and
  `tools/asyncify-audit.mjs` reports MISSING and UNUSED entries. UNUSED is
  only a candidate: most unobserved entries serve paths the run did not
  take. The log holds wasm function indices, so resolve it against the dist
  it came from.
- **wasm-EH longjmp composes with Asyncify only while no instrumented
  function calls setjmp.** Keep setjmp callers off the onlylist. The build
  is `-sSUPPORT_LONGJMP=wasm` with the standard exnref instructions
  (`-sWASM_LEGACY_EXCEPTIONS=0 -mllvm -wasm-use-legacy-eh=0`): Firefox logs
  a deprecation warning for the legacy `try`, which the Firefox gate counts
  as an error, and emcc 4.0.10 passes LLVM the switch only for C++
  exceptions. Check with
  `wasm-dis --all-features x.wasm | grep -c '(try_table'`. exnref needs
  Chrome 137, Firefox 131, Safari 18.4.
- **Firefox caps live wasm modules (~16k)** and does not count code memory
  as GC pressure; a periodic throwaway allocation keeps its worker
  collecting dropped modules. Every translated TB must be staged in an
  open batch (`w64_batch_begin_tb`): a TB run from a module of its own
  works in Chrome and eats Firefox's budget. Only the Firefox gate sees it.
- **SpiderMonkey never patches a table slot when a function tiers up**
  (Firefox 155 source, 2026-11-10). A slot written by an active element
  segment or `Table.set` keeps the code pointer of that moment, the baseline
  entry, and every later call through it runs the baseline prologue and hops
  through a jump table to the Ion code. Chained TBs enter each other only
  through the chain table, so that was every TB transition: towerblox ran
  at x0.96 where Ion-only (a pref) gave x1.31, and tiering up sooner (the
  `wasm_lazy_tiering_level` pref, even synchronous) gave nothing.
  `table.init` from a passive segment binds a slot to the best tier of that
  moment and can be repeated, so each Firefox batch carries a rebinder
  (`w64_rebind_live`). Import bindings and exported `JSFunction`s cache the
  pointer the same way and a page cannot refresh those. More facts:
  - Lazy tiering is always on; a page cannot ask for Ion-only compilation.
  - A function asks for Ion after ~20000 entries and loop headers at the
    default level: the baseline code counts down by `size / 20` (1–127) at
    each of them from `(30000 + 4000 × size) / 4`, a third of that in a
    module whose code section is under 150 kB. One Ion compile runs at a
    time, so a scene takes about a minute to settle
    (towerblox: x1.15 over the first 20 s, x1.30 over 80 s, x1.35 with
    tier-up at the first call).
  - The Gecko profiler works headless from the environment:
    `MOZ_PROFILER_STARTUP=1 MOZ_PROFILER_SHUTDOWN=<file>
    MOZ_PROFILER_STARTUP_FEATURES=js,leaf,cpu
    MOZ_PROFILER_STARTUP_FILTERS="DOM Worker,GeckoMain"`. On towerblox
    98.8 % of the vCPU thread was JIT code, so nothing but the tier is
    Firefox's own cost.
- **A build flag in `--extra-cflags` is not on a compile line.** meson gets
  two cross files, and the checked-in `configs/meson/emscripten.txt`
  replaces the generated one's `c_args`, so the C files compile at meson's
  `-O2`. Flags that must not go missing belong in configure's `CPU_CFLAGS`
  (the compiler's own argv), where `-sMEMORY64` and `-sSUPPORT_LONGJMP`
  are. Grep `build.ninja` for a flag you passed. The `-O3` on the link line
  does matter: without it emcc links at `-O0` with assertions and no
  Binaryen pass.
- **An index narrows, a pointer does not.** `-sMEMORY64=2` lowers the
  memory and the table to 32 bits and leaves pointers as i64, so
  `wasmTable.get(BigInt(i))` is a `TypeError`. When a mode switch changes a
  type, audit hand-written JS handles (table reads, `Memory`/`Table`
  construction) as well as the emitted wasm.
- **An `EM_JS` body goes through the C preprocessor.** `??=` is a trigraph
  for `#` and `??(` for `[`, which only warns. Write
  `if (x === undefined)`. `#ifdef` cannot switch code inside the body.
- **NULL does not trap in wasm.** A NULL-pointer bug surfaces as an
  out-of-bounds access at `NULL->field_far_away`, frames away from the
  mistake, after small-offset accesses succeeded silently. Resolve the
  frames through the `.symbols` sidecar and disassemble the faulting
  offset with `build/deps/emsdk/upstream/bin/llvm-objdump -d
  --start-address=`. A hard trap is never host pressure, and a bisect that
  "fits" can fit because the bug predates both revisions.

## wasm and V8

- **wasm has no relaxed atomics.** A relaxed atomic store is a seq_cst
  store, which is a locked exchange on x64; a relaxed load is a plain
  load. A single-writer publish of an aligned word that readers tolerate
  stale can be a plain store.
- **A store to a cache line another thread reads costs ~24x**: 2.2 ns
  alone, 52 ns with one reader spinning on the line (emscripten
  microbenchmark, September). The signature is a small function whose
  self time per call far exceeds its instruction count. Pad the line.
- **An uncontended mutex still costs** a locked compare-exchange and a
  locked exchange in musl. At millions of acquisitions a second the fix is
  to stop taking it (A7's deferred BQL release). A deferred release is
  safe only with a structural bound on how long it can be held.
- **Emitted TB code starts in Liftoff; C in the main module runs in
  TurboFan.** Liftoff zeroes every declared local at entry and is ~2x
  slower on TB-shaped code. A call from a TB module into the main module
  is ~2–3 ns (5–7 ns in situ), so moving work into a C helper is cheap at
  the call. Inside a real TB the same call cost ~14.5 ns, because the
  engine spills every live local and TCG treats all globals as written. An
  inline lookup of a dozen loads and six branches lost to the helper it
  replaced; the same cache comparing two or three words wins.
- **Read TurboFan's machine code before deciding what code costs.** V8's
  wasm calling convention has no callee-saved registers, so a call on a
  cold arm spills every live value where it is defined, on the hot path,
  unless the arm is hinted cold. One `metadata.code.branch_hint` entry per
  inline TLB probe made video 20 % faster (September). A hypothesis can be
  tested offline by rewriting a captured module
  (`tools/perf/wasm-bhint.mjs`; capture with `tools/perf/wasmgrab.mjs`).
- **Locality only pays on a dependent load.** A load from an address that
  the emitter wrote as a constant issues early and hides its latency.
  Removing a load whose address came out of another load won 5–11 %;
  packing the remaining constant-address slots densely was a wash.
- **A chained TB transfer is predictable per site.** With per-site
  predictable targets every dispatch mechanism (indirect tail call,
  driver loop, merged `br_table`) measured the same 16–17 ns in
  `tests/wasm/dispatchbench.mjs`. Only an unpredictable target sequence
  separates them, and that is not what `tb_add_jump` produces.
- **An interpreter compiles to wasm at native speed**
  (`tools/interp-probe.c`: 7.3 ns per op both ways). Before assuming a
  native cost ratio carries over, ask which tier each side lands in.
- **V8 caches compiled modules by their bytes.** A microbenchmark that
  compiles the same module repeatedly measures the cache. Distinct bytes
  cost 2–3.8x more. Vary the input of anything that may memoise.

## TCG backend design

- **A wasm JIT pays only if TB-to-TB control flow never leaves wasm.** The
  first attempt (one module and instance per TB, a C dispatch loop between
  instances, registers as wasm globals) reached 1.3–2.3x over TCI and was
  discarded. The backend that shipped chains by tail calls through a
  funcref table, keeps registers in locals and batches TBs into modules.
- **Value-level correctness needs its own harness.** That first attempt
  died of a data divergence with an identical PC stream for 470k TBs. The
  op-suite (`tests/tcg-isa`) and the lockstep digests exist for that
  class and were built before the backend.
- **Code that translates ahead of execution must probe without faulting.**
  A lookup of a not-yet-executed target went through the faulting
  `get_page_addr_code` and the guest took a prefetch abort at a PC it had
  not reached.
- **A key the translator can stamp statically should not be compared at run
  time.** hflags cannot change without ending the TB. A generation counter
  suits rare events only: hflags change 88k times a second, jump-cache
  flushes ~1.4k times per boot.
- **A counter that a fast path must keep exact is a constraint on that
  path.** An exact per-entry TB counter, read only by a MIPS display, once
  switched off both TB-lengthening mechanisms. Make such a counter
  refundable, as icount is.
- **Backend constraints:** immediates go through `tcg_target_const_match`
  and the `out_rri`/`out_ri`/`out_i` hooks. A bare const constraint letter
  with no register class trips `get_constraint_priority`'s assert at boot.

## Devices

- **A QEMU timer per hardware tick is a denial of service in wasm.** A
  timer callback costs ~10 µs of JS clock reads, ~200x native. A device's
  deadline must be the next event somebody can observe, not the next tick
  (`gptu.c`, `tpu.c`, the lazy dif_v2 bus timer). A device that re-arms a
  timer on a register-write path is the same storm: the TPU once made
  1.45M `timer_mod` calls a second on an idle screen.
- **When a stalled guest is really a starved one, profile every thread.**
  That GPTU storm looked like a firmware wait: the vCPU was 94 % in
  `futex_wait` while the main loop ran one device's timer at 100 kHz under
  the BQL.
- **Replacing a deferral with a synchronous path needs its resume points.**
  Every access that can drop the condition the loop stopped on must call
  back in. Keep the deferral as a backstop, armed only where progress is
  not otherwise guaranteed.
- **Before memoising a device callback, check re-entrancy.** A skip-if-
  unchanged cache on a DMA request line blanked the display: driving the
  line re-entered the function through the DMAC, and the outer call then
  finished from stale inputs with the fresh key already stored.
- **Mechanisms are board-specific.** LG boards, the SGOLD CX70 (`dif_v1`)
  and the EL71 (hot registers in regions smaller than a page, flash writes
  during boot) each hid a problem that no S75 profile contained. Work that
  is redone on every register write usually costs more than the per-word
  chain behind it.

## Measuring

The binding method is in performance.md. These are the traps behind it.

- **A counter on the slow path is not a hit rate.** Work that TCG emits
  into the TB is invisible to every C-side counter, so a cache's successes
  are absent events. Size a cache by switching it off and watching the
  counter downstream. The pc cache was nearly deleted twice on a "0.28 %
  hit rate" while it answered seven eighths of the exits.
- **Count one step earlier before believing a zero.** "The thing is rare"
  and "my probe never ran" look the same. A fast path guarded by a macro
  that no build defines compiles, links and A/Bs as "no change".
- **A path is not priced until something has been switched off.** A sum of
  the events that counters name is a lower bound. The display path was
  closed at ~1 % by arithmetic and measured 15 % of wall when switched off.
  A call count prices a call site only if the work per call is constant.
- **Price times rate, both measured, and name the workload.** A rate is a
  property of a workload, not of a function. A share is a ratio whose
  denominator moves: a rejected 0.1 % lever was 1.3 % after the rest of
  the wall halved. Re-price old rejections before trusting them.
- **Know what a probe can see.**
  - Deleting work gives the whole prize, cost included, but only if the
    guest still runs. A lock cannot be probed by deletion.
  - Simulating a mechanism gives its hit rate and is silent on what the
    real thing adds to the path that still misses.
  - Duplicating existing code prices its deletion, never the insertion of
    a cheaper check in front of it.
  - Extra work must survive the optimiser (xor distributes over rotate;
    LICM hoists a duplicated call) and must not serialise through one
    shared sink. Turn the multiplier up until the guest visibly crawls,
    to prove that the knob arrived.
- **An A/B knob must restore the untouched path.** If the "off" leg keeps
  part of the mechanism, the comparison flatters the change. An
  instrumentation knob that changes codegen can switch off the mechanism
  under test.
- **A comment explaining why something need not be measured is the thing
  to measure.** "V8 serves this memory with trap handlers, so bounds
  checks cost nothing" stood for 34 rounds; the one-flag test read −26 %.
- **Fits and ratios.**
  - A slope fitted across configurations is the price of everything the
    knob changed together, not a marginal cost. If the sweep extends past
    its optimum and changes sign, it was never marginal.
  - A high R² says that a line fits the points, not that the x-axis is the
    quantity it was named. Read a counter's definition, not its name.
  - Do not divide by a difference that does not clear the spread of the
    same quantity within one arm.
  - Two intervals from differently shaped experiments cannot be
    subtracted.
  - A counter incremented at translation time weights by compilation,
    never by execution.
  - Normalising per instruction does not make a host-paced or frame-paced
    counter guest-relative: an arm that runs 19 % faster shows −16 % on
    every per-second event. Parts must sum to their whole before any share
    is quoted.
- **Check that every leg ran the same workload.** A mean over phases that
  behave differently reports the idle one. A fixed guest-time window does
  not fix what the guest did in it: 23 % of one J2ME game's legs were on
  its title screen, with rates inside the played legs' range. Compare
  guest-paced counters between legs before reading the clock.
- **Host noise.**
  - A control that moves more than its known noise is a rejection signal.
    Locate the burst and drop those legs; do not model it as drift.
  - Rotating the arm order is a Latin square. Position was worth ~0.9 %
    per slot, enough to invent or destroy a 2 % effect.
  - Record host pressure with every run (`tools/perf/hostmon.sh`). The
    load comes from other tenants and is invisible in this container's
    process table.
- **Build both sides of an A/B the same way.** An incremental build over a
  directory left mid-state ran ~5 % slow and faked a win across four
  invocations in both orders. Swapping the order cancels position, not a
  bad baseline.
- **When removing "measurement scaffolding", list what else the call
  did.** A removed prologue import was also what opened the batch, and 20 %
  of TBs then ran from throwaway modules. Make invariants explicit calls.
- **A change can be right and unmeasurable.** Report it as flat with the
  mechanism evidence (a profile share, a counter), never as the sample
  mean.
- **Profiles.** DevTools resolves every `wasm-function[N]` through the
  main module's symbol map, so a frame from a TB module (`wasm://wasm/…`)
  wears a borrowed name. Bucket by URL; inside the TB bucket only the sum
  is meaningful. The vCPU worker's index moves between runs; identify it by
  content. Never pipe a profiler through `tail`.

- **A listing shows density, a census shows rate.** Towerblox's hottest
  ARM TBs do one guest access per instruction, which read as "the probes
  are the scene". Counted, they were ~30M a second and a few percent of
  the vCPU: removing a quarter of them (one probe per LDM/STM) gained
  ~2 %. Count events per second before sizing a lever from a hot
  function's code.

## Gates

- **Boot one fullflash per class.** S75 was the only browser boot anyone
  watched for weeks while two board-specific breakages stayed green
  natively. EL71 is the only one that writes its flash file system while
  booting (the rewind and io barrier on a ROM device). KE800 and KE970 are
  LG firmware with an EFA sidecar. CX70 is SGOLD (`dif_v1`). The native
  suite is blind to every emscripten-gated change.
- **`tools/bootcheck.mjs` judges progress in executed instructions**, not
  framebuffer updates: EL71 ends at a "set time and date?" wizard that
  never redraws. KE800 must also reach 1.5e9 instructions and KE970 1.2e9,
  because a guest parked at the LG logo still executes ~10k
  instructions/s and once passed at 590M.
- **Boards run as consecutive pages of one browser in the `close` tier.**
  The second page loads the wasm from the cache and starts at full
  optimised speed, so a race can show in the s75→el71 order that never
  shows with el71 alone.
- **Every browser the page supports is a gate.** The Firefox boot existed
  but was not in the ladder, and nine commits shipped with Firefox dying at
  the logo.
- **A stale `boards.tar` looks like a qemu regression** (board settings
  silently revert). Every deploy path repacks it.

## Shell and container traps

- **Never edit a shell script that is running.** Bash reads it by byte
  offset as it goes. Copy it and edit the copy.
- **`grep -c` prints 0 and exits 1 on no match**, so
  `n=$(grep -c PAT f || echo 0)` yields two lines. Use `${n:-0}`.
- **Wait on an artifact, not on the process table.** A `pgrep -f` waiter
  matches any command line that carries the pattern, its own included, and
  falls back to `comm` for zombies. `kill -0` succeeds on a zombie
  forever, because PID 1 here reaps nothing.
- **`ps` `%CPU` is a lifetime average.** Use `top -bn2` for what is running
  now. A killed driver leaves its headless Chromium emulating a phone;
  count browsers before trusting a number.

## pmb887x facts

- The RTC `CNT` register is a linear Unix-seconds counter to Siemens
  firmware and a packed calendar to LG firmware. The board config's
  `[rtc] format` selects the layout; the wrong one gave a 2091 date and a
  clock jumping 16 minutes per minute.
- The S75 panel is 132×176; EL71 and KE800 are 240×320, 3.3x the pixels
  through the same display chain.
- A slow J2ME stopwatch is throughput, not pacing: the guest never halts
  there.
