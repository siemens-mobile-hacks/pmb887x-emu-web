# Lessons learned

The conclusions of the investigations that shaped the current design,
kept without the investigation records. Each item is a rule, the reason
for it, and how it was established. The live working rules for perf
work are in [optimization-playbook.md](optimization-playbook.md); this
file is the "why" behind them and behind the timing model.

## A second `--cross-file` replaces the first one's built-in options

**A build flag that appears in the cross file is not thereby on a compile
line. Check `build.ninja`, not the file you wrote it into.**

`--extra-cflags="-O3 -pthread -DWASM_BIGINT -sMEMORY64=2 -DW64_MEM32"`
reached `config-meson.cross` exactly as intended (`configure:1856`,
`c_args = [...]`). None of it reached a compile command. meson is invoked
with two cross files —

```
--cross-file=build/qemu-wasm64/config-meson.cross        (generated, has the flags)
--cross-file=qemu/configs/meson/emscripten.txt           (checked in, line 2)
```

— and the later one's `c_args = ['-pthread']` **replaces** the earlier
list rather than extending it. So every wasm build in this tree has
compiled at meson's default `-O2 -g`: 2240 `-O2` against 0 `-O3` in the
deployed `build/qemu-wasm64/build.ninja`.

Two flags rode through anyway, and the difference is the rule. `-pthread`
survived because the *overriding* file names it. `-sMEMORY64=2` survived
because configure puts it in `CPU_CFLAGS`, which becomes the compiler's
own argv in `[binaries] c = ['emcc','-m64','-sMEMORY64=2']` — not an
option meson merges, but part of the command. **Flags that must not go
missing belong in the binary spec, beside the flag they have to agree
with, not in a list something else can replace.**

The failure was silent for as long as nothing read the dropped value.
`-DWASM_BIGINT` is inert (no source tests it) and `-O3` only costs speed,
so both sat unnoticed. `-DW64_MEM32` was the first one with teeth: the
modules the JIT emits declare the memory type they import, the main
module's memory had been lowered to 32-bit, and the mismatch surfaced as
`LinkError: cannot import i32 memory as i64` on the first TB instantiated
— a linker-shaped error whose actual cause was a missing `-D`.

*How it was established:* the smoke leg of the A/B failed; `grep -c
W64_MEM32 build.ninja` returned 0 while the same grep on
`config-meson.cross` returned 5; `meson-log.txt`'s "Build Options:" line
showed the two `--cross-file` arguments in order.

*The check, which costs one line:* after configuring, grep `build.ninja`
for a define you passed. It is the file the compiler is actually driven
from. `meson configure <builddir>` with no other argument is the blunter
version and reads the loss straight out: this tree reports
`c_args  [-pthread]`, with `-O3`, `-DWASM_BIGINT` and `-sMEMORY64=1` —
everything `--extra-cflags` asked for — simply absent. It also prints the
built-in options beside it, which is how `optimization = 2` and
`b_ndebug = false` turned up; both were invisible from the build script,
because neither is anything the build script says.

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
- **…and the cap needs two phases** (`budget:30:500`, the shipping
  default): `banked` is right *during* the boot — a guest that fell
  behind must be allowed to catch up — and too generous after it,
  because the same credit lets a later stall be repaid by sprinting the
  phone's clock. So bank for the guest's first 30 s of its own clock,
  then cap the repayable bank at 500 ms: a stall is still repaid, but
  never by more than half a second of skipped clock, so the phone stays
  close behind wall time instead of freezing its countdowns. The window
  is measured in **guest** time on purpose: the boot costs the same
  virtual time on every host while its wall time ranges from ~39 s to
  minutes, so a wall window would expire mid-boot on exactly the slow
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

The trampoline one was then woken up and measured, and the ending is
worth keeping: it fires on **about one walked node in 35,000**, four
boards agreeing, so it never had anything to offer.  Which is the
second half of the rule — *a counter that reads zero has two
explanations*, "the thing is rare" and "my probe never ran", and they
look identical.  Separate them by counting one step earlier: here the
first counter went on the tail probe (141 per Mi — every node) and only
the second on the pattern match (0.004 per Mi).  Without the first, a
broken `tbpc` would have produced exactly the same zero and the honest
conclusion would have been unreachable.  Then **delete what the counter
condemns**: this one had been read as a live optimization by two
separate rounds.

## A counter on the slow path is not a hit rate

The rule above says a new fast path ships with a counter and the first
thing you check is that it is non-zero.  Non-zero is not enough either,
and this round nearly cost a working optimization to prove it.

0118's PC-keyed TB cache reads, on a J2ME run, `pccFill=460.5` per Mi
against `pccHit=6.78` per Mi.  A cache filled sixty-eight times for
every hit is a cache that thrashes, and the obvious moves are to resize
it, rekey it, or delete it.  All three would have been wrong.  The
table has **two ways in**.  `w64_pcc_get` (`accel/tcg/cpu-exec.c`) is
the C helper, and it is the one that bumps `WASM_DIAG_PCC_HIT`.  The
other is `gen_goto_ptr_pcc` (`target/arm/tcg/translate.c`), which emits
the lookup *inline into the guest code* — eight TCG ops that recompute
`tb_jmp_cache_hash_func(r15)`, compare pc/gen/cpu_index/key, load
`tc` and `tcg_gen_goto_ptr(tc)` straight to it.  That way has no
counter anywhere in it, and it is the way that almost always wins.  So
`pccHit` is not the cache's hits: it is the **residual after the
inline way already missed**.  The ratio is not a hit rate, it is not a
rate at all, and the two counters do not sit on the same path.

The recipe is the one the previous section ends on, applied to the
other sign: *a counter that reads non-zero-but-tiny has two
explanations too* — "the structure is barely working" and "the counter
sits downstream of an uncounted fast path" — and they look identical
in the table.  Before reading a ratio between two counters, **find
every entry point into the thing being counted**; a ratio is only a
rate when both counters stand on the same path.  The cheapest way to
find them is to read the emitter, not the helper: work that TCG writes
into the guest code is invisible to every C-side probe by
construction, and mechanism K here was exactly that.

**It happened again on 2026-09-17, on this same counter, with this
lesson already written above.**  A handoff section read `pccHit`
2.746/Mi against `lookup` 962.943/Mi as a "0.28 % hit rate", concluded
the table was "redundant by construction", and queued an A/B to
justify deleting it.  The A/B disagreed: with both PCC knobs off,
`tbBytes/tbGen` fell 13.3 % (so the knob engaged) but wall rose 3.9 %
and **`lookup` went 972.7 → 8688.4 /Mi, a factor of 8.9**.  The emitted
probe was silently resolving seven-eighths of all exits; its hits are
the lookups that never happen, so they appear in no counter at all —
exactly what this lesson says.

Two things generalise from the repeat:

- **An effective cache can be invisible in the counter that bears its
  name.**  Its successes are *absent events*.  The way to size one is
  never its own hit counter — it is to turn it off and watch what the
  downstream counter does.  `lookup` × 8.9 is a measurement; `pccHit`
  was never one.
- **Writing the lesson down did not prevent the repeat, because nothing
  consulted it at the point of use.**  The section that erred cited
  `pccHit` by name.  So: when a lesson is about a *specific named
  counter*, put the warning where the counter is defined — in
  `wasm-diag.h` next to `WASM_DIAG_PCC_HIT` — not only in this file.
  A reader who greps the counter must meet the caveat; a reader who
  greps this file is already being careful.

## A convenient hypothesis is the dangerous kind

The browser gate failed every board on every dist for an afternoon with
`RuntimeError: memory access out of bounds` — including builds that had
passed hours earlier.  The host was at 62 GB used and 23 GB of swap at
the same moment, so it was written off as memory pressure.  Two pieces of
"evidence" agreed:

- it reproduced on the **pre-change revision**, so "not my patch"; and
- the boards trapped at different, repeatable instruction counts, which
  is what a lazily-committed 2 GB heap running out would look like.

Both were true and neither was the cause.  The bisect fitted *because
the bug was older than either revision*, and the repeatability came from
icount determinism, not from an allocator.  A wasm trap is not a
resource failure: the heap was fully allocated (`HEAPU8.length` =
2147483648) the whole time, which one `evaluate` would have shown.

What broke it open was reading the actual stack instead of the summary
line the gate prints:

```
HTMLButtonElement.release (app.js) → sendKey → _wasm_send_key
  → wasm-function[24049]:0x80ddb6 → memory access out of bounds
```

Then: resolve the frames through the symbol map (`wasm_send_key`,
`qemu_bh_schedule`), disassemble that byte offset with
`emsdk/upstream/bin/llvm-objdump -d --start-address=`, and read the
faulting instruction.  It was an `i64.load 184` on `bh->ctx` **after** an
`i32.atomic.rmw.or 40` on `bh->flags` that had not faulted — the
signature of a NULL pointer in wasm, where low addresses are ordinary
memory and only the far side of the heap traps.  Ten minutes of
disassembly against an afternoon of a plausible story.

Rules earned:

- **A hard trap is never "the host is busy".**  Slowness, timeouts and
  rotating thresholds are host; a deterministic fault is code.
- **`llvm-objdump` on the .wasm resolves a trap exactly**, and the
  `--emit-symbol-map` sidecar resolves *stack* frames exactly even though
  the sampling profiler's attribution through the same map does not.
- **NULL does not trap in wasm.**  A NULL-pointer bug surfaces as an
  out-of-bounds access at `NULL->field_far_away`, several frames from the
  mistake, and any small-offset access on the way succeeds silently.
- When a gate starts failing on builds that used to pass, suspect
  something outside the build — but check the *page*, not just the host.
  Here it was the keypad layout re-rendering under a stationary pointer.

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

`tools/wprof2.mjs` now prints that sum itself: under each thread's
top-*N* list is a rollup of **every** frame by owning module — emitted TB
code, main module C, glue JS, idle.  The url is the one field the symbol
map cannot corrupt, so the rollup is trustworthy exactly where the list
above it is not.  Take the verdict from the rollup and treat the named
list as a lead.

And take the rollup rather than the list for a second reason, which cost
round thirty-two a profile.  The list is truncated to `PROF_TOP` (40 by
default), and on the vCPU **the truncated part is the majority**: a
J2ME in-play profile put 15.3 s of a 40.6 s thread in its top 40 and left
62 % in a tail of thousands of one-sample frames.  That is not a long
tail to be ignored — it is what a profile of emitted code *looks like*
when every TB is its own wasm function, and the top of such a list is not
a sample of the bottom.  A truncated profile whose remainder is unlabelled
invites the reading that the printed rows are the story; here the printed
rows were a third of it, and the single largest row (3.4 %,
`helper_gvec_smax32`) was emitted TB code wearing a helper's name.

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

### Price a *phase* with a timer, not a profile

A volatile-spin probe prices one function; a whole phase is easier.  Put
`get_clock_realtime()` around it, accumulate into a `wasm_diag_stat`
slot, and read it with `_wasm_memstat` — `tools/modcost.mjs` does this
for translation and module compilation.  Rules learned doing it:

- **Charge the time in C, not in the EM_JS body.**  The JS half of
  `w64_batch_instantiate` already kept `__w64tM`/`__w64tI` globals, but
  they live in the vCPU worker, and that worker runs the guest without
  yielding — a page-side `evaluate()` to read them is never scheduled and
  hangs the tool.  (Same shape as the `iotrace2.mjs` hang.)  In
  `wasm_diag_stat` the number reaches the page like any other counter.
- **Gate anything hotter than a few thousand calls a second.**
  emscripten's `gettimeofday` is a call out to JS.  Module compiles
  (~1k/s) can carry it always; `tb_gen_code` (~4k/s) is behind
  `WASM_DIAG_TIME_PHASES` and is a measurement build, not an A/B build.
- **A phase timer retires folklore cheaply.**  "The early boot is
  compile-bound" had been repeated since the profiler era.  It is not:
  the translate+compile pipeline is **19.5 %** of EL71 boot wall at its
  densest and 8 % late, with compile alone never above ~10 %.  That is
  also the ceiling on tiering, which is what made it measurable before it
  was buildable — *price the prize before building the machine.*
- **Don't let the phase timer tempt you into a bad comparison.**  EL71
  boots at 27.8 MIPS and runs warm at 73.6, and it is very tempting to
  call the 2.65x "overhead the pipeline doesn't explain".  It is not:
  those windows execute *different guest code*, and MIPS is only
  comparable across identical guest work — which is the whole reason
  `workbench.mjs` exists.  What the timer does support is the narrow
  claim: the pipeline is 19.5 % of boot wall, so ~80 % is execution and
  devices, and that 80 % is unpriced.
- **Calibrate the timer, or the floor will masquerade as the finding.**
  The browser's clock is quantized to 1 ms, so a short interval measures
  0 or 1 ms and the mean is a straddle-probability estimate — unbiased,
  and fine.  What is *not* fine is that the two clock reads bounding the
  interval have their own latency inside it, so a zero-length phase still
  prices at **~66-75 ns**.  Time an *empty* interval the same sampled way
  (`CAL_NS`) and subtract.  Before doing that, round eighteen "found" a
  94 ns BQL acquire (really ~16 ns) and a 26 % MMIO share of wall; the
  A/B of a patch built on the first of those won 1 run in 3.  Corollary:
  **time the innermost thing you can reach.**  Wrapping the device
  callback needed no subtraction model and gave the number that survived
  — 3.6 ns for an MMIO read against 330 ns for a write.
- **Sample the address, not just the duration.**  Once a phase is known
  to be expensive, the same 1 ms straddle that makes the timer work also
  makes it a *sampler*: a nonzero sample is drawn in proportion to
  duration, so the `full->phys_addr` distribution of nonzero samples is
  the duration-weighted one.  Histogramming those named the EBU as 68 %
  of device-write time in one build, after two builds of guessing had
  named the wrong device twice.

## Normalize before you compare, or the counter will point backwards

Round seventeen concluded "MMIO is not the cost" from two numbers: CX70
does 100x the `ioLd` per Mi that EL71 does, and boots 3x faster.  Round
eighteen found MMIO *was* essentially the whole cost.  Both readings came
off real counters.  What went wrong:

- **It compared one half of the quantity.**  EL71 is store-heavy and CX70
  load-heavy; `ioLd + ioSt` on matched windows gives 14 357 vs 5 602 per
  Mi — the fast board doing *less*, in almost exactly the MIPS ratio.
- **It compared unmatched windows.**  A board's MMIO density varies by an
  order of magnitude between boot phases, so a per-Mi number from one
  window says nothing about another.
- **It normalized per second where the question was per unit of work.**
  The same round reported EL71 making *fewer* helper calls per second
  than CX70; per TB it makes 2.6x *more*.  Per second is a statement
  about the host, per Mi a statement about the guest, and only the second
  one compares boards.

