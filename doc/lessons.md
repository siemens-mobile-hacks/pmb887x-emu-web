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
- **…and the cap needs two phases** (`banked:30`, the shipping default):
  `banked` is right *during* the boot — a guest that fell behind must be
  allowed to catch up — and wrong after it, because the same credit lets
  a later stall be repaid by sprinting the phone's clock. So bank for the
  guest's first 30 s of its own clock, then re-anchor on lag forever.
  The window is measured in **guest** time on purpose: the boot costs the
  same virtual time on every host while its wall time ranges from ~39 s
  to minutes, so a wall window would expire mid-boot on exactly the slow
  machines `banked` exists to protect.
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

## Two generations of the same peripheral drift apart (round fifteen)

- **SGOLD was slow because `dif_v1.c` never got the work `dif_v2.c`
  got.**  The CX70 is the first SGOLD (PMB8875) board measured here;
  every earlier round measured SGOLD2 (S75/EL71) or the LG.  A profile
  put ~17 % of its vCPU in the DIF/DMAC/SSI chain, and three separate
  pieces of that were things v2 had already solved and v1 had not: the
  per-bit mux loop (v2 has a byte-lane table), the unconditional
  `qemu_set_irq` on both DMA request lines (v2 filters on the level it
  last drove), and a `timer_mod(timer, 0)` per transferred word (v2 runs
  its transfers inline and has never armed its timer at all).  Together
  **+14 %** on a CX70.
- **So when a device has a `_v1` and a `_v2`, diff them before
  profiling anything else.**  The optimised one is a written record of
  which parts of that device are expensive, and the parts are usually
  the same in both.  This is cheaper than rediscovering them.
- **A deferred completion costs twice when two devices defer to each
  other.**  v1's per-word timer was not just its own arm/fire pair: it
  meant the DIF's `breq` reached the DMAC from outside the DMAC's run
  loop, so the DMAC's `in_run` guard never applied and it armed *its*
  timer per burst too — `dmacSchedTimer` 10.87M against 10.86M bursts.
  The S75, whose DIF is synchronous, does the same display work with
  **99 DMAC timer arms a second against 11660 bursts**.  A ratio like
  that between two boards doing the same job is the signal.
- **Removing a deferral needs the resume points, not just the loop.**
  The transfer loop stops when a request is raised (the RX FIFO is four
  words deep; draining a 32-word TX FIFO into it would overflow), so a
  held word must be resumable.  Timers make that automatic; running
  inline does not.  Each point that can drop the raised request has to
  call back in — v2's list is the next FIFO write, the RX read, and the
  event handler on a *cleared* request — plus, for v1, the `CON` read,
  because BSY is v1's own and a CPU may spin on it touching nothing
  else.

## Measure at rt=off, but gate at rt=banked

- **A change can be correct at `rt=off` and hang at `rt=banked`.**  Every
  meter in this project runs `rt=off`, because the real-time cap's
  pacing is not what an engine A/B is asking about.  Round fifteen's DIF
  v1 conversion booted, rendered and menu-navigated correctly at
  `rt=off` through several hundred runs — and stalled the CX70 at 140M
  instructions under the shipping `rt=banked`, which `tools/bootcheck.mjs`
  uses and which is the only reason it was caught.  The cap changes when
  the vCPU sleeps, which changes the interleaving between it and the
  main loop, which is exactly what a device that has stopped deferring
  its work is sensitive to.  **Run bootcheck on the shipping
  configuration before believing any device-timing change.**
- **When you replace a deferral with a synchronous path, keep the
  deferral as the backstop and arm it only where progress is not
  otherwise guaranteed.**  The per-word `timer_mod` came back — but only
  when the loop exits holding a word, which happens only when the TX
  FIFO had a second word ready.  The DMAC feeds one word at a time, so
  on the display path the FIFO is empty there and the timer is still
  never armed; a CPU-driven burst gets its guarantee back.  The win
  survived intact.

## Prove a device change equivalent, do not argue it

