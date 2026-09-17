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

**The workspace is ready** (checked 2026-09-17, end of round
twenty-eight): both native builds, `build/qemu-wasm64`, `site/dist-jit`,
`tools/node_modules`, and the `qemu/` submodule at `d78977e869` (0116),
which matches `QEMU_PMB887X_REV` in `versions.env`. `site/dist` carries only the guest
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

**The "module pipeline is 12.5 % of a boot" figure is retired** — it was
measured before the interpreter tier and nothing below it survives.
`modNs` now reads ~206 ms over a 40 s S75 boot window, i.e. **~0.5 % of
wall**. Where a document below still argues from 12.5 %, read it as
history: the tier collapsed module count and the pipeline stopped being
a target in round 25.

**Round 25 landed the interpreter tier and the cost model below it
changed shape.** EL71, 12 s windows: **347 → 576.7 Mi, +66.2 %**.
Modules 18 650 → 698, module time 2.02 s → 0.34 s, members per module
5.4 → 152. Three things did it, in order of size: the tier itself
(+29.7 %), defaulting speculation off because the tier removes the thing
it was buying (+23 %), and raising the batch cap to 256 (+3.5 %).

Cost model of a boot, from counters (rounds 17–19, spread 0.04 %;
**the module and pipeline lines below were re-measured in round 25 and
are marked where they changed**):

- **The pipeline is ~21 % of an EL71 boot and is now mostly
  translation, not compilation** (round 25, `WASM_DIAG_TIME_PHASES`
  plus temporary timers around `translate_code`, `tcg_optimize +
  liveness` and `tcg_gen_code`). Per translated TB, 25.5 µs total:
  frontend (guest decode → TCG IR) **4.5**, optimize + liveness **5.3**,
  register allocation + wasm emission **8.0**, the batch close now
  charged here **3.7**, `tb_gen_code`'s own bookkeeping **4.1**. At
  ~105 k translations per 12 s window that is 2.1 s of translation
  against 0.34 s of module time.
- **A batch close is charged to `tb_gen_code` now, not to execution.**
  With the tier a batch fills before any member has to run, so the close
  fires inside `tcg_out_tb_finalize`. Anything comparing `tbGenNs`
  across a tier-on/tier-off pair is comparing translation *plus module
  time* against translation alone — that cost a round-25 measurement
  4.57 µs/TB of phantom "recorder overhead" before it was caught.
- **The recorder costs under 1 µs per TB** — under 5 % of a translation
  and under 1 % of wall. It cannot be priced by turning it off against a
  normal run, because a build with no records has no tier: module time
  goes from 0.34 s to 4.2 s and the guest gets half as far, so the two
  legs are different regimes, not an A/B (32.9 µs/TB against 25.0, with
  the *slower* leg being the one without the recorder). The legs that do
  share behaviour are record-but-discard against record-not-at-all:
  **32.9 vs 32.4 µs**. Live records are **48 KB**, because a record is
  dropped when its TB lands in a module.
- **Round 24's module law holds only at the close rate that produced
  it.** ~86 µs per close + ~2.8 µs per member was fitted at 4.85 members
  per module, where the fixed term is 96 % of the cost. At 152 members
  the per-member term dominates and **the close count is no longer the
  lever** — module time is now proportional to emitted bytes.
- **"Module count == speculation-miss count" is retired.** Speculation
  is off by default with the tier, and a batch closes on fill. Module
  count is now translations ÷ members-per-module, and members-per-module
  is capped by the union import/type tables (`W64_UMAX_IMPORTS` 192,
  `W64_UMAX_TYPES` 64) well before `W64_BATCH_N`: at a cap of 512 the
  batches still average ~200, at 1024 ~236.
- **`new WebAssembly.Module` is 79 % of a module** (83.8 µs of 106.4;
  Instance 9.0, pre 5.2, addFunction 2.8, imports 1.2, GC nudge 0.45),
  and it has **no cheap corner**: linear in function count with a
  per-call intercept over 1 → 256 functions and 23 B → 236 KB, no
  threshold, imports 0.09 µs each (`tools/modshape-probe.mjs`).
- **Round 19's "four fifths of the 80 µs is cold cache" is withdrawn.**
  It recompiled *identical* wire bytes, which V8 serves from a
  compiled-module cache keyed on exactly those bytes. Perturb one
  immediate per call and cost rises **2.0–3.8×** (7.3→27.9 µs at one
  function, 149→306 at 128). The emulator never compiles the same bytes
  twice, so that 12–31 µs was never a floor it could approach. Still
  true and independently measured: it is **not** the live-module count,
  500 → 6000 live instances flat (`modgrow.mjs`).
- **~3.6 % of TB entries run V8's baseline tier, at 2× the optimizing
  tier's cost** (round 21). `--liftoff-only` is +63 % and
  `--wasm-tiering-budget=1000` is −3.1 %. Emitted code is mostly baseline;
  a C helper in the main qemu module is optimized. Moving work *into* a
  helper can win — the call boundary is only 2.1–2.4 ns.
- The inline TLB probe is **5.07 % of EL71 wall** — round 23 measured it
  directly (`W64_TLBDUP`: N extra real probes per memop, each result
  stored to its own slot; the N=1→N=2 slope is one probe), rather than
  extrapolating `W64_LDSTPAD`'s ns-per-instruction over an instruction
  count. The two agreeing at ~5 % is a coincidence: the pad calibration
  measures a dependent ALU chain and a probe is two loads deep. **That
  5.07 % is an upper bound on deleting the probe, not a budget** — a
  cheaper check placed *in front* of it measured 4.4–5.0 % slower
  (§ REJECTED, the per-site TLB entry cache).
- **TB→TB transitions are 9.1 % of wall**: 240.6 k per Mi at ~7.7 ns
  (`W64_XCOUNT`), 4.16 guest instructions per TB entry, the C dispatcher
  re-entered once per 173 transitions, the inline cache serving 83.9 %
  of `goto_ptr` exits. The exit mix and its three ceilings are in the
  playbook § 0d. A cheaper indirect call is worth nothing — ~6 ns is
  this engine's floor for `return_call_indirect` against the emulator's
  7.7 ns.
- **Emitted bytes do not cost execution time either** (round 23,
  `W64_BYTEPAD` 0→60 flat at +420 B/TB). Caveat attached to the module
  bullet above: `modMs` per module was also flat over that range, which
  does *not* fit the 3.2 µs/KB compile term — treat that slope as
  unresolved.

## Open items (ranked)