The rule: normalize per Mi, on the same guest work, or do not compare.
And when a counter says the slow thing is doing less of the suspected
work, suspect the normalization before believing the counter.

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

## A generated-code frame wears a borrowed name

`wprof2` resolves `wasm-function[N]` through the main module's symbol
map.  That map describes exactly one binary, and a TB module is not it —
so a frame from generated guest code comes back wearing whatever symbol
happens to sit at index N in `qemu-system-arm.wasm`.  Round 30's running
J2ME profile offered `helper_gvec_umax8` at 3.5 %, `invoke_ijjj` at
2.7 % and `__wasi_fd_seek` at 0.8 % on a board that has no SIMD, no
emscripten SjLj and no filesystem; `invoke_ijjj` in particular nearly
re-opened a lever the playbook had already closed on the rate.

The tell is the **URL**, which the profile prints next to every name and
which the symbol map cannot corrupt: `jit/qemu-system-arm.wasm` is the
main module and its names are real, `wasm://wasm/<hash>` is a JIT'd TB
module and its names are noise.  Bucket by URL first; inside the
generated bucket the only honest operation is a sum.

The same trap in a cheaper form: **never pipe a profiler through
`tail`.**  `tail` buffers to EOF, so a backgrounded run prints nothing
until it finishes and then returns the bottom of the table — the
entries too small to matter — having thrown away the top self-times that
were the entire point.  Redirect to a file, and save the raw profile so
it can be re-rendered without re-running the workload.

## Some ceilings cannot be probed by deletion

The ceiling probe — build a variant with the suspect work removed, run
it once, see what the prize is — is the cheapest tool here, and it paid
for 0070 (+5.0 %, which told us the real patch at +5.2 % had taken all
of it).  But it only works when deleting the work still leaves a
*running* guest.  Deleting the BQL from the MMIO path lets the main loop
and the vCPU run device code concurrently; the guest never reached idle,
and there was no number.  When that happens, build the real thing and
measure it — do not read the failure as "no win available".

## A path is not priced until something has been switched off

Round thirty closed the device path on arithmetic.  The counters said
the display stream ran ~29 k DMA bursts and ~59 k FIFO words per Mi;
at a guessed ~100 ns an event that is ~0.9 ms against 11.30 ms/Mi, so
"the next lever is code quality, not another device" went into the
handoff.  Round thirty-one switched three display mechanisms off in one
bundle and measured **+17.5 % of `MIPS/cpu`, 15 % of wall** — the
device path was the biggest lever on the board, and it had been retired
by a sum.

Both errors in that arithmetic are the ordinary ones:

- **The price was guessed, not measured.**  A display burst is ~600 ns,
  not ~100 ns.  Nothing in the profile said 100; it was the round number
  that made the total look small.
- **Only the events the counters *name* were counted.**  One `dmacBurst`
  also buys an MMIO dispatch, a BQL round trip, a `timer_mod`/
  `icount_get` re-arm and a VIC level change.  Those are real work on
  the same path, booked in the profile under other headings or under
  none, and no counter on the display chain knows about them.

So a sum of counters is a **lower bound wearing the costume of a
total**, and the gap is unbounded in exactly the direction that closes
directions early.  The only honest close is a knob and a palindrome:
build the "off", run it interleaved against the "on", and let the clock
say what the path is worth.  Cheap enough that guessing was never the
economical choice — the bundle that recovered this cost one afternoon.

The profile has the same failure in a second form: its buckets are drawn
by **symbol family** (`dif_*`, `lcd_*`), and a cross-cutting path does
not have a symbol family.  That bucket read 4.3 % for a path worth 15 %.
Group a profile by the path an event takes, not by the prefix its
symbols share.

## A synthetic prices the real thing only if it has the real thing's topology

Round thirty-one's other prediction failed the same way, from the
opposite direction.  `tests/wasm/dispatchbench.mjs` exists precisely so
that a TB→TB transition can be priced without the emulator around it,
and it carefully offers both topologies: `loop` is `call_indirect` from
a driver in the **same module**, `xtail` is `return_call_indirect`
**across** modules.  They read 12.7 ns and 27.9 ns.  CHAINLOOP — which
replaces the cross-module tail call with a driver loop — was predicted
at ~16 % of wall from the 27.9 → 12.7 difference, over ~108 k boundaries
per Mi.  It measured **−0.1 %** on a four-leg palindrome.

The driver loop `w64_driver()` builds is **its own module**.  So a
CHAINLOOP transition crosses the instance boundary *twice* — the TB
returns across it into the driver, the driver calls across it into the
successor — where the tail call crossed once.  The real thing was the
benchmark's `xloop` leg; the prediction had read `loop`.  Two crossings
at ~14 ns is one at ~28 ns, and a tie is what that arithmetic says.

The benchmark was not wrong and was not even missing a leg — `xloop` is
in it, and the file's own header says instance-switch cost is what
`stail` exists to isolate.  The mistake was picking the leg by the
*opcode* the change was about (`call_indirect`) instead of by the
**shape the change would actually have** (a call from another module).
So: before quoting a synthetic number, say out loud which leg the real
code will be, in the synthetic's own vocabulary.  If that sentence
cannot be finished, the number is not yet evidence.

The cheap guard is a counter, as always: `xtail` vs `xloop` would have
predicted the tie before the sixteen minutes were spent.

## A dispatch benchmark measures its target sequence, not its dispatch

The sequel, and the larger error.  Having matched the topology, round
thirty-two swept `dispatchbench` properly and found the topology was
never the axis that mattered.

The benchmark offers two target orders: an LCG (`unpredictable`) and a
+7 stride (`strided`).  Every number this project has ever quoted from
it — 12.7 ns, 27.9 ns, 34 ns, the merge's ~16 % and later ~19.5 % —
came from the LCG column, because that column was described as "what a
guest interpreter's dispatch looks like" and nobody asked whether it was
what *TB chaining* looks like.  At 4096 slots, 32 modules, 64 pad ops:

| order | `direct` | `xtail` | `xloop` | `stail` | `merged` |
|---|---:|---:|---:|---:|---:|
| unpredictable | 20.27 | 59.58 | 17.79 | 58.38 | 34.58 |
| strided | 20.13 | **15.97** | 16.81 | 16.36 | 16.56 |

With unpredictable targets the mechanism is worth 42 ns.  With
per-site-predictable targets **every mechanism is identical**, at the
pad's own floor — and a fixed direct chain with no dispatch at all is
*slower*, because its bodies differ.  There is no dispatch cost to
remove.

Which column is real is not a matter of taste, and the emulator had
already answered it: `W64_CHAINLOOP` swaps precisely `xtail` for
`xloop`, the LCG column predicts +87 % of wall for that swap, and it
measured −0.1 %.  An 87 % effect does not hide behind sd 11.  TB
chaining is predictable *by construction* — `tb_add_jump` exists to nail
each site to one successor — so the strided column was always the one to
read.

Two costs of not having asked.  Three sections of the handoff were built
on a boundary cost that is really ~0, and the fix they proposed was a
regression: at a realistic body size (pad 144, strided) `merged` reads
51.13 against `xtail`'s 35.73, because a `br_table` on a runtime index
replaces a *well-predicted* indirect branch with a poorly-predicted one.

So: a dispatch benchmark has two independent knobs, the mechanism and
the target sequence, and the second one dominates.  Sweep it. Name the
real workload's sequence before reading a column, the same way the
previous lesson says to name its topology — and when a knob in the real
system already performs the synthetic's A/B, believe the knob.

## A slope fitted across configurations is a bundle price, not a marginal one

A four-point `w64_ft_max()` sweep on a J2ME game fits

    ns/insn = 9.83 + 27.87 × exits/insn        (to 1.2 %)

and 27.87 ns/exit is a beautiful number: tight fit, in-emulator, on the
real workload, agreeing to within 20 % with an unrelated EL71
differential.  It sat in the handoff for a round and every proposal in
that round was sized against it.  Multiply it by the 119 161 boundaries
per Mi and the arithmetic says the TB boundary is **half the emulator**,
so of course the round went looking for a cheaper boundary.

The number is real and the inference from it is wrong, because of what
the sweep varied.  `W64_FTMAX` is the count of deferred taken paths a TB
may hold.  Raising it removes exits — but each extra deferral is also
another **label**, and this backend drops a TB out of its nested-label
mode into a `$bp` dispatch loop where every forward branch becomes
O(n_labels).  So the sweep moved exits *and* label cost *and* TB size
together, and the fitted slope is the price of that whole bundle moving
one notch.  It is not the price of one exit.

The proof is in the same sweep, past the point that was fitted.  Going
3 → 8 slots removes another 1.69 % of exits — the mechanism fires,
`tools/exitrate.sh` confirms it at matched instruction counts — and the
clock reads **−1.06 %**.  Fewer boundaries, more wall.  The terms in the
bundle have opposite signs and they cross at three, which is why three
is the shipped default.  A marginal price cannot change sign; a bundle
price can, and this one does.

The trap is that the fit quality argues for the wrong thing.  1.2 % on
four points feels like strong evidence about exits, when all it says is
that the bundle moves smoothly — which a bundle of correlated terms will
do whatever the terms individually cost.  A good fit measures
*collinearity*, never causation, and a one-knob sweep cannot tell the
two apart no matter how many points it has.

So: before quoting a slope as a per-unit cost, list everything the
swept knob changes.  If it changes more than the denominator, the slope
is an exchange rate between configurations and the only way to a
marginal price is a second knob that moves one term alone — or an A/B
that simply buys the units and reads the clock.  And when the sweep
already extends past its optimum, **read the far end**: the sign change
is the disclosure that the number was never marginal.

## A flat per-unit cost means the phase is misnamed

`MOD_NS` — the wall time a vCPU thread waits for the browser to turn a
batch of TBs into a callable module — had been read as "compile" since
0019.  Round nineteen split it four ways and then split the compile term
by assemble source, and the two sources differ by **178x in module count
and 1.05x in bytes**:

| source | modules | bytes | compile |
| --- | --- | --- | --- |
| first close | 33 969 | 88.2 MB | 2.849 s |
| compaction | 191 | 84.3 MB | 0.132 s |

That solves to ~80 us fixed per call and ~1.4 ns/byte marginal, and an
independent knob confirms it: across `W64_SPEC_N` 8 / 32 / 128 the module
grows 1880 -> 2903 bytes and the per-module cost reads **83.6 / 82.7 /
83.3 us**.  A cost that is flat across a 1.5x size range is not paying for
the work the phase is named after.

It was not paying for compilation at all.  The same real module compiled
**200 times back to back inside the vCPU worker's own isolate**
(`W64_MODBENCH`) costs **12-31 us**; in the normal flow, once every
~700 us between stretches of guest execution, the same bytes cost 83 us.
Four fifths of "compile" is cold cache — the compiler's own code and data,
evicted by the guest.

Two things follow.  A phase whose per-unit cost ignores its input size is
telling you the unit, not the work: find what *is* proportional and rename
the line item.  And a cost paid per *event* rather than per byte inverts
the usual advice — making each unit smaller buys nothing, and only fewer
events, or events adjacent to each other, can pay.

Note also what this exonerated.  Before the split, the obvious suspect for
an inflated compile was the Firefox GC nudge next door in the same
function, which manufactures ~170 MB/s of garbage at boot rates.  It costs
exactly its own allocation (0.27 s per 25 s) and inflates compile by
nothing: with it off, compile came back **2.8754 s against 2.8761 s**.
A neighbour with a plausible mechanism is still only a hypothesis.

## A calibration pad the compiler can fold measures the compiler, not the path

Round eighteen's instruments priced a phase against an *empty* interval and
inherited the clock's floor.  The fix is to price against a known cost
instead: `W64_LDSTPAD=N` emits N filler ALU units on every guest memop, so
wall time against N has a slope of ns per wasm instruction on that path.

The filler has to survive the optimising tier, and two designs did not.  A
dropped pure result folds to nothing.  An `i64.add` chain folds to
`x + (sum of constants)`.  And xor-then-rotate, which *looks* like a mixing
step and was chosen precisely because it seemed irreducible, folds just as
completely — **xor distributes over rotate**, so `rotl(x^a, k)` is
`rotl(x,k) ^ rotl(a,k)` and N units collapse to one rotate and one xor.

That third one was measured before it was caught: 8 units, 32 ALU ops,
read **1.64 ns per memop**.  It is worth noticing that this number is not
absurd on its face — it is only absurd once you divide, which puts a wasm
instruction at 0.05 ns, about 20 GHz.  **Sanity-check a calibration
against a per-instruction bound before believing its slope**; a folded pad
fails silently and looks like good news.

`add` and `xor` do not distribute over each other in either direction, so
alternating them has no algebraic collapse; the chain ends in a store the
engine cannot prove dead.

## A shared sink serializes what it measures

Any instrument that adds duplicate work has to consume the duplicate's
result, or the compiler deletes it.  *How* it consumes it decides what
is measured.

Round twenty-three's `W64_TLBDUP` emits N extra inline TLB probes on
every guest memop and folded their results into one global with
`load; add; store`.  That is a read-modify-write of a single address
executed by every memop in the program, so each memop's duplicate waits
on the previous one's store-to-load forward.  The duplicates stop being
independent work happening alongside the real code and become a
**serialized dependency chain**, and the slope prices their *latency*
instead of their cost.  Measured that way the probe came out ~2× too
expensive, and a one-load variant read as costly as a three-load one —
the three variants' ranking was wrong, not just their magnitudes.

The fix is one line: store each duplicate's result to **its own**
address with a plain store.  Nothing reads it, nothing forwards, and the
work still cannot be eliminated.

Generally: a sink must be un-eliminable *and* un-ordered.  A single
accumulator is the natural thing to write and is exactly the wrong
thing.  Related: "A calibration pad the compiler can fold measures the
compiler, not the path" — same class of mistake at the other end, where
the pad was too easy to remove instead of too hard to overlap.

## A ceiling probe measures the benefit and is silent on the cost

The probe in "Some ceilings cannot be probed by deletion" works by
*removing* work: whatever it recovers is the whole prize, cost included.
A probe that instead *simulates a mechanism* is a different animal, and
round eighteen paid to learn the difference.

`W64_LC2` simulated a second way of the per-TB inline lookup cache in
software — a shadow table in the miss helper, filled with whatever way 0
was evicting — and reported that a second way would catch **42.3 %** of
el71's misses.  Against a ~100 ns helper call that priced at +3.3 %.
Built for real, it did exactly that: `lcCall` fell **39 % per Mi**.  Wall
time did not move (el71 0.0 %, cx70 -0.2 %, A/B'd inside one binary via
`W64_LC_WAYS`).

The probe was right about every number it reported.  It simply had no
way to report the cost the real thing adds: way 1's compare chain runs on
every miss that still misses — 856k a second — and the emitted code for
every goto_ptr exit grew 20.6 %.  The saving and the cost were the same
size.