- **Two native builds and the lockstep plugin settle it.**
  `tools/lockstep.mjs` takes `--a-bin`/`--b-bin` and any `--flash` path,
  so building the *old* code and the *new* code natively and running
  them against each other is a value-level proof: round fifteen's DIF
  rewrite is clean over **5.02G instructions — 4784 epochs plus 598
  memory digests identical, serial identical**.  That is minutes of
  work and is worth more than any amount of screenshot comparison.
  Build the second binary by checking the old file into the native
  worktree (`git -C build/qemu-native checkout <rev> -- <file>`) and
  re-running ninja; put the binaries aside before switching back.
- **Do not trust a screenshot taken after a wall-clock settle.**  The
  obvious deterministic-screenshot check — shoot at a fixed instruction
  count, since icount makes the guest deterministic — is only as precise
  as the poll that finds the milestone, and at 100 ms that is millions
  of instructions.  Validate the instrument by shooting the *same build*
  twice: on a CX70 those two shots differ, so a difference between
  builds proves nothing.  A *match* is still strong evidence (an 8 KB
  PNG does not collide by luck), which is why the early results in this
  round were believable — but the check that decides is the lockstep.

## Guest-event counters are the meter when the host is not yours

- **Under icount the guest is a deterministic function of its
  instruction count** — that is what makes the wasm-vs-native lockstep
  gate possible — so the guest work between two instruction milestones
  is identical in every run of every build that does not change
  guest-visible behaviour.  `tools/workbench.mjs` times that stretch:
  **0.9 % spread** on a CX70 where the idle meter swings ~15 %, because
  none of the guest's own variability is in it.  It prints the virtual
  time at each milestone as the check that the assumption held.
- **It also prints counters, and those are load-independent.**  `lookup`,
  `jcFlush`, `tlbFlush`, `fill` and `tbGen` count *guest* events, so a
  change that removes work shows up in them at any host load.  When this
  machine's load average went from 3 to 55 mid-session — it is a
  container, `/proc/loadavg` is the host's and the other tenants are
  invisible — wall-clock A/B stopped meaning anything (S75 idle read
  32–40 MIPS against a 56 MIPS baseline, on the *unchanged* build), but
  the mechanism could still be confirmed.
- **Check `load=` in the result line before believing an A/B**, and
  re-run anything measured above ~10.  Interleaving survives drift; it
  does not survive the host being ten times busier for one leg.

## A meter that suits one board can be wrong for another

- **`workbench.mjs` is right for a board that never halts and wrong for
  one that does.**  The CX70 spins (`halts/s` 64 against the S75's
  27091, `v/wall` 1.07 against 58), so its wall time is guest work.  The
  S75 spends the same window mostly halted, where wall time is wake
  latency, and the same meter read 41.3 then 31.1 MIPS for one build.
  Use `uibench.mjs` idle there, as before.
- **An animated idle screen is not a steady state.**  The SGOLD idle
  screen has a running clock and the GSM stack cycles through
  network-search phases, so idle MIPS swings ~15 % between runs of one
  build and `--settle` is mandatory (the rate detector never fires at
  all).

## Asyncify instrumentation is not free, and the onlylist had stale frames (round fourteen)

`-sASYNCIFY_ONLY=@configs/meson/asyncify-only.txt` names every function
that may be on the stack at a coroutine switch.  It is easy to read that
list as harmless if a little generous.  It is not: the instrumentation
puts a state test at function entry and around every call and spills
locals to the asyncify stack, so on a function entered millions of times
a second it costs about what the function costs.  Adding seven hot
cputlb functions to the list turned a **+4.1 %** patch into a **-2.5 %**
one — the same code, 4/4 pairwise either way.

