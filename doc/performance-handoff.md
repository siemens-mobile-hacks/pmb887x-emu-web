# Performance hand-off

Where the work stands, what is open, and what binds. Patch numbers are
commits on the `qemu/` submodule branch ([upstream-branch.md](upstream-branch.md));
the per-patch numbers live in the playbook's "What landed" table, the
method in [optimization-playbook.md](optimization-playbook.md), the
hard-won conclusions in [lessons.md](lessons.md).

## Start here — new session, first five minutes

**Read this far and stop:** § Where it stands, § Open items,
§ Constraints, § Non-goals — the next four sections. They are the live
state and they are enough to choose a target. Everything after them is
the round log, kept because the *reasoning* in a closed round is what
stops an idea being retried for the fourth time; but every number in it
is as of its own date, a later round beats an earlier one, and the three
corrections that matter most are tabled at the very bottom of the file.
Once you have a candidate, [optimization-playbook.md](optimization-playbook.md)
§ The iteration ladder is how to test it, and [lessons.md](lessons.md) is
what has already been paid for.

**The workspace is ready** (checked 2026-09-16, end of round twenty): both
native builds, `build/qemu-wasm64`, `site/dist-jit`, `tools/node_modules`,
and the `qemu/` submodule at `bad630a3e7` (0090), which matches
`QEMU_PMB887X_REV` in `versions.env`. `site/dist` carries only the guest
images (boards.tar, tcgisa.bin) — **its TCI engine is not built**, so the
wasm-TCI op-suite leg skips. Nothing needs bootstrapping — if
something *does* look unbuilt, `scripts/build-qemu-wasm64.sh` is the safe
mid-session rebuild; `scripts/build-qemu.sh` re-fetches and may check the
submodule out to a stale pin.

```bash
PORT=8080 node serve.mjs &               # page server; leave it running
bash scripts/ninja-fast.sh               # ~8 s. DO NOT SKIP: build/qemu-wasm64
                                         # may have been left mid-state, and an
                                         # incremental build over that once faked
                                         # a 5 % win for four invocations
cp -a site/dist-jit site/dist-jit-base   # the A leg of every A/B this session
bash scripts/gate.sh quick               # 152 s, all jobs concurrent — start green
```

**Three rules decide whether a session produces anything.**

1. **Measurements and gates are different activities.** A gate never
   reads a wall clock as a result, so all of them run at once
   (`scripts/gate.sh`: `keep` is 152 s against 846 s serial, `close`
   719 s against 2274 s). A measurement does, so it runs alone on a
   quiet host, with A and B interleaved inside one invocation. Never
   measure while a tier is running.
2. **A counter confirms a mechanism; a clock only prices it.** Counter
   spread is 0.04 %, wall spread 3–8 %. `tools/diagall.mjs` /
   `counters.mjs` first, `workbench.mjs` second.
3. **Price the prize before building the machine.** Round 17 measured
   the whole translate-and-compile pipeline at 19.5 % of a boot *before*
   anyone built a tiering scheme for it; § Open items 1 carries the same
   discipline forward with the probes to run first.

**Traps that are specific to this tree**, each already paid for once:

- **A name in a wprof2 profile is a neighbourhood, not a function** —
  off by up to 100×. Confirm with a counter or a volatile-spin probe
  before optimising anything it names.
- **Module count is speculation-miss count.** Measure `specMiss`, never
  `tbGen`, and read `mods` alongside wall on any codegen change: adding
  instructions to a hot path buys modules at ~83 µs each.
- **The wasm64 op-suite leg gates again** (0090 fixed the 2026-09-13 KNOWN
  HOLE — an Asyncify rewind into uninstrumented versatilepb machine-init
  frames). The wasm **TCI** leg still skips whenever `site/dist` has no
  engine built; and a silent skip is worse than a red gate — read the leg
  list, not the PASS line. Treat a lockstep failure as real on the first
  occurrence.
- **A silent skip is worse than a red gate.** `run-tcg-isa.sh` skips a
  leg whose dist is missing — read the leg list, not the PASS line.
- **This is a container**: `/proc/loadavg` and `free` report the *host*,
  co-tenants are invisible. Check the `load=` the tools print before
  believing a ratio inside ±10 %.
- **A hard wasm trap is never host pressure**, and a bisect that "fits"
  can fit because the bug predates both revisions.

**Landing a change:** one mechanism per commit on the `qemu/` submodule
branch with the measured numbers in the message, bump
`QEMU_PMB887X_REV` in `versions.env`, `scripts/gate.sh keep` before the
commit and `close` before the session's last one. Whatever happened, it
gets a row — the playbook's **What landed** if it shipped, **REJECTED**
with its numbers if it did not, so nobody retries it blind.

## Where it stands

The wasm64 TCG backend (`site/dist-jit`) is the default engine on every
board. Four fullflashes boot in the browser and natively.

| board | insns in the 150 s gate | notes |
|---|---|---|
| s75 (S75v40lg1) | 1.71–1.72 G | the icount reference board; idlebench's default |
| el71 | 1.62–1.64 G | the only board that programs its flash file system while booting |
| ke800 | 2.6–2.8 G | LG, the only board that boots **without** icount |
| cx70 | 13.2–13.7 G | SGOLD, the fastest-executing board |

Those counts are instructions executed inside a fixed *wall* window, so
they move with host speed and load — they are a health check, not a
metric. The icount boards settle within ~1 % run to run; ke800 and cx70
swing several percent. Use `workbench.mjs` for anything that has to
resolve a patch.

Cost model of a boot, from counters (rounds 17–19, spread 0.04 %):

- The translate-and-compile pipeline is **19.5 %** of an EL71 boot, so
  the boot is **not** compile-bound; the other ~80 % is guest code plus
  the device and lookup paths.
- **A module costs ~80 µs fixed + 3.2 µs/KB** in the app (round 21,
  fitted with `W64_BYTEPAD`). At the shipping 5.1 KB/module that is 17 %
  of the cost, so **emitted bytes are worth at most 2.2 % of wall even
  driven to zero** — which is why three earlier rounds read a −3.7 %
  byte cut as flat. Compile time is `~96 µs × module count`.
- **Module count is speculation-miss count**: a batch opens on a lookup
  miss and closes when its first member runs, so `close` == `specMiss`.
  It never reaches `W64_BATCH_N`=128 — **modules average 4.9 TBs**.
  Speculation is starved of *edges*, not budget (`W64_SPEC_N` 8 == 128).
- **Four fifths of the 80 µs is not compiling** — the same bytes compile
  in 12–31 µs back-to-back inside the vCPU worker's own isolate, and
  ~8 µs + 7–12 µs/KB in a browser tight loop. The rest is cold cache,
  evicted by ~700 µs of guest code between calls. It is **not** the
  live-module count: 500 → 6000 live instances is flat (`modgrow.mjs`).
- **~3.6 % of TB entries run V8's baseline tier, at 2× the optimizing
  tier's cost** (round 21). `--liftoff-only` is +63 % and
  `--wasm-tiering-budget=1000` is −3.1 %. Emitted code is mostly baseline;
  a C helper in the main qemu module is optimized. Moving work *into* a
  helper can win — the call boundary is only 2.1–2.4 ns.
- The inline TLB probe's ~19 wasm instructions are **~5 % of EL71 wall**
  (`W64_LDSTPAD=4`, 2.51 ns per memop for 18 added instructions).

## Open items (ranked)