So before building from a simulated-mechanism probe, write down what the
real version adds to the path that *still* takes the slow route, and
whether it grows the generated code.  If neither can be estimated, the
probe has given you a hit rate, not a prize.

## A duplicate-probe prices deletion, never insertion

The lesson above is about simulating a *new* mechanism.  This one is its
mirror: measuring an *existing* one by duplicating it.

`W64_TLBDUP` emits extra copies of the real inline TLB probe and reads
the slope, which is as direct as a measurement gets — the probe is
**5.07 % of EL71 wall**, and unlike the `W64_LDSTPAD` extrapolation it
rested on, it measures the actual code.  A cheaper replacement was then
priced the same way: a two-load per-site cache, 2.33 %.  With a measured
94.7 % hit rate, putting the cheap check in front of the probe predicted
+2.4 %.  Built, it was **4.4–5.0 % slower**, and a pool-size sweep ruled
out locality as the explanation.

The duplicates are emitted **straight-line, outside any branch**.  The
real cache is an `if/else` that every memop executes, and its hit arm
has to duplicate the fast load/store it guards.  Meanwhile the probe it
skips was already predicted-taken and sitting off the dependency chain,
where a modern core runs it nearly for free.  So the instrument measured
what that code costs *standing alone* — which is what you would recover
by **deleting** it — and said nothing about what it costs to **insert** a
branch in front of it.

The rule: a duplicate-probe number is a ceiling on removing that code.
It is not a budget to spend on a cheaper thing placed before it.  On
this backend, only a scheme that *replaces* the probe outright can
collect any of the 5 %.

## A wake must be published after the work it advertises

The emscripten main loop cannot sleep in `poll()`, so it sleeps in
`emscripten_futex_wait` on a sequence word (`ml_futex_seq`,
`util/main-loop.c`), snapshotted before the timeout is computed.  Every
waker goes through `qemu_main_loop_wake()`.  Two rules fall out of that,
and the wasm port had both wrong:

- **The sequence word is an atomic counter, not a variable.** It was
  incremented with a read, an add and a store in the open.  Two threads
  wake concurrently as a matter of course — `qemu_notify_event()` issues
  one itself and a second through `aio_notify()`, and the vCPU notifies
  on every `timer_mod` — so a waker preempted between its read and its
  store writes back a value the waiter has already snapshotted, erasing
  its own wake.
- **The wake goes last.** `aio_notify()` issued the futex wake at the
  *top*, before the `smp_wmb()` / `qatomic_set(&ctx->notified, true)`
  that publishes the work.  The main loop can wake on it, look, find
  nothing published and sleep again — and the store that follows carries
  no wake of its own.  A wake spent on an empty look is a wake lost.

Either one loses an edge, and on a board with **icount off the main loop
is the only thing that runs `QEMU_CLOCK_VIRTUAL` deadlines** (see
Timing model, and the comment at `main_loop_wait`).  So a lost edge is
not a delay, it is a stop: the loop sleeps out its timeout — `INFINITY`
when no timer is armed — the vCPU blocks on the device completion that
timer owed it, and the guest is dead with every counter frozen.  That is
the KE800-on-Android bug: 0.00 MIPS on the splash screen, `halt/s` 0,
vratio 1.00, `execIter` and `mlWake` still along with everything else.
Under icount the same defect is invisible, because the vCPU runs those
timers itself.

**How it was established, and the rule behind that.** A race you hit
once every few boots cannot be A/B'd on a clock — the first attempt,
14 boots per arm under CPU contention, read 2/14 frozen against 0/14,
which is directional and proves nothing.  What proved it was a
`W64_AIOLAG=<n>` probe that **reinstated the wrong order and widened its
window**: on a completely idle machine, `0` (wake after publish) boots
at 44–108 MIPS, `20` freezes at 977 M instructions and `200` at 912 M,
both with the phone's exact HUD signature.  When the suspected mechanism
is a race, do not try to make the race more likely — build the knob that
makes it *certain*, and let the host's speed be the thing that decides
only how often the natural window is hit.

Corollary for tooling: the page could not tell a dead guest from a slow
one, so it said "Running · 0:21" over a corpse.  `site/app.js` §6b now
calls it: instructions, halts and display reads frozen *together* for
15 s is a thread that is gone, and the overlay carries the last line
qemu managed to print.  A phone has no console; the only report you will
get is the one the page can make by itself.

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

## Emitted code runs in the baseline tier; C helpers run optimized

**The engine has two compilers and our code lands in the slow one**
(2026-09-16, round twenty-one). A TB function is compiled when its
module is created, by V8's single-pass baseline compiler, and tiers up
only after thousands of calls. The main `qemu-system-arm.wasm` module is
compiled once and everything hot in it is optimized long before the
guest gets interesting. So the two halves of the system do not run at
the same speed, and the usual JIT instinct — inline it into the
generated code to avoid a call — is **inverted here**.

The numbers, all from `tools/locals-probe.mjs` and `--js-flags`:

- Baseline is **2×** the optimizing tier on the same TB-shaped function
  (49.9 vs 25.1 ns), and **3.6×** at the probe's ~70-local leg
  (88.9 ns) — wasm must zero locals at entry and a single-pass
  compiler has no liveness analysis to drop the unused ones. The
  optimizing tier drops them in SSA and is flat at 25 ns.  (The real
  emitter declares **37**, not ~70 — `tcg-target.c.inc:3397` writes four
  runs, `NB_REGS+1` i32, `NB_REGS` i64, one i32 and three i64, in nine
  fixed bytes; `W64_LOCALPAD` can add a fifth run, so read the count
  rather than assuming four.  Our TBs sit between the two probe points,
  nearer the 49.9 ns one.)
- The boot runs `--liftoff-only` **+63 %** and `--no-liftoff` +119 %
  (compile swamps it), so TB code does tier up and the baseline tier is
  genuinely expensive.
- `--wasm-tiering-budget=1000` is **−3.1 %, 3/3 interleaved** — that is
  the share still executing baseline code in the shipping build,
  ≈3.6 % of TB entries.
- **Tier-up takes ~1–2.4 × 10⁴ calls, and does not depend on function
  size** (`tools/tierup-probe.mjs`, across an 85× size range). So a
  function called ~1000 times does not tier up, and anything short-lived
  never leaves the baseline tier. It also means merging functions to make
  them tier up sooner buys N, not N² — the budget drains per call.
- Two ways to mis-measure this, both paid for once: a warm-then-measure
  ladder cannot work (the measuring calls drain the budget too, so
  measuring is what causes the transition), and the body must be *live* —
  a dead one is removed by the optimizing tier's DCE so every trial reads
  as already-tiered, while a straight dependent add/xor chain compiles
  identically in both tiers and reads as never-tiered.

- **On a running J2ME game the baseline share is 3–6 %, not 3.6 %**
  (2026-09-17, round thirty-one).  `--js-flags=--no-liftoff` read
  **+6.3 %** over the shipping default on a four-leg palindrome, games 1
  and 2 (on 77.23 vs off 82.10; g2 separated cleanly, g1 did not, so
  read this with 0050's +3 % as the same number's lower end).  The boot
  reads `--no-liftoff` +119 % *slower* because compile swamps it; the
  game's working set is long-lived, so what is left is the execution
  difference.  The flag is live and not a placebo — `modCompileNs` per
  module went 1.06 → 1.76 ms.  Two consequences: a browser flag is not
  a shipping lever, so this is a *ceiling* on tiering, not a win; and
  3–6 % is larger than every remaining device item except the display,
  which makes **tier-up latency** — ~1–2.4 × 10⁴ calls per *function* —
  a first-class target.  277 TBs/s are still being translated in steady
  state, and a TB called a few thousand times a second needs seconds to
  leave the baseline tier.  The budget drains per call, so the fix is
  fewer, bigger functions: see the module-local dispatch loop in
  performance-handoff.md.

And the call you were avoiding is nearly free: a TB module's call into
the main module is **2.1–2.4 ns** optimized, 3.6–4.4 ns baseline, the
same whether the helper is imported as an export, taken from
`wasmTable.get()` the way `wasm64.c` resolves it, or reached by
`call_indirect` (`tools/import-probe.mjs`). `wasmTable.get()` returns a
real exported-function object, so V8 wires a direct cross-instance wasm
call with no JS frame.

Two rounds hit this wall before it had a name: 0046's first two inline
lookup caches were both rejected with "Liftoff code for a dozen loads
and six branches costs more than the TurboFan-compiled helper's
jump-cache hit", and the `$tlb` hoist removed eight emitted bytes and a
load per memory access and was **+3..+10 % slower**. Read those as the
same fact. Before moving work into emitted code, ask what it costs at
2× — and before rejecting a helper call, remember it is 2 ns.

**A counter proves a mechanism fires. Only a clock proves it pays, and
round thirty-one paid to learn the difference.** The inline per-TB-slot
cache (mechanism K, `gen_goto_ptr_pcc`) emits a second way into every
`goto_ptr` so a hit never reaches the C helper. Its counter is
emphatic: helper entries (`lcCall`) fall **14 738 → 548 per Mi** on
game 1 and **7 787 → 448** on game 2, so ~96 % of `goto_ptr` exits stop
in emitted code, exactly as designed. On the
strength of that drop it was reported confirmed. Then `W64_NOPCCIN=1`
switched the emitted way off inside the same binary, and the mechanism
read **−7.4 %** — worse than not having it (per game: one −15.4 %, one
a tie; an eight-leg confirmation was queued before anything shipped).
The counter was never wrong. It answered "does the fast path run?",
which was not the question; the question was "is the fast path faster?",
and a six-word compare chain at 2× loses to a 2 ns call into
TurboFan-compiled C. The playbook rule *a counter confirms a mechanism,
a clock only prices it* had been written down two rounds earlier and
still did not fire here, because the counter moved by an order of
magnitude and a big number feels like a verdict. **A hit-rate is a
confirmation of firing and nothing else** — it contains no information
about the cost of the path that produced the hit.

**And the first telling of this lesson quoted the wrong counter, which
turns out to be the more useful half.** It read "helper `lookup` calls
fell 15 839 → 1 283.7 per Mi, so 92 % of lookups stop in emitted code".
Tagging every leg on disk by arm shows `lookup/Mi` does not move at
all: **1276 with the emitted way off, 1298 with it on.** What moves is
`lcCall`, the helper *entry* count. The two are not the same counter
because `helper_lookup_tb_ptr_lc` increments `lcCall` on entry and can
then return on a C-side pcc hit **before** it ever calls `tb_lookup`
(`cpu-exec.c:876–901`). With the emitted way switched off, 14 738
entries per Mi produce 1276 lookups: the C-side pcc absorbs 13 462 of
them *inside the helper*.

So the caching here is three levels deep — emitted inline way, C-side
pcc, then jump cache and qht — and mechanism K is the third one added
in front of two that already worked. Its true job is not "stop 92 % of
lookups", which the C-side pcc was already doing; it is to save the
**call boundary** on exits the C-side pcc would have caught anyway.
That boundary is ~2 ns, and it buys it with a six-word compare chain
run at 2× on every exit. Stated that way the −7.4 % needs no
explanation at all. **When a counter moves by an order of magnitude,
check what the layer *underneath* it was already absorbing** — a cache
in front of a working cache inherits its hit rate and can claim credit
for it, while owning only the difference.

The corollary is the useful half, and it generalises past this
mechanism: **"inlining is wrong here" is a statement about the tier, not
about inlining**, so it expires when the tier does. If the module-local
dispatch loop lands and TBs reach TurboFan ~277× sooner in TB-entry
terms, the compare chain gets cheap while the helper call does not, and
mechanism K should flip back to profitable. That is why it is being
defaulted off behind a live knob rather than deleted. When you retire
an optimization because emitted code is slow, write down what would have
to change for it to come back.

## An interpreter compiles to wasm at native speed; emitted code does not

Two numbers that look like they belong to the same scale and do not.

`tools/interp-probe.c` is a TCI-shaped dispatch loop — byte opcode,
jump-table switch over ~15 cases, operands decoded out of the stream, a
register file, TCG's own op mix.  Compiled with `gcc -O2` and with
`emcc -O3` it runs at **the same speed**: 7.30 / 7.42 / 7.43 ns per op
native against 7.26 / 7.42 / 7.22 in wasm, three pairs.  V8's optimizing
tier has nothing to apologise for on branchy interpreter code.

Emitted TB code does not get that.  It lands in the **baseline** tier
(see "Emitted code runs in the baseline tier; C helpers run optimized"),
and the whole wasm64 emulator runs 2.7× slower than the native JIT on the
same guest window — 49 MIPS against 131.1.

So the *ratio* between interpreting and compiling is much kinder in the
browser than on the host.  Natively, TCI is 6.1× the JIT (21.4 against
131.1 MIPS on EL71).  In wasm the interpreter keeps its native speed
while the compiled side gives up 2.7×, so the same interpreter costs
about 3× — and against a translate-and-compile pipeline that costs
~83 µs per module, that changes a verdict rather than a decimal.

The general form: **before assuming a native cost ratio carries to the
browser, ask which tier each side lands in.**  C in the main module is
optimized; emitted wasm is mostly not.  Anything that moves work from the
second to the first gets a 2–3× discount that has nothing to do with the
work itself.

## Locality only pays on a dependent load

**A load from a compile-time-constant address is not on the critical
path** (2026-09-16). 0091 won 5–11 % by removing a load whose address
came *out of another load* — the dispatch followed the chain slot into
the target TB's descriptor, two hops feeding an indirect branch. The
obvious follow-up, packing those chain slots into a dense arena so four
TBs share a cache line, was **a wash over six interleaved pairs** (mean
−0.9 %, SE 1.6 %).

The difference is not size, it is dependence. After 0091 the remaining
slot address is a constant the emitter wrote into the code, so the load
issues as soon as the TB starts and its latency is hidden behind
everything else in the block. Making it denser improves a number nobody
was waiting on. The same argument retires the matching idea for the
`w64_lc` inline-cache slots, whose address is likewise constant.

When a locality change is proposed, first ask **where the address comes
from**. If the emitter knows it, the prize is small however cold the
line is.

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

## A comment explaining why you need not measure is the thing to measure

The knob-sweep script carried a note saying wasm bound checks were not
worth an arm, because V8 serves this memory with trap handlers and the
checks therefore cost nothing.  It read as settled.  Round 35 spent one
leg on `--js-flags=--no-wasm-bounds-checks` anyway: **−26.0 %**, larger
than every improvement this workstream had shipped in thirty-four rounds
put together.  About 1.08 ns of the 4.15 ns each guest ARM instruction
costs — roughly three host cycles per guest instruction.

The number refutes the comment by existing.  If trap handlers really
served this memory, there would be no explicit checks for the flag to
remove and the arm would have read 0 %.  So an effect size is evidence
about the *mechanism*, not only about the magnitude: a flag that does
nothing tells you the code is absent, and one that does a great deal
tells you it is present and hot.  The comment had an argument where it
needed an observation.