**The vCPU thread can never be on such a stack, and the tree already says
so.**  `rr_cpu_thread_fn()` calls `qemu_coroutine_forbid_current_thread()`,
and `qemu_coroutine_switch()` in `util/coroutine-wasm.c` *aborts* if it is
ever reached there, because the JIT'd TB frame and the `invoke_*` wrapper
beneath a helper cannot be instrumented at all — unwinding through them
is impossible in principle, not merely unsupported.  So everything
reachable only from the vCPU was pure cost: `cpu_exec`, `cpu_exec_loop`,
`cpu_exec_setjmp`, `cpu_tb_exec`, `tcg_cpu_exec`, `tcg_qemu_tb_exec`,
`rr_cpu_thread_fn`, `do_ld_*`, `do_st_*`, `helper_ld*_mmu`,
`helper_st*_mmu`, `int_ld_*`, `int_st_*`.

Those entries were not wrong when written — they are the stack of a flash
write issued from the vCPU, exactly the case `hw/arm/pmb887x/flash-blk.c`
later removed by recording the dirty range and writing it from a
main-loop bottom half.  **The fix deleted the stack; nothing deleted the
list entries.**  Removing work does not remove the scaffolding built for
it; go back and check what the scaffolding was for.

**Verify with the tool, not with the argument.**  `QEMU_COSTACK=1` logs
every distinct stack at a coroutine switch, and
`tools/asyncify-audit.mjs` resolves those frames through the `.symbols`
sidecar and reports MISSING (observed but not covered — a real bug) and
UNUSED (listed but not observed — only a *candidate*).  A 120 s S75 boot
produced 67 distinct frames, every one of them block layer, device
realize, main loop or monitor; the trimmed list still covered all 67.
UNUSED is never sufficient on its own: 96 entries were unobserved in that
run and most are needed for paths it did not exercise (the pwrite path,
shutdown, thread creation).  The trim was justified by *why the frame
cannot appear*; the audit only confirmed it.  The log stores wasm
function *indices*, so resolve it against the dist it was captured from —
any relink renumbers them and every name silently becomes wrong.

**Prefer a change whose failure mode is an abort.**  Get this wrong for a
vCPU frame and `qemu_coroutine_switch()` aborts with a message; get it
wrong elsewhere and the boot, lockstep and Firefox gates run the block
layer hard.  That asymmetry is what made a change to a correctness-shaped
setting worth attempting at all.

**And when a patch that should win loses, suspect what you changed
alongside it.**  The wasm had grown 21 KB and 20.6 KB of that was
instrumentation, not the inlining — splitting the two was one relink.

## wasm has no relaxed atomic and no acquire fence (round thirteen)

QEMU's `qatomic_read`/`qatomic_set` are `__ATOMIC_RELAXED` and
`smp_rmb()` is `__atomic_thread_fence(ACQUIRE)`, both of which cost
nothing on x86.  On wasm they are not free and not equal:

- a **relaxed load** lowers to `iN.atomic.load`, which the wasm spec
  defines as seq_cst — but x86 gives a seq_cst load away, so it stays a
  plain `mov`.  Cheap.
- a **relaxed store** lowers to `iN.atomic.store`, also seq_cst, and
  that is a locked exchange.  Not cheap.
- an **acquire fence** lowers to `atomic.fence`, seq_cst because wasm
  has no other kind, and that is a locked operation too.

Two consequences that drove a whole round:

**The ordering is often already there.**  If every shared location a
read section touches is reached through `qatomic_*`, then on wasm they
are all seq_cst accesses and the engine has already ordered them; what
is left to prevent is the *compiler* reordering them, because LLVM sees
`__ATOMIC_RELAXED` whatever the backend later emits.  A `barrier()` does
that for nothing.  This is a per-section argument, never a general one —
a seqlock whose payload is plain loads still needs the real fence — so
make the local pair, do not change `seqlock.h` (0070).

**A single-writer publish does not need to be atomic.**  If exactly one
thread writes a naturally-aligned word and readers already tolerate
staleness (a seqlock reader does: the writer of `qemu_icount` does not
hold the write lock), a plain store is the same value with none of the
locked operation.  0070's first cut — the two fences replaced *and* an
early return when nothing had executed — measured +1.8 %; adding the
plain store took it to +5.2 %, matching the ceiling probe.  So **the
locked store was the larger half**, and round eleven's "barriers are
free" (an `atomic.fence` microbenchmarked at 0.2 ns) is not contradicted
by this: the two changes in that first cut were never separated, and the
+1.8 % may be mostly the early return.  If the split ever matters,
measure it — three builds, not two.