1. **The module pipeline is the last big target, and after the round-20
   probe there is exactly one way at it: the interpreter tier.**
   Compile time is `83 µs × module count`, module count is miss count
   (0080), speculation is already at its budget optimum (`W64_SPEC_N`=64
   is a measured tie), and observed edges cannot predict because an edge
   is recorded only after the guest took it. The **AOT cache route is
   closed** (2026-09-16, probed in both engines before building — see
   the playbook's REJECTED table): neither V8 nor SpiderMonkey stores a
   compiled `WebAssembly.Module` in IndexedDB, byte-persistence costs
   more than the recompile it avoids (0.56–0.60× in V8, 0.90–0.91× in
   Firefox at
   real module size), a put per batch close alone would cost 4.4–13.3 s
   per boot, and Cache-API `compileStreaming` gives synthetic responses
   no code-cache hit. What remains:

   | route | ceiling | what it needs |
   |---|---|---|
   | **interpreter tier** (run cold code interpreted, compile only what repeats) | up to **12.5 %** — that is the whole pipeline; halving module count is ~6 % | keep the TCG op stream alongside the wasm |

   Rounds 21–22 firmed the arithmetic and closed the alternatives. A
   translation costs **~12 µs** against ~96 µs for the module a miss
   forces, so speculation pays at a **12.5 % hit rate** and already
   converts at **66 %**. That looked like headroom, and it is not:
   **speculating harder is closed by measurement** (0097). The miss
   stream is 31 397 events at 31 397 *distinct* pcs — zero repeats — and
   only **10.2 % of them appear anywhere in the 64 MB flash image as a
   pointer**. The other 89.8 % are reached by computed addresses (jump
   tables whose entries are branch *instructions*, index-scaled
   dispatch), which no literal, pointer or relocation scan can see. That
   caps **every** static-edge idea at ~1.2 % of wall. Misses also
   cluster only weakly — 10.2 per touched page against ~529 basic blocks
   in a page, so eager page translation is 7× negative. Two edges were
   tried before this was known: call returns bought 2.6 % of misses
   (0092), and the address after an unconditional transfer bought nothing
   and **panicked the guest** (§ REJECTED; **read that before touching
   speculation** — a speculation "hint" can change guest behaviour and
   the cause is still unknown). The cost is `~80 µs fixed × miss count`; **bytes are capped at 2.2 % of wall**
   (`W64_BYTEPAD` fit), the live-module count is not a factor
   (`modgrow.mjs`), bigger modules are not the lever (`dispatch-probe`:
   128-per-module vs one module is 8–13 % of the dispatch, and batches
   average 4.9 members anyway), and misses are **edge-limited, not
   budget-limited** (`W64_SPEC_N` 8 == 128; the walk makes 3.5 TBs per
   miss against a budget of 32). Two edge classes were measured: the
   call-return address is real but small (**0092, −2.6 % misses**), and
   speculating from the link register when a TB has no static successor
   is **−7.6 % of wall for nothing** (§ REJECTED).

   **Probe before building**: (a) is an interpreted first execution of a
   ~3.9-instruction TB really ~100× cheaper than the module it avoids?
   The TCI dist already answers the cost side per-op; the open question
   is the dispatch overhead of entering a one-off interpreter run from
   the wasm64 dispatcher without paying a module boundary. (b) **How long
   would a missed TB stay interpreted?** Decoupling the close from the
   miss is the whole point, and the current close rate is one per 4.9
   translations — a TB that waits for a 128-member batch waits ~22 ms,
   which a hot TB spends thousands of entries in. The design almost
   certainly needs a per-TB interpreted-execution count that promotes a
   TB to its own module, so measure that distribution first.

2. **The baseline tier: ~3.6 % of TB entries, at 2× the optimizing
   tier's cost.** New in round 21 and barely exploited. Nothing page-side
   can set a V8 flag (`--wasm-tiering-budget=1000` is −3.1 %, and that is
   the size of the prize), so the ways at it are (a) emit less or cheaper
   code for the baseline tier — the declared locals are priced at under
   1 % and rejected on cost, but the same question has not been asked of
   the inline TLB probe or the ld/st sequence — and (b) get functions to
   tier up sooner. For (b): if V8's tiering budget drains by function
   *size* per call, merging a batch's members into one `br_table`
   function multiplies both size and call count and would tier up ~N²
   sooner, against a br_table per TB entry and a coarser dispatch target.
   **That was measured and the premise is false**: `tools/tierup-probe.mjs`
   puts tier-up at **~1–2.4 × 10⁴ calls across an 85× range of body sizes**
   (329 B, 2849 B, 28051 B all land in the same decade; the calls × size
   product spans 47×, so it is per-call, not size-weighted). Merging N
   members therefore buys N, not N² — 5× at the 4.9 members a batch
   actually holds — against a `br_table` on every one of ~12.8 M TB
   entries a second. Not worth building. What the number *does* explain:
   a TB needs ~15k entries to leave the baseline tier, and the average
   live TB sees ~250 entries a second, so only the genuinely hot ones ever
   get there. Compaction re-instantiates a member into a new module and
   resets its budget, but it does so roughly once per TB and within ~1024
   translations of its creation, so it costs almost nothing.

   The generalizable half is already usable: **work moved out of emitted
   code into a C helper lands in the main qemu module, which is hot
   enough to be optimized; work moved the other way does not.** The call
   boundary is not the obstacle it looks like — 2.1–2.4 ns
   (`tools/import-probe.mjs`).

3. **CX70's device writes have no named device.** Post-0083 they are
   ~103 ns each at 56k/s — about **0.6 % of wall**, so this is a
   name-the-register task, not a prize. (Round eighteen measured 645 ns
   before 0083 landed; that figure is stale.) `iotrace2.mjs --board cx70`
   is the tool.

4. **ke800 saw −2.1 % from 0083** (2 pairs, inside noise): the LG board
   does not toggle EBU readonly, so it should be a wash. Wants one longer
   run to confirm.

5. **Does Firefox still need the GC nudge?** 0087 keeps it for Firefox
   and takes it off Chromium, but the gate can no longer reproduce the
   OOM it exists for: 202 s with `W64_GCNUDGE=0` reached 2.73 G insns and
   40 152 modules, `errors=0`. The original report was *mobile* Firefox
   on a Pixel, so it stays until someone retests there.

6. **Instrument hygiene, unfinished.** The phase timer over-attributes
   short functions — it put hflags at 3.8 % of wall and the patch
   delivered ~1 %. `CAL_NS` removes the interval floor but not whatever
   else inflates a sub-50 ns measurement, and it has not been used with
   the measurement build's other instruments. A better instrument would
   calibrate against a *known-cost* function (a volatile spin of N
   iterations) rather than against an empty interval. Until then: trust
   the call-count reduction and the A/B, and read any sub-50 ns per-call
   figure as an upper bound.

7. **J2ME throughput** (`tools/stopwatch.mjs`, vratio ~0.60 after 0052):
   the remaining third is the DIF FIFO word loop, the DMAC per-word MMIO
   writes and the SRB events — a device-path target, not an engine one.
   This meter drifts with host load; take alternating samples.

8. **Timer storms / main-loop wakeups — sized, audited and parked.** The
   clock/timer path is ~2.5 % of the vCPU mid-boot at ~37k `timer_mod`/s.
   Halving it is below the noise floor of a single pair, so it only lands
   bundled with something measurable. The 0049-pattern audit is **done
   (2026-09-16, by inspection — round twenty)**: `capcom.c` and `stm.c`
   carry no QEMU timers at all; `tpu.c` re-arms only when the deadline
   moved (0068's guard); `tpu2.c`'s `dyn_timer` arms at
   min(next-unfired-IRQ, overflow); `gptu.c` is 0049 itself; `sccu.c` is
   a one-shot sleep timer; `rtc.c` arms on calendar events; and
   `timer.c`'s generic framework has **zero callers** — dead legacy
   code. The "deadline = next hardware tick" shape exists nowhere else
   in the tree.

9. **The idle-warp share of a boot is a fidelity question, not a
    performance one.** A boot consumes ~42 s of virtual time, ~31.5 s of
    it idle warp on millisecond device timers. Whether that is what a
    real S75 takes needs a measurement against hardware before any device
    timer period is touched. Engine work can only move the first ~0.75 G
    instructions — about 27 of the 39 s a user waits.

10. **Native has no real-time cap** (0032 defaults it off outside
    emscripten), so native and web agree on the timing model and disagree
    on pacing. **Reviewed and deliberately not done**: it is a fidelity
    change that makes every native run 2.7× slower, costing the cheapest
    gate in the ladder and buying the shipped build nothing.
    `QEMU_ICOUNT_RTCAP=banked` already reaches it for anyone who wants a
    paced native run. Flip the default only alongside the hardware
    reference measurement item 8 needs.

## Constraints (what still binds)

- **The timing model is fixed**: stock `-icount shift=3,sleep=off` +
  the real-time cap on wasm; correctness must never depend on execution
  speed (lockstep gates enforce it). Do not "fix" pacing by pinning
  clock frequencies.
- **The firmware busy-polls** (~50–100k MMIO dispatches/s in poll
  phases) and its TBs are 3–4 insns: per-access and per-wake costs are
  the only ones that scale; any per-access condition on a hot path must
  pay for itself at that rate.
- **qemu-core changes shift all backends**: A/B on both dists, and the
  full correctness matrix per landing — which is what `scripts/gate.sh
  keep` is, with `close` adding the 2.5e9 lockstep and Firefox at
  workstream close. Backend-only (`dist-jit`) changes skip the `dist`
  legs but nothing else.
- **Quote boot improvements against `rt=banked` as well as `rt=off`**,
  or they read larger than a user will see.
- emscripten traps that don't compose: wasm-EH longjmp × ASYNCIFY,
  `poll()` never sleeps, condvar waits are whole-ms, proxied syscalls
  are ~1 ms — [lessons.md](lessons.md) § Emscripten runtime.

## Non-goals

- More emitter/interpreter micro-optimization as the primary lever —
  the backend holds a ~10× compute reserve the boot cannot spend on
  cold code.
- Changing the timing model or any device's semantics for speed.


## Round log (newest first)

## Update (2026-09-16, round twenty-two: speculation has headroom, but not this edge — 0095)

Round twenty-one left item 1 with one number missing: what a translation
costs, against the ~96 µs a miss costs in module time.  It is **~12 µs**,
and it was got by solving a two-point system on the fixed-work meter
rather than by a phase timer — a `WASM_DIAG_TIME_PHASES` build is 2.2×
slower overall (its `tlb_fill_align` timer runs at 54k/s) and its shares
are unusable, which is worth knowing before anyone reaches for it again.

`W64_SPEC_N` 0 vs 32, el71, 100–1400 Mi:

| | tbGen | misses | modules |
|---|---|---|---|
| 32 (default) | 160 655 | 33 621 | 33 817 |
| 0 (off) | 117 881 | 117 881 | 118 342 |

So speculation spends **127k extra translations to remove 84k misses** —
a **66 % conversion against a 12.5 % break-even**.  It is already a 16:1
win, and there is room to guess much more wildly than it does.

The edge tried was the address after an unconditional transfer: goto_tb
records only the branch target, an indirect exit records nothing, so the
next basic block is never pre-translated.  **It makes 89 % more
speculative translations and removes no misses** — rejected on its own
merits — and then, guessed after an *indirect* exit, it panics the EL71
firmware in 4.5 s at a fixed guest pc.  s75 and cx70 survive it; EL71 is
the board that programs its flash file system while booting.

That second half outlives the experiment.  `w64_speculate` is documented
as a hint that cannot change guest behaviour, and it can.  Three causes
were ruled out by experiment (tb_flush — the shipping build survives 11
and 38 forced flushes, which also exercises 0091's tidx recycling for the
first time and finds it sound; ISA alignment; and a stale TB over
reprogrammed flash).  A real gap was found on the way and recorded rather
than fixed: **the pmb887x flash model and `pflash_cfi01` both write their
rom device's backing RAM directly and neither invalidates TBs for the
range**, which `nrf51_nvm.c` shows is required.  It is latent — something
has to translate the range before it is written — but a speculative
translator makes that ordinary, so it is a prerequisite for item 1 rather
than a curiosity.

`W64_LINSPEC` ships off, as the reproducer.  New tool:
`tools/abortlog.mjs` — the failure was a firmware panic on the serial
console, which `workbench.mjs` reports only as a Node crash three layers
up.

### The miss stream, priced — and "speculate harder" closed

The open list kept coming back to "can another edge be guessed?", and the
economics invited it. 0097 answers it by measuring the stream instead of
guessing a third time:

- 39 562 misses land in 3 878 distinct guest pages — **10.2 misses per
  touched page** — against ~529 basic blocks in a 4 KB page at this
  firmware's 3.87 insns/TB. Translating a page on first entry costs
  ~6.3 ms to save ~0.88 ms: **7× negative**.
- `W64_MISSDUMP` over a 60 s boot: 31 397 miss events at **31 397
  distinct pcs — zero repeats**, exactly as the model says (a miss is a
  TB being discovered, once).
- Intersected with every pointer-shaped word in the 64 MB image:
  91.5 % of missed pcs are inside flash, and only **10.2 % appear
  anywhere in the image as a pointer**.

So **89.8 % of misses are at addresses the firmware never stores as a
pointer at all**. They are computed — base+offset, `add pc, pc, rN lsl
#2` tables whose entries are branch instructions, index-scaled dispatch.
Nothing a translator can scan will find them. That is a ceiling of
**~1.2 % of wall** on every static-edge idea, and it assumes a heuristic
that can read the whole image, which a real one cannot.

**The 12.5 % is the interpreter tier or nothing.**

### Three more closed the same round

- **Compaction granularity is not a dispatch lever.** `W64_COMPACT_MEMBERS`
  256 / 1024 / 4096 is **flat over a 4.6× range in compaction events**
  (five pairs, then three more of 1024 vs 4096 reading +1.0 % the other
  way). The synthetic probe genuinely shows 1024 functions per module
  dispatching **38 % cheaper** than 128 across a 32768-function set
  (60.3 vs 96.5 ns) — but that is a **uniformly random draw**, the worst
  case, and the emulator does not live there: its hot set is a few
  hundred TBs that were translated together and share a module. **Do not
  read `dispatch-probe`'s absolute ns as the emulator's dispatch cost**;
  the `live` knob is a ceiling, not a measurement. A *direct*
  `return_call` instead of an indirect one, at identical access
  patterns, is worth only 1.1 ns at 128 functions per module.
- **`CF_PCREL` off is a wash** (0096): −0.7 %, 2/3 pairwise, and +2 %
  misses. No saving because `cpu_R[15]` is a TCG global, which this
  backend keeps in a wasm local — the "read" is a `local.get`, not a
  load. *Do not price a TCG global access as a load on this backend.*
- **`tb_flush` is sound**, exercised for the first time: 11 and 38
  flushes forced with `?qargs=-accel tcg,tb-size=24` / `=8`, no panic.
  That also covers 0091's `tidx` recycling across a flush, which its own
  commit noted had never been observed to run.

### Method notes from this round

- **A `WASM_DIAG_TIME_PHASES` build is not usable for shares.** It is
  2.2× slower overall (677 M insns in 30 s against 1500 M) because its
  `tlb_fill_align` timer runs at 54k/s, and it inflates even the
  always-on `modNs` (96 → 226 µs/module). Get a phase cost by solving a
  two-point system on the fixed-work meter instead — that is where the
  ~12 µs translation figure comes from.
- **`modcost.mjs` is fixed-*wall*, not fixed-work.** Counts from it must
  be normalised per Mi, and its insn totals swing 15 % run to run with
  how much idle the window caught. An earlier A/B in this round read as
  "no effect" purely because of that; `workbench.mjs` (fixed guest work,
  and now printing `modMs`) is the right meter for anything counted.
- **`modcost.mjs` takes `WENV=`, not `EXTRA_Q=`.** Four runs were
  compared before anyone noticed the knob had never reached qemu.

## Update (2026-09-16, round twenty-one: the dispatch, and then the tier — 0091–0094)

Two landings and five closures.  0091 is the round's win; the rest of it
went into finding out where the remaining time actually is, and most of
that came back negative — which is the useful part, because four of the
five closures were things the open list still wanted somebody to build.

### 0091: dispatch on the table index, not the target's descriptor

Every TB entry is a `return_call_indirect` through the shared chain table
— ~11 M a second on an EL71 boot — and **both** exits reached it by
following a pointer into the *target TB's* descriptor to read `fidx` and
`tidx`.  That is one cache line per TB, in ~20 MB of module staging the
execution path otherwise never reads, sitting on the dependency chain of
an indirect branch.

Nothing here had ever priced the dispatch, so it was priced first.
`tools/dispatch-probe.mjs` builds F functions of the real TB signature,
spread over a configurable number of module instances, each tail-calling
the next index of a pseudo-random sequence: the mechanism is cheap (a
predictable `return_call_indirect` is 2.4 ns, and 128-per-module vs one
module costs 8–13 % of the dispatch, not a multiple), the cost is
locality (5.5 ns at a 1-function working set, 46 ns at 4096), and the
descriptor load specifically is **+2.1 ns over 256 TBs, +8.2 ns at 1024,
+9.1 ns at 4096**.

So the helpers and `tb_set_jmp_target` now carry `W64_TIDX_TAG | tidx`
directly.  A wasm64 heap pointer is below 2 GB, so the high half
separates a table index from the two cases that must still reach the C
dispatcher, with no test of its own.  **el71 −5.4 %, s75 −4.5 %,
cx70 −7.0 %, ke800 −10.8 %, 3/3 pairwise each.**

### 0092: the call-return edge nothing recorded

A lookup miss costs a wasm module — `closeN` == `specMiss` exactly — and
the module pipeline is **12.5 % of an EL71 boot** (`tools/modcost.mjs`).
The batcher never gets near `W64_BATCH_N`=128: the open batch is
force-closed the moment a staged TB has to run, so **modules average 4.9
TBs**.  Speculation is starved of *edges*, not of budget — `W64_SPEC_N` 8
and 128 give the same miss count, and the walk makes 3.5 TBs per miss
against a budget of 32, because `w64_succ` holds goto_tb destinations and
the walk dies at the first TB ending in an indirect branch.

The one statically-known indirect edge is where a call returns to.
`trans_BL`/`trans_BLX_i` already note it; three paths did not, and one of
them matters: this is an ARM926EJ-S, so Thumb has no 32-bit BL and every
Thumb call goes through the split `BL_BLX_prefix` + `BL_suffix` pair —
and this firmware is mostly Thumb.  **Misses −2.6 %, 3/3 on fixed guest
work**, ≈0.3 % of wall.  Counter-confirmed, free at run time, kept;
nobody should expect to feel it.

### The tier, which is the round's real finding

`tools/locals-probe.mjs` was written to ask what the ~70 locals every TB
function declares cost — wasm zeroes locals at entry and a baseline
compiler has no liveness analysis to drop them.  The answer split by tier
and the *split* turned out to matter more than the locals:

| declared extra locals | baseline tier | optimizing tier |
|---|---|---|
| +0 | 49.93 ns/call | 25.08 |
| +16 | 70.49 | 23.97 |
| +69 | 88.87 | 25.02 |

So the baseline tier is **2× the optimizing tier before any locals, and
3.6× with ours**.  Which tier the boot is in, measured with `--js-flags`
(`JS_FLAGS` is now a `workbench.mjs` knob):

- `--liftoff-only` **+63 %** (30.3 → 49.4 s) — TB code really does tier up
- `--no-liftoff` +119 % — forcing the optimizing tier from the start is far
  worse, because compile swamps it
- `--wasm-tiering-budget=1000` **−3.1 %, 3/3 interleaved** — that is what
  is still running baseline in the shipping configuration, ≈3.6 % of TB
  entries

This is the same wall two earlier rounds hit without naming: 0046's first
two designs were both "Liftoff code for a dozen loads and six branches
costs more than the TurboFan-compiled helper's jump-cache hit".  It now
has a number, and a direction: **work moved out of emitted code into a C
helper lands in the main qemu module, which is hot enough to be
optimized; work moved the other way does not.**  The call boundary is not
what makes that trade — `tools/import-probe.mjs` prices a TB module's
call into the main module at **2.1–2.4 ns** (3.6–4.4 ns baseline),
whether imported as an export, taken from `wasmTable.get()` the way
`wasm64.c` does it, or reached by `call_indirect`.

### What a module costs, finally decomposed

Two knobs landed for this (0093 `W64_LOCALPAD`, 0094 `W64_BYTEPAD`), and
between them the module cost has a shape instead of a single number:

- **`new WebAssembly.Module` on its own is ~8 µs** for a small module,
  rising at ~7–12 µs/KB in a tight loop (`tools/locals-probe.mjs
  --split`).  Large modules compile on background threads, which is why
  the 404 KB compaction modules come in at 1.4 µs/KB and the 2.3 KB close
  modules at 33 — do not fit a line through those two populations, they
  are not the same experiment.
- **In the app it is ~80 µs fixed + 3.2 µs/KB**, fitted properly by
  inflating emitted bytes in place (`W64_BYTEPAD` 0/40/120 → 5.1/7.7/14.5
  KB per module → 96/110/125 µs).
- The live-module count is **not** a factor: `tools/modgrow.mjs` holds
  500 → 6000 instances alive and the cost stays ~50 µs, and dropping them
  all does not change it.

That closes the emitted-byte question that three earlier rounds left
ambiguous.  At the shipping 5.1 KB/module, bytes are 17 % of the module
cost, so **emitted bytes are worth at most 2.2 % of wall even driven to
zero** — the inline TLB probe at 37 % of bytes is worth ~0.8 %.  The
earlier "flat" readings at −2.6 % and −3.7 % bytes were consistent with
this all along; those experiments were looking for 0.4 % with meters that
resolve 3 %.

**So module count is the only lever on the 12.5 %, and module count is
miss count.**  That is item 1, unchanged, and now with its arithmetic
firm.

### Rejected this round, with numbers

1. **Dense goto_tb chain-slot arena** (16 B per TB keyed by tidx, four
   translations per cache line, instead of `tb->jmp_target_addr[n]` inside
   a TranslationBlock at ~1 KB stride).  Six interleaved pairs across two
   sessions: −3.2, −1.1, +2.1, −7.2, +4.2, −0.0 % — mean −0.9 %, SE 1.6 %,
   a wash.  The explanation is worth keeping: after 0091 the slot address
   is a **compile-time constant**, so the load issues early and its
   latency is hidden.  0091 won by removing a load whose address *depended
   on another load*.  Locality only pays on the dependent one — which also
   kills the matching idea for the `w64_lc` slots, whose address is
   likewise constant.
2. **Speculating from the link register** when the missed TB has no static
   successor at all (17.5 % of misses).  **−7.6 % of wall, 3/3, with no
   change in miss count.**  The walk it enables costs a
   `probe_access_full_mmu` and a qht lookup on every one of those misses,
   and the root can never be marked `w64_explored` because the hint is a
   register, not a property of the TB.
3. **Shrinking the declared locals.** Priced at under 1 % in-app
   (superlinear, so the derivative at 70 is the small end), against
   interleaving the i32/i64 register locals so trailing runs can be
   patched to zero and renumbering `TCG_REG_TMP` off R28.  Not built.
4. **Raising `W64_BATCH_N` / making modules bigger.**  Closed by
   dispatch-probe: 128-per-module vs one module is 8–13 % of the dispatch.
   Batches average 4.9 members anyway — the knob is not what binds.
5. **The helper-call boundary as a cost.** 2.1–2.4 ns; it is not where
   `helper_lookup_tb_ptr_lc`'s 102 ns goes.

### Open at the end of round twenty-one

The ranked list at the top of this file stands.  What this round changes
about it:

- **Item 1 is the only big one left, and its arithmetic is now firm**:
  80 µs × miss count, misses are edge-limited and the edges are
  indirect-branch targets that nothing static can name.  The interpreter
  tier is the route; the probe it still needs is the one item 1 already
  states, plus one this round adds — how long a missed TB would have to
  run interpreted before its batch closes, since decoupling the close from
  the miss is the whole point and the current close rate is one per 4.9
  translations.
- **A new lever exists and is barely exploited**: ~3.6 % of TB entries
  execute baseline-tier code at 2× the optimizing tier's cost.  Nothing
  page-side can set a V8 flag, so the ways at it are (a) emit less/cheaper
  code for the baseline tier, and (b) get functions to tier up sooner.
  For (b) there is an untested idea with a real mechanism behind it: if
  V8's tiering budget drains by function *size* per call, then merging a
  batch's members into one `br_table`-dispatched function multiplies both
  size and call count and would tier up ~N² sooner — against a br_table
  per TB entry and a much coarser dispatch target.  **Measure the drain
  rule first** (call count to tier-up vs body size, which
  `locals-probe.mjs` can be pointed at) before building any of it.

## Update (2026-09-16, round twenty: the op-suite hole is closed — 0090)

Round nineteen's hand-off said of the broken wasm64 op-suite leg:
"hypothesis confirmed, missing names in hand — only the landing is
left."  This round landed it, and the shipping backend has op-suite
coverage for the first time since 2026-09-13.

The 20 names (all on the versatilepb machine-init / legacy-SCSI /
board-reset path, captured with `QEMU_COSTACK=1` in round nineteen)
went into `qemu/configs/meson/asyncify-only.txt` as the minimal explicit
set — no wildcards — with a `#` comment at the top of the file naming
where they came from (emscripten's one-symbol-per-line parser skips
`#` lines, verified in the emsdk source first).

**One new trap, paid for once so it is free forever: changing the
onlylist's *content* does not relink.**  The link command embeds
`-sASYNCIFY_ONLY=@/abs/path` — an unchanged string — and meson/ninja
have no dependency on the file's bytes, so `build-qemu-wasm64.sh`
completes "successfully" with the *old* instrumentation.  Deleting
`build/qemu-wasm64/qemu-system-arm.{js,wasm}` (or touching a link input)
forces the relink.  Symptom to remember: a rebuilt dist whose md5 did
not change.

Results, per the ladder:

- wasm 27 804 606 → 27 817 238 bytes (+12.6 KB — the price of
  instrumenting 20 once-per-machine-init functions).
- `WASM64_SUITE=1 scripts/run-tcg-isa.sh`: **wasm64 page leg green,
  1156/1156, serial byte-identical to native JIT** (as the no-onlylist
  build had predicted).  The KNOWN-HOLE special case is deleted from
  `scripts/run-tcg-isa.sh`; the leg gates unconditionally now, and
  `WASM64_SUITE` is retired.
- `gate.sh keep`: 11/11 GREEN in 152 s, the opsuite job now carrying the
  wasm64 leg (its log shows the leg, not a skip).
- el71 boot A/B (workbench, 100–1400 Mi, 3 interleaved pairs against the
  pre-change dist): **tie** — medians 29.45 s both legs (base
  29.46/29.45/29.25, new 29.45/31.07/29.05; the +1.6 s leg is host
  noise, load 3.5–4.3), guest counters identical, `miss` == `close` as
  always.  The instrumentation costs a phone boot nothing, as predicted.

Landed as `bad630a3e7` (0090) on the qemu branch; `QEMU_PMB887X_REV`
bumped.  The link-time warnings about non-existing onlylist names
(`qemu_machine_creation_done`, `raw_co_preadv_20784`, …) are 0074-era
cruft, harmless no-ops — none of the 20 new names is among them.

Also corrected this round: the workspace-ready claim that `site/dist` is
built — it holds only guest images; its TCI engine is absent, so the
wasm-TCI op-suite leg skips (that is the documented normal state, but
the claim was wrong).

### The AOT-cache probe: the ~19.5 % ceiling is unreachable, item 1
halved

The hand-off's discipline is *probe before building*, and item 1's two
probes were both page-side, so this round ran the AOT one to ground
(`tools/wasmclone-probe.mjs`, `tools/wasmcache-probe.mjs`, both kept;
synthetic modules shaped like a real batch — 2 imports, 69 declared
locals, ~2.5 KB — measured in Chromium and Firefox, fresh DB per run):

- **Neither engine persists a compiled module.** `put` of a
  `WebAssembly.Module` into IndexedDB throws `DataCloneError` in V8
  ("can not be serialized for storage") *and* SpiderMonkey. The
  spec's "structured clone preserves compiled code" holds only for
  the in-memory clone (1.5/0.9 µs — cheap, and useless: that is just
  not dropping the module).
- **Persisting bytes loses to recompiling.** At real module size,
  restore = getAll + `new Module(bytes)` + instantiate measured
  **56 µs/mod against 30–34 µs/mod for compiling fresh in the same
  isolate — 0.56–0.60× in V8 across two runs**; **0.90–0.91× in
  Firefox**. The getAll read
  (~18 µs/mod at ~150 MB/s) is half a cold compile by itself.
- **Writing costs more than the prize.** One transaction per put —
  what writing at every batch close means — is **0.13 ms (V8) / 0.39 ms
  (FF)**; ×34k modules = **4.4–13.3 s per boot**, against the whole
  2.82 s compile prize. A single bulk transaction is ~0.5–0.9 s of
  first-boot write.
- **The code-cache escape route is closed too.** V8's HTTP wasm code
  cache does not apply to Cache API responses:
  `compileStreaming(cache.match(...))` showed **no gen1→gen2 improvement
  in either engine**, and the streaming path itself is 12× slower than
  plain `new Module` in V8 (promise/Response machinery: 418 vs 34 µs).

Conclusion, recorded in the playbook's REJECTED table: **the AOT cache
is dead on the web platform** — not on its qemu-side merits. The
interpreter tier (~5.7 %) is the module pipeline's only remaining
route, and its probe question is now item 1's only open probe.

Two side findings: **SpiderMonkey compiles the same 2.5 KB module ~7×
slower than V8** (150 vs 20 µs) — the 83 µs/module economy is V8's and
the Firefox boot's pipeline share has never been measured; and a
hard-killed browser can leave an IndexedDB database **wedged** so every
new transaction on it hangs forever — the probes now use a fresh DB
name per run and attach transaction handlers before issuing the put
(the chained `txDone(db.transaction(...).put(...))` form crashed the
renderer on its first transaction after a wasm-heavy preamble;
handlers-first ran 500× clean).

### Two more items closed by inspection

**"A compile is 4–6× cheaper warm" (old item 2) is unreachable by
construction.**  The batcher is a *single global* `B` (`tcg/wasm64/
wasm64.c`): one batch is open at a time, it closes the moment its
opener executes (`close` == `specMiss`, round sixteen), and only then
may the next open.  A second pending compile therefore never exists —
there is nothing for warm-compile adjacency to batch with, except
compaction, which is already 0.13 s per boot.  Closed with nothing to
fix.

**The 0049-pattern audit (old item 8's tail) is clean.**  Every
`timer_mod` call site under `hw/arm/pmb887x/` was read for the
"deadline = next hardware tick" shape that made the GPTU a 100 kHz
storm: `capcom.c` and `stm.c` carry no QEMU timers at all (their cost
is register-access cost, priced in rounds 11–13/18); `tpu.c` re-arms
only when the deadline actually moved (0068's guard, `tpuRearm`
counter); `tpu2.c` — the SGOLD TPU — goes through `dyn_timer.c`, which
arms at min(next-unfired-IRQ-threshold, next-overflow), the
observable-events-only shape; `gptu.c` is 0049 itself; `sccu.c` is a
one-shot sleep timer plus calibration timers on fixed durations;
`rtc.c` arms on calendar events; and `timer.c`'s generic framework has
**zero callers** — dead legacy code, worth deleting next time anyone
touches the directory.  The pattern exists nowhere else; the ~2.5 %
clock/timer path stays parked as sized.

### Open at the end of round twenty

*Superseded by § Open items at the top of this file.*  Three items
closed this round — the op-suite hole (landed as 0090), the AOT cache
(probed and rejected in both engines), and the 0049-pattern audit
(clean by inspection) — plus one by inspection (warm-compile batching:
structurally impossible with a single open batch).  The module pipeline's interpreter tier (~5.7 %, with its own
probe question) is the last big target; the small items (CX70 device
write naming, the ke800 confirmation run) are unchanged.

## Update (2026-09-16, round nineteen: a module costs 83 us, and almost none of it is compiling)

Round eighteen left seven open items.  This round closed the cheap one by
inspection, then spent itself on the module pipeline, where a decomposition
that had never been taken turned an 11 %-of-wall line item into a number
with a mechanism behind it.  One small win landed; two candidates were
built, measured and rejected; and the thing the round actually produced is
a price list.

### `topoCommit` after 0083: there is nothing left there

Item 2 asked what still forces ~665 topology commits a second on an EL71
now that the EBU's readonly flips do not.  `WASM_DIAG_TOPO_COMMIT` counted
both commit paths together, which stopped being useful the moment 0083 gave
the cheap one all the traffic.  Split, over a 25 s EL71 boot:

| | per 25 s |
| --- | --- |
| `topoFull` (re-render every flat view) | **170** |
| `topoVar` (adopt a stashed variant, 0083) | 16 872 |

and a per-setter attribution mask says 122 of those 170 are
`memory_region_add_subregion` — device construction at startup.  Steady
state is ~7 full commits a second on a board that used to do 1135.  **The
item is closed with nothing to fix.**

### The module pipeline, decomposed

`MOD_NS` has been measured since 0082 and read ~14.6 % of EL71 boot wall,
but nobody had split it.  The EM_JS body had timed four sub-phases into
`__w64tR/M/I/A` all along — and those globals live in the vCPU worker,
which runs the guest without yielding, so no `evaluate()` had ever read
them.  Charged into `wasm_diag_stat` instead (the round-seventeen trick),
over a 25 s EL71 boot:

| phase | s | share of `modNs` |
| --- | --- | --- |
| `new WebAssembly.Module` | **2.82** | 77 % |
| `new WebAssembly.Instance` | 0.31 | 8.5 % |
| `addFunction` | 0.10 | 2.7 % |
| building the import object | **0.026** | 0.7 % |

The import loop — a `'f'+i` concatenation, a `BigInt`, a `wasmTable.get`
and a property add per import — is 0.7 % of instantiation, because a close
module has **2.1 imports**, not the twenty the code's shape suggests.  A
cached import namespace was built anyway and is recorded under REJECTED.

### 83 microseconds per module, and it does not depend on the module

Split again by assemble source, the two sources differ by 178x in count and
1.05x in bytes:

| source | modules | bytes | compile |
| --- | --- | --- | --- |
| first close | 33 969 | 88.2 MB | 2.849 s |
| compaction | 191 | 84.3 MB | 0.132 s |

Solving the two points gives **~80 us fixed per `new WebAssembly.Module`
call and ~1.4 ns/byte marginal** (722 MB/s).  An independent knob agrees:
`W64_SPEC_N` 8 / 32 / 128 moves bytes per close module 1880 / 2625 / 2903
and per-module compile time reads **83.6 / 82.7 / 83.3 us**.  Compile time
is `83 us x module count` and the size term is invisible.

That retro-explains three entries already in the REJECTED table.  Turning
compaction off halves the bytes compiled and buys nothing because
compaction is 0.13 s of 2.98 s.  `W64_SPEC_N` = 64 is a tie because at
83 us per module and ~13 us per translated TB, the trade is at par —
8 -> 32 saves 7414 modules (0.62 s) for 26 472 extra translations (0.34 s),
and 32 -> 128 saves 1463 (0.12 s) for 11 477 (0.15 s), which is where it
turns over.  **The knob is at its optimum and now it is known why.**

### Most of the 83 us is not compiling

The same shape compiled in the page costs ~21 us.  Everything about the
module was eliminated as the difference — size, the 69 locals every TB
function declares, control-flow density (160 `if/else` per module changed
nothing), the GC nudge, machine load (the page reads 23.5 us *while the
guest boots*), and the number of live modules (`W64_LIVE_MAX` 512 to
200 000: 81.5 / 84.4 / 78.5 / 77.5 us).

Then `W64_MODBENCH=<n>` compiled one real module's own bytes 200 times
back to back **inside the vCPU worker's own isolate**:

| | per compile |
| --- | --- |
| close #200 | 30.9 us |
| close #8000 | **12.0 us** |
| close #20000 | 16.9 us |
| the same module, once, in the normal flow | **83 us** |

The isolate is not slow.  A compile costs 12-31 us warm and 83 us when it
happens once every ~700 us with the caches full of guest code.  **Roughly
four fifths of the "compile" line is cold-cache cost**, paid per compile
event, which is why it tracks the count and ignores the bytes.

### What landed: the GC nudge is a Firefox workaround Chromium was paying for

0019 allocates 32 MB of garbage every 256 instantiations so SpiderMonkey's
GC sees pressure from dropped modules (module code is not GC pressure
there, and the worker never yields — without it Firefox OOMs against its
~16k executable-memory budget).  At the EL71 boot's ~1360 modules/s that is
~170 MB/s manufactured on purpose, and V8 needs none of it.  The nudge now
decides from the user agent.

It does **not** inflate compile time — that was the first hypothesis for
the 83 us and compile came back bit-identical with it off (2.8761 vs
2.8754 s).  It is simply its own cost: `modNs` per module 119.3 -> 111.6 us,
**0.27 s per 25 s of EL71 boot, ~1.1 % of wall**, and nothing else moves.

### And 0.6 % was sitting outside every timer

The four-way split did not sum to `MOD_NS`: ~14.5 us a module was
unaccounted for.  Timing the prologue found it — `w64_batch_instantiate`
was rebuilding a `DataView` and a `Float64Array` over the 2 GB shared
buffer on every call and copying the module bytes twice, because
`HEAPU8.slice()` already returns a `Uint8Array` and the `new Uint8Array()`
around it copied again.  **9.8 -> 5.3 us a module, 0.156 s per 25 s boot,
~0.62 % of wall** (0088), and `modPreNs` is stable to +-0.5 ms across runs
where `modCompileNs` swings 2.62-2.94 s.

The general point is the one worth keeping: **a decomposition that does
not add up is itself a finding.**  Four phases summing to 3.35 s inside a
3.71 s whole said there was a fifth, and it was 40 % as large as every
non-compile phase put together.

### Open at the end of round nineteen

*Superseded by § Open items at the top of this file — kept for the
reasoning, which is the part a later round needs.*

1. **The remaining module prize is ~5.7 % of EL71 boot** — halving module
   count would save 17k x 83 us = 1.43 s of 25 s — and it needs a design
   that lets a cold TB run *without* a module.  Module count is miss count
   (0080); speculation is at its budget optimum; observed edges do not
   predict (below).  That leaves running cold code interpreted and
   compiling only what repeats, which is a large change and needs the TCG
   op stream kept alongside the wasm.  Nothing smaller is left here.
2. **A compile is 4-6x cheaper warm.** Nothing today batches compile
   events except compaction, which is already nearly free.  If a second
   pending compile ever exists, doing it adjacent to the first is worth
   ~68 us.
3. Items 1, 3, 4 and 7 of round eighteen are untouched: the ke800 -2.1 %
   from 0083 still wants a longer run; CX70's ~103 ns device writes at
   56k/s still have no named device; `CAL_NS` should be used with the
   measurement build's instruments.
4. **Item 7 is answered, with a working range.** `W64_LDSTPAD=N` emits N
   fold-proof ALU units on every memop, so wall against N gives ns per
   wasm instruction on the hot path — a known cost rather than an empty
   interval.  Two designs folded before one survived (see lessons), and
   the instrument then turned out to have a limit of its own:

   | N | wall (3 runs, el71 100M-1400M) | modules |
   | --- | --- | --- |
   | 0 | 28.70 s | 34 363 |
   | 4 | 30.25 s (+1.55) | 34 178 |
   | 12 | 38.25 s (+9.55) | 42 919, 3 `tb_flush` |

   At N=4 it is clean: **18 added wasm instructions per memop cost
   2.51 ns/memop**, 1.55 s of a 28.70 s window — so the inline TLB probe's
   ~19 instructions are **roughly 5 % of EL71 wall**, and shaving three of
   them is worth under 1 %.  At N=12 the pad has grown the emitted code
   enough to add **8556 modules** (+0.71 s by itself) and the slope means
   nothing.  **Adding code to a hot path costs module count**, which after
   this round is the expensive axis — so measure `mods`, not just wall, on
   any codegen change.
5. **Does Firefox still need the GC nudge?**  0087 keeps it there and takes
   it off Chromium, but the gate can no longer reproduce the OOM it exists
   for: a 202 s Firefox run with `W64_GCNUDGE=0` reached 2.73 G insns and
   40 152 modules created, `errors=0`.  Since 0053 `temp` is 0 and creation
   plateaus at ~37k once the guest idles.  The original report was *mobile*
   Firefox on a Pixel, so it stays until someone retests there.

## Update (2026-09-15, round eighteen: the 80 % had one name on it; 0083-0084)

Round seventeen closed four candidates and left one question: the pipeline
is 19.5 % of the boot, so **what is the other 80 %?**  It is, to a first
approximation, one thing — and it was never a CPU-emulation problem at all.

### MMIO stores, and only stores

The chain, each step a counter rather than a guess:

1. **Guest memory ops were entirely uncounted.**  `W64_LDSTCOUNT=2` emits a
   bump into the generated code itself.  EL71 does **0.476 memops per guest
   instruction**, CX70 0.329, and **3.38 % / 1.83 % of them miss the inline
   TLB probe**.
2. **The misses are MMIO, not TLB pressure.**  Decomposing `mmu_lookup1`:
   92.5 % (EL71) / 96.8 % (CX70) of probe misses are MMIO.  `slowClean` —
   the probe rejecting something it could have served — is **0**.  The
   inline probe is not the problem.
3. **MMIO per instruction tracks the board speed gap exactly.**  14 357 vs
   5 602 per Mi, a 2.56x ratio, against a 2.66x MIPS ratio.  This *inverts*
   round seventeen's "MMIO is not the cost", which compared `ioLd` alone on
   an unmatched window and so missed that EL71 is store-heavy.
4. **Loads are already free; stores are not.**  Timing the device callback
   itself: **3.6 ns for a read, 330 ns for a write** on EL71.  Rounds 11-13
   did their job on the read path.
5. **68 % of the write time was the EBU**, found by histogramming the
   duration-weighted samples on `full->phys_addr`.  17.4k EBU writes/s at
   **7.7 us each = 13 % of EL71's wall**.
6. **100 % of the EBU remaps were readonly flips.**  Size, base and enable
   moved 14, 10 and 14 times in an entire boot; `readonly` flipped 41 358.

The fix is 0083 and it is small: a readonly change alters the rendered
`FlatRange`, not the region tree, so it is a flat-view *variant* in exactly
the sense romd mode already is.  Fold the readonly set into the stash
signature and stop bumping `topo_gen`.  The EBU's open-flash/close-flash
toggle is then A-B-A and hits the stash.

**Boot window, fixed guest work: el71 +55.6 %, cx70 +31.5 %, s75 +15.1 %.**

### What this round says about method

- **Normalize before you compare.**  Round seventeen's per-*second* helper
  rates hid a 2.6x per-*TB* difference, and its `ioLd`-only comparison
  pointed the opposite way from `ioLd + ioSt` on matched windows.  Per-Mi,
  on the same guest work, or not at all.
- **Calibrate a timer before believing it.**  The browser clock is
  quantized to 1 ms, so a timed interval is a straddle-probability
  estimate — unbiased, but with a **floor of ~66-75 ns** that is just the
  two clock reads.  Before that floor was measured (`CAL_NS`, an empty
  interval sampled the same way) this round "found" a 94 ns BQL acquire and
  a 26 % MMIO share.  Both dissolved: the BQL is ~16 ns and the A/B of a
  change to it was 1 win in 3.  *Subtract the floor, and time the innermost
  thing you can reach* — `DEV_W_NS` around the callback needed no model at
  all, and it was the number that held up.
- **Pick the window the mechanism lives in.**  The first A/B ran 2000-8000
  Mi and read a tie, because the EBU toggling is a boot-phase behaviour.
  The same patch is +55.6 % over 100-1400 Mi.  A tie is evidence about the
  window, not only about the patch.

### Then the lookup helper, which is what the 80 % mostly is

With MMIO closed, EL71's budget was re-taken on the same instrument.  The
pipeline is now 3.7 % of wall and MMIO 3.8 %; `tlbFill` fell 33.8k/s ->
4.6k/s all by itself, because the topology commits had been flushing the
TLB.  What is left, timed directly and with the `CAL_NS` floor removed:

| | rate | ns each | share of wall |
|---|---|---|---|
| `helper_lookup_tb_ptr_lc` | 811k/s | **102** | **8.3 %** |
| `arm_rebuild_hflags` | 809k/s | 32.6 | 2.6 % |
| module compile (`modNs`) | | | 2.5 % |
| MMIO store callback | 671k/s | 42 | 2.8 % |
| `tb_gen_code` | 641/s | | 1.2 % |

The 102 ns is confirmed independently: `W64_LC_VERIFY` routes *every*
goto_ptr exit through the helper, and the delta between that build and
the normal one is 9.1 ms per Mi over 81 334 extra calls — **112 ns a
call**, from a completely different arithmetic.  Two methods, one number.

Verify mode also gives the hit rate free: the inline cache **hits 84.0 %**
and `LC_VBAD` is 0, so the inline test is correct and the misses are real.
0084 attacks the miss *cost* (the qht fall-through); the miss *count* is
still open, and `W64_LC2` — a software ceiling probe that simulates a
second way — says a 2-way cache would catch **42.3 % of el71 misses and
34.2 % of cx70's**, worth roughly 3 % of wall for a generated-code change
plus 32 bytes per TB.  Measured, not built.

### Open at the end of round eighteen

*Superseded by § Open items at the top of this file — kept for the
reasoning, which is the part a later round needs.*

1. **ke800 saw -2.1 %** (2 pairs, within noise) — the LG board does not
   toggle EBU readonly.  Worth a longer run to confirm it is a wash.
2. **`topoCommit` is still 665/s** on EL71 after the fix, and the counter
   does not separate a full rebuild from a variant adoption.  Split it, and
   see what the remainder is — `romdFlip` is only 305/s.
3. **CX70's device *writes* cost 645 ns each**, twice EL71's 330 ns, on
   only 56k/s.  Nobody has looked at which device that is.
4. The measurement build now has `W64_LDSTCOUNT`, `DEV_R_NS`/`DEV_W_NS`,
   `CAL_NS`, the `SLOWW_*` phys_addr histogram, `HFLAGS_NS`/`LC_NS` and
   the `W64_LC2` two-way ceiling probe.  **Use `CAL_NS`.**
5. ~~The 2-way inline cache is measured and unbuilt~~ — **built and
   reverted, see § REJECTED.**  It does exactly what the probe said
   (`lcCall` -39 % per Mi) and buys nothing: el71 0.0 %, cx70 -0.2 %,
   A/B'd within one binary.  The second way's compare chain runs on
   every remaining miss and emitted code grew 20.6 %.  **The ceiling
   probe measured the benefit and was silent on the cost** — it
   simulated the hit rate, not the work added to the path that still
   misses.  That is the generalizable bit.
6. ~~`arm_rebuild_hflags` runs 809k/s~~ — **closed by 0085**: it was
   `cpsr_write()` rebuilding whenever the write *mask* covered M/E/IL,
   which `msr cpsr_c` always does.  873k/s -> 317k/s; cx70 +1.0 %, el71
   a tie.  The ten minutes were worth it; the *wall* win was not what
   the timer promised, which is item 7.
7. **The phase timer over-attributes short functions.**  It put hflags
   at 3.8 % of wall and the patch delivered ~1 %.  `CAL_NS` removes the
   floor but not whatever else inflates a sub-50 ns interval.  Trust the
   *call-count* reduction and the A/B; treat a sub-50 ns per-call figure
   as an upper bound.  A good next instrument would calibrate against a
   known-cost function (a volatile spin of N iterations) rather than
   against an empty interval.

## Update (2026-09-15, round seventeen: what the pipeline actually costs)

Round sixteen took the profiler away.  This round builds the replacement
for the one question the profiler was still being trusted on — *where
does the boot's time go* — and the first answer retires a belief this
document has repeated since round nine.

### The translate-and-compile pipeline is 19.5 %, not "the boot"

`tools/modcost.mjs` times the two halves directly: `tb_gen_code` in C
(behind `WASM_DIAG_TIME_PHASES`, a measurement build) and the browser's
`WebAssembly.Module` + `Instance` per batch (`modNs`, always on — ~1k
modules/s at boot makes two clock reads noise).  EL71, `dist-jit`:

| window | insns | compile | translate | **pipeline** |
|---|---|---|---|---|
| 0–12 s | 285 M | 10.04 % | 9.45 % | **19.49 %** |
| 12–27 s | 396 M | 10.06 % | 7.98 % | **18.04 %** |
| 30–45 s | 559 M | 5.28 % | 2.77 % | **8.05 %** |

So **the early boot is not compile-bound.**  That claim traces back to
the profiler and should not be repeated.  Compile alone never exceeds
~10 %, and the whole pipeline peaks under a fifth of wall time.

**This is also the ceiling on tiering**, which is why it was worth
measuring before building: running first executions on TCI can only ever
win back part of the compile slice, while adding interpretation cost on
cold TBs and re-translation on hot ones.  Roughly 10 % gross, at the
densest part of the boot, for a change that needs a second execution
tier and doubles the lockstep gate's surface.  *Price the prize before
building the machine.*

### What the other 80 % is, is still unknown

EL71 boots (0 → 1000 Mi) at **27.8 MIPS** and runs warm at **73.6 MIPS**,
while deleting the pipeline entirely would buy only 1.24x.  **Do not read
that 2.65x as overhead**: the two windows run *different guest code*, and
boot code does more per instruction (flash, MMIO, device setup) than the
idle loop does.  The honest statement is narrower — the pipeline is 19.5 %
of boot wall, so ~80 % is execution and devices, and **that 80 % has never
been priced by anything but wprof2.**

**This is now the top open item.**  The method is the one above: a
`get_clock_realtime()` pair around a phase, charged in C, read through
`_wasm_memstat`; sample 1-in-N for anything hotter than a few thousand
calls a second.  Start with MMIO dispatch and `tlb_fill_align`, whose
rates are already known.  To separate "boot code is expensive" from "cold
state is expensive", price the *same* guest window twice — the counters
are per-Mi and comparable; MIPS across different code is not.

### Four directions measured and closed

With the hot counters on and phase timers around `tb_gen_code`,
`tlb_fill_align` and the batch instantiate, the EL71 boot accounts for
**20.9 %** of its wall — compile 10.85, translate 7.25, TLB fill 2.79 —
and CX70 for 12.6 %.  Against that, four candidates died:

- **MMIO is not the cost.**  CX70 does **100x** the MMIO per Mi that EL71
  does (`ioLd` 26 478 vs 836 per Mi) and boots **3x faster**.  `hflags`
  likewise: 4x more on the fast board.  Stop looking at device rates.
- **TLB fills cost ~520 ns each** and 2.8 % of EL71 wall (1.2 % CX70),
  even at EL71's 8x-higher 2071 per Mi.
- **The inline cache's global generation is not what's missing it.**
  Ceiling probe `W64_NOGENBUMP=1` (unsound: stops retiring slots
  entirely) cut helper calls only **17 %**, 14 644 -> 12 112 per Mi, with
  MIPS unmoved.  The misses are genuinely megamorphic return sites, as
  the 0047 note guessed.  ~1 % of wall; not worth a sound scheme.
- **TB length is not board-specific.**  Mean guest insns per TB is
  **3.79 / 3.79 / 3.80 / 4.66** (el71/cx70/s75/ke800).  All four
  firmwares are equally branchy; EL71's slowness is not shorter blocks.

### The question for round eighteen

EL71 executes **7.1M TB/s**, CX70 **23.6M TB/s** — 141 ns vs 42 ns for a
block of the *same* 3.8 instructions, with EL71 making *fewer* helper
calls per second (389 k vs 499 k) and doing *less* MMIO.  Nothing
counted explains a 3.3x.  So the cost is inside the generated code for
the instructions themselves — a guest-code-mix or codegen-quality
question, and the first one this project has faced without a profiler.

Ideas, cheapest first: count guest memory ops (the softmmu fast path is
entirely uncounted, and a load/store-heavy mix would explain it); compare
the two boards' `W64_TBLOG` opcode histograms; sample-time the helper
1-in-16 rather than every call.

### An instrument was quietly reading the wrong counters

`diagall.mjs`'s hand-written name list still carried `specRet` from a
rejected experiment, so everything after it was off by one and
`hflagsCalls`/`lookupConfl` were reported as their neighbours.  Both
tools now import `tools/diagnames.mjs`, which parses the enum out of
`wasm-diag.h`.  `counters.mjs` was correct, so round sixteen's
conclusions stand.  **Never transcribe the enum.**

## Update (2026-09-15, round sixteen: 0080–0081 — the round the profile lost its credibility)

No throughput patch landed.  What landed is **instrumentation and two
retired beliefs**, and the second of those is worth more than a patch:
every profile-driven decision in this project rested on a measurement
that is wrong by two orders of magnitude.

### Round fifteen, re-priced on a quiet host

The CX70 numbers were re-taken at load 2.9–4.3 (the originals spanned
2.8–5.8):

| | pre-round `r15` | tip | |
|---|---|---|---|
| fixed-work MIPS | 113.20 | 126.57 | **+11.8 %**, 3/3, guest work identical to 0.217 % |
| **idle v/wall** | **2.58** | **4.28** | **+66 %** |
| idle halts/s | 676 | 1322 | |

Take **+11.8 %** as the throughput number (the +14 % sum of three
separately-measured steps overstated it, as such sums do).  Re-confirmed
end to end after 0080/0081 at **+8.6 %, 3/3** (load 4.9–6.4, and the one
low run was the first, while the load was still falling) — so the
instrumentation and the key-path guard cost nothing measurable.  But the
throughput number is the *small* half.  `tools/haltprobe.mjs` shows the
DIF/DMAC timer storm was not merely costing cycles, it was **keeping the
vCPU awake**: the idle screen now warps instead of spinning, which is
+66 % on the thing a user actually sits in front of.  **On any board that
does not halt, run `haltprobe` next to `workbench` — throughput alone
under-reports a change that lets the guest sleep.**

The same probe closed the round-fifteen question: `interrupt_request` is
**0 for 99.2 %** of an idle CX70, so nothing is holding a line asserted
and `arm_cpu_has_work()` is honest.  There is no emulation bug there; the
board is awake because the firmware is, at about a 30 % duty cycle.

### The profile names the wrong function

A fresh CX70 profile put **11.0 %** of the vCPU in `arm_rebuild_hflags`,
its largest single entry — apparently contradicting round fifteen's
rejection of the `cpsr_write` hflags skip.  It took four steps to settle,
and the method is the reusable part:

1. **Count it.** A new unconditional counter at that function's entry
   (`hflagsCalls`) reads **11,606 calls/s**.  11.0 % of a 30 s profile
   over 348k calls is **9.5 µs per call**, for a function priced at
   ~76 ns.
2. **Probe the cost.** Re-running its body 2000 extra times per call
   measured **+3.7 % faster** — which reads exactly like "this function
   is free", and was a lie: the compiler had hoisted the duplicate calls.
3. **Prove the knob arrived.** A 10,000-iteration *volatile* loop (which
   cannot be hoisted or elided) took the board from **113 MIPS to 0.7**.
   So the counter, the knob and the call rate all agree.
4. **Profile the probe.** With all the work provably inside
   `arm_rebuild_hflags`, calling nothing, the profiler reported
   `rebuild_hflags_a32` **67.3 %**, `arm_rebuild_hflags` 20.3 %,
   `arm_security_space` 9.5 %, `cpsr_write` 1.0 %.

**A name in a wprof2 profile identifies a neighbourhood, not a
function.**  Round fifteen's A/B was right and its profile was not; its
lesson ("a self-time share is an upper bound, not a budget") was too
generous — it is not a bound at all.  Frames under `wasm://wasm/<hash>`
are JIT'd guest TBs symbolised through the *main* module's map, which is
why `machine_parse_smp_config` and `target_s390x` appear as hot functions
in an ARM phone emulator; their sum (~59 % of the vCPU) means something,
their names do not.

Use `tools/counters.mjs` (new: every unconditional counter as a rate, per
board) to find work, and a volatile-spin probe to price it.
`tools/modcost.mjs` (round seventeen) prices the translate-and-compile
pipeline directly off wall-clock timers rather than sampling — the
browser's own `WebAssembly.Module`/`Instance` cost, and (in a
`WASM_DIAG_TIME_PHASES` build) `tb_gen_code` beside it.

Counter names now come from `tools/diagnames.mjs`, which parses
`wasm-diag.h`: the transcribed list in `diagall.mjs` had kept a
`specRet` entry from a rejected experiment and was reporting
`hflagsCalls` and `lookupConfl` one index off.  Never transcribe the
enum — a counter that is quietly reading its neighbour looks exactly
like a result.

### The EL71 key lag has a floor, and speculation is below it

Return-address speculation — translate each walked TB's fall-through,
which is the return point of a `bl` and of an indirect `blx rN`, neither
of which the frontend records — is in § REJECTED with its numbers.  The
counters it needed established the shape of the problem permanently:

> **Module count is miss count.**  On an EL71 boot window, `closeN`
> (34922) equals `specMiss` (34922) *exactly*, with zero throwaway temp
> modules.  A batch is opened by a lookup miss and closed the moment that
> miss's TB executes.

So no amount of extra speculation can lower the module count; only
speculating what the guest misses on *next* can.  Fall-throughs are that
on an interactive path (press 2: modules 456 → 339, **−26 %**) but not
during boot, where the wall time is — there the goto_tb graph already
yields 5.3 TBs per module, and the patch bought **+15 % translation for
nothing**.  Measure `specMiss`, never `tbGen`.  **Tiering** (first
executions on TCI, compile once a batch fills or the TB is hot) remains
the only direction that breaks this floor, because it is the only one
that decouples "the guest needs this TB now" from "compile a module now".

### Also found

- The ARM `ldr pc, [pc, #-4]` trampoline heuristic in `w64_speculate()`
  has **never run**: `arm_cpu_realizefn` sets `CF_PCREL` on every
  system-mode TB and the branch is guarded on `!CF_PCREL`.  It was born
  inert (both guards landed in one commit).  `CF_PCREL` also means
  `tb_gen_code` never writes `tb->pc`, so anything in `accel/tcg` wanting
  a TB's guest pc must carry it alongside.  Enabling it is a behaviour
  change with a known crash mode (the KE800 Prefetch_Abort) and wants its
  own measurement.
- The CX70's device layer is now **clean**: no counter shows a storm.
  Per million guest instructions at idle — `tpuRamW` 898–1349,
  `lookup` 715–980, `tpuRearm` 81, `dmacBurst` 51 (was 84,481/s before
  round fifteen), `tpuTimer` 46.  The remaining cost is general
  emulation, not a peripheral.
- Every qht lookup on an idle CX70 is a **capacity** miss
  (`lookupConfl` == `lookupQht`, `jcFlush` = 0 there).  At 90 per million
  instructions a bigger jump cache is not worth it; during EL71 boot it
  is ~0.9 %.

### 0081: a key event before the display exists killed the module

The browser gate failed every board on every dist for an afternoon,
including builds that had passed hours earlier, with `RuntimeError:
memory access out of bounds`.  The host was simultaneously at 62 GB used
and 23 GB of swap, so it was written off as memory pressure and bisected
against the pre-change revision, where it reproduced — which fitted.
**It was a crash, and the bisect "fitting" is exactly what made it easy
to dismiss: the bug was older than either revision.**

What settled it was refusing to accept the hypothesis without the stack:

```
HTMLButtonElement.release (app.js) → sendKey → _wasm_send_key
  → wasm-function[24049]:0x80ddb6 → memory access out of bounds
```

`--emit-symbol-map` resolves those frames exactly — 12112 is
`wasm_send_key`, 24049 is `qemu_bh_schedule` (which also sharpens the
profiler finding above: the *map* is fine, it is the sampler's
address→index resolution that is not).  Disassembling 0x80ddb6 named the
faulting instruction: an `i64.load 184` on `bh->ctx`, immediately after
an `i32.atomic.rmw.or 40` on `bh->flags` that had **not** faulted.  That
pair is the signature of `bh == NULL`: offset 40 is a valid wasm address
so the atomic quietly succeeds, `bh->ctx` then reads address 0, and the
list insert at garbage+184 leaves the 2 GB memory.

`wasm_send_key()` is exported the moment the module instantiates;
`wasm_display_init()` creates `key_bh` much later; and the page's keypad
is live from its first render.  A pointer resting where a key lands —
which is precisely what a stationary Playwright pointer does when the
keypad re-renders after Start — sends a release into a machine that does
not exist yet.  A real user hits it by touching a key during the boot.

The fix publishes a readiness flag with a release store and drops events
taken before it.  `tools/earlykey.mjs` is the regression test (fires a
key at the first instant the export exists, then checks the guest still
runs and still takes keys): PASS on all four boards, FAIL on the build
before.  The page also no longer sends a release for a key that was
never pressed — `pointerleave` fires on a button the pointer merely
moved over, or one that rendered underneath it.

**The CX70 went from trapping at 203M instructions to 13442M with 2443
framebuffer updates, its best boot recorded here.**

### Gates

All green after 0081: **native op-suite 1156/1156 on both backends with
byte-identical serial**, **native JIT-vs-TCI lockstep 3/3 clean at
2.5 G**, **native suite 4/4**, **browser bootcheck 4/4**, and
**earlykey 4/4**.

One real caveat remains, and it is the host: `/proc/loadavg` and `free`
in this container are the *host's*, co-tenants are invisible, and it sat
at 62–64 GB used with 23 GB swapped.  Native `boot-init` is a wall-clock
liveness threshold (10M insns in the first 15 s) and under that load it
fails on a rotating board — S75 and KE800 in one run, C81 in the next,
none in the one after.  That one *is* host variance; `boot-progress` and
`no-exit` never wavered.  Do not read a single `boot-init` failure as a
regression, and do not read a hard wasm trap as host pressure.

### Open at the end of round sixteen

*Superseded by § Open items at the top of this file — kept for the
reasoning, which is the part a later round needs.*

> **Round seventeen closed 1, 2, 3 and 4 of these.**  Tiering (1) is
> capped at the ~10 % compile slice and is not being built.  The
> trampoline heuristic (2) fires on one node in 35 k and is deleted.
> The generic path (3) is now priced by phase timers, not a profile.
> `do_ld4_mmu` (4) is answered by the hot-counter build: MMIO is 23 k/s
> on EL71, and CX70 does 100x more per Mi while booting 3x faster.  See
> the round-seventeen section at the top for what replaced them.

1. **Tiering is the only way past the module floor.**  Module count is
   miss count; nothing that speculates harder can beat it.  Run a TB's
   first executions on TCI and compile once a batch has filled or the TB
   is hot, so "the guest needs this TB now" stops meaning "compile a
   module now".  It is a large change and it is the one that would
   answer the EL71 key lag.  Measure `specMiss` and `closeN`.

2. **The `w64_speculate` trampoline heuristic has never run.**  Guarded
   on `!CF_PCREL`, which is set on every system-mode ARM TB.  `qpc`-style
   pc tracking is what it needs (`tb->pc` is unwritten under CF_PCREL).
   Enabling it is a behaviour change with a known crash mode (the KE800
   Prefetch_Abort that shaped its `!(target & 3)` guard), so it wants its
   own A/B and its own bootcheck — but it is free to try.

3. **Nothing has re-profiled since the profiler was discredited.**  Every
   "where does the time go" statement older than this round rests on
   wprof2 self-time.  The reliable pair is now `tools/counters.mjs` for
   rates and a volatile-spin probe for cost.  The CX70's device layer is
   clean by counters; the *generic* emulation path (lookups, MMIO
   dispatch, TB execution) has never been priced by anything but the
   profile.  Start there, and price before optimising.

4. **`do_ld4_mmu` is the obvious next candidate and is unverified.**  The
   profile put it at 10.2 % — a number now worth nothing on its own.  It
   cannot be doubled safely (MMIO reads have side effects), so it needs a
   different probe: count MMIO loads with a `WASM_DIAG_HOT_COUNTERS`
   build (rates only, never a wall A/B) and price one dispatch, or probe
   only the non-MMIO tail, which is idempotent.

5. **The host is still not fully measurable.**  62–64 GB used, 23 GB
   swapped, co-tenants invisible.  Native `boot-init` fails on a rotating
   board under that load and means nothing by itself.  But note what this
   round proved: **a hard wasm trap is never host pressure**, and a
   bisect that "fits" can fit because the bug predates both revisions.

## Update (2026-09-15, round fifteen: 0078–0079 — SGOLD, and the v1 that never caught up)

This round starts from a new board.  The user added a **CX70 fullflash**
(`fullflashes/CX70_FW56_clean.bin`) and reported SGOLD as terrible;
every earlier round measured SGOLD2 (S75/EL71) or the LG.  It is the
"board you measure is the board you fix" lesson again, and the answer
was sitting in the tree: **`hw/arm/pmb887x/dif_v1.c` never got the work
`dif_v2.c` got.**

**How SGOLD differs, in one table.**  Same firmware job, same host:

| | S75 idle (dif_v2) | CX70 idle (dif_v1) |
|---|---|---|
| v/wall | 58.7 | 1.07 |
| halts/s | 27091 | 64 |
| dmacBurst/s | 11660 | 84481 |
| DMAC timer arms/s | 99 | ~72000 |

The S75 idles by halting: the vCPU sleeps, the virtual clock warps, and
the idle screen is nearly free.  **The CX70 never halts** — it burns
~116 MIPS of real guest work to achieve 1.07× real time, so on a host
five times slower than this desktop it is far below real time.  That is
what "terrible" is.  The last row is the tell: two boards doing the same
display work, three orders of magnitude apart in timer traffic.

**What was wrong.**  A profile put ~17 % of the CX70's vCPU in the
DIF/DMAC/SSI chain.  Three pieces, all of which v2 had already fixed:

- `dif_mux()` looped over `p->bits` (16) with two divisions and two
  modulos *per output bit*, once per transferred word.  v2 uses a 4×256
  byte-lane table rebuilt only when its inputs change.  **+3.1 %**
- `dif_trigger_dma()` drove both DMA request lines on every
  `srb_set_isr`/`set_icr` — ~4 times per word — though the level almost
  never changes.  The DMAC drops the repeat, but one indirect call and
  two wrappers later.  v2 filters at source.  **+3.0 %**
- Every word went through `timer_mod(transfer_timer, 0)` and its
  callback.  The deadline is *zero*, so the timer bought nothing but a
  list removal, a sorted insert and a dispatch — and because the DIF's
  `breq` then reached the DMAC from outside the DMAC's own run loop, the
  DMAC's `in_run` guard never applied and it armed its timer per burst
  too.  v2 has never called `timer_mod` at all.  **+7.3 %**

Together **+14 %** on a CX70, measured as wall time for a fixed 8 G guest
instructions, every step winning every interleaved pair.

**Re-measured on a quiet host** (load 2.9–4.3, where the step numbers
above were taken between load 2.8 and 5.8): pre-round `dist-jit-r15`
113.20 MIPS, tip 126.57 — **+11.8 %, 3/3 wins**, virtual time at the
milestone spanning 0.217 % across all six runs.  Take +11.8 % as the
round's number; the +14 % sum of the three steps overstates it slightly,
as sums of separately-measured steps do.

**The meter had to be built first.**  `uibench --state idle` cannot
resolve this board: the SGOLD idle screen animates and the GSM stack
cycles through network-search phases, so idle MIPS swings ~15 % between
runs of *one* build.  `tools/workbench.mjs` times the stretch between
two instruction milestones instead.  Under icount the guest is a
deterministic function of its instruction count — the same property the
lockstep gate rests on — so that stretch is identical in every run of
every build that does not change guest-visible behaviour, and the wall
time across it is pure host speed.  Spread: **0.9 %**.  It prints the
virtual time at each milestone as the check that the assumption held,
and it prints guest-event counters (`lookup`, `jcFlush`, `tlbFlush`,
`fill`, `tbGen`) which are load-independent.

It is the right meter only for a board that does not halt.  On the S75,
where the same window is mostly halted and wall time is wake latency, it
read 41.3 then 31.1 MIPS for one build — use `uibench` idle there.

**A regression the meters could not see.**  The synchronous conversion
booted, rendered and menu-navigated correctly through several hundred
runs at `rt=off` — which is what every meter here uses — and **stalled
the CX70 at 140M instructions under the shipping `rt=banked`**.  Only
`tools/bootcheck.mjs`, which uses the page default, caught it.  The cap
changes when the vCPU sleeps and so changes the vCPU/main-loop
interleaving, which is exactly what a device that has stopped deferring
its work is sensitive to.  The fix keeps the timer as a backstop and
arms it in one place: when the loop exits still holding a popped word.
That is not the old per-word arm — a word is only held when the TX FIFO
had a second one ready, and the DMAC feeds one word at a time, so on the
display path the FIFO is empty there and the timer is never armed.
Under `rt=banked`, 200 s: **9563M -> 11153M instructions**.

**Correctness.**  The mux table was compared against the loop it replaces
over 4.6M random configurations across every bits width, corner values
included, with no disagreement.  For the whole display path the check
is a value-level lockstep of this board between a native build of the
*old* code and one of the *new* (`tools/lockstep.mjs --a-bin/--b-bin`,
any `--flash`): clean over **5.02G instructions — 4784 epochs plus 598
memory digests identical, serial identical**.  That is the check that
decides, and it is minutes of work.  Screenshots at a fixed instruction
count also matched, but do not rely on them: the milestone is only as
precise as the poll that finds it, and shooting the *same* build twice
on a CX70 already gives two different images.  Menu navigation renders
correctly, which is what drives the path hardest.

### Tried, verified, and not kept

Both are in § REJECTED with their numbers; neither shipped.

- **`cpsr_write` hflags skip.**  The rebuild is chosen from the
  instruction's field mask, not from what changed, and the common
  "msr cpsr_c" for interrupt masking carries `CPSR_M` while writing the
  mode back unchanged.  Skipping when no bit hflags reads actually
  changed removes **93.7 %** of the rebuilds `cpsr_write` asks for on a
  CX70 (90 % of all of them) and 52 % on an S75, and a
  `CPSR_HFLAGS_SKIP_VERIFY` build — take the skip, rebuild anyway,
  compare — found **zero** disagreements over 74.8M skips.  It measured
  **+0.6 %, 2/6 pairwise**.  The useful part is the negative result:
  after 0071 the hflags fast path is close to free, so
  `arm_rebuild_hflags`'s **3.3 % profile self-time is not 3.3 % of
  recoverable work**.  For a small leaf function, self-time is an upper
  bound, not a budget.
- **`dacr_write` value guard.**  `dacr_write()` flushes the whole TLB
  unconditionally where `fcse_write()` and `contextidr_write()` beside
  it both guard on the value changing, and a full TLB flush also drops
  the jump cache — which on wasm retires every TB's inline next-TB
  cache.  Over an identical 5.1G-instruction window it changed
  **nothing**: `tlbFlush` 15636 → 15635.  This firmware does not write
  DACR idempotently.

### Open at the end of this round

*Superseded by § Open items at the top of this file — kept for the
reasoning, which is the part a later round needs.*

1. **The EL71 key-press lag the user reported is wasm module
   compilation, not slowness.**  `tools/keylag.mjs` measures it.  Per
   press there is **no** `tb_flush` and **no** module re-creation — the
   emulator is not redoing translation it already had — but on the later
   presses `mods` tracks `tbs` essentially **one to one** (441 TBs / 440
   modules, 296/297, 286/283).  Each newly reached TB is paying its own
   synchronous `WebAssembly.Module` compile, a few hundred per press.
   Rough slope across presses: **~0.2-0.3 ms per module** (on a loaded
   host), i.e. most of a 100-250 ms response.

   The cause is the batching policy.  `w64_batch_close_pending()`
   assembles the open batch the moment any staged member first runs, so
   a batch is only large if many TBs were translated before any of them
   executed — which is exactly what the speculative successor BFS
   (`w64_speculate`, `W64_SPEC_N`, default 32) provides during boot.  On
   a newly reached interactive path the successors are not known yet:
   with `W64_SPEC_N=0` the ratio is exactly 1:1 (914 TBs / 917 modules,
   233/233, 2/2), and on the later presses the default is already
   indistinguishable from that.  Press 1 still got 12:1, so speculation
   works when there is something to follow.

   **Return-address speculation was tried and rejected** (2026-09-15,
   § playbook REJECTED).  The instrumentation it needed — `specMiss`,
   `specNosucc`, `specExists`, `specNotram`, `specMade`, indices 80-84 —
   is kept, and it settled the shape of the problem for good:

   > **Module count is miss count.**  On an EL71 boot window,
   > `close` = 34922 and `specMiss` = 34922 *exactly*, with `temp` = 0.
   > A batch is opened by a lookup miss and closed the moment that
   > miss's TB executes, so no amount of extra speculation can lower the
   > module count — only speculating the TBs the guest will *miss on
   > next* can.  Measure `specMiss`, never `tbGen`.

   Fall-throughs are those TBs on an interactive path (press 2: modules
   456 → 339, −26 %) but not during boot, where the wall time is: there
   the goto_tb graph already yields 5.3 TBs per module, and the change
   bought +15 % translation for no module reduction and no measurable
   time.  **Tiering** — run a TB's first executions on TCI and compile
   once a batch has filled or the TB is hot — is still the real answer
   and still a large change; it is the one direction that breaks the
   module-count = miss-count floor, because it decouples "the guest
   needs this TB now" from "compile a module now".

2. **The inline next-TB cache hits 85.1 %, so it is not the problem it
   looked like.**  `lcFill` 248,137,662 against `lcCall` 248,153,578 is
   a 99.994 % *fill-per-miss* rate, which reads like thrashing, but the
   hit rate is what matters and the existing runtime knob measures it:
   over one CX70 window, `lookup` is 56.8M normally and **380.2M** with
   `W64_NOLC=1`, so 85.1 % of `goto_ptr` exits never call the helper.
   That matches the 84 % the translator comment records.  A second cache
   way would tax the 85 % to help the 15 %, which is why the earlier
   attempt at a wider inline test measured *slower*.  Of the 56.8M
   misses the jump cache serves 83 % and the qht 17 %.

3. **The CX70's wakefulness is not a stuck interrupt line — answered.**
   `tools/haltprobe.mjs` (1.95M samples over 20 s at the idle screen)
   reads `cs->interrupt_request == 0` **99.2 %** of the time, so
   `arm_cpu_has_work()` is false and the vCPU is free to halt whenever
   the firmware asks.  There is no emulation bug to find here; the board
   is awake because the firmware is awake, and the only lever is raw
   speed.

   The same probe re-priced round fifteen, and much higher than the
   throughput number did.  At the settled idle screen:

   | | pre-round `r15` | tip |
   |---|---|---|
   | v/wall | 2.58 | **4.28** |
   | halts/s | 676 | **1322** |
   | MIPS | 132.3 | 160.9 |

   **+66 % on idle v/wall** — the DIF/DMAC timer storm was not just
   costing throughput, it was keeping the vCPU awake.  At 30 % duty
   cycle the CX70 now idles like a phone rather than a spin loop.  Use
   `haltprobe` alongside `workbench` on any board that does not halt:
   throughput alone under-reports a change that lets the guest sleep.

4. **The host stopped being measurable half way through.**  Load average
   went 3 → 55 and stayed; this is a container, `/proc/loadavg` is the
   *host's*, and the other tenants are invisible.  A CX70 run that
   normally takes 75 s did not reach its milestone in 800 s.  Anything
   re-measured from here should check the `load=` field the tools print
   and be re-run above ~10.  Guest-event counters stay valid at any load
   (§ lessons).


## Earlier rounds (0042–0076) — ledger

The blow-by-blow for these rounds was removed on 2026-09-16: the durable
parts are the playbook's **What landed** (per-patch mechanism + numbers)
and **REJECTED** (per-experiment numbers + why) tables and
[lessons.md](lessons.md), and the narrative had begun to do harm —
several of its cost figures were superseded by later measurement while
still reading as current. One line per round, with where to look:

| round | patches | what it established |
|---|---|---|
| 2026-09-12 status | 0042–0045 | every board on the wasm64 backend by default; the first boot cost model — **since re-measured and wrong** (see corrections below) |
| 1–2 (09-13) | 0046 | inline next-TB lookup cache on `goto_ptr` exits: helper lookups 2.75 M/s → 0.43 M/s, J2ME stopwatch +7–9 %, **boot milestones flat**. The lookup helper was a throughput lever, never a boot lever |
| 3 (09-13) | 0047–0049 | the display path per word (DIF mux rebuild, DMAC timer re-arm, DMA ack clears) took the stopwatch 0.35 → ~0.50; **0049** found the ke800 stall — the GPTU's per-byte-overflow deadline was a 100 kHz timer storm starving the vCPU |
| 4–5 (09-13) | 0050–0051 | incremental; "still below real time on a Pixel 8 Pro" |
| 6 (09-13) | 0052 | TB labels as nested blocks instead of a dispatch loop (V8 adds a stack check and loop phis per label): stopwatch +3.5 % |
| 7 (09-13) | 0053 | **Firefox had been broken since the review session**: a TB translated right after a batch close ran from a throwaway per-TB module, ~20 % of TBs, exhausting Firefox's ~16 k-module budget. Chrome has no such budget and never showed it. `ffboot.mjs`'s `temp=` exists because of this |
| 8–9 (09-14) | 0054–0055 | the last cheap per-word item; then `local.tee` — **mechanism proven, speed flat**, which with two earlier results closes **emitted-byte count as a lever** |
| 10 (09-14) | 0056–0057 | the other two phones; board-specific mechanisms are invisible on the S75, which is why `uibench` is per-board |
| 11 (09-14) | 0058–0066 | the device access path: **shared cache lines cost 24×, barriers are free, the tax is per call**, look for work done twice. S75 idle +30 % MIPS, EL71 +21 % |
| 12 (09-14) | 0067–0069 | **a cross-thread wake costs the BQL round trip, not the futex** (38k/s → 66/s, +37 %); and the trick of verifying "this cannot change anything" by counting the *size* of disagreements |
| 13 (09-15) | 0070–0073 | what a wasm atomic costs — wasm has no relaxed atomic, so the locked publish store was the larger half of `icount_get`; deferring the BQL with a structural bound. S75 idle +20 % |
| 14 (09-15) | 0074–0076 | the cost of being unwindable: the Asyncify onlylist, 18 stale vCPU frames, and the finding that **instrumentation is expensive**. S75 idle +8.5 % |

**Three corrections later rounds made to numbers this section used to
state as fact** — if an old note anywhere quotes these, it is stale:

| was stated | actually |
|---|---|
| module compile ≈ 33 µs fixed + 5.5 µs/KB | **~80 µs fixed + ~1.4 ns/byte**, and four fifths of it is cold cache, not compiling (round 19) |
| translation ≈ 38 µs per TB | **~13 µs per TB** (rounds 17–19) |
| the early boot is compile-bound | the whole pipeline is **19.5 %** of boot wall (round 17) |