Why it was so large here is worth keeping: it is not one check per
access.  Every `CPUState` field touch is a check (~1.33 env memory ops
per guest instruction), and every *guest* load or store is **four** —
the inline TLB probe is three loads plus the data access.  Nor is it
additive with the standing budget; the boundary row, the 5.07 % TLB
probe and the ~23 % TB-entry row each already contain a share of it.

The rule: when a one-line flag would reprice the entire budget if it
moved, it costs one leg and you do not get to *reason* it to zero.  Sweep
the cheap disprovable thing before the expensive plausible one.

**It happened again on 2026-09-17, and the second instance shows the
shape more clearly than the first.** `hflags.c` carried: "called 11.6 k
times a second, which at any believable cost per call is under 0.3 %."
Same structure — an arithmetic argument standing in for an observation,
and persuasive enough that the row was nearly dropped a second time.
When it was finally timed: **31.6 ns/call, 0.8–2.3 % of wall** depending
on the game.

What makes this instance instructive is *why* the argument failed, which
was not the arithmetic.  "11.6 k/s" was measured, correct, and taken on
an **idle** CX70; a J2ME game drives the same function 5× harder still
between its own games, because the rate tracks the guest's SWI rate at
~2.7 rebuilds per SWI.  The comment was true about what it measured and
false as a dismissal, and nothing in its text said which.

So the rule has a second half: **a rate is a property of a workload, not
of a function.** Any comment that prices code from a measured rate must
name the workload beside the number, or it will be read as general by
the next person — including the person who wrote it.

## Grep the logs before declaring a measurement owed

The handoff carried a section arguing that pricing `arm_rebuild_hflags`
needed "one build with `-DWASM_DIAG_TIME_PHASES`", called it "the
cheapest unpriced row on the list", and queued it for the next rebuild.
The counters were already in two logs on disk, from a build earlier the
same day.  One `grep hflagsNs` would have closed the row; instead it was
scheduled behind a forty-minute compile.

The error was a **scope creep in a true statement**.  What was verified
was narrow: *the 18:38 `postsweep.sh` rebuild* did not carry the flag —
checked, correct.  What got written down was general: the measurement
does not exist.  The gap between those two is invisible when you are the
one who checked, because you remember the check and not its scope.

This is cheap to defend against and the defence is mechanical:

- Before writing "needs a build", grep the existing logs for the
  counter's **output name**, not the macro.  `hflagsNs` appears in a
  `perMi:` line; `WASM_DIAG_TIME_PHASES` appears nowhere in a log, and
  grepping for the macro finds nothing and feels like confirmation.
- A per-Mi counter from a spoiled run is still exact.  An
  over-instrumented leg has a useless wall but correct ratios, so a leg
  rejected for one purpose is not rejected for all — `nsrate` was 17 %
  slow and still gave a `hflagsCalls/excSwi` ratio agreeing with the
  clean leg to 2 %.
- State the scope you actually checked.  "This build lacks the flag" and
  "no build has the flag" differ by one grep and forty minutes.

## A share's denominator must be the population its numerator came from

The five `GSYNC_*` counters attribute each guest-register write-back to the
liveness site that demanded it, and the natural thing to print is each
cause as a percentage of `tcgGst`, the write-back counter.  Doing that
printed `attributed 19.938 of 14.756 per Mi (135.1 %)`, with the surplus
waved off in the script's own words as "the residue is allocator
pressure".  A residue cannot exceed the whole, and that line should have
stopped the round on the spot.

The two counters count different populations.  `la_charge` fires once per
global output arg that liveness marks `SYNC_ARG` — a sync **demand** —
while `WASM_DIAG_TCG_GST` fires inside `temp_sync`, which emits nothing
when the global is already coherent.  Demands ran 1.32–1.35× the stores.
Nothing was miscounted; the ratio was simply between a numerator and a
denominator that were never drawn from the same set.

**The test costs one line: sum the parts.**  Against the demand total the
five causes come to 100.0 % and 99.9 % — an exact partition, which is the
positive evidence that the denominator is now the right one.  Against
`tcgGst` they came to 135 % and 132 %, and two numbers that miss by
different amounts are not a partition of anything.  Any counter family
that claims to decompose a total owes this check before any share it
prints is quoted.

The correction moved a lever's bracket from 11.3–15.2 % down to
8.3–11.5 % and changed no decision, which is the easy case.  It is worth
noticing that the previous round's commit is titled *"the meter was wrong
by a factor of two"*: two rounds running, the defect was in the
denominator rather than in the mechanism being measured.  When a
conversion factor is suspicious, suspect the meter before the machine.

## Per-TB is not per-instruction: vary the denominator or you cannot falsify

`tcgGst` counts guest-register write-back stores.  Divided by generated
TBs it is 9.46 per TB, which reads unmistakably like a boundary cost —
`wasm-diag.h` had filed it under one since round eleven, and the handoff
doc drew the obvious conclusion in as many words: "neither grows with TB
length, so they amortise directly: doubling the average TB halves both."

Normalise by *guest instruction* instead and sweep TB length across a
60 % range.  Stores per translated instruction are **0.939** at FTMAX 1,
**0.972** at the default, **1.026** at FTMAX 4: as TBs lengthen they do
not fall, they **rise**.  The mechanism is immediate once seen — folding
through a branch is *what lengthens a TB*, every branch folded in is
another brcond, and every brcond demands a write-back.  So lengthening
TBs does not amortise register sync, it buys more of it, and that cost
sits against the entry saving it was bought for.  It is also a candidate
explanation for why the fold-through optimum turns over: FTMAX 4 is
−2.0 %, but 6 is only −1.5 %.

Flatness is the crude test.  The constructive one is to regress the
per-TB count on TB length and read the two coefficients: the intercept
is the boundary cost, the slope is the per-instruction cost.  Seven legs
spanning 6.83 to 10.91 guest instructions per TB, R² ≥ 0.99 on all
three:

| counter | fixed per TB | per guest insn | what it says |
|---|---|---|---|
| env **loads** | 1.77 | 0.555 | 25 % fixed at base — the prologue reload, and this half really does amortise |
| env **stores** | −1.45 | 1.149 | intercept *negative*: super-linear, no boundary term at all |

A negative intercept is not a cost.  It is the fit reporting that the
curve bends the wrong way for the story you brought it.  The two halves
of "env traffic" are not the same kind of cost, and the single per-TB
number had been wrong about both.

**Then the units bit back, in the same way.**  The first run of that fit
used `tbIcount` as the mean TB length and produced a clean, plausible,
entirely wrong table — 2.82 fixed loads and 0.69 fixed stores per TB,
stores flat at 0.68 per instruction.  But `WASM_DIAG_TB_ICOUNT` is the
**sum** of `tb->icount` over translated TBs (`wasm-diag.h:112`), and
every `perMi` value carries the same denominator already
(`j2mebench.mjs:776`).  So mean TB length is `tbIcount/tbGen`, and a
per-instruction rate is `x/tbIcount` — never `x/tbGen/tbIcount`, which
divides by the TB count twice.  The wrong version put mean TB length at
12.60 instructions instead of 9.73 and turned a rising store trend into
a flat one, which is to say it inverted the finding.

Both versions fit at R² ≈ 0.99.  **A high R² certifies that a line fits
the points; it says nothing about whether the x-axis is the quantity you
named it.**  Downstream the error was large: TB entries per Mi 79,340
versus 102,745, and the entry price ~12 ns versus ~17 ns — the
difference between the TB entry being a quarter of wall and nearly half
of it.

So: before dividing, read the counter's *definition*, not its name.
`tbIcount` sounds like a mean and is a sum.

The error was structural, not arithmetic.  "Per TB" was a ratio whose
denominator had never been varied, so no observation could ever have
contradicted it; it was a unit, being read as a claim.  The correction
also shrank a downstream item: passing guest registers as call
parameters can only remove the sync at block ends, never the sync that
a faulting op or a helper requires, so the "17 env accesses per TB" it
was priced against badly over-stated it.

The rule: to test whether a cost is per-X, hold the work fixed, vary X,
and normalise by something that is not X.  A ratio is only evidence
about its denominator if you have moved the denominator.

## A difference is only a denominator if it clears its own noise

Round thirty-five priced a TB entry by dividing the wall that FTMAX 3→4
bought by the fraction of entries it removed.  The entry count itself is
not measured on this workload — `wasm_tbs()` returns 0 on the wasm64
backend under icount unless `W64_TBSTATS=1`, so every result JSON carries
`insnsPerTb: null` — so three rounds running, somebody substituted a count
derived from whichever counter looked like a mean TB length.  It was
`tbIcount` twice (79,340 then 81,096 entries/Mi, and a "13.6 % of wall"
that stood in the budget for months) and `tbIcount/tbGen` once (102,745).

Writing the algebra out looked like the fix, and it is a good trick worth
keeping: with `L` the mean executed TB length, `r` the factor the arm
multiplies it by and `Δt` the wall it buys, entries are `1e6/L`, the arm
removes `1e6/L·(1 − 1/r)` of them, the per-entry price is
`Δt·L/(1e6(1 − 1/r))` — and the total, price × count, is
**`Δt/(1 − 1/r)`.  `L` cancels.**  The unmeasured quantity was never needed
for the number anyone wanted.  Before hunting for a missing denominator,
always ask whether the answer is a *ratio* of things already in hand.

Then the cancelled form produced **43 % of wall**, three times the
standing figure, and it was wrong too.  `r` was 1.048, so `1 − 1/r` was
0.046 — and the round-to-round spread of translated TB length *within a
single arm* is about 11 % (ft4 alone reads 9.449, 9.927, 10.481 across
three rounds).  The divisor's error bar spanned zero.  A quotient whose
denominator might be anything from 0 to 0.09 can be anything at all, and
the algebra had made that invisible by turning two clean-looking
measurements into one clean-looking number.

Fitting instead of sloping fixed it.  `ms/Mi = 3.48 + 6.19/len` over all
ten legs (R² = 0.89, `tools/perf/entryfit.py`) puts the entry at **15.8 %
of wall** — restoring the 13.6 % the budget had carried and agreeing with
round 23's independent 7.7 ns per transition.  Of the four pairings
available in the same data, three give 18–22 % and only the one with the
smallest, noisiest denominator gives 43 %.  The leg that makes the fit
trustworthy is `ft1`, whose length change (−28 %) is the only one that
dominates its own noise.

Three rules, in the order they would have saved time.  **Before dividing
by a difference, compare that difference to the spread of the same
quantity within one arm** — if it does not clear it, there is no
measurement there, however many digits the quotient has.  **Prefer a fit
over all legs to a slope between two**, because a fit is visibly wrong
when the points do not line up and a slope never is.  And **a derived
count is not a measurement; the give-away is that it never disagrees with
anything** — 79,340 and 102,745 differ by 29 % and neither was ever
contradicted by an observation, because neither was one.

## A translation-time counter weights by compilation, never by execution

Even after `tbIcount/tbGen` was fixed to mean what it says — the mean
length of a *translated* TB — it was still the wrong quantity for
pricing a TB entry, and the error is bigger than the units error was.
On J2ME the translated mean is 9.4 guest instructions; the exit census
(`xGotoptr + xGototb + xGototb1` = 55.4 k/Mi, already sitting in
`tools/perf/xcensus.out`) puts the *executed* mean at ~18. Nearly a
factor of two, in the direction nobody would guess wrong on purpose.

The mechanism is obvious once stated and invisible until then: every TB
contributes to `tbGen` exactly once no matter how often it runs, so the
translated mean is a histogram over *compilations*, and a cold TB
translated once and abandoned weighs as much as the interpreter's inner
loop. Hot code is loops, loops are long, so the executed mean is pulled
up. Any counter incremented in `tb_gen_code` has this property — and the
wasm64 backend has a lot of them, because translation-time counters are
cheap and do not perturb the wall.

The rule: **a counter incremented at translation time can only answer
questions about translation.** To price something that happens per
execution, count it in the generated code (`W64_XCOUNT`, `W64_TBSTATS`,
`W64_LDSTCOUNT` are all this class) and accept that the leg's wall time
is no longer comparable — per-Mi rates stay exact, which is what a rate
question needs. The give-away that you have crossed the line is a ratio
whose numerator counts events and whose denominator counts compilations.

## Never edit a shell script that is currently running

Bash does not load a script; it reads it **by byte offset, as it goes**.
Insert lines above the point it has reached and every subsequent read is
shifted — the next chunk starts mid-statement and bash executes whatever
the shifted bytes happen to spell.

This was nearly done here, mid-A/B, to fix a cosmetic guard: the script
was blocked on a benchmark leg, an edit added ~300 bytes above its read
position, and only the fact that it was parked in a command substitution
kept the damage from landing. The fix is to restore the exact original
bytes at once (length included), then make the change after the run, or
to `cp` the script and edit the copy.

The bug being fixed is worth its own note, because the idiom is
everywhere: **`grep -c` prints `0` and exits `1` when nothing matches.**
So `n=$(grep -c PAT file || echo 0)` sets `n` to the two-line string
`"0\n0"`, and every `[ "$n" != 0 ]` test on it fires. A guard written
that way reports the condition it was built to rule out — here, "-O2 is
still present" against a `build.ninja` containing exactly zero of them.
Use `n=$(grep -c PAT file); true` and default with `${n:-0}`.

## Two intervals from differently-shaped experiments cannot be subtracted

Round 35 measured a V8 flag at −24.51 % ± 1.53 of wall. Round 36 measured
a build change at −15.92 % ± 1.78. Both intervals were tight, neither
overlapped, and subtracting them said **8.6 % of wall is unexplained** —
a number large enough to justify a round of its own, complete with a
ranked candidate list and a mechanism (the table bounds check on the
indirect call every TB exit makes).

Measured directly, the residue is **zero**: +5.73 % ± 6.30 on ms/Mi,
−3.59 % ± 5.11 on MIPS/cpu, unresolved on both meters over six paired
legs on a quiet host.

The subtraction was never valid. The two experiments had different
shapes — 4 single-game legs against one binary, versus 6 paired
two-game legs against another — and the games, the pairing, the window
and the baseline all differed. Each interval was a correct statement
about its own experiment. Neither was a statement about the other's
quantity, so their difference described nothing.

**The rule: a quoted ± is a property of one experiment, not a portable
measurement of a mechanism.** Two such numbers may be compared only when
the same instrument produced both under the same protocol. When you want
the difference between two effects, run the arm that isolates it — here
that was one script, no rebuild, 23 minutes, and it replaced a ranked
list of three hypotheses with an answer.