Corollary for the whole tree: anywhere QEMU pays for ordering in a hot
path, ask what it is ordering *against* on this target before assuming
the cost is intrinsic.  `qatomic_set_mb()` in `cpu_handle_interrupt()`
was a store plus a fence on every pass of the execution loop, whether or
not there was anything to clear (0072) — though that one turned out to
be nearly free, so ask the profiler too.

## An uncontended lock still costs, and the fix is to stop taking it

The BQL on the MMIO path was already the leanest possible pair — one
TLS read, `pthread_mutex_lock`, one TLS write — and still cost 3.2 % of
the vCPU, because an idle S75 takes it **three million times a second**
and musl's uncontended path is a locked compare-exchange plus a locked
exchange.  There is no way to make that pair cheaper.  There is a way to
stop running it: **hold the lock and give it back only when asked**
(0073).

What makes deferred release safe is not the release mechanism — it is a
structural bound that holds when the mechanism fails.  Here the rr loop
already unlocks the BQL for real before every `tcg_cpu_exec()`, so the
worst case of a missed release is one icount slice of delay, not a
deadlock.  Design for that property first; the prompt-release path
(`bql_wanted`, checked once per `cpu_exec_loop()` pass) is then an
optimisation of the latency, not the thing correctness rests on.

Check the other direction too: the boards that stood to lose are the LG
ones, where `icount=none` puts the virtual-clock timers on the main loop
— the thread being kept out.  They got 10 % *faster*.

## Count the fast path, or it may never have run

Twice now a carefully written fast path has turned out to be dead code
that nothing complained about:

- 0044's devirtualised TB lookup was gated on `CONFIG_TARGET_ARM`, which
  has never existed (`TARGET_ARM` is poisoned inside `accel/tcg`).  It
  compiled, it linked, it was never once compiled *in*.
- the speculative-translation walker resolves ARM `ldr pc, [pc, #-4]`
  trampolines "when the TB is not `CF_PCREL`".  `arm_cpu_realizefn` sets
  `CF_PCREL` on **every** system-mode TB, so that branch has never been
  taken on any board here.  It was written to fix a real KE800 crash,
  which means the crash was fixed by the `!(target & 3)` guard on a
  different path, and this one has been inert ever since.

Both are silent: a fast path that never runs produces correct output and
costs nothing, so no gate and no A/B can see it — the A/B just reads
"no change", which is indistinguishable from "the idea was wrong".  The
first version of this round's fall-through speculation died exactly that
way, reading `specRet=0` on every key press because it copied the same
`CF_PCREL` guard.

So: **every new fast path ships with a counter, and the first thing you
look at is whether the counter is non-zero** — before the timing, before
the A/B.  `CF_PCREL` also means `tb->pc` is never written
(`tb_gen_code` skips it), so anything in `accel/tcg` that wants a TB's
guest pc has to carry it alongside rather than read it back.

## The wasm profile names the wrong function

`tools/wprof2.mjs` resolves a CDP `wasm-function[N]` frame through the
`--emit-symbol-map` sidecar.  **The resulting per-function self-time is
not trustworthy in this build**, and a whole round was nearly spent on
what it said.

The evidence, in the order it was gathered on an idle CX70:

1. The profile put **11.0 %** of the vCPU in `arm_rebuild_hflags` — the
   largest single entry, and apparently a direct contradiction of round
   fifteen's rejection of the `cpsr_write` hflags skip.
2. An unconditional counter at that function's entry
   (`hflagsCalls`, index 85) says it is called **11,606 times a second**.
   11.0 % of a 30 s profile over 348k calls is **9.5 µs per call**, for a
   function its own comment prices at ~76 ns.  One of the two is wrong by
   a factor of a hundred.
3. The counter is the one to believe.  A spin loop of 10,000 volatile
   increments placed in that function took the board from 113 MIPS to
   **0.7 MIPS** — exactly what 11.6 k calls/s predicts, and proof that
   the knob, the counter and the call rate all agree.
