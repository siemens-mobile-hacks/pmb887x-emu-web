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