The corroboration came from the variance, not the mean. The flag arm's
legs spread 43 % where the plain arm's spread 21 % — *the same binary,
noisier with the flag than two different binaries were against each
other*. A flag with no mean effect that still perturbs codegen looks
exactly like that, and it retro-explains why the same flag had read so
tightly on the older build: there, it was removing explicit checks on
every memory access. **When an instrument's own variance grows, it has
stopped being able to answer; record it as spent.** `--no-wasm-bounds-
checks` can no longer resolve anything under ~10 % on this build.

## Per-Mi does not make a host-paced counter guest-relative

Normalising a counter per mega-instruction is supposed to remove the
speed of the arm from it, so that two arms running the same guest agree.
It does that only when the guest *causes* the event. Round thirty-six's
mem32 A/B nearly lost a good result to the gap.

The paired analysis printed five translation-side counters under the
heading "should be unchanged", and they read −25 % to −32 %: `tcgGst`,
`tcgGld`, `tbGen`, `tbIcount`, `tbBytes`. On its face that says the two
arms translated different code, which would have voided the +19 % as a
comparison of different work.

Two separate errors, and the second is the one worth keeping. The first
was reading a ratio of means: taking the delta *inside* each (repeat,
game) pair first collapsed the raw 70–90 % within-arm spread to
−16.17 % ± 7.34 %, because which code a leg translates is a property of
which game it played and that cancels in a pair. Incidentally the 70–90 %
also retires a house assumption — the hand-off's "counter spread is
0.04 %" is a *boot* fact. In a steady-state J2ME window translation is
rare and bursty (`tbGen` ≈ 2.1/Mi), so those counters are among the
noisiest things in the file, not the quietest.

The second error was the heading. A TB flush here is driven by module GC,
a `mlWake` is a worker wake, a compile is a compile: all of them happen
at a rate per *second*. Their rate per guest instruction is therefore
`rate_per_second / (guest instructions per second)`, so an arm that runs
the guest 19 % faster shows `1 − 1/1.19 = −16 %` on every one of them,
having changed nothing. Inverting them recovers the speedup they were
hiding in:

| counter | paired Δ | implied speed-up |
|---|---|---|
| `tbGen` | −16.17 % | +19.3 % |
| `mlWakeDup` | −15.36 % | +18.2 % |
| `mlWake` | −14.72 % | +17.3 % |

against +19.16 % ± 2.47 % measured from the wall clock. The genuinely
guest-paced counters stayed flat across the same pairs — `execIter`
−0.37 %, `excSwi` −0.36 %, `armIrq` −0.35 %, `hflagsCalls` −0.34 %, and
all 24 device counters (`lcdPx`, `ssiByte`, `dmacRun`, `tpuTimer`, …)
identical to three digits — which is the check that actually answers "did
both arms run the same guest".

So: **classify a counter as guest-paced or host-paced before reading a
per-Mi delta from it.** For a host-paced counter that delta is not an
observation about the change, it is the speed-up restated — which makes
it useless as a validity check and rather good as a free second opinion
on the clock, since it is derived from counts rather than from timing.
The tell is that a whole cluster of unrelated-looking counters moves by
the same percentage and that percentage is `1 − 1/speedup`.
`tools/perf/ctrdiff.py` diffs all of them paired, with each one's
within-arm spread beside it, which is what makes the cluster visible as a
cluster.

(It also turned up `irecBytes` reading **−46.2**/Mi in the baseline arm.
A byte count cannot be negative; something is differencing a counter that
wraps or is read unsigned. Unused so far, so nothing downstream is
wrong — but it is a live bug in the diagnostic set, not a quirk. Found
and fixed in round thirty-eight — see the next section.)

## A gauge cannot share a slot with counters, and the tell is a negative rate

`irecBytes` was a **gauge**: `w64_irec_bytes` tracked bytes of interpreter
records *currently live*, so recording over a slot subtracted the old
record's size before adding the new one. Every other entry in
`wasm_diag_stat` only ever goes up, and the harness differences
consecutive samples to get a rate — so the one slot that could go down
printed a negative rate whenever a window dropped more records than it
added. That is the whole bug: not an unsigned wrap, not a read race.

The fix is to split it into two monotonic counters, `IREC_BYTES`
(recorded, cumulative) and `IREC_FREED` (released, cumulative), and let
the reader subtract for the live figure. Both now read positive —
1056.3 recorded against 579.7 freed per Mi on a J2ME window, which also
says something the gauge never could: **the tier churns**, retiring more
than half the bytes it records.

Generalised: **a value that can go down cannot share a slot with values
that only go up**, because the container's contract — differencing — is
defined on the majority. The tell is cheap and worth looking for
whenever a new counter appears: a rate that is negative, or that is
implausibly small because two real movements cancelled inside one sample
window.

## A construct that emits two boundaries charges two counters — price both

`GSYNC_*` splits guest-register write-backs by the liveness site that
demanded them, and the split is exact. That exactness is what made the
mistake possible: A32 predication was priced at
`GSYNC_CBR × (PRED_SEL/PRED_A32)` and declared dead at 0.2–0.75 % of
stores, because `CBR` is the counter whose comment says "a brcond, which
on this guest is mostly predication".

A predicated instruction emits **two** block boundaries. `arm_skip_unless`
emits the `brcond` over it; `arm_post_translate_insn` emits the
`gen_set_label` after it. Liveness walks backwards, so the label is seen
first and claims the instruction's *own outputs* (`BBEND`); the
instruction's write then clears `TS_MEM` (`tcg.c:4234`, "Output args are
dead"), which restarts the blame span, so the `brcond` claims only what
was dirty *before* it (`CBR`). If-conversion deletes both boundaries and
therefore both charges — and `CBR` is the half it does **not** remove.
Pricing the lever off it priced the wrong half, and the upper bound is
11–15 % of stores rather than 0.75 %.

The give-away was available without any new measurement: `BBEND` was 42 %
of sync causes and sitting in the same table, labelled "the open
question", while the lever next to it was being closed on a 0.8 % row.
**Before converting a counter into a lever's ceiling, enumerate every op
the transformation deletes and check which counter each one charges.**
Exact attribution tells you where a cost landed; it does not tell you
which costs a change would remove, and a per-site counter family invites
exactly this confusion — the finer the split, the easier it is to price a
construct off one of its pieces.

Corollary on confirmation: `BBEND/PRED_A32` came out 5.55 and 5.64 across
two games and looked like a mechanism. It was shared denominator —
everything translation-side tracks `tbIcount`. A ratio that is stable
across legs is evidence only if its two terms are known not to track a
common third.

## A waiter that greps the process table can match itself

Chaining a build behind a benchmark looks like one line:

```sh
until ! pgrep -f '[a]fter.sh' >/dev/null; do sleep 20; done
```

The `[a]` bracket is the old trick to stop the pattern matching the
`pgrep` process itself, and it works.  What it does not stop is the
pattern matching *any other process whose command line contains the
text* — including a second waiter written to report on the first:

```sh
until ! pgrep -f '[a]fter.sh' >/dev/null; do sleep 20; done
echo "after.sh chain finished at $(date +%H:%M:%S)"
```

That one's own command line carries the literal `after.sh` in its `echo`,
so it matches itself and waits forever; and the build waiter matches *it*
and waits forever too.  The benchmark had finished; both waiters sat in
their sleep loops, and from outside it looked exactly like a build that
was merely slow.  Ten minutes went by before anyone asked why a 0-byte
log had a live writer.

**Wait on an artifact, not on the process table.**  A file cannot match
itself:

```sh
until grep -q '^== exit ' build.log; do sleep 20; done
```

It is also strictly more informative — the same poll that says *finished*
can say *finished how*, which `pgrep` never can, so the chained step gets
to refuse to run after a failure instead of benchmarking a stale binary.

The trap recurs whenever a command's own text is the thing being searched
for.  Killing the waiter later in the same session, `pgrep -af mem32ab`
listed three matches that were all the monitor's own `tail` and `grep`,
and a `pgrep -af 'bash tools/perf/mem32ab'` matched nothing but itself.
Read what a process-table match actually *is* before acting on it: the
only safe test names the interpreter and the script path together, and
even then the answer is worth a second look.

## A host burst inflates a contiguous run of legs — reject them, don't model them

Round 35's FTMAX sweep ran six arms in rounds. Its control moved:

| leg | ran at | ms/Mi |
|---|---|---|
| k1_base | 17:17 | 4.151 |
| k2_base | 17:47 | 4.209 |
| **k3_base** | **18:01** | **4.543** |

A 9.4 % spread on the *control*, against the 1.4 % this workstream quotes
as base noise. A control does not move 9.4 %, and that — not any
statistic — is the tell worth training on.

**The wrong model is drift.** Regressing legs on time after removing each
arm's mean gives a tidy **+0.111 %/min**, and it is an artefact. Two
things falsify it. The rate is unstable: one more leg moved it to
+0.156 %/min, a 40 % swing. And the host, sampled directly, was caught
switching off — `vmstat` showed 24 k pages/s swapped out and ~1 GB/s of
block reads at 18:00, and flatly **zero** swap-out with 35 GB available by
18:05, with nothing changed inside the container.

**The right model is a burst over a contiguous run of legs.** Round 3 ran
ft4 17:50, ft6 17:53, pg12 17:56, nobc 17:59, base 18:01, ft1 18:04.
Against the same arms in round 1 those read **+0.0, +2.0, +1.5, +9.3,
+9.4, +9.0 %** — a step between pg12 and nobc, exactly where the sampled
burst began. Three legs were hit; fifteen were clean.

Rejecting those three restored everything, and the restoration is the
point:

| quantity | with the 3 bad legs | with them rejected |
|---|---|---|
| entry-cost fit R² | 0.472 | **0.891** |
| entry cost | ~20 %, band 9–28 % | **15.8 %, band 12.3–18.9 %** |
| `ft4` vs base | −5.4 % ± 3.7 (unresolved) | **−2.85 % ± 0.88** † |
| per-round intercepts | 3.293 / 3.282 / 3.502 | **3.496 / 3.484 / 3.481** |

† A fourth round later withdrew this one: `ft4` is **−2.09 % ± 1.81**,
unresolved, once the sweep's *position* effect is in the model. Rejecting
the bad legs was necessary and did what this table says; it was not
sufficient. See the next lesson.

**Three bad legs in eighteen were enough to make a settled number look
unsettled and a good fit look like small-`n` luck.** The collapse in R²
read exactly like "the earlier result was overfitted to ten points",
which is the trap: a fit that degrades when you add data usually means
bad data, not a bad fit. Check what you added before rewriting what you
had.

Both corrections attempted before rejection were wrong. Detrending
against time *lowered* R² to 0.63, because a linear correction cannot fit
a bursty driver. A per-round intercept barely moved the slope (8.163 →
7.985), because the arms being contrasted already run adjacently inside a
round — **contamination shifts levels, not within-round contrasts.** And
within-round ratios are not a defence either when the burst is shorter
than a round: it cut round 3 in half.

**The cause was outside the container.** Two suspects were wrong first.
There were 10,193 zombie processes — every orphaned Chromium child of
every leg, since PID 1 here is `sleep infinity` and reaps nothing — but
`pid_max` is 4,194,304, so 10 k zombies is 0.24 % of PID space, they hold
no memory, and they cost nothing. There were 29.8 GB of swap in use,
which looked like the answer until the arithmetic: our entire process
table is ~1.5 GB RSS against `AnonPages` **70.8 GB**. ~100 GB of
anonymous memory belongs to processes in another namespace, invisible
from in here.

The rules that follow:

- **A control that moves more than its known noise is a rejection
  signal, not a new result.** Find which legs moved and when, before
  touching the analysis.
- **Prefer rejection to correction.** A burst you can locate lets you
  drop three legs; a rate you have to estimate adds error to the other
  fifteen.
- **Sample host pressure alongside the legs** (`tools/perf/hostmon.sh`:
  `pswpout`, `allocstall_movable`, `MemAvailable`, runq, every 10 s).
  Without a timestamped pressure record, a contaminated leg is
  indistinguishable from an effect.
- **Order the legs and line them up against the clock.** The step
  between pg12 and nobc was visible only once the legs were sorted by
  mtime; by arm they looked like scatter.
- **A shared host is an uncontrolled variable.** Check it by arithmetic —
  sum your own RSS against `AnonPages` — not by reading `free`. And do
  not trust `load=`: it sat at 4–6 through both the quiet and the
  thrashing samples.
- **A large number is not automatically the cause.** 10,193 zombies
  explained nothing; the 100 GB that was never in the process table
  explained everything.

## A rotating sweep is a Latin square — analyse it as one, or position becomes the effect

Rejecting the three burst legs above fixed the contamination and left a
second error untouched for another round. Adding a fourth round to the
same sweep moved `ft4` from a settled **−2.85 % ± 0.88** to **−0.22 % ±
3.79**. The reflex — one more bad leg, find it and reject it — was wrong,
and chasing it would have burned the round.

**The design had an effect nobody had modelled.** `ftsweep2.sh` rotates
the arm order by one each round so no arm is permanently first. That
makes the sweep four rows of a cyclic 6×6 Latin square, and it is a good
design: arm, round *and position* are all estimable from it. What it is
not is self-correcting. Rotation only cancels position when the rows
cover the positions evenly, and four rows of six do not — `ft6` averaged
position 2.5 against `base`'s 4.0.

Position mattered:

```
pos:slope   +0.87 % ± 0.32 per position   95 % [+0.22, +1.53]
```

Legs run later in a round are slower by ~0.9 % per slot. `ft4` sat at
positions 3, 2, 1 in the first three rounds, reading 4.069 / 4.052 /
4.068 — a 0.4 % spread — and at position 6 in the fourth, reading 4.456.
**The arm did not change; where it ran did.**

**Within-round ratios do not see this.** Dividing each leg by its own
round's base — the discipline this workstream adopted precisely to beat
host drift, and the right call against *round-level* drift — removes the
round effect and nothing else. Against a within-round gradient it is
blind, because the base it divides by occupies one position and the arm
occupies another. A defence built for one confound is not a defence
against confounds.

The fix is to fit the design instead of working around it:
`log(ms/Mi) ~ arm + round + position`, 14 parameters against 24 legs, 10
residual df (`tools/perf/square.py`; pure Python, because this host has
no numpy and installing one mid-measurement perturbs the thing being
measured). Then let the model say which terms it needs — an F-test put
position's curvature at F = 0.26 on 4 and 10 df, p = 0.90, so the five
dummies collapse to one slope and hand four degrees of freedom back to
every arm estimate.

What survived, and what did not:

| arm | ratios (3 rounds) | Latin square (24 legs) | verdict |
|---|---|---|---|
| `nobc` | −24.56 % ± 1.25 | **−25.29 % ± 1.79** | stands |
| `pg12` | +8.17 % ± 1.14 | **+6.31 % ± 1.79** | stands |
| `ft1` | +5.70 % ± 1.64 | **+6.18 % ± 1.79** | stands |
| `ft4` | −2.85 % ± 0.88 | −2.09 % ± 1.81 | **withdrawn** |
| `ft6` | −2.77 % ± 1.27 | −2.34 % ± 1.84 | **withdrawn** |