4. Profiling *that* build settled the attribution.  The spin loop is
   inside `arm_rebuild_hflags` and calls nothing.  The profiler reported
   it as **`rebuild_hflags_a32` 67.3 %**, `arm_rebuild_hflags` 20.3 %,
   **`arm_security_space` 9.5 %**, `cpsr_write` 1.0 %.  Work that
   provably lives in one function was spread over four.

So a name in that profile identifies a *neighbourhood*, not a function.
Two corollaries:

- **Never size a change from profile self-time alone.**  Get a rate from
  an unconditional counter and multiply by a defensible per-call cost, or
  probe the cost directly (below).  Round fifteen's rule — "treat a
  self-time share for a small leaf function as an upper bound, not a
  budget" — was too generous; it is not a bound at all.
- Frames whose url is `wasm://wasm/<hash>` are **JIT'd guest TBs**, and
  wprof2 symbolises them through the *main module's* map, which is how
  `machine_parse_smp_config` and `target_s390x` turn up as hot functions
  in an ARM phone emulator.  Their sum (~59 % of the vCPU here) is
  meaningful; their names are not.

### The cost probe: multiply the work and measure

The way to price a function without trusting a profile is to make it do
its own work *n* extra times and measure the wall difference.  It is
correct by construction when recomputation is idempotent — the guest
stays bit-identical and only the cost moves — and `workbench.mjs`'s
fixed-guest-work window resolves it.

Two traps, both hit in one afternoon:

- **The compiler will delete your probe.**  A duplicated call to a
  memory-reading function is loop-invariant; LICM hoists it, and even a
  `volatile` sink plus `__atomic_signal_fence` did not stop it here.
  2000 extra rebuilds per call measured **+3.7 % faster**, which reads
  exactly like "this function is free".  A `volatile` read-modify-write
  loop cannot be hoisted or elided — use that.
- **Confirm the knob arrived.**  Before believing "no change", crank the
  multiplier until the guest visibly crawls.  If it never does, you are
  measuring a knob that never reached the code, not a function that costs
  nothing.  (See § Count the fast path, or it may never have run.)

Also: the vCPU is not a fixed worker index.  It was #4 in one profile and
#1 in the next on the same board and build — identify it by content (the
`wasm://wasm/` TB frames land there), never by number.

## Read the symbol map before believing a cost model

Three ideas died in one round, each in under a minute, each of which
would have been an afternoon:

- `muldiv64()` divides by a runtime frequency, so the TPU path "must" be
  running software 128-bit division.  There is no `__udivti3` in the
  symbol map at all — `CONFIG_INT128` is unset for this build, so the
  64-bit fallback runs and is inlined.
- the BQL's coroutine-TLS accessors are deliberately `noinline`, so they
  "must" be four extra calls per device access.  They profile at 0.0 %.
- a function marked `static inline` is not necessarily inlined:
  `io_clock_window` and `rebuild_hflags_a32_el` both appeared as their
  own symbols until they were marked `always_inline`.

The symbol map (`site/<dist>/qemu-system-arm.js.symbols`) and a deep
profile (`PROF_TOP=150`) answer all three.  Ask them first.

## Some ceilings cannot be probed by deletion

The ceiling probe — build a variant with the suspect work removed, run
it once, see what the prize is — is the cheapest tool here, and it paid
for 0070 (+5.0 %, which told us the real patch at +5.2 % had taken all
of it).  But it only works when deleting the work still leaves a
*running* guest.  Deleting the BQL from the MMIO path lets the main loop
and the vCPU run device code concurrently; the guest never reached idle,
and there was no number.  When that happens, build the real thing and
measure it — do not read the failure as "no win available".

## What a cross-thread wake really costs (round twelve)

The wake is not the futex call.  It is the **BQL round trip behind it**:
the woken thread takes the lock, finds nothing to do, and parks again,
and the thread that woke it pays for the handoff.