**New in round 28 (0116), and it belongs near the top: the ARM exception
entry path.** The guest takes **~93 k exceptions a second** and **90 % of
them are its own `SVC`s** (`excSwi` 4.95 M against `excIrq` 0.54 M over
40 s; every other kind reads zero). They account for **77 % of all
dispatcher re-entries**, which is the only reason a TB chain ever
unwinds. The rate is not reducible — it is what the firmware's RTOS
does — so the question is entirely the per-exception cost of
`arm_cpu_do_interrupt` → `take_aarch32_exception`, which this core
(ARM926EJ-S: no M, no AArch64, no EL2/EL3, no PMSA, no v6) makes almost
entirely constant-foldable, the same shape 0071 turned into +3.9 %.
**Price it with a calibration pad before building anything** — the
profiler's self-time on this cluster is an upper bound, not a budget
(round 23's `arm_rebuild_hflags` row), and the standing budget entry is
"cpsr / hflags / exceptions ~2.7 %". Closed by the same counters: this
is *not* a device storm, and the `cpu_loop_exit` route is already gone
(`execLjmp` = 34 per boot, against a ~15 µs JS-exception unwind each).

**Item 1 of every hand-off since round nineteen — the interpreter tier —
landed in round 25 (0101–0103), and with it the module pipeline stops
being the target.** Modules are 0.34 s of a 12 s window (2.8 %), down
from 2.02 s. What the tier did *not* do is reduce translation, and
translation is now the biggest single item at ~2.1 s (17 %).

1. **Cold TBs are still fully compiled, and the tier is what makes that
   avoidable — but only from the TCG IR.** Every translated TB runs the
   whole of `tcg_gen_code` (optimize + liveness 5.3 µs, regalloc +
   emission 8.0 µs) and joins a batch, even though the threshold means
   most of them are interpreted for their first 64 entries and round
   23's distribution says 74 % of entered TBs never run more than 31
   times. The threshold delays *use* of a module; it does not prevent
   its creation.

   **Deferring only the wasm emission does not pay, and this is
   measured, not argued.** The record is produced *by* the emitters,
   from post-register-allocation operands, so a record-only translation
   still costs the frontend, optimize, liveness and regalloc — it skips
   the byte writing alone, at most ~4 µs of 25.5. Re-translating the
   ~25 % that promote costs 25.5 µs each, i.e. 4.9 µs spread over every
   TB. **Break-even needs emission to exceed 4.9 µs and it does not.**

   The version that *does* pay records at **IR level**, before
   `tcg_gen_code`, with an interpreter over TCG temps rather than target
   registers. A cold TB then costs the frontend plus the record (~9.6 µs
   against 25.5) and a promoted one pays a full re-translation:
   0.75 × 9.6 + 0.25 × 35.1 = **16.0 µs against 25.5, ~8 % of wall**.
   The cost is a second interpreter — TCI's shape without TCI's bytecode
   step — and it would replace the one round 25 just built. Price the
   promotion share on the real thing first: the 25 % is round 23's
   pre-tier distribution, not a measurement of this build.

   A cheaper slice of the same idea, if the big one is not wanted:
   **defer only batch membership** until a TB is hot. Emission stays as
   it is, so nothing needs re-translating; module *bytes* drop by the
   cold share and module time is now proportional to bytes. Worth
   ~1.5–2 % for the cost of keeping a TB's call fixups until promotion.

1a. **Closed in round 25, with numbers — do not retry these.**
   `W64_NOCLOSEEXEC` (round 24's deferral knob) now *raises* module
   count, 1091 → 2277, because the tier already removed the early closes
   it was built to defer. The promotion threshold is flat from 16 to 256
   (557/570/574 Mi) — it is not a lever, which is what round 23
   predicted. The batch cap pays once, 128 → 256 (+3.5 %, modules
   1092 → 700), and then stops: 256 → 512 is a tie on throughput
   (608 vs 600 Mi) because the union import and type tables bind at
   ~200 members before `W64_BATCH_N` does. Raising *those* is the only
   way further, and the remaining prize behind them is under 2 %.

1b. **Merging a conditional branch's fall-through into its own TB —
   ≤ 2.7 % of wall, and it needs an icount correction.** Sized in round
   23: `goto_tb` which = 1 exits are **29.8 %** of all TB transitions
   (97 455 274 of 327 250 283 on a 1360 Mi EL71 window), and transitions
   are 9.1 % of wall. Second-order and possibly larger: a merged TB
   covers two basic blocks, so TB count — and therefore miss count and
   module count — would fall too.

   **The frontend side is small.** ARM already has the machinery: a
   conditional branch emits `arm_skip_unless` (a `brcond` to
   `dc->condlabel`) and then `gen_jmp` → `gen_goto_tb(dc, 0, diff)`,
   which sets `DISAS_NORETURN`, and `arm_tr_tb_stop`'s
   `if (dc->condjmp)` tail emits the fall-through as
   `gen_goto_tb(dc, 1, curr_insn_len(dc))`. The same `condjmp` mechanism
   *already* lets a TB continue past a conditionally-skipped
   instruction (`arm_post_translate_insn`); a branch is the one case
   where it stops instead.

   **The blocker is icount, and it is structural.** `gen_tb_end()`
   patches the TB-start subtraction to `db->num_insns` and sets
   `tb->icount = db->num_insns`, so QEMU charges the guest for **every**
   instruction in the TB the moment it is entered. A TB that can leave
   early through `goto_tb 0` would over-charge by the length of the
   fall-through it skipped — which this tree cannot absorb: three of
   four boards run stock `-icount shift=3` and the lockstep gate is
   instruction-exact.

   The way round it is to **emit the taken path last**, so the skipped
   count is known when it is emitted:

       brcond  cond -> Ltaken
       <fall-through instructions, inline>
       goto_tb 1   (after the last one)
     Ltaken:
       icount_decr += n_fallthrough_insns    <- the correction
       goto_tb 0   (branch target)

   which fits `arm_tr_tb_stop`'s existing `if (dc->condjmp)` tail, with
   the roles inverted. **Do not start without a plan for the second
   problem**: the fall-through block is usually reachable from elsewhere
   too, so it will *also* exist as a TB of its own — duplicate
   translation, more TBs, more modules, the classic trace-JIT blow-up.
   Measure how much of the which = 1 traffic goes to a block with only
   that one predecessor before building anything.

   This is a qemu-core + frontend change, so it shifts both backends and
   needs the full matrix plus `close`'s 2.5 G lockstep. Ranked below the
   interpreter tier on prize (2.7 % against ~6 %) and well below it on
   risk.

2. **The baseline tier: ~3.6 % of TB entries, at 2× the optimizing
   tier's cost.** New in round 21 and barely exploited. Nothing page-side
   can set a V8 flag (`--wasm-tiering-budget=1000` is −3.1 %, and that is
   the size of the prize), so the ways at it are (a) emit less or cheaper
   code for the baseline tier — the declared locals are priced at under
   1 % and rejected on cost, and round 23 asked the same question of the
   inline TLB probe and got an answer that closes it: the probe is
   5.07 % of wall, a two-load replacement is 2.33 %, a one-load `v128`
   one is 4.09 % (lane extraction is not free), and fronting the probe
   with a 94.7 %-accurate per-site page cache measured **4.4–5.0 %
   slower**, because the hit arm has to duplicate the access. Nothing is
   left on the ld/st sequence short of a scheme that *replaces* the
   probe — and (b) get functions to
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

## Update (2026-09-17, round twenty-eight cont.: the guest's own exceptions, counted — 0114–0116)

**0114 (`b4559d83`): the C-side callers get the probe the generated code
has. +0.81 %.** The emitted code carries an inline TLB probe and the C
entry points into the memop slow path carry none — so the interpreter
tier, which reaches the guest only through `helper_*_mmu`, took a full
`mmu_lookup` for every access. A counter said **76 % of those found a
matching entry with no flag set at all**: aligned, not page-crossing, no
MMIO, no watchpoint, no notdirty — a round trip that bought nothing.
`do_ram_1p()` is the backend's own one-compare test written once in C and
wired into all eight one-page entry points. `slowClean` **5.69 M → 0**,
`ram1p` picking up the same 5.7 M per 20 s. The trap on the way is worth
carrying: **`TARGET_PAGE_MASK | a_mask` silently truncates to 32 bits** in
`cputlb.c` (not a `COMPILING_PER_TARGET` TU, so `TARGET_PAGE_TYPE` is
`int`, and `int | unsigned` zero-extends into a `vaddr`).

**0114b (`fa470233`): halve the register file, +2.05 %** — and it
**revises a number this document relied on**. Every TCG register costs
*two* declared wasm locals in every TB function and the baseline tier
zeroes all of them on entry; `tcgSpill` reads 0 over a whole boot at 13
allocatable, so 28 allocatable was mostly locals TCG never used.
`TCG_TARGET_NB_REGS` 32 → 16 is 33 fewer locals per TB (70 → 37,
verified with `wasm-dis` on a `W64_DUMPTB` module), emitted bytes
unchanged. 0093 had priced the spare locals at "under 1 %" — re-priced
with `W64_LOCALPAD=192` the slope is **8.09 µs/Mi per declared local**,
making 69 locals ≈ 6 % of wall. 0093 read the derivative at the bottom
of a superlinear curve and generalized it upward: **a pad's slope is
only valid near the N it was measured at.**

**0115 (`764aa9eb`): the TPU event-RAM scan window is one event, not the
rest of the list.** 0068 skips `tpu_update_state()` outside
`[ceap, eapt)`; but `tpu_run_events()` breaks at the first event the
counter has not reached and `p->next` comes from words `ceap..ceap+2`
only, so the window is three words. The prize was proven with a counter
*before* the code existed: of 8.7 M event-RAM writes in 25 s, 1.97 M
passed the old test and **every one landed past `ceap+3`**. After:
`tpuRamSkip` 77.5 % → **99.99993 %**, `tpuRearm` **−14 %**, `tpuTimer`
flat. Wall effect is below the meter floor and is not claimed.

**0116: the dispatcher's and the CPU's own rates — and this is the part
that should drive the next round.** New cold counters `execIter`,
`execSjmp`, `execLjmp`, `armIrq` and a seven-slot exception histogram.
Three readings, each of which closes or opens something:

1. **90 % of ARM exceptions are guest `SVC`s.** Over a 40 s S75 window,
   `excSwi` 4 947 895 against `excIrq` 537 242, and `excUdef` /
   `excPabt` / `excDabt` / `excOther` all **zero**. So the ~93 k
   exceptions a second are **not** a device model firing too often —
   this is not another 0049/0062/0068 — and the *rate* is guest
   behaviour that cannot be reduced. One `SVC` per ~1 200 guest
   instructions is simply what this firmware's RTOS does.
2. **Exceptions are 77 % of all dispatcher re-entries** (`armIrq`
   1.85 M against `execIter` 2.41 M in 20 s). Round 23 established that
   the C dispatcher is re-entered once per 173 TB transitions and
   "chains essentially never unwind" — this says *why* they unwind when
   they do. The exception is the chain-breaker.
3. **`execLjmp` = 34 per boot.** The exception path does not use
   `cpu_loop_exit` at all: it leaves through a normal TB exit and
   `cpu_handle_exception` picks `exception_index` up on the next pass.
   This matters more than it looks. A longjmp in this build is the
   emscripten **JS-exception unwind** — the artifact carries `setThrew`
   and `_emscripten_throw_longjmp`, and `cpu_exec_setjmp`'s one call is
   the profile's `invoke_ijj` — priced at **~15 µs** by the
   `HELPER(wfi)` comment that removed the last hot one. At 93 k/s that
   would have been the entire program. The counter stays as the
   regression guard: if a future change puts a longjmp back on a hot
   path, this number is where it shows up.

**What that leaves, and how to price it.** The one cluster on this path
still unpriced is the exception *entry work* itself:
`arm_cpu_do_interrupt` → `arm_cpu_do_interrupt_aarch32` →
`take_aarch32_exception`, which for every `SVC` runs `switch_mode`,
`cpsr_read`, `arm_current_el`, two `cpu_isar_feature` loads, two
`A32_BANKED_CURRENT_REG_GET`s and `arm_rebuild_hflags`. This core is an
ARM926EJ-S: no M, no AArch64, no EL2/EL3, no PMSA, no v6 — which is
**exactly the shape 0071 exploited for the hflags rebuild and got
+3.9 %**. But do not build it from the profile: round 23 established
that `arm_rebuild_hflags` "at 11 %" was 9.5 µs/call for a 76 ns
function, and the rule that came out of it is that **a self-time share
for a small leaf is an upper bound, not a budget**. Price this one with
a calibration pad placed inside `arm_cpu_do_interrupt` (N cheap
non-foldable ops, extended until the slope is unambiguous), read ns per
operation in situ, multiply by what the short path would delete, and
only then decide. The budget table's "cpsr / hflags / exceptions ~2.7 %"
is the number to beat or refute.

**The BQL pair was priced and refused** — ~1 ns a call, ≈ 0.06 % of wall
(`W64_BQLDUP=N`, N=32 reading −1.5 % over 25 s), against a profile
self-time of 1.4 %. And `W64_NOBQL=1` is recorded as an unsound *probe
shape*: deleting a lock stalls the guest at 15 M instructions, so no
number comes out. Ceiling-probe-by-deletion works on redundant work, not
on mutual exclusion; for a lock the sound instrument is a pad that adds
more of the same.

**A meter failed this round and the failure is instructive.** In a 20 s
S75 window the four legs of a palindrome read `ram1p` identical to four
digits and `halt` within 17 counts, while `insns` swung **18 %**. Both
are true: those counters are boot-burst quantities that saturate, and
`insns` then accrues in the guest's idle spin for however much of the
window is left. The swing is not noise to be averaged down — **the meter
is measuring a different thing in each leg**, and more rounds cannot
fix it. Stay inside the boot, or use the fixed-guest-work milestones.
Matching `halt` proves the legs are paced alike; it does not prove they
measured the same work.

## Update (2026-09-17, round twenty-eight: a meter that resolves what the clock cannot — 0113)

**The round's real product is a meter.** Every TB-shape mechanism since
0108 has been measured on a fixed-wall clock whose round-to-round spread
is ±8 %, which means anything under ~3 % is unresolvable by it and has to
be argued from counters. `tools/exitrate.sh` closes that gap: it reads
exits (or any counter) **per Mi at matched instruction counts**, and its
spread is **0.8 %**.

The matching is the whole point, and the trap it avoids is one the
playbook's own rule half-covered. "Normalize per Mi" is not the same as
"the window does not matter": a per-Mi rate is exact for a *given* stretch
of guest work, but the boot's mix changes as it runs, so the same binary
reads **exits/Mi 100 759 at 1018 Mi and 114 857 at 839 Mi** — 14 % from
the window alone. And a faster leg reaches further in a fixed 20 s, so
sampling both legs at the same *second* hands the winning leg the
flattering window: **the confound points the same way as the
hypothesis**. An early mismatched pair read −12.3 % for a change that is
really −2.8 %. diagall's per-second samples are cumulative, so the fix is
to sample each leg at the first sample past a milestone.

**0113 (`e58e2625`): `w64_ft_max()` 2 → 3, +0.8…+1.4 %.** One character,
the same as 0112. Two independent five-round palindromes read **+1.4 %
(3/5)** and **+1.1 % (3/5)** — both positive, neither outside the clock's
floor. The new meter is not close: exits/Mi **110 380 → 107 253 at
600 Mi (−2.83 %)** and **113 647 → 110 704 at 800 Mi (−2.59 %)**, three
rounds each, and they move exactly where the mechanism says — `xGototb`
20 193 → 16 081 against `xGototb1` 16 103 → 18 797, i.e. branches that
used to leave through a `goto_tb` slot now leave as a fall-through the TB
carried on into. Instructions per TB 6.436 → 6.723. At the standing
"1 % fewer exits ≈ 0.3 % of wall" that predicts +0.8 %, which is what both
clock runs read. Mechanism, magnitude and sign agree; only the clock
alone is short of its own floor.

**The lookup helper is 33 ns, not ~100 ns — and that retires a standing
number.** `helper_lookup_tb_ptr_lc` has been quoted at ~102 ns since
round 23, from a `WASM_DIAG_TIME_PHASES` timer sampling 1 call in 8 with
emscripten's `gettimeofday`, i.e. a JS call on a path taken 600 k times a
second. Priced instead by deletion, in one binary: `W64_NOLC=1` turns the
inline cache off so every `goto_ptr` calls the helper, taking lookups per
Mi from **14 793 to 73 313** and the clock from 2139.7 to 1773.2 Mi per
20 s (three palindrome rounds, 16.6/16.6/18.2 %). That is
**1.932 ms per Mi for 58 520 extra calls = 33.0 ns each**, marginal over
the inline-hit path.

So the helper's whole share of wall is **14 793 × 33 ns = 0.49 ms/Mi of
9.35, i.e. 5.2 %** — that is the ceiling on a *perfect* next-TB cache,
not on a better one. It also explains the round-15 result that never made
sense: the second cache way cut `lcCall` by 39 %, which is worth 0.19
ms/Mi ≈ 2 %, and the inline compare chain it added to every `goto_ptr`
site ate all of it. **A ~100 ns helper would have made that experiment
succeed; a 33 ns one makes it a wash, which is what it measured.**

Where the boundary budget now sits, at 9.35 ms/Mi and ~107 k exits/Mi:
boundaries ≈ **39 %** of wall (34 ns each), guest instructions ≈ **39 %**
(3.68 ns each). Of the boundaries, **68 % are `goto_ptr`** — and that is
the next question, which is why this round also lands `W64_XWHY=1`:
indirect exits attributed to the guest instruction that asked for them
(`xwPcst`, `xwBx`, `xwPsr`, `xwRfe`, `xwDefer`, `xwNochain`). The reason
to want it is a comment already in the tree: `gen_set_psr` says the
firmware's critical sections make `msr cpsr` "the most frequent TB exit
of the boot", and that exit is an *indirect* one whose next pc is
statically known.

## Update (2026-09-17, round twenty-seven: two mechanisms priced and refused, and the one that was free — 0112)

Round 26 emptied the cheap end of "do not end the TB". This round went
looking for the next lever and found mostly walls — which is the useful
result, because two of them were the ideas a reader of this file would
have tried next, and both are now measured rather than assumed.

### What landed

**0112, `W64_FTMAX` 1 → 2: +4.7 %** (EL71, 20 s windows, five interleaved
rounds × 2 legs/side, 2229.6 vs 2130.3 Mi, 3/5 rounds; `tbIcount/tbGen`
6.44 against 5.81; `halt` unchanged). One character.

The interesting part is that **this exact knob sits in the REJECTED table
from earlier the same day, measured flat.** What made it flat was the
cost of holding a deferral slot to the end of the TB; 0111 lets a
deferral end at a join instead, and the slot comes back within a few
instructions. Nothing about the knob changed — the mechanism it was
competing against did. **Re-measure a rejected knob after the mechanism
it was rejected against changes.**

### What was refused, and why each one is worth knowing

**Merging a batch's TBs into one wasm function** (§ The one idea left,
above, now answered). Both preconditions hold — 55 % of indirect exits
are co-located — and it still fails, because a `br` inside one function
removes only ~39 % of a hand-off, not all of it: **~3 % of wall** for a
module-assembler rewrite. `tools/merge-probe.mjs` has the numbers.

**One helper call for a whole ldm/stm.** 33.7 % of every executed guest
memory op is inside an ldm/stm (`ldstExec` 331.0 M vs `lsmExec` 111.4 M,
3.61 registers each), so collapsing them deletes 80.6 M of 331 M inline
TLB probes. Built, correct (`lockstep-wasm --insns 250e6` clean), and
**−11.7 % then −6.3 %** across two 4-round interleaved sweeps.

The arithmetic that says so was already in the tree: 0106 priced an
import call *placed in a real TB* at **~14.5 ns**, and the probes it
deletes are ~1.16 ns each — 14.5 ns spent to save 4.2 ns, every
instruction. `tools/import-probe.mjs` says 2.1–2.4 ns for the same call
and that is the trap: **a microbenchmark has nothing live across the
call.** In a TB the engine spills every live wasm local and TCG marks all
globals written, so each guest register the rest of the TB touches is
reloaded from env. Restricting the helper to `ldm {…,pc}` — a return,
where the TB ends and nothing follows — does not rescue it either
(−8.3 / −7.9 / +3.6 / −8.9 %).

**The rule to carry:** price a helper by the *nanoseconds* it deletes,
not the operations. A helper on a hot path inside a TB has to move
≥15 ns of work before it breaks even.

### The absorb refusals, sized

`w64_absorb` now counts every path that refuses (14 s EL71 window, static
translation counts, `tbAbsorb` 8 609 successes):

| refusal | count | share |
|---|---|---|
| `abCond` — a conditional branch's taken path | 53 094 | 46 % |
| `abBackout` — backward, before this TB | 24 405 | 21 % |
| `abFar` — forward, past `W64_ABSORB` | 17 252 | 15 % |
| `abIset` — target runs in the other instruction set | 11 049 | 10 % |
| `abPage` — forward and near, but next page | 499 | 0.4 % |
| `abBackin` — backward, inside this TB's own range | 280 | 0.2 % |

`abCond` is already handled (0108/0111 defer and join it). `abBackin`
being 280 closes internal-loop absorption. **`abBackout` is structurally
blocked and should not be attempted**: a TB's invalidation range is
`[tb->pc, tb->pc + size)` and `tb->pc` is also its lookup key, so
translating instructions *before* the entry point cannot be made to
invalidate correctly. `abFar` does not respond to a bigger bound either —
`W64_ABSCHG=0` with the distance at 1024 lifts absorbs only 8 632 → 9 464
(+9.6 %) and `tbIcount` +0.3 %, because the same-page rule binds first.

## Update (2026-09-16, round twenty-six: the TB boundary was 68 % of wall — 0104–0109)

Round 25 left the pipeline cheap and the *execution* of TBs expensive.
This round priced that and took two bites out of it.

### The cost model, from dynamic counters

`W64_XCOUNT=1` counts TB exits in the generated code by kind. Solving
`t = c + e·b` across a mechanism that changes only the exit count gives:

- **a TB boundary costs ~34 ns**, against **~3.7 ns** for a guest
  instruction of real work;
- boundaries were **68 % of an EL71 window's wall** before this round
  and are **~40 % after**;
- the exits left are **56 % `goto_ptr`** — indirect branches, mostly
  returns, which no merge can remove.

This is the number that should rank everything from here. It was
reachable only because 0106's `W64_DUMPTB` made the emitted exit
readable: it is a `return_call_indirect` through a table of thousands of
TB functions, which `tools/dispatch-probe.mjs` had already priced at
5.5 ns for a working set of 1 and **46 ns at 4096**. The dump also
closed a standing hypothesis: **the register globals are not cached in
wasm locals across a boundary** — env memory is the storage — so there
is no "global sync" to delete at an exit. Only *fewer exits* help.

### What landed

Four mechanisms, all the same idea — **do not end the TB** — applied to
the four reasons it was ending:

- **0108, the conditional fall-through merge: +20.8 %.** A conditional
  branch used to end the TB and produce two ~4-instruction TBs. The
  taken path becomes a forward `br` to a label at the end of the TB and
  translation carries on into the fall-through.
- **0109, the guest-loop back-edge: +7.65 %.** One exit in five was a
  TB tail-calling itself. It becomes a `br` to a label at the TB's top.
- **0110, the forward absorb: +4.37 %.** An unconditional direct branch
  to a nearby address on the same page just moves `pc_next` there.
- **0111, the forward join: +6.0 %.** The deferred taken path of 0108 is
  often reached by the fall-through a few instructions later — which is
  what an `if (cond) { ... }` is — so the label goes there instead.
- **0112, two deferrals per TB: +4.7 %.** `W64_FTMAX` > 1 was measured
  *flat* earlier the same day and written into the REJECTED table. What
  made it flat was the cost of holding a deferral slot to the end of the
  TB; 0111 deleted that cost, and the same one-character change is now
  worth +4.7 % (6.44 guest insns per TB against 5.81). **Re-measure a
  rejected knob after the mechanism it was rejected against changes.**

Exits per Mi across the round, from `W64_XCOUNT` at 14 s:

| | xGototb | xGototb1 | xSelf | xGotoptr | total |
|---|---|---|---|---|---|
| before 0108 | | | | | **231 300** |
| after 0108 | | | 26 334 665 abs | | **163 116** |
| after 0109 | 32 386 | 24 462 | 439 | 75 151 | **132 458** |
| after 0110 | 23 560 | 19 334 | 403 | 73 876 | **117 215** |
| after 0111 | 21 146 | 17 057 | 381 | 67 376 | **105 972** |

**231 300 → 105 972, a 54 % cut**, and the rule that fell out of it is
worth carrying: over this round, **1 % fewer exits bought ≈ 0.3 % of
wall**, consistently enough to predict each mechanism before measuring
it. Use it to reject ideas cheaply.

### Three traps this round walked into, all worth remembering

**A mechanism that changes icount changes the workload.** The first
back-edge build re-ran `gen_tb_start`'s prologue on every iteration and
so charged icount twice. It measured **+36 %** — entirely artefact: an
over-charged icount runs the guest's virtual clock fast, the guest
spends less time halted, and a fixed-wall instruction meter reads work
that is not there. `halt` is the tell, and it must match between legs.
Corrected, the same mechanism is +7.65 %.

**A counter can confirm a mechanism and still not predict the clock.**
The first back-edge (frontend only) drove `xSelf` from 21.8 M to 0 and
exits per Mi down 25.4 % — and measured **9 % slower**, because a
backward branch dropped the TB out of the backend's nested-label mode
into the `$bp` dispatch loop, where every *forward* branch is
O(n_labels). The mechanism was perfect and the cost was somewhere else
entirely.

**This meter cannot see anything under ~15 % in one pair.** An 8-leg
sweep read the same configuration at 1830 and then 2122 Mi. Every
verdict below that needs interleaved legs and a per-round pairing, which
is what settled `W64_NOOPT` (nothing), `W64_FTMAX` > 1 (flat) and the
`W64_LC_JC` fast path (+0.10 %).

### Where the remaining time is

Boundaries are now **~27 % of wall** (106 k/Mi at ~22–34 ns against a
~9.7 ms budget per Mi), and **64 % of what is left is `goto_ptr`** —
indirect branches, mostly returns, which no merge can reach. The four
direct kinds have been taken from 156 k/Mi to 38 k/Mi; what still exits
directly is far branches and calls, and the distance knob is exhausted
(`W64_ABSORB` 512/1024/4096 all read within 0.7 % of 256).

**Three candidates for the other half were priced and closed this
round, all of them before anything was built:**

- **The ~70 wasm locals every TB function declares.** wasm zeroes locals
  at entry and a baseline compiler has no liveness analysis, so this
  looked like ~39 ns per TB entry (`tools/locals-probe.mjs`: 49.9 →
  88.9 ns/call). But it is **~0 in the optimizing tier**, and only
  ≈3.6 % of TB entries still run baseline code (round 24), so the whole
  item is worth ~1.9 % and interleaving the locals to drop the trailing
  run is not worth building.
- **Redundant env loads in the emitted code.** A `W64_DUMPTB` read finds
  guest register 4 loaded five times and the PC three times in a
  6-instruction TB — TCG spills and invalidates every global at each
  `set_label`, and 0108–0111 all *add* labels. Forwarding them in the
  backend is a real mechanism, but it follows from the point above that
  V8's optimizing tier is what runs ~96 % of entries, and it does
  redundant-load elimination itself. Do not build this without first
  showing, in a dump of *optimized* code, that the reloads survive.
- **Instance locality / bigger modules.** Closed in round 21 and still
  closed: 128-per-module against one module is 8–13 % of the dispatch,
  and a *direct* `return_call` instead of an indirect one is worth
  1.1 ns.

The inline TLB probe is ~5 % of wall (0098) and the slow-memop path is
~1 % (`ldstMiss` 3.78 M against 6.31 M helper entries per 14 s window,
of which ≥2.49 M find a *clean* entry the inline probe could have
served).

### The one idea left that is worth its risk — ANSWERED, and the answer is no (round 27)

**Both conditions below were measured, and the second one held: 55 % of
indirect exits do land in the module they are leaving.** The idea still
fails, because the premise underneath both of them — that a `br` inside
one function removes the whole ~22 ns hand-off — is false.
`tools/merge-probe.mjs` builds both shapes and times them: 1024 members,
realistic bodies (66 locals, 20 env load/add/store of live work), cost of
the hand-off over the work floor —

| shape | ns |
|---|---|
| `direct-c` (direct call, consecutive targets) | 2.60 |
| `ind-in-c` (indirect, consecutive targets) | 4.48 |
| `ind-in` (indirect, shuffled — what we ship) | 13.38 |
| `merged-c` (one function, `br_table`, consecutive) | 4.91 |
| **`merged`** (one function, `br_table`, shuffled) | **8.18** |

`ind-in` at 13.38 ns calibrates the probe against production's ~22 ns, so
merging removes about **39 %** of a hand-off, not all of it. Carry that
through: 64 % of exits are `goto_ptr`, 55 % of those are co-located, and
each saves ~8.6 ns — **~3 % of wall**, for a module-assembler rewrite
(depth fixups, group ids, packed chain words, eviction). The estimate
below said ~8 % because it assumed the whole hand-off disappeared.

It is consistent with everything else the tree knows: a TB boundary is
worth ~44 ns marginal and the *call* is only 6-8 ns of it — the rest is
the prologue, the PC store and the inline-cache check, none of which
merging touches. Round 23 already said "a cheaper indirect call is worth
nothing". **Fewer boundaries, not cheaper ones.** The original reasoning
is kept below because it is how the number was arrived at.

### The one idea left that is worth its risk (as written before it was priced)

Every exit — direct or indirect — is a `return_call_indirect` out of one
wasm function and into another, and the self-loop priced that mechanism
at **~22 ns even when the callee is the caller**, i.e. with perfect
locality and a perfectly predicted target. So the cost is the *function
hand-off*, and the way to remove it for the indirect exits that no merge
can reach is to put the TBs in one wasm function and branch between them.
The batch assembler already builds one module per ~284 TBs with a
`run(env, sp, tp, tidx)` thunk; making the members bodies of that one
function, wrapped in a `loop` + `br_table`, turns an exit whose target is
in the same module into a `br`.

Two things have to be true first, and the second is now measurable:

1. The bodies must survive being concatenated — they share a local
   layout, and their branches are self-contained, but the final branch
   depth differs per member, so the assembler has to patch a padded LEB
   the emitter leaves (the fixup machinery already does this kind of
   thing for union indices).
2. **A useful share of exits must stay inside the module.**
   `W64_COLOC=1` with `W64_LC_VERIFY=1` routes every `goto_ptr` through
   `helper_lookup_tb_ptr_lc` and counts `xSamemod` / `xDiffmod` /
   `xNomod` from the two TBs' `W64_TCP_BATCH` words. Read that ratio
   before writing a line of the assembler: at 64 % of exits being
   `goto_ptr` and ~22 ns each, a 50 % co-location rate is worth ~8 % of
   wall and a 15 % one is not worth the risk.

## Update (2026-09-16, round twenty-five: the interpreter tier, and what it retired — 0101–0103)

**EL71, 12 s windows: 347 → 576.7 Mi, +66.2 %.** Modules 18 650 → 698,
module time 2.02 s → 0.34 s, members per module 5.4 → 152. Three
landings, in order of size: the tier (+29.7 %), speculation defaulted
off because the tier removes what it was buying (+23 %), and the batch
cap raised to 256 (+3.5 %).

### The tier

The backend records every emitter's already-register-allocated operands
into a flat `uint32_t` stream (`tcg/wasm64/w64-interp.h`) and a C
interpreter in the main module runs a TB before its module exists, so a
batch is no longer closed early by the first member that has to run.
Coverage is total: `irecN == tbGen` exactly, so no TB is
un-interpretable, and `itryNorec` is 0 — a record is never missing when
it is wanted.

**Two invariants broke outside the backend, both silently.**

*32-bit signed compares.* Operands are held zero-extended, so comparing
them at 64 bits makes `(int64_t)(uint32_t)-1` positive. `gen_tb_start`'s
icount test is `count - n < 0`, which therefore never fired, and the
guest wedged with its instruction budget uncharged. This is the bug
class to expect first in any future work on the interpreter.

*`tb_add_jump` linking into a target with no module.* A compiled
`goto_tb` tail-calls the target's shared-table entry, and
`tb_set_jmp_target`'s own comment says why that used to be safe:
"tb_add_jump is immediately followed by executing the target, so its
table entry is live by then". The tier is precisely the thing that makes
a target run for a long time without one. The guard must go **before**
the `cmpxchg` that claims `jmp_dest[n]`, or the pair is marked linked
and can never link later.

### What the tier retired

- **Speculation.** Round 22 priced it soundly: a translation costs
  ~12 µs against ~96 µs for the module a miss forces, break-even 12.5 %,
  actual conversion 66 %. The tier invalidates the numerator — a miss no
  longer forces a module — and break-even moves to ~100 %. The sweep is
  monotone with no interior optimum: **593/571/540/514 Mi at a budget of
  0/2/8/32**. Round 23's separate "27.2 % of translated TBs are never
  entered" was measuring the same waste.
- **Round 24's module law.** ~86 µs per close + ~2.8 µs per member was
  fitted at 4.85 members, where the fixed term is 96 % of the cost. At
  152 members the per-member term dominates, module time is proportional
  to emitted bytes, and **the close count is no longer the lever**.
- **`W64_NOCLOSEEXEC`.** Round 24's deferral knob now *raises* module
  count, 1091 → 2277: the tier already removed the early closes it was
  built to defer.
- **The promotion threshold.** Flat from 16 to 256 (557/570/574 Mi).
  Raising it does cut modules hard — at a 512 cap, T = 64/1024/8192
  gives 527/348/319 modules — but interpreted entries rise in step
  (353 k/944 k/1.96 M) and throughput does not move. Both ends of the
  trade are visible and they cancel.
- **Deferring wasm emission for cold TBs.** Priced and rejected without
  building it. The record is produced *by* the emitters, so a
  record-only translation still pays the frontend, optimize, liveness
  and regalloc — it skips byte-writing alone, at most ~4 µs of 25.5 —
  while re-translating the ~25 % that promote costs 4.9 µs spread over
  every TB. Break-even needs emission above 4.9 µs and it is not.

### Method notes from this round

- **`?env=` takes ONE assignment per parameter.** `site/app.js` does
  `getAll("env")` and splits at the first `=`, so
  `&env=A%3D1%26B%3D2` sets `A` to the literal `1&B=2` and never sets
  `B` at all — silently, with no error and a plausible-looking result.
  Three measurements in this round were invalidated by it, including a
  "the recorder costs 4.57 µs" figure that was really speculation being
  on in one leg. **Pass each variable as its own `&env=`.**
- **`tbGenNs` changed meaning when the tier landed.** A batch now fills
  before any member runs, so its close fires inside
  `tcg_out_tb_finalize` — i.e. inside `tb_gen_code`. Any tier-on/off
  comparison of `tbGenNs` compares translation *plus module time*
  against translation alone.
- **You cannot A/B the recorder by disabling it**, because a build with
  no records has no tier: the two legs differ in module time by 12×
  and in guest progress by 2×. Compare record-but-discard against
  record-not-at-all instead, which share behaviour exactly.
- The per-TB translation decomposition (temporary timers around
  `translate_code`, `tcg_optimize + liveness`, `tcg_gen_code`): frontend
  **4.5 µs**, optimize + liveness **5.3**, regalloc + emission **8.0**,
  batch close **3.7**, `tb_gen_code` bookkeeping **4.1**.

## Update (2026-09-16, round twenty-three: the probe, priced — and what pricing it cost — 0098)

Round 22 left the execution side of the cost model as "the other 80 %".
This round measured it. Nothing shipped except instruments; the one
mechanism built on the numbers was rejected by its own A/B.

### The exit mix, and what a TB transition costs

`W64_XCOUNT=1` counts TB exits in the generated code; `dispCall` /
`dispIter` count the C dispatcher. One 1360 Mi EL71 window:

| exit | count | share |
|---|---|---|
| `goto_tb` which = 0 | 135 528 086 | 41.4 % |
| `goto_tb` which = 1 (fall-through) | 97 455 274 | 29.8 % |
| `goto_ptr` | 94 266 923 | 28.8 % |
| — chaining back to the *same* TB | 15 638 733 | 4.8 % of all |

240.6 k transitions per Mi, **4.16 guest instructions per TB entry**,
`dispCall` 1 893 390 — the dispatcher is re-entered once per 173
transitions, so after 0091 chains essentially never unwind — and
`lcCall` 15 134 439, i.e. the inline cache serves **83.9 %** of
`goto_ptr` exits. At ~7.7 ns a dispatch that is **9.1 % of wall**.

Three ceilings fall straight out, all in the playbook § 0d:
self-chaining loop-back ≤ 0.43 %, merging conditional fall-throughs
≤ 2.7 %, and a *cheaper* indirect call ≈ 0 — `tools/dispsize-probe.mjs`
puts this engine's `return_call_indirect` floor at ~6 ns (8 targets)
against the emulator's 7.7 ns, on a clean cache-size curve that only
reaches 22.7 ns at 131 072 targets.

### The inline TLB probe is 5.07 %, and that is a ceiling not a budget

`W64_TLBDUP=N` emits N extra *real* probes per memop against mmu index
^ 1, so no load is CSE'd with the genuine one, each result stored to its
own per-site slot. The N=1 → N=2 slope is exactly one probe: **+5.07 %
of EL71 wall** (+4.8…+5.5 % across runs, with `mods`, `tbGen` and
`modMs` identical between legs, so it is not the pipeline).

The instrument had to be corrected once, and the correction is the
transferable part. Folding every duplicate's result into one global with
`load; add; store` makes each memop wait on the previous one's
store-to-load forward: the duplicate's dependency chain lands on a
serialized critical path, which prices its *latency* rather than its
cost. Measured that way the probe inflated ~2× and a one-load check
looked as expensive as a three-load one — the ordering of the three
variants below was wrong until the sink became a plain store to a
per-site address.

Replacements, priced before building any of them:

| check | loads to the addend | cost |
|---|---|---|
| current inline probe | 4 | +5.07 % |
| generation-tagged per-site cache | 2 | +2.33 % |
| the same as one `v128.load` | 1 | +4.09 % |

**SIMD lane extraction is not cheap, and the probe's cost is not simply
its load count** — one load costs nearly twice what two do here.

And the hit rate the cheap check needs: `W64_TLBHIT=1` runs the per-site
page cache for real and counts it — **1 656 776 205 hits / 91 863 184
misses = 94.7 %**.

### Then it was built, and it was 4.5 % slower

Every input said +2.4 %: a 2.33 % check, 94.7 % of the time, replacing a
5.07 % probe. Built end to end (`W64_SITECACHE`, knob flipped inside one
binary): **26.62 s cache-off against 27.83 s cache-on, 4.4–5.0 % the
wrong way**. `W64_SITEPOOL` 512 / 8192 / unlimited read +8.4 / +5.0 /
+5.0 %, which rules out slot locality — an unlimited pool loses exactly
as much as an 8192-entry one. Reverted in full.

**What the instrument could not see is the branch structure.** A
duplicate probe is emitted straight-line, outside any `if`; the real
cache is an `if/else` every memop executes, whose hit arm must
*duplicate the fast load/store*. The probe it skips was already
predicted-taken and off the dependency chain, so the trade is a test, a
taken branch and a second copy of the access against work that was
nearly free in the shadow. Generalizes to every "check before the check"
on this backend: **a duplicate-probe number is an upper bound on
deleting that code, never a budget to spend fronting it.** Retry only
with a scheme that replaces the probe outright.

### Also closed, each with a number

- **Emitted bytes as an *execution* lever** — flat from `W64_BYTEPAD` 0
  through 60 (+420 B/TB, ~2× module size): 27.22–28.03 s against a
  27.2–27.6 s baseline. The +17.6 % cliff at 120 is a **`tb_flush`
  artifact** — `tbFlush` 0 → 1, `tbGen` 159 k → 204 k, `mods`
  33.6 k → 40.8 k — not the i-cache. Check those three counters before
  reading any wall number off a knob that changes code size.
  *Unresolved and worth someone's attention*: `modMs` per module was
  flat (≈100–109 µs) across that same doubling of module size, which
  contradicts round 21's ~80 µs + 3.2 µs/KB fit.
- **memory64 bounds checks** — free. 0.241 / 0.253 / 0.258 ns per load
  for m32 / m64 / m64-with-dynamic-index at a 2 GB memory
  (`tools/mem64-probe.mjs`). The per-memop tax is the TLB probe, not the
  wasm bounds check.
- **`return_call_ref`** — 11.68 ns against 8.04 ns for the plain
  indirect call, **45 % worse** (`tools/callref-probe.mjs`). A *typed*
  non-nullable table is 7.52 ns, −6.5 %, which is ~0.6 % of wall: kept
  as a micro-item, not pursued.
- **Neighbour / jump-table speculation** — replayed offline against a
  32 394-pc EL71 miss trace instead of building a predictor. 18.0 % of
  misses are within ±4 words of an earlier miss and 36.4 % within ±12,
  but unfiltered speculation converts at **10.0 %** against a 12.5 %
  break-even. Filtering on the target being an ARM `B`/`BL` converts at
  **23.6 %** — and only 10.1 % of missed pcs are at a branch at all,
  2.9 % inside a run of ≥3, so it prevents **1.1 %** of misses.
  Consistent with 0097: the miss stream is edge-limited.

### The interpreter tier: both its gates measured, and both open green

Open item 1 has carried two "probe before building" questions since round
twenty.  Both are now answered, and the item changes from *plausible* to
*priced*.

**(b) How long would a missed TB stay interpreted?**  `W64_TBHIST=1`
bumps a per-TB entry counter at a translation-time-constant address in
the prologue, so every TB's lifetime entry count is exact.  EL71, 2528 Mi,
`tbFlush` 0 (tidx is recycled at flush, which would merge counts):

| entries in this TB's life | TBs | % | of all entries |
|---|---|---|---|
| never entered at all | 47 251 | 27.2 % of translated | — |
| exactly 1 | 45 406 | 35.9 % of entered | 0.01 % |
| ≤ 3 | 63 689 | 50.4 % | 0.01 % |
| ≤ 15 | 86 123 | 68.2 % | 0.04 % |
| ≤ 31 | 93 568 | 74.0 % | 0.07 % |
| ≥ 1 048 576 | 107 | 0.08 % | 50.5 % |

**The distribution is bimodal and the gap is enormous.**  A TB that will
be hot is hot immediately — 0.08 % of TBs take half of all entries — and
a threshold anywhere between 2 and 128 separates the two populations at
negligible cost: promoting at 32 entries leaves 74 % of entered TBs
interpreted forever and only **0.25 % of all TB entries** ever
interpreted.  S75 is the same distribution (36.5 % / 72.7 % / 0.27 %), so
this is a property of guest code, not of one board.

**(a) Is an interpreted first execution cheap enough?**  Measured in two
steps rather than guessed.  Natively, the same EL71 window runs **131.1
MIPS on the JIT and 21.4 MIPS on TCI** (`tests/run.mjs --flash el71`,
`QEMU_BIN=build/qemu-native-tci-build/...`) — interpretation is 6.1× at
that end.  That ratio does not transfer, because the two sides land in
different tiers in the browser, so `tools/interp-probe.c` measures the
transfer factor directly: the same TCI-shaped dispatch loop (byte
opcode, jump-table switch, decoded operands, a register file, TCG's own
op mix) compiled with `gcc -O2` and with `emcc -O3`.

**They are the same speed.** 7.30 / 7.42 / 7.43 ns per op native against
7.26 / 7.42 / 7.22 in wasm, three pairs — V8's optimizing tier compiles a
branchy interpreter loop as well as gcc does.  So the interpreter
transfers at **1.0×** while the thing it replaces — emitted TB code in
V8's *baseline* tier — is 2.7× slower in wasm than native.  **The
browser is the favourable place for this design, not the unfavourable
one**, which is the opposite of the assumption the item was written
under.

Decomposing the four measured throughputs (native JIT 7.63 ns/insn,
native TCI 46.7, wasm64 20.4, devices/other common to all) puts the
wasm penalty for interpreting rather than executing compiled code at
**~28 ns per guest instruction, ~118 ns per 4.16-insn TB entry** —
against ~83 µs for the module a first execution currently forces.

### What it is worth

Module count is what changes: a batch closes today because its first
member has to *run*, and an interpreted first run removes that reason.
The saving is `(modules no longer forced) × 83 µs`, the cost is
`(interpreted entries) × 118 ns` plus a second translation for each TB
that does get promoted.  At the measured distribution, promoting at
T = 64:

| assumption about how batches close | net |
|---|---|
| every promotion forces its own close (no batching at all) | **+0.25 s** |
| closes keep today's 3.55 members each | **+1.8 s** |
| batches fill to `W64_BATCH_N` = 128 | **+2.35 s** |

On a ~27 s EL71 boot that is **1 % to 9 %, most likely ~6 %** — and the
curve is flat from T = 16 to T = 256, so the threshold is not delicate.
**The middle column is the one assumption no probe can settle**, because
it depends on the interleaving of translation and execution order that
only the real thing produces; it is the first thing to measure once a
prototype runs.

Two risks worth writing down before anyone starts. **Asyncify**: the
interpreter would sit under `tcg_qemu_tb_exec` and call helpers that can
longjmp, so it is a candidate for the onlylist — and round fourteen
measured Asyncify instrumentation as expensive.  `interp-probe.c` is
*not* instrumented, so its 1.0× is an upper bound on how well the real
loop transfers.  **Memory**: every live TB would carry a TCG/TCI op
stream alongside (or instead of) its wasm bytes.

### Open at the end of round twenty-three

**The interpreter tier is the target, and it is now the only one with a
measured prize.** Both of its gates opened green (above): the per-TB
entry distribution is bimodal, with a 0.25 %-of-entries interpretation
cost at a promotion threshold of 32, and an interpreter loop compiles to
wasm at *native* speed while the emitted code it replaces runs 2.7×
slower than native. Worth ~6 % of an EL71 boot on the central
assumption, 1–9 % across the range. It is a multi-session build; the
plan is in open item 1.

Everything else shrank this round rather than grew: the dispatch line is
9.1 % with a ~6 ns floor under it, the TLB probe is 5.07 % with no
cheaper *front* and no replacement designed, and emitted bytes are
closed on both the compile and the execution side. The two structural
ideas left, both bounded and both real work, are **merging conditional
fall-throughs** (≤ 2.7 %) and **typed funcref tables** (~0.6 %).

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