**The large effects never moved and the small ones never survived.** That
is the shape to expect: a confound worth ~1 % per position cannot touch a
25 % arm and can invent or destroy a 2 % one. The three arms that stood
were the three already far outside the confound's reach — so the extra
rounds and the better model bought nothing on them, and everything on the
two that mattered for a landing decision.

The rules that follow:

- **Know what design you ran.** "Rotate the order so nothing is always
  first" is an experimental design, not a precaution. Write down what it
  makes estimable and then estimate it; rotation alone balances position
  only when every arm visits every position.
- **A result that moves when you add a clean round is a model error, not
  a data error.** Reject legs for evidence collected *about the host*
  (`clean.py` reads `hostmon.tsv` before looking at any result), never
  because a number became inconvenient. The k4 `ft4` leg showed
  `allocstall +75` against 0/15/19/25 elsewhere — three times the next
  highest and nowhere near a rejection — and rejecting it would have
  restored the answer and kept the bug.
- **Fit the nuisance parameters you can afford.** 24 legs against 14
  parameters still leaves 10 df. Degrees of freedom are cheap here;
  a wrong landing decision is not.
- **Report the band, not the point.** −2.09 % ± 1.81 is an honest "we
  cannot tell 2 % from 0 % with this instrument", and it is what stopped
  a one-character default change that three rounds of analysis had
  called ready to land.
- **When wall cannot resolve it, stop buying wall.** Per-leg rmse was
  2.5–2.8 % against a ≤2 % effect, so ±0.5 % needs ~13× the rounds —
  about forty hours. The mechanism is counted instead: fold-through acts
  by making TBs longer and entries rarer, and entries are a guest-side
  count with no host drift in them at all.

## An instrumentation knob that changes codegen can disable the mechanism under test

The follow-up to the sweep above was going to settle fold-through the
honest way: run two legs with `W64_TBSTATS=1` to count executed TB
entries directly, once at the default fold and once at `FTMAX=4`, and
read the ratio. The design is right and the instrument was wrong.

`W64_TBSTATS` arms `wasm_tb_stats`, and `tcg/wasm64/tcg-target.c.inc:3311`
says what that costs: leaving it in "switched off TB lengthening — the
fold target and the conditional loop back-edge merge both". **The knob
that counts the entries disables the transform that removes them.** The
`FTMAX=4` leg could only ever have returned the same number as the base
leg, and `dt/(1 − 1/r)` with `r ≈ 1` is the same division-by-noise that
had already priced a TB entry at 43 % of wall two rounds earlier.

The evidence was in the first leg's own output, before its partner ran:

| | census leg (`XCOUNT` only) | `tbs_base` (`+TBSTATS`) |
|---|---|---|
| `tbIcount` | 13.833 | **5.555** |
| exits/Mi | 55,385 | **182,786** |
| implied executed length | 18.05 | **5.47** |
| ms/Mi | 4.252 | 5.582 |

Both are internally consistent; neither is wrong; they describe different
machines. The one that ships is the left column, and it is the one the
budget uses.

The partner leg, run anyway, confirmed the diagnosis to four digits:
`FTMAX` 3→4 moved the exit count from **182,786.3** to **182,804.9** per
Mi, **+0.01 %**. So r = 1.0001 and `dt/(1 − 1/r)` divides by 0.0001. It
would not have errored — it would have returned a large, confident,
meaningless number, which is the failure mode worth fearing.

- **Read what an instrumentation knob does to codegen before trusting a
  pair that rides on it.** The comment naming the side effect was in the
  backend the whole time, three lines from the function the knob gates.
- **A counter that halves a structural quantity is the tell.** `tbIcount`
  5.555 against 12.83 was visible in the first leg; nothing needed to
  wait for the second.
- **Prefer the instrument that does not participate.** `W64_XCOUNT`
  counts exits without touching TB formation, which is why the census it
  produced is still the number in the budget.

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

## JS written inside C: two traps an EM_JS body sets

Both cost a build cycle if found the slow way, and both were found by
reading rather than by building, during the `-sMEMORY64=2` migration.

- **An index narrows; a pointer does not.** `-sMEMORY64=2` lowers the
  *memory and the table* to 32-bit (`link.py` runs `--memory64-lowering`
  **and** `--table64-lowering`) while leaving pointers as i64 values.
  Emscripten encodes exactly that distinction in two macros —
  `toIndexType()` wraps in `BigInt` only for `MEMORY64 == 1`, `to64()`
  wraps for both — so its own glue is right by construction and
  hand-written JS is not. `wasmTable.get(BigInt(i))` is correct under
  `=1` and a `TypeError` under `=2`. Auditing the wasm we *emit* does not
  cover this: the other surface is every JS-side handle on a wasm index
  (table reads, `Memory`/`Table` construction, `grow`). When a mode
  switch changes a type, enumerate both surfaces.
- **Modern JS operators can be C trigraphs.** An `EM_JS` body is
  stringified `__VA_ARGS__`, so it goes through translation phase 1 like
  any other source. `??=` is the trigraph for `#`, and `?? (` is `[`. GNU
  modes disable trigraphs, so this usually only warns — and with
  `--disable-werror` a warning does not fail the build, which is the
  dangerous half. Write `if (x === undefined)` rather than `x ??= …`.
  For the same reason `#ifdef` cannot be used inside an `EM_JS` body to
  switch on a build mode; probe at runtime and cache on `globalThis`.

## A path worth optimizing has to be shown to execute at all

The J2ME exception path looked like the round's best lever on paper.
A playing game takes 265–1877 guest exceptions per Mi, ~98 % of them
SWI, against a comparable number of dispatcher iterations — so on this
workload the exception path *is* the C dispatcher. Emscripten's default
`-sSUPPORT_LONGJMP=js` turns every `siglongjmp` into `throw Infinity`
in JS, unwound out of the wasm frames into an `invoke_*` catch that
calls `setThrew` back in: two boundary crossings and a real JS throw
per exception. `-sSUPPORT_LONGJMP=wasm` removes all of it. The build
knob was written, wired through `CPU_CFLAGS` (the only route that
reaches a compile line, see the cross-file lesson above), and was one
command from being spent.

`WASM_DIAG_EXC_LJ_NS`/`_N` — the timer opened in `cpu_loop_exit`
immediately before the `siglongjmp` and closed on the `sigsetjmp != 0`
return in `cpu_exec_setjmp` — came back **absent from the counter dump
in all five titles**, while `EXC_BQL_NS`, `EXC_DO_NS`, `EXC_CAL` and
`EXC_N` beside them all moved. `j2mebench` omits a counter whose delta
is zero (`if (!dv) continue;`), so absent means exactly zero: **not one
of 223 302 guest exceptions unwound.** `cpu->jmp_env` has only one
`siglongjmp` site (`cpu-exec-common.c:95`; `tb-maint.c:451` is a
different jmp_buf), so there is no second path to have taken instead.
The wasm64 port's exception delivery never unwinds, and the flag had
nothing to act on.

Two things made this cheap to catch and would have made it expensive to
miss:

- **The absent counter is the result, not a gap in the instrument.**
  Four counters from the same six-member enum group moved, so a
  positional name shift would have *misnamed* values rather than
  dropped two — the one alternative explanation was ruled out by the
  neighbours, not by re-reading the code.
- **The mechanism story was detailed, sourced and correct, and still
  predicted nothing.** `throw Infinity` and the 18 `invoke_*` wrappers
  really are in the emitted JS; the only false step was assuming a
  path that exists is a path that runs. Grep proves a path exists. A
  counter proves it executes.

The residue is worth keeping: the *other* halves of the exception path
were timed at the same time and are real but small — `EXC_BQL_NS` +
`EXC_DO_NS` total 0.0–1.6 % of wall, mean 0.9 %. Priced beside it, the
whole DMA → DIF → SSI → LCD display chain is 0.9–2.1 %, mean 1.5 %.
Both candidate levers of the round measured small by direct
measurement rather than by argument.

## Separate fixed per-frame cost from marginal per-instruction cost

Ranking per-Mi counters by correlation with `ms/Mi` across five titles
produced a confident, entirely spurious answer: `lookup`, `dispNs`,
`tpuRearm`, `halt`, `lcdPx` and a dozen others all came back at
r = 0.91–0.95. They share one cause. Every slow title is also a
low-`duty` title, and `duty` is the fraction of virtual time the guest
executes rather than halts. Work paced by *frames* rather than by
instructions — display, timers, halt/wake — is roughly constant per
virtual second, so dividing it by a smaller instruction count inflates
it automatically. Per-Mi normalization does not make a host-paced or
frame-paced counter guest-relative (see the earlier lesson of that
name); here it manufactured a correlation with the metric being
explained.

Regress the two terms apart instead. Per title take
x = `duty` × 125 Mi of guest work per virtual second, y = wall ms spent
per virtual second; the slope is the marginal cost of a guest
instruction and the intercept is the fixed per-frame overhead:

    slope     3.126 ns per guest instruction
    intercept 39.0 ms per virtual second  (3.9 % of real time)
    r         0.912 over 5 titles

So execution, not frame overhead, is 45–91 % of the wall in every
title, and the ~3.1 ns/insn — about 11 host cycles on this desktop — is
the thing to attack. Two caveats the fit itself states: n = 5 with one
large residual (g4 at −29.5 ms/vsec is genuinely cheaper per
instruction than the line), so the intercept is a cross-title average
and not any single title's overhead.

## A counter census prices a call site only if the cost per call is constant

The budget table carried "notdirty stores | ~0.5 % | 203.7/Mi, 100 %
SMC-miss | structural, no lever found" for several rounds. The number
came from a census: count the calls, multiply by an assumed per-call
cost. It was wrong by more than a factor of ten, and the reason is that
nobody had counted the work *inside* the call. `tb_page_covers` walks
the page's TB list, and on a J2ME title that list is 51 entries long, so
each of those 203.7 calls was 51 dependent loads into randomly placed
`TranslationBlock`s rather than the handful of instructions the census
implicitly assumed.

This is the same error the TB-entry row of that table already warns
about, arrived at from the other direction: there, arithmetic replaced
timing; here, a call count replaced a work count. A census answers "how
often" and nothing else. Before believing one, add a second counter for
the work the call performs -- here `smcWalk`, incremented once per call
by the number of list steps, which turned "203.7 calls" into "24,453
list steps" and made the real size obvious. Accumulate that counter
once per call, not once per step: a store inside the loop inflates the
very baseline it is measuring.

Found the same round by a sampling profile, which put the call site at
14.7 % of the vCPU -- 30x the table's figure -- and prompted the
counter that confirmed it.

## A/B a knob that removes the whole mechanism, not just its payoff

The first version of the code-granule mask rebuilt the mask exactly
during the list walk, on the reasoning that `PAGE_FOR_EACH_TB` visits
every TB anyway so the rebuild rides along free. `W64_NOSMCMASK` then
disabled only the early-out, leaving the rebuild in both legs. The OFF
leg was therefore *not* upstream: it was upstream plus a
`tb_page_granules` and a `tb_gmask_set` on every step of a 51-step walk,
plus a 32-byte `memcpy` per call. The A/B measured the early-out against
a baseline the change itself had slowed down.

Two consequences, and the second is the general one. The comparison
flatters the change, which is the obvious hazard. But it also hid the
design error: the rebuild's whole justification was that the walk is
free, and the walk is precisely the path the mask exists to avoid, so
paying per step to accelerate a path you intend never to take is
backwards. Removing the rebuild entirely made the hot path identical to
upstream plus one mask test -- and the mask needs no rebuild anyway,
because on this workload stores outrun TB removals 5500:1, so a
grow-only mask never goes stale.

Make the knob restore the untouched upstream path byte for byte. If it
cannot, the honest A/B needs three legs, not two.

## An observational slope across runs can invent a price

Round 1 of the mask A/B was inconclusive (+0.97 % +/- 4.61 %, n=4), so
the run-level aggregates were regressed instead: `ms/Mi` against the
walk-step counter, over the four baseline runs where the only variation
is how much walking the guest happened to do. It gave 23.4 ns per list
step at r = 0.861, which put the whole walk at 14.4 % of wall -- in
near-perfect agreement with the sampling profile's 14.7 %.

It was noise. Six more baseline runs turned the same regression into
+4.0 ns/step at r = 0.297, and at one intermediate point it was
*negative* (-13.6 ns/step, r = -0.644). Four points spanning a 23 %
range of the x-axis will produce a confident-looking slope out of host
drift alone, and the agreement with the profile was coincidence, which
is exactly what made it persuasive.

The knob-driven contrast survived: 6.50 % +/- 2.54 % (se 1.04 %) over
six counterbalanced pairs, every pair positive. Only a knob prices a
mechanism. A regression across run-level aggregates is a way to *find*
a candidate, never to size one -- and when a weak design happens to
agree with a strong one, that is not corroboration, because the weak
design had every opportunity to agree by accident.

## A module-bucketed sampling profile splits JIT from C by construction

"How much of the vCPU is emitted TB code and how much is the C
runtime?" cannot be answered with a timer. A bracket around
`cpu_tb_exec` costs two clock reads, roughly 140 ns, against a 3.1
ns/insn budget -- a 15-instruction TB's entire execution is a fraction
of the instrument.

The JIT emits every TB as its own `WebAssembly.Module`, so a sampling
profile already carries the answer: bucket the frames by module URL.
`wasm://wasm/<hash>` is a JIT TB, the main module is C. The split on a
J2ME title came out 70.9 % emitted / 28.7 % main module / 0.4 % other,
at zero instrumentation cost.

One trap makes this look unreliable when it is not. JIT modules have no
symbol table, so V8 labels those frames with the nearest main-module
symbol -- the *names* are nonsense, borrowed. The URL is not. Bucket on
the URL and the split is sound; read the borrowed names as function
attribution and it is worthless.

## TCG / backend design

- **A wasm JIT only pays off if TB-to-TB control flow never leaves
  wasm.** The first attempt (a port of the ktock/qemu-wasm wasm32
  design: TCG regs as wasm globals, one `WebAssembly.Module`+`Instance`
  per TB, a C dispatch loop between instances) measured a ~1.3–2.3×
  ceiling over TCI on this 3–4 insn/TB busy-polling firmware and was
  discarded. The redesign that shipped (tail-call chaining through a
  funcref table, regs as locals, batched modules) shipped as 0017.
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

- **An estimate assembled from two legs is not a measurement** (round
  thirty-four).  The display chain was carried in this file at 0.25 % of
  wall for three rounds.  That figure was one leg's post-fix burst time
  (638.8 ns) multiplied by a burst rate read off a *different* leg.
  Measured properly — both quantities from one binary, with a
  calibration counter for the clock read — a burst is 1810–1933 ns and
  the chain is **1.74 %, seven times the carried number**.  Neither
  input was wrong; multiplying across legs was.  The same leg also
  showed why the calibration counter is not optional: the exception path
  reads 142,594 ns/Mi raw and **45,250 ns/Mi** once the ~66–75 ns clock
  read is subtracted from each ~110 ns span, so the naive number is 3×
  the truth.