Deleting 38k useless wakes a second was worth **+37 % MIPS** on the S75,
on a board whose vCPU those wakes accounted for only ~15 % of by
self-time.  Nothing in the self-time profile predicts that ratio, and
nothing would have, because the cost lands on the *other* thread and
comes back as lock contention.  When a profile shows a parked thread
being woken at kHz rates, size the fix by the wake count, not by the
symbol's share.

Corollary for this port: `qemu_clock_notify()` fans out to every
timerlist on the clock, and an empty one still costs a full wake.  Check
for empty-list fan-out before assuming a notify is meaningful.

And the asymmetry that nearly made it a regression: **who runs the
timers decides whether the wake is waste.**  Under icount the vCPU
thread runs QEMU_CLOCK_VIRTUAL timers, so waking the main loop for them
is pure loss.  With `icount=none` — the LG boards — the main loop *is*
the timer runner, and the same notify is the kick that keeps it
iterating.  Gate on `icount_enabled()`, not on the shape of the code.

## "This recomputation cannot change anything" — verify, don't argue

Two of round twelve's three patches rest on that claim.  The way to
check it is a build that **takes the skip but does the work anyway and
counts the disagreements**, run across every board and state.  It is one
build and one measurement run, and it is the only check that sees a
behaviour change against the *previous revision* — the lockstep gate
runs both legs from the same tree, so it proves JIT-vs-wasm equivalence
and nothing about whether the patch altered the machine.

**Count the size of a disagreement, not just its existence.**  0068's
predicate looked violated 840k times per 20 s window.  Measuring the
magnitude showed **max 1 ns, none above 64 ns** — `tpu_ticks_to_ns()`
rounding (`ticks_to_ns(a) + ticks_to_ns(b) != ticks_to_ns(a+b)`) against
a ~232 ns device tick, on a clock icount already quantises to 8 ns per
instruction.  A violation *counter* would have killed a patch worth
+12 %; a violation *histogram* shipped it.  0069's came back 51.8M
skips, 0 disagreements.

## When the change is smaller than the meter

0069 is a real 0.7 % win whose three interleaved wall-clock pairs came
out **+2.4 %, −4.4 %, +8.1 %**.  Back-to-back profiles of the same state
settle that case: self-time *shares* do not move with host load, and the
symbols the patch does not touch are the control.  0069 read
`rebuild_hflags_a32` 2.4 → 2.0 % and `arm_rebuild_hflags` 1.5 → 1.2 %
with `icount_get` 4.2/4.2 and `do_st_mmio_1p` 3.6/3.6 unmoved — which is
a result, where the wall-clock numbers were not.  Report it as a
mechanism result and say so.

Related: watch for shares that *rise* across a round.  After round
twelve `do_st_mmio_1p` reads 3.1 → 3.6 % and `cpu_exec_loop` 2.3 →
2.6 %.  Nothing got slower; the denominator shrank.

## What a wasm hot path actually costs

Round eleven (0058–0064) profiled the device access path and found that
*none* of the intuitions carried over from native code were right.

- **A store to a cache line another thread touches costs ~24× a store to
  an uncontended one, and that dominates everything else.**  An
  emscripten microbenchmark of `icount_get`'s exact shape (three atomic
  reads, one atomic store): **2.2 ns/iter alone, 52 ns/iter with a
  single reader spinning on the same line from another core, 0.5 ns/iter
  if the store is removed.**  That 52 ns *is* the ~50 ns/call the
  profiler attributed to `icount_get`.  The fix was 56 bytes of padding
  (0060).  Look for this signature: **a small function whose profiled
  self-time per call is wildly more than its instruction count can
  explain** — it is usually one store to a shared line.
- **But do not "fix" it by removing the store.**  Not publishing the
  running icount slice returns a bit-identical value and is a **7.8 %
  MIPS regression, measured twice**: a global clock that only moves at
  slice boundaries changes how the main loop paces itself.  Pad, don't
  skip.
- **Barriers are not the problem.**  `smp_rmb()`/`smp_wmb()` become
  `atomic.fence`, and V8 lowers that to approximately nothing on x64: a
  full seqlock read loop microbenchmarks at 2.3 ns/iter against 2.1 for
  the same code with the fences removed.  Do not go after seqlocks for
  speed.