- **A diagnostic counter can cost more than it measures, and the bill
  lands somewhere else** (round thirty-four).  `wasm_tb_stats` is read
  only by a MIPS display.  Keeping it exact per TB entry meant a
  frontend could not emit a TB that leaves early, which switched off
  *both* TB-lengthening mechanisms — on exactly the boards the counter
  was armed for, since its gate was `!icount_enabled()`.  A counter that
  a fast path must preserve is a constraint on that fast path; check
  what the constraint forbids before deciding the counter is cheap.  The
  repair is usually not deletion but making the counter **refundable**,
  the way icount already handles the identical problem.
- **Do not chain background work on `kill -0`** in this container.  PID 1
  is `sleep infinity` and reaps nothing, so an orphaned process stays a
  zombie, keeps its pid slot, and `kill -0` succeeds forever — a waiting
  loop never ends.  Put the chain in one shell instead:
  `(setsid nohup bash -c "a.sh; b.sh" &)`.
- **Close the budget before choosing a lever** (round thirty-two).  Every
  A/B of this round — nine of them — came back null or under 1 %, and the
  reason was arithmetic that took ten minutes and was never done: the leg
  ran at 5.686 ns per guest instruction, and the *sum* of every mechanism
  the workstream has instrumented (exception entry 2.07 %, display DMA
  0.29 %, module pipeline 0.22 %) is 2.6 % of that.  97.4 % was raw
  emitted-code execution, uninstrumented and unexamined.  A counter tells
  you a mechanism's rate; it cannot tell you the mechanism is worth
  attacking.  Price each instrumented mechanism against the total
  per-instruction cost *first*, and if they do not add up to most of it,
  the target is whatever is left over — not the best of the ones you
  happen to have counters for.  The streetlight is where the counters
  are.
- **A mean over phases that behave differently reports the idle one**
  (round thirty-two).  Game 1's 45-second play window read duty 0.348,
  which was used to conclude the CPU was 2.1× oversubscribed and every
  1 % lever therefore pointless.  Tracing the same window every 2 virtual
  seconds showed 27 bins at duty 0.12–0.22 and **five at duty 0.96–1.00**
  — the guest asking for the whole 125 MIPS during a level transition.
  The mean is weighted toward wherever the instructions are *not*: an
  idle bin contributes its full share of time and almost none of the
  work, so it drags the average down and hides the phase that is actually
  slow.  Before averaging a workload, check that it is one workload.
  Beware which weighting the dilution follows, though: those five bins are
  15 % of the *time* but **47 % of the instructions** (1233 Mi of 2648),
  because an idle bin contributes time and almost no work.  Counters
  normalised per-Mi, and MIPS/cpu, are instruction-weighted, so a lever
  that only bites in the saturated phase is diluted 2.15× in them — not
  the ~6× the bin count suggests.  Reason about dilution in the units the
  metric is actually normalised in.
- **Never mix a real-time-paced counter into a virtual-time bin.**  The
  duty trace bins guest instructions per *virtual* second, and alongside
  them the same sampler prints frames from `fb_updates` — which the
  display pipeline advances on *real* time.  Uncapped, virtual and real
  time differ by the warp factor, and the warp factor is itself a
  function of duty, so the frame column varies with exactly the thing
  being studied: the same 45 virtual seconds drew 468 frames uncapped and
  1063 capped, and the per-bin "fps" spread that looked like evidence
  (19 fps busy vs 6 fps idle) is mostly 1/warp.  Before reading any rate
  out of a window, check that its numerator and denominator are on the
  same clock.  Under a real-time cap the two coincide and the column
  becomes meaningful again — which is one more reason to keep a capped
  leg alongside the uncapped ones.
- **A "bin 0" is usually not a bin.**  The trace sampler records a
  cumulative counter and the printer differences consecutive entries from
  zero, so the first entry prints the absolute total — in this case every
  instruction since the emulator started, 1521 Mi, which reads as duty
  6.08 over a 2-second bin.  Any series built by differencing has this
  artifact at its head.  A value that is impossible (duty > 1 under
  icount) is the tell; drop the entry rather than clamping it.  Same
  family: bins that are *polled* rather than scheduled are not all the
  same width, so divide by the observed width, not the nominal one.
- **Measure the headroom before choosing a target, not after** (round
  thirty-two).  This round spent 229 legs closing an "11 % gap" between
  113 MIPS and the 125 MIPS that icount shift=3 calls full speed — and
  125 MIPS is what a **100 %-duty** guest would need.  The workload is
  15–35 % duty, so the rate actually required to hold real time is
  `duty × 125` = 43.5 MIPS (game 1) and 18.8 (game 2), against 91
  delivered: **2.1× and 4.5× of headroom.** Every lever the round priced
  — the exception entry at 1.4 %, the inline cache at ~1 %, display at
  0.25 %, the pipeline at 0.24 % — was competing for a resource that was
  not scarce, which is the real reason `pccin`, `chain`, `nopcc`, `merge`
  and `lc` all came back null.  The check is two divisions against
  numbers already in every result JSON, it takes a minute, and it belongs
  *before* the first A/B.  `mipsCpu / (duty × 125)` predicted the measured
  `vratio` to a median 1.04 over 229 legs with an IQR of 0.01 — so the
  arithmetic is not a rule of thumb, it is the whole model.

- **A default that is right for A/B work can be wrong for the question
  you were asked** (round thirty-two).  All 239 legs on disk ran
  `uncap=true`, because `--uncap` defaults to 1 and drops the real-time
  cap for the play window so "the engine's own ceiling shows" — exactly
  right for comparing two builds, and unable in principle to answer *does
  the game run at full speed*.  Worse, the uncapped numbers look like an
  answer: `vratio` reads 2.03 and 4.35, which is not "twice real speed"
  but the idle fraction being advanced for free by icount.  Before
  trusting a long-standing default, ask which regime it was chosen for.

- **A guard that watches the inner process misses the gap between outer
  iterations** (round thirty-two).  A measurement script waited on
  `pgrep -f j2mebench.mjs` and took the slot in the same second a queued
  `ab4.sh` started its next leg — the previous leg's node had exited and
  the next had not yet spawned.  Two measurements then ran concurrently
  and both were void.  Wait on the *driver* (`ab4.sh`, the queue), not
  only on the process it happens to be running, and when several waiters
  can wake at once, chain them from one parent instead of racing them.

- **A counter's absence is a reading, not a gap** (round thirty-two).
  `tools/j2mebench.mjs:687` has `if (!dv) continue;`, so a counter whose
  window delta is exactly zero never reaches the JSON at all.  `execLjmp`
  is missing from all 99 legs of the round — which is the *proof* that no
  `cpu_loop_exit` longjmp is taken, the single fact that makes a
  691-exception/Mi workload affordable when the emscripten unwind costs
  ~15 µs.  Read the always-absent list deliberately; it is where "this
  mechanism never happens" is recorded.  The same list is a trap in the
  other direction: `hflags`/`hflagsFast`/`hflagsBad` read zero because
  `WASM_DIAG_HOT` compiles to `((void) 0)` in the shipping build, which is
  a disabled counter tier and not a dead fast path.  Before calling a zero
  a finding, check whether the increment is even compiled in.
- **A ratio that holds across configurations is a structural fact; a rate
  that moves with them is the thing under test** (round thirty-two).  On
  this host no single clock reading was trustworthy to better than ~12 %,
  yet `execIter`/SWI (1.10), `lookupJc`/SWI (1.09) and `hflagsCalls`/SWI
  (2.80) held to ±5 % over 99 legs, two games whose exception rates differ
  by 1.6×, and every knob in the battery.  That is not a measurement of
  any build — it is the shape of the workload, and it survives a host the
  clock cannot.  It also collapses four apparent levers into one: if the
  dispatch loop, the jump cache and the hflags rebuild all count in fixed
  proportion to exceptions, optimising them separately is optimising the
  same thing three times.  Look for the invariant ratio *first*; it tells
  you how many levers there really are.
- **A gate's threshold is part of the gate, and one nothing passes is as
  useless as one everything passes** (round thirty-two).  The quiet-host
  wait was armed at load ≤ 10 against a host whose 72 recorded legs ran
  min 4.1 / median 25.9 / max 42.2, with 3 % at or below the threshold.
  It could only ever spend its whole 600 s budget and measure anyway —
  ~40 min per four-leg tag for nothing.  The useful threshold was 30:
  truncate the tail where the fitted correction extrapolates worst, do
  not chase a quiet hour that never arrives.  Set a threshold from the
  measured distribution of the thing being gated, never from the value
  you wish it had.
- **Check whose load it is before building machinery to wait it out.**
  `ps` `%CPU` is a lifetime average and will implicate processes that are
  idle now; diffing `/proc/<pid>/stat` utime+stime over a few seconds is
  the honest instantaneous read.  This container drew **1.3 cores** while
  the host showed **24.8** of 32, so the confound was other tenants and
  nothing local could fix it.  The 10 001 visible processes were 9 950
  zombies — PID 1 is `sleep infinity` here, so nothing is ever reaped, and
  a process count is not a load.
- **"Load-robust" was a claim, not a measurement, and it was wrong by a
  factor of two** (round thirty-two).  `MIPS/cpu` exists to survive a busy
  host: it divides guest instructions by the vCPU thread's own
  `utime+stime`, and the comment above it in `tools/j2mebench.mjs` said so
  outright — "unlike MIPS this does not fall when another tenant takes a
  core away, it only falls when the thread is actually made to do more
  work."  Nobody had ever regressed it against the load it claimed to be
  robust to.  Fitted **within identical configurations** — every `(tag,
  arm, game)` group mean-centred first, so that a build which happened to
  run in a quiet hour cannot set its own correction — `log(MIPS/cpu)` on
  `log(1-minute load)` has slope **−0.29** with **r = −0.73** over 64 legs.
  Load ran 4.1 to 42.2 this round, so the confound alone spans **1.96×**,
  against A/B effects of 2–16 %.  CPU time divides out how many *seconds*
  the host gave the vCPU.  It cannot divide out how much work a second
  contains, and under SMT and memory-bandwidth contention that is most of
  what varies.  A denominator can normalise the resource you can count and
  not the one you cannot.

- **The counters said the host did it, and only the counters could.**  Two
  legs of `lcdrow-on` game 2 — same binary, same query string, same
  `--game`, same everything — read `82.25` and `144.35` MIPS/cpu.  What
  settled it was the per-Mi table: every guest-side counter agreed to
  within **0.4 %** (`ssiByte` 1.004, `lcdPx` 1.004, `hflagsCalls` 1.006,
  `armIrq` 1.006, `excSwi` 1.006, `halt` 1.004), so the guest executed the
  same instruction stream and the emulator did the same work, and the
  1.76× had nowhere to live but the host.  This is the diagnosis a clock
  cannot make about itself: **a counter confirms a mechanism, a clock only
  prices it** — and when two clocks disagree, the counters say whether
  anything real moved.  Identical-config repeat spread across 28 groups:
  median **12.0 %**, max **54.8 %**.  Every verdict of this round was
  quoted to a tenth of a percent against that.

- **A palindrome cancels a ramp, not a step, and it puts the step where it
  hurts most.**  `off on on off` cancels linear drift because both arms
  average to the same midpoint.  The host went quiet between leg 3 and leg
  4 — load 26.3 then 5.1 — so the jump landed entirely on the second
  `off`, and the `lcdrow` verdict came out **−34.7 %** on game 1.
  Corrected it is −10.7 %, with the two arms sitting at mean load 27.9
  against 13.1.  The interleave is a defence against drift, and it was
  being read as a defence against the host.  `verdict.py` now prints each
  leg's load next to its rate and marks a verdict `LOAD-SKEWED` when the
  arms differ by more than 15 %, because the number that needs checking
  first is not the percentage.

- **The fix is a covariate and a wait, and the wait goes before the
  uncap.**  `hostBusy` is now recorded from `/proc/stat`'s all-CPU line
  differenced across exactly the measurement window — the 1-minute load
  average is smoothed over 60 s and the window is 6–11 s, so loadavg is
  mostly describing seconds the window did not contain.  `--maxload` waits
  for a quiet host before the window and then **measures anyway** rather
  than failing: failing would retry three times and drop the leg, and a
  dropped leg punctures the palindrome, which is worse than a leg the
  read-time correction can partly undo.  The wait is placed *before* the
  real-time cap comes off — uncapped, the guest warps its own clock as
  fast as the host allows, so a ten-minute wait after the uncap would play
  the game for hours of its own time and open the window on something the
  `--start` plan never aimed at.  The threshold has a file default
  (`tests/.j2me-maxload`) because a battery already running has its shell
  drivers' environments fixed, and editing a script bash is currently
  reading corrupts it mid-leg.

- **A guard that guards nothing looks exactly like a guard** (round
  thirty-two).  `ab4d.sh` exists to add the workload guard to `ab4.sh`,
  and its header said a leg that walked into the wrong game "is retried
  instead of measured".  It passes `DUTY` to the runner as `--duty`.
  `tools/j2mebench.mjs` has no `--duty`: the option table is eleven
  `opt()` calls and `duty` is not among them, so the flag lands in
  `argv`, is never read, and — since the tool rejects nothing it does
  not recognise — produces no warning.  Every leg said `duty='0.348,…'`
  in its header line and not one of them was guarded by it.  Check a
  flag against the option table, not against the driver that passes it;
  an unknown flag that is silently ignored is indistinguishable, from
  the outside, from one that worked.
  - The guard did exist, one layer further in: `verdict.py` takes each
    game's median duty across every leg on disk and drops any leg
    outside ±25 %, and both `ab4.sh` and `ab4d.sh` call it.  So the
    round's verdicts are guarded after all — the defect was in *where*,
    and the difference between the two places is not cosmetic.  A
    run-time guard **retries** a bad leg; a read-time guard **drops**
    it.  `off/on/on/off` cancels linear host drift only while all four
    legs are present, so a dropped leg leaves an asymmetric survivor set
    and the cancellation the palindrome was chosen for is simply gone.
    `verdict.py` prints `n=` per arm and `dropped=` because of this:
    they are load-bearing, and `+3 %` on n=1 vs n=2 is a weaker claim
    than `+3 %` on 2 vs 2 even though the percentage is formatted the
    same.  Read them with every verdict.