- **The tax is per *call*, not per instruction.**  Every one of the
  MMIO path's small functions measured ~3× what its body suggests, and
  the wins came from removing frames: six dispatch frames to one
  (0059/0061), ~22 BQL calls to four (0063), one clock frame (0064), a
  four-line `static inline` the size heuristic had left out of line
  (`io_fast_bswap`, its own 0.5 % symbol).
- **`bql_locked()` is a coroutine-TLS accessor and is `noinline` by
  design** (`QEMU_DEFINE_STATIC_CO_TLS` puts an `asm volatile("")` in
  it).  `BQL_LOCK_GUARD()` reaches it five times per lock and five more
  per unlock, because three `g_assert`s and
  `qemu_mutex_post_lock()`/`pre_unlock()` all call it again.  On a path
  taken millions of times a second that is the cost, not the mutex.
- **LTO is the obvious answer and it is the wrong one here**: it cannot
  inline those `noinline` accessors, its link is single-threaded and
  open-ended on a 27 MB module, and its function merging would break the
  `ASYNCIFY_ONLY` list 0031 depends on — a silent regression no gate
  watches for.
- **A device that re-arms a QEMU timer on a *write* path is a storm
  waiting to happen.**  `tpu_io_write()` ended in two `timer_mod()`
  calls per register write (the first overwritten by the second before
  the guest could see it): **1.45 M `timer_mod` calls a second on a
  standing idle screen** (0062).  0049 found the same shape in the GPTU.
  `sccu.c` and the `dyn_timer`/`timer` helpers are not audited.  The two
  counters that made it obvious took ten minutes to add — add the
  counter first.

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

### Measuring round eleven taught the hard way

- **`--state menu` is not reproducible; `--state idle` is.**  The driven
  menu lands on different screens run to run: across runs of the *same*
  build, `ioLd/s` ranged from 171 k to 4.0 M and MIPS from 23 to 55.
  Anything that must be comparable goes on `idle`, or on a state whose
  counters you check match between the two legs before believing the
  wall-clock number.
- **Above ~20 of external host load the wall meters resolve nothing
  below ~10 %.**  Three interleaved pairs of S75 idle at load 35
  disagreed in *both directions* on a change that back-to-back profiles
  showed cleanly.  Check `uptime` (uibench prints it) and, when the host
  is busy, **fall back to profiling the two builds back to back in the
  same state** — self-time proportions are load-insensitive in a way
  MIPS is not.
- **Orphaned `chrome-headless` processes survive killing the node
  driver** and will quietly eat the host for the rest of the session.
  They show as `PPID 1`.  Note that `ps %CPU` is a *lifetime average*,
  so a pile of zombies looks like a pile of CPU hogs and is not — check
  `STAT` for `Z` before panicking, and check `vmstat`/`top` for the real
  number.
- **`pgrep -f <pattern> | xargs kill` kills the invoking shell** when
  the pattern appears in its own command line (the bash wrapper carries
  the whole script).  It happened three times this session.  Bracket the
  pattern: `pgrep -af "uibench[.]mjs"`.

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
- The bsp main branch used to define an RF peripheral (`hd155153np`) the
  emulator does not implement, and this project carried a `bsp-patches/`
  workaround re-pointing it at the `pmb6272` stub. bsp `55752c5`
  commented the peripheral out at the source; the patch directory went
  with it (2026-09-15).
- qemu-pmb887x master alone aborts every Siemens fullflash in L1 GSM
  frame handling; the "hacky AFE (LLE+HLE)" DSP commit is required.
- The boot consumes ~42 s of virtual time, ~31.5 s of it idle warp on
  millisecond device timers — after t0.75G the shipping boot is
  virtual-time-bound and no engine speed shortens it; whether that warp
  is the right amount is a fidelity question needing a hardware
  reference.
- The J2ME stopwatch running slow is throughput (the guest never halts
  there: `vratio` = guest MIPS / 125), not pacing.