- **Four workloads is not a regression, however tempting the table
  looks** (round thirty-two).  Four J2ME games had been profiled over
  matched 45 virtual-second windows, each with the full counter set, so
  regressing host cost (`ms/Mi`) on the two candidate drivers — the
  guest's exception rate and the display pixel rate — looked like a free
  price for both.  It is not, and the run says so out loud: display came
  back with a **negative** coefficient for a path an eight-leg
  palindrome had just measured at **+17.5 %**, and exceptions came back
  at 5.8 ns each, which works out to 38 % of game 1's cost against a
  profile that puts the whole exception cluster at 5.7 %.  One variable
  gave R² = 0.62 and a meaningless magnitude; adding the second gave
  R² = 0.76 and a sign error.
  The reason is that the games differ in `duty` by 3× and *every*
  per-Mi device rate is inversely proportional to `duty` by
  construction, so the regressors are collinear with the thing being
  explained and there are four points for three parameters.  A
  cross-workload fit can suggest which mechanism is **general** — the
  exception rate stays in one band across all four games while the
  device rates swing 2.4× — but the price has to come from switching
  the mechanism off.  **Use the spread across workloads to choose what
  to A/B, never as a substitute for the A/B.**

- **A leg that measured nothing looks exactly like a leg that worked**
  (round thirty-two).  Two legs in one battery were queued as `--tag
  excns` and `--tag dispns` to price the exception path and the display
  chain, and both ran without `W64_EXCNS=1` / `W64_DISPNS=1`.  Those
  counters are *span timers*: the clock reads only happen when the knob
  is set, so without it the spans stay zero while every other counter,
  the rate line and the JSON come out completely normal.  Nothing failed,
  nothing was empty, and the tag in the filename said the leg was what it
  was supposed to be.  The cost is two slots of a serialized resource and
  the discovery arrives only when someone greps for a counter that is not
  there.  So: **a diagnostic leg must assert its own counter is non-zero
  before it counts as spent** — one `grep -E '^(exc|disp)[A-Za-z]*='` on
  the result, in the driver, right after the leg.  The general form of
  this is the rule that already governs mechanisms: a mechanism that
  cannot be shown to have fired earns no verdict, and the same is true of
  an instrument.
- **A knob that counts and a knob that changes what is emitted do not
  compose, and the knob's name will not warn you** (round thirty-two).
  Three drafts of one probe script got this wrong, and the output looked
  entirely reasonable every time — each counter still carried a
  plausible number, just not the number its own comment claimed.  The
  goto_ptr exit in `translate.c:1641–1716` has *two* emitted layers, a
  per-TB slot test and a pcc compare chain, and `w64_lc_mode()` selects:

  | mode | knob | slot test | pcc chain emitted |
  |---|---|---|---|
  | 1 | *(default)* | yes | yes |
  | 2 | `W64_LC_VERIFY=1` | **no** | **yes** |
  | 0 | `W64_NOLC=1` | no | **no** |

  So `W64_NOLC` — which reads like "turn off the lc" — removes *both*
  layers, and `W64_LC_VERIFY` does not make every exit reach the helper,
  because the pcc chain still absorbs most of them and the C-side pcc
  returns before the verify block ever runs.  Counting the exit
  population honestly needs `W64_LC_VERIFY=1` **and** `W64_NOPCCIN=1`
  **and** `W64_NOPCC=1` together.  Before combining knobs in one leg,
  read what each one *emits*, not what it is called; and a counter whose
  denominator is set by another knob in the same leg is measuring a
  population you have not named.

- **A fixed guest-time window makes the rate comparable; it does not
  make the workload the same** (round thirty-one).  Every leg of the
  J2ME battery collects the same 45 guest-seconds, which is exactly what
  lets `MIPS/cpu` be compared across legs of different wall length.  It
  says nothing about *what the guest did* in those seconds.  Across
  every 45 s leg on disk, game 2 landed in **three** separate modes —
  and 12 of its 52 legs, **23 %**, were not the game being played:

  | `duty` | `mi` | fps | halts/s | `MIPS/cpu` | n | what it was |
  |---|---|---|---|---|---|---|
  | 0.147–0.153 | 825–859 | 39–49 | 1170–1961 | 63.6–101.4 | 40 | the game, played |
  | 0.087–0.091 | 487–509 | 58–61 | 2382–3098 | 65.9–85.3 | 10 | its title screen |
  | 0.282 | 1588 | 36 | 738 | 81.8 | 2 | game 1's shape, under game 2's label |

  Same 45 guest-seconds in all three.  Read the `MIPS/cpu` column: every
  contaminated leg's rate falls **inside** the played legs' range.  The
  two distributions do not merely overlap, one contains the other — so
  no amount of staring at the result, no outlier rule on the rate, and
  no repetition can separate them.  Only a statistic about the
  *workload* can, which is the whole argument for carrying one.  The light mode is the start keys
  missing; the heavy one is the *navigation* missing, so the leg played
  the wrong game entirely.  Game 1 was unimodal (0.341–0.397), so this
  was one game's walk, not the clock.
  - The contaminated legs read 85.29, 83.76, 72.61 and 72.56 — high,
    high, low, low.  A contaminant that adds *variance* rather than bias
    survives a palindrome untouched, because interleaving cancels drift
    and order, not workload.  It shows up as a fat sd on one game, which
    is easy to read as "this game is noisy" and move on.
  - At n=2 per arm one such leg decides the verdict.  It did: three of
    the round's five A/Bs caught one, and the one it was read from
    (`pccin`, −15.4 % on game 2) halved to −8.7 % with the leg dropped,
    after that document had already been written.
  - So **check the workload shape of every leg before reading its
    rate** — `duty`, `mi` and `haltsPerS` are all in the record already.
    The guard must be **two-sided**: a band of ±25 % around that game's
    median duty (`tools/perf/verdict.py`).  A floor would have caught the
    title screens and waved the wrong-game leg straight through, and the
    wrong-game leg is the more dangerous of the two because its *rate*
    looks perfectly ordinary (81.79, mid-range) while its workload is
    somebody else's.  The guard costs nothing, works retroactively on
    every leg ever measured, and needs no change to anything that runs —
    which matters when the battery is mid-flight and the runner is
    re-read from disk per leg.
  - The guard is safe to apply to an *optimization* A/B, which is the
    first objection to it: `duty` is `insns × 8 ns / virtual-ns`, guest
    instructions retired per unit of the guest's own clock, so under
    icount it is a property of the guest alone.  A build that retires the
    same 45 guest-seconds in less host time does not move it — `fps`,
    `MIPS` and wall all move, `duty` does not.  It falls only when the
    guest itself does something else.  So the guard cannot quietly delete
    the legs of the arm that won; it can only delete legs that were
    playing a different thing.  (`disp`, the round's largest effect at
    +17.4 %, dropped zero legs.)  The runner had already written this
    invariant down at `tools/j2mebench.mjs:728` — "legs whose `mi`
    disagrees played different games, and their wall times are not
    comparable" — and then never enforced it; the accept test three
    hundred lines earlier was `fps >= 2`.  **A stated invariant that
    nothing checks is a comment, not a guarantee.**
  - The general form: **a rate is only comparable across windows that
    contain the same mix.**  Normalizing the denominator (per Mi, per
    guest-second) is necessary and not sufficient; something also has to
    hold the *numerator's composition* still, and for an interactive
    guest nothing does that automatically.
- **A benchmark that leaks its browser poisons every later leg, and
  possibly its own denominator** (round thirty).  Chromium launched by
  a tool that is then killed — a `timeout`, a `pkill`, an OOM — keeps
  running, still emulating a phone at full tilt, reparented to a PID 1
  that in this container is `sleep infinity` and never reaps.  The pile
  found here was **8 958 processes, the oldest three days old**, holding
  ~20 cores and 30 GB of swap.  The drift that causes is monotone —
  later legs are always slower — which is the one shape a palindrome
  cannot cancel by interleaving.  Worse, `j2mebench` measured
  `MIPS/cpu` against the busiest thread of *every* chrome process on
  the host, because chromium's zygote children reparent away from the
  launcher and a run's real vCPU thread would otherwise be missed: the
  survivors were inside the denominator.  Three fixes, all cheap:
  snapshot live chrome PIDs before launching and exclude them, kill
  `ppid == 1` chrome at startup, and close the browser from
  `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException`.  **Before trusting
  an A/B, run `ps -eo comm | sort | uniq -c | sort -rn | head`** — and
  `top -bn2`, because load inside a shared container is mostly not
  yours: 28.8 % of these cores were `ni`ced work no process in the
  container owned.
- **A `pgrep -f` wait loop keyed on a bare script name never exits
  here** (round thirty-one).  A driver that must not overlap a running
  benchmark waits on `pgrep -f "ab\.sh"` — and `pgrep -f` falls back to
  `comm` for a process whose `/proc/<pid>/cmdline` is empty, which is
  exactly what a zombie has.  Same unreaped PID 1 as the bullet above:
  three `[ab.sh] <defunct>` from two days earlier match that pattern
  forever, so the loop spins until the session ends and the work behind
  it silently never runs.  The existing drivers were accidentally immune
  because they matched `tools/perf/ab4?\.sh` — a zombie's `comm` carries
  no directory — which also means **the moment one driver is launched by
  a relative path, a path-anchored waiter stops seeing it**: the pattern
  that dodges the zombie is the pattern that misses the job.  `queue6`
  was launched as `bash queue6.sh` and was invisible to every waiter and
  to my own `pgrep`, which is how it came to be launched twice.  Match on
  the name and then **filter by state** — skip anything whose `ps -o
  stat=` is empty or starts with `Z` — and exclude self, parent and
  grandparent, because a launcher carrying the script's text on its
  command line matches every pattern inside it.
- **Scratch tooling that another script calls is part of the running
  system.**  `verdict.py` was written fresh into the scratchpad to hold
  the new workload guard, on the assumption that a file in a scratch
  directory has no callers.  It had one: every `ab*.sh` ends with
  `python3 "$(dirname "$0")/verdict.py" "$out"`, passing a *log path*,
  and the replacement read its arguments as tag names — so it matched
  nothing and printed nothing, and the next A/B to finish came out with
  an empty verdict section while the battery ran on.  The failure was
  silent in both
  directions: the caller does not check, and an empty verdict looks like
  a run that has not finished.  **Before writing a file you did not
  create, grep the tree for its name**, and when a tool grows a second
  invocation style, make it accept both rather than swapping one for the
  other.
- **Read the milestones, not tIdle.** tIdle sums phases with opposite
  signs: the JIT once lost ~9 s early and won ~11 s late, and "parity"
  was reported for a day while users saw 86 vs 78 s. Decide on
  t0.5G + window for boot work, ns/access mirrors for device-path work.
- **The benchmark must measure what ships.** idlebench hardcoded
  `rt=off` for a week while the page shipped `rt=banked`; the two are
  identical through t0.75G and then +33 % apart. If the page has a knob,
  the benchmark must be able to set it, and a knob A/B must be
  interleaved in one invocation (`<dir>@<query>`).
- **A knob that changes emitted code size can trip a `tb_flush`, and it
  looks exactly like a cache cliff.**  `W64_BYTEPAD` reads flat from 0
  to 60 (+420 B/TB) and then +17.6 % at 120 — which is not the i-cache:
  `tbFlush` goes 0 → 1, `tbGen` 159 k → 204 k and `mods` 33.6 k →
  40.8 k, because the padded code overflows the code buffer and the
  whole translation is redone.  The artifact is ~10× the effect being
  looked for.  **Read `tbFlush`, `tbGen` and `mods` alongside every wall
  number from a code-size knob**, and treat any leg whose `tbFlush`
  differs from the baseline's as void.
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
  and V8 function indices include imports. Add a cold counter
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
- **A repeat-the-same-input microbenchmark of a compiler measures its
  cache** (2026-09-16, round 24).  Round 19 timed `new
  WebAssembly.Module` back-to-back on one real module, got 12–31 µs
  against ~84 µs in the app, and concluded that four fifths of the
  module cost was cold cache — a conclusion that shaped two rounds of
  planning.  It was compiling the *same wire bytes* every time, and V8
  keeps a compiled-module cache keyed on exactly those bytes.  Perturb
  one immediate per call and the cost rises 2.0–3.8×.  The check costs
  one line and the false floor it removes was worth two rounds: **if
  you are benchmarking something that is allowed to memoise, vary the
  input.**  The same trap is waiting in any probe of a translator, a
  parser, a regex engine or a shader compiler.
- **Fit a cost model by moving the variable you care about, not a
  proxy for it** (2026-09-16, round 24).  "A module costs ~80 µs fixed
  + 3.2 µs/KB" was fitted with `W64_BYTEPAD`, which inflates *bytes* at
  a fixed member count, over a 2.8× range — and the per-byte term it
  produced did not survive.  Moving the close policy instead
  (`W64_SPEC_N`, `W64_BATCH_N`, `W64_NOCLOSEEXEC`) sweeps **members**
  over 48×, which is the term that actually varies in the emulator, and
  six points land on one line: ~86 µs per close + ~2.8 µs per member.
  A padding knob is easy to build and sweeps the wrong axis; a policy
  knob is the real experiment.
- **The assumption a probe "cannot settle" is usually settled by a knob
  that already exists** (2026-09-16, round 24).  The interpreter tier's
  cost — how much runs interpreted while a batch fills — was written
  down twice as depending on an interleaving only the real thing
  produces, and therefore as the thing to measure *after* building a
  prototype.  But `W64_NOCLOSEEXEC=1`, added rounds earlier as an A/B
  for a different question, **is** that deferral: batches fill to 128
  under it.  Summing each member's existing per-TB entry counter at
  close time turned the last assumption into 7 001 592, measured, for
  about twenty lines.  Before accepting "only a prototype can tell us",
  re-read the knob list for a mechanism that already produces the state
  you need.
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

- **A gate is not a measurement, so gates can run concurrently.**
  Nothing in a gate reads a wall clock as a result, which means host
  load cannot change a verdict — so there is no reason to run them one
  after another, and every reason not to: the four-board browser gate
  alone was ten minutes serial and is 2.5 minutes in parallel
  (`scripts/gate.sh`). The same property is exactly what benchmarks
  lack, so keep the two sets apart and never measure while a tier runs.
- **A gate that is slow gets skipped, and a gate that skips silently is
  worse than none.** Both failure modes were live here at once: the
  op-suite waited out a 10-minute timeout on a leg that had been dead
  since 2026-09-13, and announced `PASS` while printing "wasm leg
  skipped" for the backend under test. Bail the moment a page throws —
  no result line is coming — and make a skipped leg say so in the
  verdict, not only in the log.
- **Boot one fullflash per class, not one fullflash.** S75 was the only
  browser boot anyone watched for the whole 0019–0032 run; EL71 (the
  only one that programs flash during boot) and KE800 (the only one
  without icount) each hid a distinct bug the whole time while the
  native suite stayed 4/4. CX70 joined for SGOLD. The four-board browser
  gate (`tools/bootcheck.mjs`) is in every tier of `scripts/gate.sh`.
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
