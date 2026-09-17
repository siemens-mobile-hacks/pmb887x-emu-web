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

### The module-local dispatch loop — merge a module's TBs into one wasm function

**New in round 31, and it is the top item because it is the only way to
collect the 3–6 % the baseline tier costs without a browser flag.**  (It
may also address the TB boundary; that half is unproven — see below —
and the item does not rest on it.)  A module holds
~277 TBs (`modCount` 0.01/Mi against `tbGen` 3.45/Mi) and today emits one
wasm function per TB.  Merge them into a *single* function whose body is
a `br_table` cascade over the module's TBs, and two separate prices fall:

- **Tier-up latency.**  V8's tier-up budget drains per *call* and is
  charged per *function* (~1–2.4 × 10⁴ calls; see lessons.md, "Emitted
  code runs in the baseline tier").  277 functions each need their own
  10⁴ calls; one merged function needs 10⁴ calls *in total*, so it
  reaches TurboFan roughly 277× sooner in TB-entry terms.  The prize is
  the measured baseline-tier share on a running game: **3–6 %**
  (`--js-flags=--no-liftoff`, round 31, +6.3 % on a four-leg palindrome;
  0050's +3 % is the same number's lower end).  A browser flag is not a
  shipping lever — this is the only way to collect that share from
  inside the binary.
- **The TB boundary — CLOSED, 2026-09-17, and it was never there.**  The
  merge's second half was to turn intra-module successors into a `br`
  back to the cascade head instead of a cross-module
  `return_call_indirect`.  Swept properly it is worth **nothing, and at
  a realistic body size it is a regression**.  See *The boundary
  mechanism is not a lever* below.  The item now stands on tier-up
  amortisation alone — which is fine, because that half never depended
  on dispatch: it rests on `--no-liftoff`, which changes no call opcode.

**Feasibility is established, and it is better than expected: the merge
is a pure assembler-side transform that needs no backend change at
all.**  Four facts, each verified in the source this round:

1. *Staged bodies are copied verbatim.*  `wasm64.c:1443` does
   `mb_put(&mod, body + W64_BODY_OFF, src->member[m].body_len)`; the only
   bytes ever rewritten are union import indices, via the existing
   per-member fixup list.
2. *No TB body branches out of itself.*  `w64_br_to_label`
   (`tcg-target.c.inc:1371`) resolves every branch to a depth of
   `W.n_blk - 1 - i` with `i >= 0`, and `W.n_blk` counts only blocks the
   body pushed.  The maximum depth reaches the body's own outermost
   block, never function level — in nested mode *and* in the `$bp`
   dispatch-loop mode, including the `W.selfloop` back-edge (1383–1387).
   Branch depths are relative, so wrapping a body in N more enclosing
   blocks cannot change its meaning.
3. *The locals declaration is fixed and identical.*  `tcg-target.c.inc:
   3400–3406` emits the same 9-byte run in every body (`0x04`, then
   17 × i32, 16 × i64, 1 × i32, 3 × i64 = **37 locals**), preceded by a
   5-byte padded size LEB.  Merging strips a constant 14-byte prefix
   from each body and declares the run once.  (`W64_LOCALPAD` adds a
   fifth run; the merge must read the count rather than assume four.)
4. *The tail needs a two-byte rewrite and nothing else.*  A body ends
   `i32.const 0` / `end` (3579–3580), i.e. with a live i32 the function
   `end` consumes.  Copy the body minus its final `end` and append
   `return` + `end`: the arm block becomes `[] -> []`, the value leaves
   by `return`, and the code after it is unreachable so the `end`
   validates.  Every other exit in the body is already a `return`
   (`tcg_out_exit_tb` 1434, `w64_chain_go` 1448 under CHAINLOOP).

So **merging alone is legal today**, and it collects the tier-up half
without touching `tcg-target.c.inc` at all.  That is the increment to
build and measure first — it is also the half with a real number behind
it.  The boundary half is a second, separable increment: the merged
function
takes the successor index as a fourth parameter (the CHAINLOOP driver
already holds it), subtracts a patched `BASE` constant, and at each
chain exit tests `arm < N` — both constants patched at assembly time by
the fixup machinery that already exists (`W64_MAX_FIXUPS` 1024).  In
range it is `local.set $bp; br $cascade`; out of range it falls back to
today's `return tidx | W64_EXIT_CHAIN`.

**Price it before building.**  Two cheap probes, both queued behind the
round-31 battery:

- *The dispatch itself.*  **Written this round**: `tests/wasm/
  dispatchbench.mjs` gained `merged` / `merged37`, one function holding
  `DB_NFUNC` arms behind a `br_table` with the transition expressed as
  `br` to the loop head.  It validates and runs; sweep
  `DB_NFUNC` = 32 / 128 / 277 / 1024 against the existing `loop`
  (`call_indirect`) and `stail` legs **on a quiet host**.  This prices
  the `br`+`br_table` transition **and** exposes the one real risk:
  TurboFan's register allocator on a ~263 KB function with a 277-arm
  cascade and 37 declared locals.  If it stops scaling with `DB_NFUNC`,
  the whole item dies there for the cost of one benchmark variant.  Run
  `xtail` and `xloop` in the same invocation: if they are equal, that
  also closes out CHAINLOOP's tie, which is the same topology question.
  (A one-rep look at `DB_NFUNC=64` on a *loaded* host read merged 1.5 ns
  against loop 3.3 ns — the right shape, but not a number: it was taken
  while the round-31 battery was running and must be re-taken.)
- *The locality.*  The ~60 % intra-module figure was an assumption.  It
  has now been run, and **it is 37.6 %, not 60 %**
  (`W64_XCOUNT=1&W64_COLOC=1`, game 1, 1925.6 Mi, 2026-09-17):

  | | per Mi | share |
  |---|---:|---:|
  | `goto_ptr` | 79,939 | 67.7 % |
  | `goto_tb` which=1 | 22,235 | 18.8 % |
  | `goto_tb` which=0 | 15,860 | 13.4 % |
  | self-chaining | 17 | 0.0 % |
  | **total boundaries** | **118,033** | 8.47 guest insns per TB entry |
  | `xSamemod` | 5,489 | **37.6 %** of the helper population |
  | `xDiffmod` | 9,090 | 62.3 % |
  | `lcCall` | 14,594 | the whole population: 12.4 % of boundaries |

  Two things follow.  The merge's prize scales with that share, so at a
  25 ns saving it is `0.376 × 25 × 118033/1e6 = 1.11 ns/insn` against
  5.686 — **19.5 % of wall**, not the ~28 % the 60 % assumption implied.
  And the share is not a constant of the workload: a batch is 259
  consecutively-*translated* TBs, so `W64_BATCH` (already a knob,
  clamped 1..1024) moves it mechanically — 27 modules give 37.6 %, and
  seven modules of 1024 should give far more.  If the merge lands, batch
  size stops being a compile-cost tradeoff and becomes a locality knob.

#### The boundary mechanism is not a lever (closed 2026-09-17)

`dispatchbench` had welded two axes together: `DB_NFUNC` set the table
size *and* the instance count, so every cell was "N functions in N
modules".  The emulator is 6,985 TBs in 27 modules.  `DB_NMOD` separates
them.  Swept at a realistic table (4096) and body (64 pad ops), ns per
transition:

| NMOD | order | `direct` | `xtail` | `xloop` | `loop` | `stail` | `merged` |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | unpredictable | 20.88 | 59.73 | 17.68 | 17.44 | 59.23 | 34.79 |
| 32 | unpredictable | 20.27 | 59.58 | 17.79 | 17.44 | 58.38 | 34.58 |
| 4096 | unpredictable | 20.17 | **163.68** | 29.16 | 17.85 | 58.59 | 34.10 |
| 1 | **strided** | 20.93 | **16.41** | 16.95 | 16.71 | 16.46 | 16.44 |
| 32 | **strided** | 20.13 | **15.97** | 16.81 | 16.63 | 16.36 | 16.56 |
| 4096 | **strided** | 19.79 | **17.75** | 16.90 | 16.68 | 16.35 | 16.30 |
| 32, pad 144 | **strided** | 35.60 | **35.73** | 35.99 | 36.43 | 35.20 | **51.13** |

Read the two orders, not the two mechanisms:

- **Unpredictable targets** (an LCG): the driver loop beats the indirect
  tail call by ~42 ns at every module count, and the merge only halves
  the gap.  This is the regime every previous estimate was quoted from.
- **Predictable targets** (each site's successor fixed): *every*
  mechanism lands on the same 16–17 ns, which is the pad's own floor.
  Dispatch costs nothing.  `direct` — a fixed chain with no dispatch at
  all — is *slower* at 20, because its bodies differ; that is the
  measurement saying there is no headroom left to find.

The emulator has already told us which regime it is in.  `W64_CHAINLOOP`
swaps exactly `xtail` for `xloop` and measured **−0.1 %** (87.00 vs
87.08, n=4).  The sweep predicts +87 % of wall for that swap in the
unpredictable regime — a seven-sigma effect against that leg's sd of 11.
It did not appear.  **Therefore the emulator's TB dispatch is
per-site-predictable**, which is also what one should expect from a
mechanism whose whole purpose (`tb_add_jump`) is to nail each site to
one successor.

**What this does and does not close.**  It closes every *mechanism*
proposal: the merge's boundary half, `W64_CHAINLOOP`, `stail`, and the
`W64_BATCH`-as-locality-knob idea, which cannot be worth 19.5 % of wall
when colocation's entire mechanism is worth nothing.

It does **not** close the boundary.  The 27.9 ns is not a synthetic
number — the four-point `w64_ft_max()` sweep measured it *in the
emulator on this game*, fitting `ns/insn = 9.83 + 27.87 × exits/insn`
to 1.2 %.  That fit varies how many exits there are, never which opcode
performs one, and both readings are true together.  The only way they
are both true is:

> **A TB boundary costs 27.9 ns and almost none of it is the
> dispatch.**

Which says what the cost must be instead — everything a boundary does
*besides* jump.  TCG allocates registers per TB, so every live guest
register is written back to `env` at the exit and reloaded at the next
entry; then there is the prologue, the icount decrement, the chain-slot
load, and a cold function entry in V8.  At 8.47 guest instructions per
TB entry that write-back/reload round trip is amortised over almost
nothing.  It is also exactly why CHAINLOOP tied and why the synthetic
ties: neither the driver loop nor `dispatchbench` has any guest state to
spill.

So the lever was never "make the transition cheaper".  It is **make
boundaries rarer, or make one carry less state**, and the `w64_ft_max`
fit has already priced the first at 27.9 ns each: raising guest
instructions per TB entry from 8.47 to 12 would remove ~34,700
boundaries per Mi, worth **~17 % of wall** at that slope.  That is the
largest sized lever this workstream has, and it now has the mechanism
family cleared away from in front of it.

Worse than neutral, in fact: at a realistic body size (pad 144, strided)
`merged` reads **51.13 against xtail's 35.73**.  A `br_table` on a
runtime-loaded index replaces a *well-predicted* indirect branch with a
poorly-predicted one.  Building the boundary half would have been a
regression, and the only reason that was not obvious is that nobody had
ever run the predictable column.

The transferable rule, now in lessons.md: **a dispatch benchmark
measures its target sequence, not its dispatch mechanism.**  Sweep the
order before quoting a number from it — and prefer the order the real
workload has, which for TB chaining is "almost always the same
successor".

  A counter confirms a mechanism, a clock only prices it — and round
  31's own lesson is that a path is not priced until something has been
  switched off.

  **This counter did not need building: it already exists and already
  ships.**  `W64_COLOC` (`cpu-exec.c:815–834`) reads the batch tag out
  of the source and destination `tc.ptr` and splits every transition
  into `xSamemod` / `xDiffmod` / `xNomod`; the knob is in the deployed
  wasm and had simply never once been run.  An earlier revision of this
  section listed it as work to do, which would have bought a duplicate.
  Before writing a probe, `strings` the deployed build for `W64_` — it
  carries 70 knobs and this round found three of them unused.

  It is a *partial* answer, and quoting it as more is the trap.  The
  counter sits in `helper_lookup_tb_ptr_lc`, so it sees only
  transitions that missed the per-TB inline cache and reached the
  helper — not the CHAINLOOP exit, and not the ~98 % of transitions
  that are direct-chained and never look anything up.  It bounds the
  locality of the *missing* population only.  Read against `lcCall`,
  never against the TB execution count.

**What CHAINLOOP's tie says about this, and it is the reason the
TB-boundary half is marked unproven.**  CHAINLOOP measured **−0.1 %**
where ~16 % was
predicted, because its driver loop is built by `w64_driver()` as **its
own module** (`wasm64.c:975–1009`): a CHAINLOOP transition crosses the
instance boundary *twice* where `return_call_indirect` crosses once, so
it is the synthetic's `xloop`, not its `loop`.  The prediction had
priced it off the same-module leg.  Two readings follow, and they point
opposite ways:

- *For this item.*  The cost is the instance crossing, not the call
  opcode — and the merged function is the only proposal that removes
  crossings outright, since an intra-module successor becomes a `br`
  inside one function with no call at all.
- *Against trusting the 16 %.*  That number came from the same
  synthetic-versus-topology mistake.  **Treat the TB-boundary half as
  unmeasured** until `merged` has been swept on a quiet host *and* the
  intra-module locality has been counted.  Tier-up amortisation is the
  half that rests on a real measurement (3–6 %).

The transferable rule, now in lessons.md: a synthetic leg prices the
real thing only if it has the real thing's module topology.

**What the pccin measurement says about this — less than it first
appeared, and the retraction is the point.**  The inline TB probe — six
words of compare chain emitted into every `goto_ptr` — first read
**7.4 % slower than deleting it**, which this document reported as a
hypothesis pointing at the baseline tier.  One of those four legs turns
out to have measured a title screen rather than a game (see *A fixed
guest-time window does not fix the workload*).  Guarded, it is g1
−0.2 % and g2 −8.7 %, both overlapping: **no evidence either way**, and
the eight-leg run has to decide it.  So this item rests on the
`--no-liftoff` ceiling alone (+6.3 %, both halves, the flag provably
live) and not on two independent measurements.  Two things still follow:

- The one number that did survive the guard is `disp` at +17.4 / +17.7 %
  with both games agreeing — which is a device win, not a tier win, and
  is the reason the display chain outranks this item in the queue.
- The follow-on stands regardless of which way pccin lands: **re-measure
  the inline TB probe after the merge lands.**  If merged TBs reach
  TurboFan 277× sooner, the compare chain gets cheap while the helper
  call does not.  A probe that is wrong today can be right after a tier
  change, which is why it gets a knob (`W64_NOPCCIN`) rather than a
  deletion — but it does not get *defaulted off* on an overlapping
  four-leg number with a contaminated leg in it.

Known costs and non-risks: the merged function is ~263 KB, which is
within every wasm limit; module *compile* stops being parallelisable
across 277 functions, but module time is already only 2.8 % of a window
and is off the hot path; 277 nested blocks for the cascade is legal wasm
and well under `W64_MAX_BLK`'s concern (that limit is per-TB, and the
cascade is assembled outside the per-TB emitter).

**Built, behind `W64_MERGE=1`, default off** (round 31).
`w64_assemble_instantiate` now has a second code-section shape: one
function holding every member's expr as an arm of a `br_table` cascade
over a module-local selector global, plus a small entry stub per member
registered in the chain table in the member's place.  The merged
function keeps **type 0**, the TB signature, rather than taking the
selector as a fourth parameter — locals are indexed *after* parameters,
so a fourth parameter would shift every local index in every body and
the "copy bodies verbatim" property, which is the whole reason this is
an assembler-side change, would be lost.  Bodies are copied byte for
byte except the trailing `end`, which becomes a `return` so control
cannot fall out of one arm into the next.  Four preconditions are
checked before merging and the batch is assembled *unmerged* if any
fails (`mergeSkip` counts it): ≥2 members, byte-identical locals
declarations, every body ending in `0x0b`, every call fixup landing
inside the copied expr.  Counters `mergeMod` / `mergeMemb` /
`mergeSkip`; `mergeMemb / mergeMod` is the fan-in tier-up amortises
over and is the thing to read before any clock.

*The selector global is safe against re-entry*, which is the one
non-obvious correctness argument: the stub sets it immediately before a
tail call, and the merged function reads it exactly once, at the
`br_table`.  Nothing that could re-enter the module runs between the
`global.set` and that read, and a nested entry that clobbers it after
the read cannot affect an invocation that has already dispatched.

`tests/wasm/mergeshape.mjs` builds the identical byte layout — same
section order, same type 0, same global, same cascade, same stubs, same
thunk — and asserts every arm is selected by the arm its stub asked for.
It validates and dispatches correctly at **1024 members**, which is
`W64_BATCH_N_MAX`, i.e. the most this code can ever emit.  That retires
the one feasibility question reading could not answer (deep block
nesting) for a second of CPU instead of a rebuild.

**The stub is probably the wrong design, and the synthetic said so
before the emulator did.**  `dispatchbench.mjs` grew `xstub`/`sstub`,
which differ from `xtail`/`stail` by the stub hop and nothing else.  On
a loaded host at tiny N — a *shape*, not a verdict — the hop reads
**+3–4 ns same-module** and worse across instances.  Price × rate:
3 ns × ~108 k TB boundaries/Mi ÷ 10.03 ms/Mi ≈ **3.2 % of wall**, which
is the entire 3–6 % prize.  A tail call is not free, and the merged
design adds one to *every* TB entry.

The alternative costs a store instead of a call: let the **caller**
write the successor's table index to a fixed memory slot just before its
`return_call_indirect` (the value is already in `SCR0` — `w64_chain_go`
wraps it for CHAINLOOP today), point **every** one of a module's table
slots at the merged function, and have the merged function open with
`i32.load $slot; i32.const base; i32.sub; br_table`.  No stubs, no extra
call, ~0.2 % instead of ~3 %.  It is not free to build: it changes
`w64_chain_go`, the run thunk, the C dispatcher and the CHAINLOOP
driver, so it is a backend change and not only an assembler one.  It
also needs a module's tidx values to be near-contiguous — they are
allocated one per TB at translation (`tcg-target.c.inc:3353`) in the
same order members are appended, so a batch is contiguous except where a
TB-overflow retry burns an index; the safe form is a `br_table` over
`tidx - min_tidx` with holes mapped to a dead arm, declining to merge
when the span exceeds ~2× the member count.

**What that sketch leaves out, and it is the part that decides whether
the boundary half is buildable at all.** Removing the stub is only the
entry side. The *prize* is the intra-module transition becoming a `br`
back to the cascade head with no call at all — and a `br` has to be
emitted **inside a copied body**, by the backend, at translation time,
when the TB does not yet know which batch it will land in, what its arm
index will be, or how deep the cascade will nest it. In the nested-block
cascade the assembler already emits, arm *m*'s body sits at depth
`N − m` from the head, so the branch depth is **not a constant** and the
backend cannot emit it.

That is not fatal, because the machinery for exactly this already
exists: bodies are copied verbatim *except* at positions named in the
per-member fixup list, which is how union import indices are rewritten
today (`W64_MAX_FIXUPS` 1024). So the backend emits a chain exit as

```
  <successor tidx already in $scr0, as today>
  local.get $scr0
  i32.wrap_i64
  i32.const BASE   ; fixup, 5-byte padded
  i32.sub
  i32.const N      ; fixup, 5-byte padded
  i32.lt_u
  if
    br DEPTH       ; fixup
  end
  <today's return_call_indirect, unchanged>
```

and registers three fixups per exit; the assembler patches all three
once it knows `m` and `N`. Three things make this cheaper than the
sketch it replaces:

- **No new local, and no fourth parameter.** The successor's table index
  is *already* in `$scr0` at this point (`w64_chain_go`,
  `tcg-target.c.inc:1441`) and `$scr0` is a declared local, so it
  survives the `br`. The cascade head reads it back —
  `local.get $scr0; i32.wrap_i64; i32.const BASE; i32.sub; br_table` —
  which is why the merged function can keep **type 0** without the local
  renumbering the round-31 note rejected a fourth parameter to avoid.
- **A batch that declines to merge patches `N = 0` and `DEPTH = 0`.**
  `i32.lt_u` against zero is never true, so the arm never runs; `br 0`
  inside its own `if` is a valid depth in *any* body, so the unmerged
  module still validates. No second code path, and no precondition that
  can strand a body.
- **There is exactly one site to change.** Both `goto_tb` and `goto_ptr`
  reach the transition through `w64_chain_go`, so the whole emitter-side
  change is that one function, gated on `w64_merge_mode()` so a build
  with merging off emits literally today's bytes.

The in-TB machinery this leans on already exists and is proven: a TB
whose labels form irreducible control flow is *already* emitted as
`local.set $bp; br $loop` into a top-level dispatch loop
(`tcg-target.c.inc:596–608, 1415–1416`). Selector-plus-branch-to-head is
not a new shape for this backend — the merge extends it from within one
TB to within one module.

Three consequences worth having before anyone starts:

- **The binding constraint is the fixup's *width*, not its count.**
  The batch's fixup array grows on demand (`B.cap_fix` doubles through
  `g_realloc`, `wasm64.c:2475`), and `W64_MAX_FIXUPS` 1024 is the
  *per-TB* emitter's array (`tcg-target.c.inc:46`, checked at 1404) —
  three fixups against one or two chain exits per TB is nowhere near it.
  What does bind is that a fixup patches a **fixed two-byte ULEB**
  (`p[0] = (uimp & 0x7f) | 0x80; p[1] = uimp >> 7`, `wasm64.c:1644`), so
  a patched value must fit in 14 bits. `N` and `DEPTH` do; **`BASE` does
  not** — it is a `tidx`, allocated one per TB globally, and reaches
  millions. That wants a second fixup kind writing a 5-byte padded ULEB,
  which is an idiom the file already has (`w64_read_leb5`).
- **`br` out of an `if` is legal and cheap, but the value stack must be
  empty at that point.** Every chain exit in the current emitter reaches
  `w64_chain_go` with its result already materialised, so the `if` has
  to be opened *after* the value is consumed into `$sel`, which the
  sketch above does deliberately.
- **The fan-in is real and it is ~259, not ~5.** Measured, not assumed,
  from the counters of an ordinary J2ME leg: game 1 translates
  `tbGen` 6985 TBs into `modCount` **27** modules (**258.7 members
  each**, `modBytes` 8.87 MB → 328 KB a module); game 2 is 1474 into 4
  (368.5 each). The "batches average 4.9 TBs" figure carried in the
  pipeline notes is a *boot* number from before the interpreter tier
  changed what closes a batch, and it must not be used here — it would
  have made the merged function pointless by construction. At 259 arms
  the cascade is exactly the shape `tests/wasm/mergeshape.mjs` already
  validates to 1024.
- **This is what makes locality the gating measurement rather than a
  detail.** The scheme converts only same-module transitions; every
  cross-module one still pays the full 27.9 ns *plus* the new compare.
  At a same-module share `p`, the yield is `p × ~25 ns × 108 k/Mi`
  against a budget of 5.686 ns/insn — **28 % of wall at p = 0.6, 9 % at
  p = 0.2, and negative below about p = 0.05.** Nobody has measured `p`.
  `W64_COLOC` bounds it from below (it sees only inline-cache misses,
  the least local population); the honest number wants a translation-time
  count of same-batch successors, which is a counter and not a lever and
  can ride along with the next rebuild.

**So the order is: measure the stub build, then decide.**  The stub
version ships nothing and is default-off, but it is the only way to put
a real number on the tier-up half, which nobody has — the 3–6 % is a
*ceiling* read off a browser flag, not this mechanism's yield.  A
measured stub result of ~0 would say tier-up ≈ stub cost ≈ 3 % and make
the store design worth its backend change; a measured loss says the
whole item is smaller than the flag suggested.  Either way the number
comes from the emulator, not from the synthetic.

**New in round 28 (0116): the ARM exception
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

7. **J2ME throughput — ANSWERED for the device path, round 30 (0118).**
   The "remaining third" named here was right, and it is now spent: the
   DMAC per-word MMIO write (**A**, 321 ns/word) and the DIF FIFO word
   loop's byte-at-a-time bus walk (**B**, 137 ns/word) are both gone, and
   a general TB-lookup cache (**C**) took another 6.8 % on top —
   **51.49 → 77.53 MIPS/cpu, +50.6 %** on an actual running game.  The
   meter is no longer `stopwatch.mjs`: use **`tools/j2mebench.mjs`**,
   which boots CX70, walks the firmware menu to a game, plays it, and
   reports **`MIPS/cpu`** — guest Mi over the CPU seconds the vCPU thread
   itself burned, taken from `/proc/<pid>/task/<tid>/stat` at the
   window's own two ends.  That denominator is why this no longer "drifts
   with host load": the same ladder read 77.53 at load 43.7 and 75.30 at
   load 54.1.  `tools/j2meab.sh` runs the four-config palindrome.
   **What is left is not the device path.**  The counter-visible events
   (`difTxWord` 12 828, `hflagsCalls` 1 896, `dmacBurst` 1 603, `lookup`
   1 252, `execIter` 746, `excSwi` 677, `slowNotdirty` 428 per Mi) sum to
   roughly 20 k events/Mi; even at 100 ns each that is ~15 % of the
   13.47 ms/Mi the window costs.  **~85 % is the emitted code executing
   1 M guest instructions at ~11.4 ns each** — ~34 host cycles per guest
   instruction.  The next lever is code quality, not another device.

   **Correction, round 31: that last sentence was wrong, and the way it
   was wrong is the lesson.**  Three further *device* mechanisms —
   `lcd_run_rows` walking rows instead of pixels, `dmac_coalesce_words`
   taking a whole stream burst in one call, and the DIF's RX-tail skip —
   are worth **+17.5 % of `MIPS/cpu`, 8/8 legs separated in both games**,
   i.e. 1.83 of 12.25 ms/Mi = **15 % of wall**, after everything above
   had already landed.  The arithmetic that closed the device path
   ("~20 k events/Mi, even at 100 ns each is ~15 %") failed twice over:
   it priced each event at a *guessed* 100 ns when a display burst is
   ~600 ns and rises with its length, and — the larger error — it counted
   only the events the device counters *name*.  One `dmacBurst` also buys
   a `memory_region_dispatch_write`, a BQL round trip, a
   `timer_mod`/`icount_get` re-arm and a VIC level change, none of which
   has a counter of its own and all of which die with the burst.
   **A path is not priced until something has been switched off**;
   summing the counters you happen to have is a lower bound wearing the
   costume of a total.

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

## Update (2026-09-17, round thirty-two: the meter was wrong by a factor of two)

**`MIPS/cpu` was built to be load-robust, was documented as load-robust,
and had never been regressed against load.** It is not. Fitted *within
identical configurations* — every `(tag, arm, game)` group mean-centred
first, so a build that happened to run in a quiet hour cannot set its own
correction — `log(MIPS/cpu)` on `log(1-minute load)` has slope **−0.29**
with **r = −0.73** across 64 legs. Load ran **4.1 to 42.2** during this
round's battery, so the confound alone spans **1.96×**, against A/B
effects of 2–16 %. CPU time divides out how many *seconds* the host gave
the vCPU thread. It cannot divide out how much work a second contains,
and under SMT and memory-bandwidth contention on a 32-core shared host
that is most of what moves.

**What forced the issue, and it could only have been the counters.** Two
legs of `lcdrow-on` game 2 — same binary, same query string, same
`--game`, nothing between them but four minutes — read **82.25** and
**144.35** MIPS/cpu. The per-Mi table settled it: every guest-side
counter agreed to within **0.4 %** (`ssiByte` 1.004, `lcdPx` 1.004,
`difTxWord` 1.004, `hflagsCalls` 1.006, `armIrq` 1.006, `excSwi` 1.006,
`halt` 1.004, `tpuRamW` 1.003), so the guest executed the same
instruction stream and the emulator did the same work. The 1.76× had
nowhere left to live but the host — and the host's load had gone from
29.5 to 16.6. A clock cannot make this diagnosis about itself.

**Identical-config repeat spread, 28 groups: median 12.0 %, max 54.8 %.**
Every verdict this round was quoted to a tenth of a percent against that.

**The palindrome does not cover this, and it fails in the worst
direction.** `off on on off` cancels *linear* drift because both arms
average to the same midpoint. The host went quiet between leg 3 and leg 4
— load 26.3, then 5.1 — so the step landed entirely on the second `off`,
which is the one position that cannot cancel. `lcdrow` came out **−34.7 %**
on game 1; corrected it is **−10.7 %**, with the arms sitting at mean
load 27.9 against 13.1.

### What this leaves standing

Re-derived with the correction and the duty guard (`scratchpad/verdict.py`,
which now prints each leg's load, a corrected column, and `LOAD-SKEWED`
when the arms differ by more than 15 %):

| tag | knob on the `off` leg | g1 raw → corrected | g2 raw → corrected | reading |
|---|---|---|---|---|
| `disp` | `DMACOAL=1 & NORXTAIL=1 & NOLCDROW=1` | +17.4 → **+15.6 %** | +17.7 → **+16.6 %** | n=4/4, load-balanced, tight — **stands** |
| `txfast` | `NOTXFAST=1` | +3.5 → +4.4 % | +20.2 → +6.9 % | both positive, balanced — plausible |
| `nested` | `NONESTED=1` | +17.4 → +17.1 % | — | g2's `off` arm wholly dropped by the duty guard |
| `noliftoff` | `--js-flags=--no-liftoff` | +1.3 → +0.3 % | −13.6 → −11.4 % | games disagree — the V8-tier ceiling is **not** settled |
| `chain` | `CHAINLOOP=1` | −5.5 → +1.3 % | +6.6 → +6.9 % | overlap both games — null |
| `pccin` | `NOPCCIN=1` | −0.2 → −7.1 % | −15.4 → +0.8 % | correction makes the games *disagree* — unsettled |
| `lcdrow` | `NOLCDROW=1` | −34.7 → −10.7 % | −11.7 → +10.8 % | contradictory — unsettled |

Round thirty-one's **+17.5 % headline for the display bundle survives**
(+15.6 / +16.6 %, four legs an arm, arms within 3 % of each other on
load). It is also the only large effect in the round that does, and it is
*already shipped* — the `on` arm is the default build. **Nothing new has
been won yet this round; what has been won is the ability to tell.**

### The repair

- `hostBusy` — the host's non-idle fraction over **exactly** the
  measurement window, from `/proc/stat`'s all-CPU line differenced at the
  window's two ends. The 1-minute load average is smoothed over 60 s and
  the window is 6–11 s of wall, so loadavg is mostly describing seconds
  the window did not contain; this is the honest covariate, and
  `verdict.py` switches to it automatically once 12 paired legs carry it.
- `hostLoad0` alongside `hostLoad`, so drift *across* a window is visible
  rather than inferred.
- `--maxload N` / `--loadwait S` (file defaults `tests/.j2me-maxload`,
  `tests/.j2me-loadwait`): wait for a quiet host before the window opens.
  Three details, each of which was a bug first:
  - It **measures anyway** after the budget runs out rather than failing.
    Failing would retry three times and drop the leg, and a dropped leg
    punctures the palindrome — worse than a leg the read-time correction
    can partly undo.
  - The wait goes **before the real-time cap comes off**. Uncapped, the
    guest warps its own clock as fast as the host allows, so a ten-minute
    wait after the uncap plays the game for hours of its own time and
    opens the window on something the `--start` plan never aimed at.
  - The budget is **one deadline for the process**, not one per wait. The
    wait sits inside the three-attempt walk loop and a sweep runs one
    window per `--game`, so a per-wait budget would let six waits spend
    6 × 600 s and walk straight through `ab4.sh`'s 1800 s leg timeout.
- The threshold has a **file** default because a battery already running
  has its shell drivers' environments fixed at launch, and editing a
  script bash is currently reading corrupts it mid-leg.
- **The threshold was then set to a value the host can never reach, which
  is the same bug in the other direction.** Armed at `10`, against a host
  whose recorded load across 72 legs is min 4.1 / median **25.9** / max
  42.2, with only **3 %** of legs ever at or below 10. That guard cannot
  pass: it spends the full 600 s budget and measures anyway — ~40 min per
  four-leg tag, bought nothing. Re-armed at **30 / 240 s**, which
  truncates the *untrustworthy tail* (load > 30, the worst ~22 % of legs,
  where a fitted exponent extrapolates worst) instead of chasing a quiet
  hour that does not come. A gate's threshold is part of the gate: one
  nothing passes is as useless as one everything passes.
- **The load is not mine.** Sampled instantaneously (`/proc/<pid>/stat`
  deltas, not `ps` lifetime averages), this container draws **1.3 cores**
  while the host sits at **24.8** of 32. The 10 001 processes visible are
  **9 950 zombies** — PID 1 here is `sleep infinity`, so every exited
  process is reaped never. No leaked browsers, no self-inflicted load:
  the confound is other tenants, and waiting is the only lever over it.

### What the workload actually is, measured on counters rather than clocks

The meter repair is worth having because it made the *clock* readable
again, but every finding below comes from the counters, which agreed to
0.4 % across a 76 % clock swing and are the only instrument this host
cannot corrupt. All ratios are medians over **99 legs**, two games and
every A/B configuration in the round.

**Full speed is 125 MIPS.** icount `shift=3` puts 8 ns of guest time on
every instruction, so the guest is at real time when the emulator retires
125 Mi/s. This build delivers **113 MIPS (90 %)** on the loaded host and
**144 MIPS/cpu (115 %)** when it is quiet. The gap the user asked to
close is therefore **~11 %, and only under load** — not a factor.

**There are no `cpu_loop_exit` longjmps left.** `execLjmp` is absent from
all 99 legs, and absence *is* the reading (`j2mebench.mjs:687` skips a
counter whose window delta is exactly zero). The emscripten JS-exception
unwind is priced at ~15 µs, wasm-EH longjmp does not compose with
ASYNCIFY (binaryen's pass crashes on `-sSUPPORT_LONGJMP=wasm`), and this
workload takes 691 exceptions per Mi — at 15 µs that would be 10.4 ms
against a 9.5 ms/Mi budget, i.e. impossible. Patches 0013 (SVC without
the longjmp) and 0025 (WFI) already spent this. **`arm_excp_exit_ok()`
has exactly one call site, `EXCP_SWI` at `translate.c:7914`** — and the
counters say that is enough, because `excSwi` (680.5) + `excIrq` (10.65)
= `armIrq` (691.2): in steady state this guest raises nothing else.

**The whole dispatch layer is exception-driven, and that is one lever,
not four.** Since 0091 a chained TB never returns to the loop, so what
breaks a chain is what costs:

| ratio | median | range over 99 legs |
|---|---|---|
| `execIter`/SWI | 1.10 | 1.08 – 1.24 |
| `lookupJc`/SWI | 1.09 | 1.07 – 1.19 |
| `armIrq`/SWI | 1.02 | 1.01 – 1.04 |
| `hflagsCalls`/SWI | 2.80 | 2.70 – 2.90 |
| `lookupQht`/SWI | 0.74 | 0.30 – 1.27 |

The first four are constants of the workload: they hold across two games
whose SWI rates differ by 1.6× (680 vs 1095 /Mi) and across every knob
tried this round. The exec loop goes round **once per guest exception and
essentially never otherwise** — the header's S75 boot put exceptions at
77 % of unwinds; here it is ~91 %. Chaining is therefore already doing
its job: the mean chain runs ~1000–1470 guest instructions and is broken
by a syscall, not by a branch. `lookupQht`/SWI is the one ratio that
*moves* with configuration, which is why it is what the `pcc`/`lc` A/Bs
are actually measuring.

**Two paths are closed and should not be re-opened.** Display: with
DMACOAL on, `dmacRun` falls 1471 → 25.5 /Mi (58×) and `lcdRow` 1471 →
100.9 (14.6×), leaving 127.7 px per row call decoded by a bulk loop —
two byte loads, a shift, a decode, a store — at ~0.4 % of the budget.
`ssiByte` reading exactly 2× the word rate is **not** a byte-at-a-time
loop; `dif_v1.c:952` is `+= chunk * word_bytes`, a bulk increment, and
`difRxskip`/`difTxWord` = 99.2 % says the per-word RX loop is already
skipped. Module pipeline: `modNs` = 21.5 µs/Mi = **0.24 %**.

**The per-exception cost is settled, and it is the small end of the
spread: ~1.4 %, not ~7 %.** The 6× uncertainty is closed, and no new run
was needed to close it — the reading was already on disk, in
`j2me-2026-09-17-12-28-dist-jit-excns.json`. Over 1,304,369 timed
exceptions:

| span | measured | less one clock read | per Mi |
|---|---|---|---|
| `excCal` (one `get_clock_realtime`) | 163.3 ns | — | — |
| `excDoNs` (`arm_cpu_do_interrupt`) | 286.7 ns | **123.4 ns** | 82.6 µs |
| `excBqlNs` (BQL lock + unlock, two reads) | 375.7 ns | **49.1 ns** | 32.9 µs |

At 669.7 SWI/Mi that is **115 µs/Mi**: 0.92 % of this leg's own 12.46
ms/Mi, and 1.44 % against the 8 ms/Mi that 125 MIPS would spend. `excN`
equals `excSwi` **exactly** (1,304,369 both), so every timed exception is
a syscall and nothing else is hiding in the count. An ARMv5 exception
fast path is therefore worth ~1.4 % at the absolute ceiling of a perfect
implementation, which puts it in the same class as `pccin`, `chain`,
`nopcc` and the inline-cache work — all of them fighting over ~1 %.

Two things about the instrument, because both misled once.
**`W64_EXCNS` arms two different spans and only one of them is live.**
`EXC_LJ_NS`/`EXC_LJ_N` bracket the *longjmp unwind* — opened in
`cpu_loop_exit` (`cpu-exec-common.c:91`) and closed inside the
`sigsetjmp(...) != 0` branch (`cpu-exec.c:1985`) — and since `execLjmp`
is zero that span never opens, which is why it reads empty and why it
looks at first like a broken knob. The live one is the second site,
`cpu-exec.c:1613`, which brackets `tcg_ops->do_interrupt` itself. It does
price the ARM exception entry; it just does not announce that in its
name. And **every raw value is an exact multiple of 1 ms** because the
browser clock is ms-quantized: each individual span reads 0 or 1 ms, so
the sums are Bernoulli estimates — unbiased over a million events,
meaningless over a hundred.

A caution for whoever reads `hflags`, `hflagsFast`, `hflagsBad` and finds
them zero: they are gated behind `WASM_DIAG_HOT`, which the shipping
build compiles to `((void) 0)`. That is a disabled counter tier, **not** a
fast path that never fires, and the header says never to measure a
wall-clock A/B against a hot-counter build.

### Every leg on disk measured the engine's ceiling, not the game's speed

**All 239 recorded legs ran `uncap=true`. There is not one capped
measurement in `tests/results`.** That is deliberate and, for A/B work,
correct: `--uncap` defaults to 1 (`j2mebench.mjs:131`) and drops the
real-time cap for the play window alone, because "this window runs
uncapped so that the engine's own ceiling shows" (`:798`). It is the
wrong instrument for the question that started this work — *the game
still doesn't run at full speed* — and it cannot be made to answer it.

Uncapped `vratio` reads a median **2.03** on game 1 (n=167) and **4.35**
on game 2 (n=72). Neither means the game runs at twice or four times real
speed. Under icount a halted guest's virtual clock is advanced for free,
so `vratio` is inflated by exactly the idle fraction, and `duty` says
that fraction is large: **0.348 and 0.149**, i.e. the guest is halted for
65–85 % of virtual time *while a game is being played*. `vratio` and
`duty` are two views of one number and neither is a speed.

So the throughput this round has been optimizing — MIPS/cpu, the ~11 %
gap — describes only the compute-bound moments, and nothing on disk says
what share of the wall clock those moments are. `--uncap 0` keeps the cap
on through the window; `rtcapThrotNs` then counts the time the cap spent
*holding the guest back*, which is headroom measured directly rather than
inferred. `vratio ≈ 1` with a large `throt%` means throughput is not what
binds and this round's whole target is worth less than it looks;
`vratio < 1` with `throt% ≈ 0` means it is. `capchar-ab.sh` runs it.

### The headroom is 2.1× and 4.5×, and "125 MIPS" was never the target

This needs no new run either; it falls out of the 229 legs already on
disk. To hold real time the emulator must retire `duty × 125` Mi per wall
second — 125 MIPS is what a **100 %-duty** guest would need, and these
games are 15–35 % duty:

| | required | delivered (median) | headroom |
|---|---|---|---|
| game 1 | 43.5 MIPS | 91.0 | **2.09×** |
| game 2 | 18.8 MIPS | 85.0 | **4.53×** |

The model checks out: `mipsCpu / (duty × 125)` predicts the measured
`vratio` to a median ratio of **1.04** (g1, n=155) and **1.05** (g2,
n=74), with an inter-quartile range of 0.01. That tight, constant 4–5 %
residual is the non-CPU work — display, timers, browser — and its
constancy is what makes the accounting trustworthy.

So **the "~11 % gap to 125 MIPS" is not a gap to anything the games
need.** On this host they already run 2–4× faster than real time, and
every lever this round has priced — the exception entry at 1.4 %, the
inline cache at ~1 %, display at 0.25 %, the pipeline at 0.24 % — is a
few percent of a budget that is already 2–4× oversubscribed. That is the
honest reason the `pccin`, `chain`, `nopcc`, `merge` and `lc` A/Bs keep
coming back null: they are real mechanisms, correctly instrumented,
competing for a resource that is not scarce here.

Which raises the question this round should have asked first: *where* is
it not fast enough? Not on this machine, on this window. The candidates
are a slower device (the header's own rule of thumb is **phone = desktop
v/wall ÷ 5**, which turns game 1's 2.09× into 0.42× — slow motion, and
exactly the reported symptom), or a phase the 45-guest-second play window
never covers, such as game startup and class loading. Both are testable
and neither is a micro-optimization. **Establish which before spending
another round on 1 % levers.**

### Answered: the mean was the wrong statistic, and the peak is duty 1.0

The phase question above is now measured, and it corrects the section it
follows. `--trace` samples frames and instructions every 2 virtual
seconds, which is a duty series for free (`duty = Mi × 8 ns / width`).
Run on game 1 on a quiet host, it does *not* show a flat 0.35:

| virtual s | fps¹ | Mi | duty | MIPS needed |
|---|---|---|---|---|
| 6–43 (18 bins) | 5.5–10.5 | 31–55 | 0.12–0.22 | 15–28 |
| **2** | 19.0 | 246 | **0.984** | **123.0** |
| **45** | 19.5 | 246 | **0.984** | **123.0** |
| **47** | 18.5 | 251 | **1.004** | **125.5** |
| **49** | 19.5 | 251 | **1.004** | **125.5** |
| **53** | 20.0 | 239 | **0.956** | **119.5** |
| 55 | 14.5 | 186 | 0.744 | 93.0 |

¹ frames-per-virtual-second, a warp artifact in an uncapped leg — see
the caution below; it is listed only because the raw trace prints it.

Five of 32 bins sit at duty ≈ 1.0 — the guest asking for *the entire*
125 MIPS — inside the very window whose mean read 0.348. The mean was an
average over phases that behave nothing alike, and it reported the idle
one because that is where the instructions are not.

So the answer is **both, and the phase is not where this section guessed
it was**. It is not startup, and it is not before the window: it is
*inside* it. `--shots 6` caught the panel at 49 s showing *"Atomic
Skater — Level 2 — Lives left: 3"*, with ordinary platform gameplay at
36 s and 61 s on either side. The saturated stretch is a **level
transition**.

Two things about it invert the natural reading:

- **Do not read the fps column of an uncapped trace.** It is tempting to
  say the saturated bins "draw more" because they show 18.5–20 fps
  against the quiet bins' 5.5–10.5, but `fb_updates` is paced by *real*
  time while the bin is measured in *virtual* time, and an uncapped leg
  warps the two apart by exactly the factor that differs between these
  phases. The same 45 virtual seconds of game 1 drew **468 frames
  uncapped and 1063 capped**. Per bin the implied warp is 1.43× where
  duty is 0.98 and 9.8× where duty is 0.14, which alone predicts a ~6.8×
  spread in frames-per-virtual-second; the observed spread is 3.3×. The
  column is a warp artifact with an unknown residue, not a rendering
  measurement. **duty is the trustworthy series** — it is virtual-time
  based and cap-independent — and the phase identification rests on the
  `--shots` panels, which are direct evidence.
- **The levers are not competing for a slack resource after
  all.** The claim above — "a resource that is not scarce here" — holds
  for 27 bins of 32 and fails for the five that matter. During a level
  transition this host needs 123–125 MIPS and delivers 91 loaded (it
  delivered 176 on the quiet host that took this trace). A user's browser
  clears that bar by less, or not at all, which is the reported symptom
  without needing the ÷5 phone rule at all.

**Instrument cautions, both of which would have inverted the reading:**

- **Trace bin 0 is not a bin.** The sampler pushes a *cumulative* insn
  count (`j2mebench.mjs:583`) and the printer differences from `pf=pi=0`
  (`:723`), so the first entry prints the absolute counter — every
  instruction since the emulator started, i.e. the whole boot. For g1
  that is 1521 Mi, which reads as duty 6.08 over 2 s. Drop it.
- **Bins are polled, not scheduled.** `nextTrace = v + 2e9` is only
  applied once a poll observes the deadline, so a bin can be wider than
  2 s — the g1 series steps 36 s → 39 s. Divide by the real width or a
  wide bin looks busier than it was.

**Game 2 measures nothing here** and should not be read as a contrasting
result: it sits at duty 0.084–0.092 and 5 fps for 55 of its 65 seconds,
which is a screen the `--play` pattern never engages. The meter launches
it but does not play it. Fixing that walk is a prerequisite to any claim
about game 2, and the "4.53× headroom" row above is measuring an idle
title screen.

### The consequence: profile the bin, not the window

The `perMi:` rollup spans both window ends, so on game 1 it is an average
over 27 idle bins and 5 saturated ones. It is instruction-weighted, and
the instructions are split far more evenly than the bin count suggests:

| phase | virtual s | share of time | Mi | share of instructions |
|---|---|---|---|---|
| saturated (duty ≥ 0.8) | 10 | 15 % | 1233 | **46.6 %** |
| middle (0.3–0.8) | 4 | 6 % | 363 | 13.7 % |
| idle (duty < 0.3) | 51 | 78 % | 1052 | 39.7 % |

So the rollup is roughly a 50/50 blend of two unlike workloads — it
describes *neither*, rather than describing the idle one. The practical
consequence for A/B design is milder than the bin count implies but still
real: a lever that only bites in the saturated phase is diluted **2.15×**
in any per-Mi counter or in MIPS/cpu. A genuine 10 % win on the phase
that matters surfaces as 4.6 % window-wide, which is within the noise
this workstream has been fighting all round. `--tracec` (added this
round, default off) snapshots every counter at every trace sample and
emits the series as `traceCs` in the JSON, so consecutive bins can be
differenced and the duty ≈ 1.0 bins profiled on their own. That is the
measurement the next lever should be chosen from — and it is the first
one in this workstream aimed at a phase that is actually CPU-bound.

### Why every A/B this round was null: the instrumented mechanisms are 2.6 %

Priced against the same leg's own per-instruction cost, every mechanism
this workstream has instrumented — together — is a rounding error. The
g1 phase-trace leg ran at MIPS/cpu 175.86, i.e. **5.686 ns per guest
instruction**, a budget of 5686 µs per Mi:

| mechanism | µs/Mi | share |
|---|---|---|
| exception entry (`excSwi` 682.8/Mi × 172 ns) | 117.4 | 2.07 % |
| display DMA (`dmacBurst` 25.46/Mi × 638.8 ns) | 16.3 | 0.29 % |
| module pipeline (`modNs`, already ns/Mi) | 12.3 | 0.22 % |
| **total accounted** | **146.0** | **2.57 %** |
| **unaccounted — raw emitted-code execution** | **5540.4** | **97.43 %** |

This is the round's real result, and it subsumes the rest. `pccin`,
`chain`, `nopcc`, `merge`, `lc`, `lcdrow`, `rxtail`, `excns`, `dispns`
all came back null or sub-1 % **not because they were mis-measured but
because they are all inside that 2.6 %**. No arrangement of them reaches
10 %. The 2.15× phase dilution above is a second-order worry next to
this: a lever confined to the accounted 2.6 % cannot matter regardless of
which phase it lands in.

The cost is in the emitted code itself. 5.686 ns per guest ARM
instruction is ~17 cycles of a ~3 GHz core to execute one guest
instruction — where an optimised native TCG backend spends 2–4. The 2×
Liftoff penalty is real but already banked (V8 tiers the TB functions up
on its own; stock is within 5 % of TurboFan-only). So the remaining gap
is **what the wasm64 backend emits per guest instruction**, and that is
where the next round belongs:

- `tcg/wasm64/tcg-target.c.inc` — instruction selection and the
  per-op emission shape.
- The TB call boundary and prologue/epilogue, now that the boundary
  itself is known to be only ~2 ns.
- Whether a TB-per-wasm-function structure is the right unit at all
  (queue7's merged-module emitter is the standing experiment here, and
  queue9's "where does the vCPU thread actually go" is the profile that
  should pick the target — its truncation problem is precisely that a
  profile of emitted code is thousands of one-sample frames).

**Stop pricing peripheral mechanisms.** The measurement discipline was
sound; it was aimed at 2.6 % of the machine.

### The density number, which is where the 97.4 % goes

Three counters already on disk size the emitted code, and they have never
been divided into each other. From the same g1 leg (`tbGen` 6850,
`tbBytes` 8,449,465, `tbIcount` 69,932):

| | |
|---|---|
| bytes of wasm per TB | 1233 |
| guest instructions per TB | 10.2 |
| **bytes of wasm per guest instruction** | **120.8** |
| mean re-executions of a translated TB | ~28,000× |

At 2–3 bytes for a typical wasm opcode-plus-LEB128, 120.8 bytes is on the
order of **40–50 wasm instructions emitted per guest ARM instruction**. A
native x86-64 TCG backend emits roughly 10–20 *bytes*. wasm is a stack
machine with LEB128 immediates and is inherently more verbose, but not by
this margin.

The re-execution factor matters as much: at ~28,000 executions per
translated TB, *nothing about translation cost can matter* — which is
why `modNs` prices at 0.22 % and why every module-pipeline lever from
rounds nineteen and twenty-six is closed. The entire budget is in
executing those ~45 wasm instructions, ~28,000 times each.

So the metric that looks like the one to move is **emitted wasm
instructions per guest instruction**. Two structural facts in the backend
offer themselves as levers, and **both are already closed on disk.** They
are written out here because the density number makes them look new, and
they are not.

- **The inline TLB probe is 37 % of emitted bytes and 5.07 % of wall.**
  The byte share is real (`optimization-playbook.md` § 0b, per-opcode
  histogram: `qemu_ld` 83.9 B/op, `qemu_st` 86.9 B/op) — but round
  twenty-three priced the probe *directly*, with `W64_TLBDUP=N` emitting
  N extra real probes per memop, and the N=1→2 slope reads **5.07 % of
  EL71 wall, not 37 %**. Bytes are not time here, and the factor is
  seven. Worse for the idea: the obvious replacement was then built end
  to end and **reverted for being 4.4–5.0 % slower** (§ REJECTED, the
  per-site TLB entry cache — `W64_SITECACHE`, 26.62 s off vs 27.83 s on,
  and it is not slot locality: an unlimited pool loses as much as an
  8192-entry one). The reason generalizes and is the part to carry: a
  duplicate-probe instrument emits its copies **straight-line, outside
  any branch**, so it prices the work and not the branch the replacement
  would really live behind. **+5.07 % is an upper bound on deleting the
  probe entirely, not a budget to spend** — and a scheme that *fronts*
  the probe with a cheaper check can only add to the path. Retry only
  with something that replaces it outright.
- **The TB boundary is not an open question either — it is the answer,
  and it is already measured on this exact game.** The "~2 ns boundary"
  above was wrong, and so was the instinct to look for it in bytes.
  Two numbers, taken independently, agree:

  | source | per-boundary cost |
  |---|---|
  | four-point `w64_ft_max()` sweep, **this game**: `ns/insn = 9.83 + 27.87 × exits/insn`, fit to 1.2 % | **27.9 ns** |
  | 0108's merge differential on EL71 (exits/Mi 231 300 → 172 650 against 87.1 → 105.2 Minsn/s) | ~33.7 ns |

  A third row used to stand here — `dispatchbench`'s unpredictable
  `return_call_indirect` at ~27 ns — and it agreed so well that it
  looked like confirmation. It was coincidence, and the section below
  (*The boundary mechanism is not a lever*) shows why: that 27 ns was
  the cost of a **randomly chosen target**, not of a dispatch opcode,
  and the emulator's own targets are per-site predictable. Round
  twenty-three's 7.7 ns, long treated as the outlier, is the honest
  price of the *transition*; the missing ~20 ns is everything else a
  boundary does.

  Which is the useful form of the number, because it says where to
  push. `goto_ptr` is **67.8 %** of J2ME boundaries (`W64_XCOUNT=1`,
  game 1, 1980 Mi: 80 781 `goto_ptr`, 22 371 fall-through, 16 010
  `which=0`, 16 self-chaining, **119 161 per Mi = 8.4 guest insns per
  TB entry**) — indirect, and so unabsorbable by any translator
  heuristic. The 20 ns, by contrast, is spent on both kinds alike:
  TCG allocates registers per TB, so every live guest register is
  stored to `env` at the exit and loaded back at the next entry, over
  and over, amortised across only 8.4 guest instructions.

  **What changed is the denominator, and it changed by a factor of two.**
  That sweep ran at 11.30 ns/guest-insn and the playbook records the
  boundary as 27 % of wall there. Today's build runs at **5.686
  ns/guest-insn**, and nothing in 0104–0118 touched the boundary — the
  display-DMA, SSI and pc-cache work all removed cost from *elsewhere*.
  A cost that does not move, over a budget that halved, roughly doubles
  its share:

  | | ns/insn | boundary share |
  |---|---|---|
  | round 31 build | 11.30 | 27 % |
  | today (if 108 k boundaries/Mi still) | 5.686 | **~53 %** |

  So the TB boundary is now plausibly **half the emulator**, and every
  other lever this workstream has priced — the TLB probe at 5 %,
  exception entry at 2.07 %, display DMA at 0.29 %, the module pipeline
  at 0.22 % — is rounding error beside it. That is the reading the
  "97.4 % is raw emitted-code execution" line above was missing: a large
  part of that 97.4 % is not *inside* the emitted code at all, it is the
  cost of leaving one TB and arriving at the next, which the density
  metric cannot see because a boundary is a handful of bytes.

  The one input that is genuinely stale is **exits/Mi**, since
  `w64_ft_max()`'s default has since moved to 3 and 0118's pc-cache
  changed what the lookup path does. That is one leg, not a re-sweep —
  `W64_XCOUNT=1` (own wall meaningless, per-Mi rates exact), with
  `W64_COLOC=1` riding along to measure the same-module share the merged
  module's case rests on and which is recorded here as *assumed* ~60 %
  and never once run. Queued as `scratchpad/lever-chain.sh` step 2.

**The merged module is not that lever, and the sweep that was supposed
to gate it killed it instead.** The reasoning that pointed here was:
the boundary is ~53 % of wall, and the merge is the only scheme that
removes the *instance crossing* rather than changing which call opcode
performs it — an intra-module successor becomes a `br` back to a
`br_table` cascade head, with no call at all. The gate was whether
`merged` still beat `xtail` at the ~277 TBs a real module holds. It was
run (`scratchpad/lever-chain.sh` step 1, swept properly over body size
and module count), and at a realistic body size in the order the
emulator actually exhibits, `merged` **lost**: 51.13 ns against
`xtail`'s 35.73 at pad 144 strided. Not a tie to argue about — a
regression, and one that reproduces across the sweep. Removing the
crossing is not worth anything because the crossing is not worth
anything; see *The boundary mechanism is not a lever* below. The merge
item keeps only its tier-up half, which never depended on dispatch.

**The lever the 27.9 ns actually points at is per-boundary state
traffic.** Nothing in the mechanism family touches it, which is why the
whole family tied. Two forms, in order of how well they are sized:

1. **Fewer boundaries — already at its peak, do not re-propose it.**
   This looks like the obvious move and the arithmetic is seductive:
   8.4 → 12 guest instructions per entry removes ~34 700 boundaries per
   Mi, which at 27.9 ns is ~17 % of wall. **It has been run and it
   loses.** `W64_FTMAX` is exactly that knob, and the playbook's
   REJECTED table has the four-point result: 1 → 2 is +4.7 %, 2 → 3 is
   +1 %, and **3 → 4 and 3 → 8 remove the exits and cost wall anyway**
   (exits/Mi 107 960 → 106 706 → 106 140, i.e. −1.16 % and −1.69 %, for
   a clock reading of −1.06 %, 2/5). Three slots is the peak, and it is
   a real peak, not a measurement floor: each extra deferral is another
   label, and 0109 established that label count is what drops a TB out
   of the backend's nested-label mode into the `$bp` dispatch loop where
   every forward branch becomes O(n_labels).

   Which is also the correct reading of the 27.9 ns fit, and the reason
   it must not be quoted as a marginal price. It is a slope **across
   configurations that change labels and TB size along with exit
   count**, so it prices a bundle. Inside the bundle the terms have
   opposite signs and they cross at FTMAX=3. The refusal counters
   confirm there is nothing else to harvest: on game 1, `abCond` is
   **82.2 %** of all refusals, and `abCond` is not a missed absorb at
   all — it is `w64_absorb` handing the branch to `w64_defer_taken`,
   which requires precisely that condition (`translate.c:2000` refuses
   on `s->condjmp`, `:1900` requires it). The genuinely lost population
   is `abBackout` 11.3 % and `abFar` 4.4 %, of 4.5 refusals per Mi
   against 119 161 executed boundaries.

2. **A lighter boundary — the one form nobody has tried.** TCG
   allocates registers per TB, so the boundary's cost is a
   store-to-`env`/load-from-`env` round trip on every live guest
   register, amortised over 8.4 guest instructions. Every result above
   is consistent with this and none of them touches it: the mechanism
   family tied because neither `dispatchbench` nor the CHAINLOOP driver
   has any guest state to spill, and FTMAX peaked because it traded
   boundary weight it could not change against label cost it could.
   `tcgSpill` per translated TB is the first number to look at, and
   `nsbudget`'s `nsrate` leg collects it.

The general lesson the first bullet earns: **an emitted-byte share is not
a time share, and this backend has now proven it twice** — round
fourteen closed emitted-byte count as a lever outright, and the probe is
37 % of bytes for 5 % of wall. Count bytes to find *candidates*; never
size a lever with them. The corollary the second earns is sharper:
**this round spent its whole battery pricing mechanisms while the
largest single cost sat already-measured in the playbook.** Before
instrumenting anything, read § 0d and the J2ME budget table for a number
that already exists.

### Per-boundary state traffic, measured — and it is ~4.5 ns, not ~20

Bullet 2 above is now instrumented rather than reasoned about. Two
counters, `WASM_DIAG_TCG_GLD` / `WASM_DIAG_TCG_GST`, were added to the
three places in `tcg/tcg.c` that actually emit a global's memory access
— `temp_sync`'s `TEMP_VAL_CONST` (`tcg_out_sti`) and `TEMP_VAL_REG`
paths, and `temp_load`'s `TEMP_VAL_MEM` path — so they count the
store-to-`env`/load-from-`env` round trip at translation time, per TB.
Two independent legs agree to **0.85 %**:

| leg | env ops per TB generated | guest insns per TB translated |
|---|---|---|
| `nsrate` (more counters on, 148.7 MIPS) | 18.128 | 10.05 |
| `nsclock` (174.3 MIPS) | 18.282 | 10.11 |

The split is **7.68 loads + 10.45 stores**; more stores than loads is
what a per-TB register allocator should produce, since every live global
is written back at the exit but only the ones the next TB reads are
loaded. Against the executed population — 8.4 guest instructions per TB
*entry*, not the 10.1 translated — that is **≈ 2.16 env ops per
executed guest instruction**, against the guest's own **0.421** memory
operations per instruction. The emulator does roughly **five times the
guest's own memory traffic** purely to move ARM registers in and out of
`env` across boundaries.

**And it is still not the missing 20 ns.** The first reading of this
table priced an env op at ~1.1 ns and concluded the round trip was most
of the 27.9 ns boundary. That is refuted by a number this workstream
already measured: `optimization-playbook.md` § memory64 records
**0.241 (m32) / 0.253 (m64) / 0.258 (m64 dynamic) ns per load** at a
2 GB memory — memory64 bounds checks are free, and a load is a quarter
of a nanosecond. So:

| | |
|---|---|
| env traffic per boundary | 18.13 × 0.253 ns = **4.59 ns** |
| transition mechanism (round twenty-three) | **7.7 ns** |
| of a 27.9 ns boundary | 12.3 ns attributed, **~15.6 ns still not** |
| share of wall at 0.253 ns/op | **9.6 %** |
| share of wall at a pessimistic 0.5 ns/op | 19 % |

The 0.253 ns comes from a tight synthetic loop where every access hits
L1; the real ones are scattered across a 32 KB `CPUARMState`, so the
true price is somewhere in that 9.6–19 % band and nearer the bottom than
the top. Either way it is a large single line item — and **no mechanism
to reduce it was found.** The two obvious ones are both closed on disk:
fewer boundaries is `W64_FTMAX`, already at its measured peak at 3 (see
above), and the emission itself is already minimal — `w64_memarg`
(`tcg/wasm64/tcg-target.c.inc`) folds the offset into the memarg, so
`tcg_out_ld` / `tcg_out_st` are **three wasm instructions each** with
nothing to shave. Reducing it needs a register allocator with a scope
larger than one TB, which is a TCG-wide change, not a backend one.

A reading trap worth carrying, because it cost a wrong number here:
`tbIcount` counts guest instructions **translated**, while everything in
a `perMi` column is already *per million guest instructions executed*.
A per-executed-instruction rate is therefore `counter / 1e6` and never
`counter / tbIcount` — dividing by the latter once reported "14 301
memory ops per guest insn" for a true value of 0.421, inflated by about
34 000×. The two denominators differ by the ~28 000× re-execution
factor, so the mistake is never small enough to notice by eye.

### The boundary budget does not add up, and the gap is a factor of two

Put the three directly-measured components of a boundary next to the
slope that is supposed to price the whole thing, and they disagree
badly. This is the most important open item at the end of this round,
and it was only visible once the env traffic above was counted.

| component | ns per boundary | how it was measured |
|---|---|---|
| transition mechanism | 7.7 | round 23 `dispatch-probe.mjs`, per-site predictable targets |
| env load/store round trip | 4.59 | `tcgGld`/`tcgGst`, 18.13 ops × 0.253 ns (above) |
| declared locals zeroed at entry | ~1.0–1.6 | 0114b's own A/B: +2.05 % for 33 fewer locals |
| **sum of what is measured** | **13.3–13.9** | |
| **the `w64_ft_max()` slope** | **27.9** | four-point fit, 1.2 % residual |

Converted to wall at 5 686 µs/Mi, against either boundary count on
record (107 960/Mi from the FTMAX sweep at the shipping default,
119 161/Mi from `W64_XCOUNT` on game 1):

| | boundary share of wall |
|---|---|
| sum of measured components | **25–28 %** |
| the 27.9 ns slope | **53–58 %** |

**A factor of 2.1, and it is not a rounding argument.** Three
resolutions are live, and they imply completely different next rounds:

1. **The 27.9 ns is a bundle price and overstates the marginal cost.**
   This is the reading the lessons file already warns about (*A slope
   fitted across configurations is a bundle price, not a marginal one*)
   and the FTMAX row above states outright: the sweep changes labels
   and TB size along with exit count, the terms inside have opposite
   signs, and they cross at 3. If this is it, **the boundary is about a
   quarter of the emulator, not half** — every proposal sized against
   "~53 %" in this document is overstated by two, and the question of
   where the other three quarters go is reopened rather than answered.
2. **The 7.7 ns is the wrong transition.** `dispatch-probe.mjs` tail-calls
   within one module; a production exit usually crosses a wasm
   *instance*, and round 27's `merge-probe.mjs` put `ind-in` at
   **13.38 ns** against `ind-in-c`'s 4.48 with its header calibrating
   against "production's ~22 ns". Substituting 13.4 for 7.7 lifts the
   sum to ~19 ns and closes most of the gap. Note what does *not*
   refute this: `W64_CHAINLOOP`'s −0.1 % changes which opcode performs
   the hand-off and **keeps the crossing**, so its null is silent here.
   The only evidence against is `dispatchbench`'s `merged` losing — in
   the synthetic whose target-order knob was shown the same round to
   dominate its mechanism knob.
3. **A component nobody has counted.** The named candidates are the two
   *inline* checks that ride on every `goto_ptr` exit and that no
   mechanism knob removes, because neither is the call: the `w64_lc`
   inline-cache probe, and `gen_goto_ptr_pcc`'s eight TCG ops
   (`target/arm/tcg/translate.c`). Both are emitted into guest code and
   therefore invisible to every C-side counter — the same blind spot
   that made `pccHit` unreadable (see the lessons file, *A counter on
   the slow path is not a hit rate*). `W64_NOPCCIN` is the knob for the
   second, and its recorded result is **unsettled**: −7.1 % on g1 and
   +0.8 % on g2 after the duty correction, i.e. the games disagree.

**What to run, in order, and none of it needs a new mechanism:**

- Settle resolution 2 first, because it is the cheapest and it is a
  pure-JS probe with no browser leg and no rebuild: `dispatchbench`
  already has `DB_NMOD`, so run the *same* mechanism at one module and
  at many and read the difference as the instance-crossing price.
  Run it on a quiet host — it is a microbenchmark and host load
  invalidates it.
- Then build the instrument that has never existed: **a pad that adds a
  boundary.** `W64_CALLPAD` prices an import call placed in a real TB
  (14.5 ns); nothing prices a real *exit*. N extra
  `return_call_indirect` hops through trampoline TBs that do nothing but
  hand on would give the boundary's marginal cost directly, without
  FTMAX's label-and-size confound — which is the whole reason the 27.9 ns
  cannot be trusted as a marginal price.
- Settle `W64_NOPCCIN` last, with the duty-aware method from this round
  (profile the bin, not the window), since it is the one of the three
  that could still be a lever rather than only a correction.

### The 2× Liftoff penalty is real and already banked — at most 5 % left

The one lever in the right order of magnitude was the execution tier:
emitted TB code runs in V8's baseline (Liftoff) at ~2× the cost of the
main module's optimized code, so if the emitted code were stuck there,
tiering it up would be worth ~2×. Three tags on disk settle it (game 1,
n=2 each, duty 0.34–0.37 throughout so the workload is matched):

| V8 tier configuration | MIPS/cpu | vs base |
|---|---|---|
| `--liftoff-only` (never tier up) | 34.9, 37.2 → **36.1** | −49 % |
| stock (Liftoff, then tier up) | 66.9, 73.9 → **70.4** | — |
| `--no-liftoff` (TurboFan only) | 74.4, 73.3 → **73.9** | **+5 %** |

The 2× penalty is real — Liftoff-only is half speed — but **stock is
within 5 % of TurboFan-only, so V8's tier-up is already capturing almost
all of it.** What is left is the residual time spent in Liftoff before
tier-up completes, and the only way measured to get it is
`--js-flags=--no-liftoff`, a Chromium launch flag that does not exist in
the user's browser. Not shippable, and not big.

The four-leg `noliftoff` A/B agrees and shows why it is not worth more
legs: corrected, game 1 reads **+0.2 % (overlapping)** and game 2
**−11.2 %**, on n=2 per arm. Some games concentrate in fewer, hotter TBs
and tier up sooner; the spread is the workload, not the knob.

### The display, re-confirmed — and why an aggregate lies about it

`WASM_DIAG_DISP_NS` is not the dispatcher. It lives in `dmac.c:544` and
"DISP" there means *display*: it brackets one `dmac_transfer_stream`
burst. That burst costs **638.8 ns** (729.4 ns measured, less that site's
own 90.6 ns clock read — 90.6 against the exception site's 163.3, so
calibrate per site and never once for the file). At the coalesced
default's ~35 bursts/Mi that is 22 µs/Mi, **0.25 %**, which confirms the
~0.4 % above by a second route. Uncoalesced it is 1614.7 bursts/Mi =
1.03 ms/Mi = **8.3 %**, which is what DMACOAL is worth and why it is on.

The warning is for anyone aggregating counters over the results
directory: **`dmacRun`/Mi is bimodal and the two modes are 46× apart.**
One cluster sits at 25–48 /Mi and 127.6 px per row, the other at ~1600
/Mi and 8.0 px per row. `disp-on` (34.9) and `dmacoal-on` (47.8) are the
shipping default — those legs carry no env var, since `W64_DMACOAL=1`
*disables* coalescing — against `disp-off` 2197.7 and `dmacoal-off`
2111.8. But `ftA*`, `ftB*`, `cl-*`, `diag`, `xcount` and `tier-*` — some
sixty legs — sit in the uncoalesced cluster. A median over "all legs"
mixes them and lands somewhere between: the `excns` tag's own median is
820 /Mi at 67.8 px/row, a configuration no leg has ever been in. Group
by tag before believing any display number.

## Update (2026-09-17, round thirty-one: the display path, which a sum had retired — 0118/0119)

**The round's headline is +17.5 % of `MIPS/cpu` on a running J2ME game,
and the interesting part is that round thirty had already closed this
path.** Round thirty added up the device counters — ~29 k DMA bursts and
~59 k FIFO words per Mi, at a guessed ~100 ns each — decided the display
stream was worth ~0.9 ms against 11.30 ms/Mi, and wrote "the next lever
is code quality, not another device" into the hand-off. Round thirty-one
put three display mechanisms behind one knob, ran an eight-leg
palindrome, and the path was worth **15 % of wall**. The lesson is
written up in lessons.md ("A path is not priced until something has been
switched off"); the short form is that the price was guessed rather than
measured (a burst is ~600 ns, not ~100), and that only the events the
counters *named* were counted — a `dmacBurst` also buys an MMIO
dispatch, a BQL round trip, a `timer_mod`/`icount_get` re-arm and a VIC
level change.

**The bundle A/B** (`W64_DMACOAL=1 & W64_NORXTAIL=1 & W64_NOLCDROW=1`
switches all three *off*), eight legs, two games, palindromic:

```
all       on 95.99 (n=8 sd 10.42)  off 81.66 (n=8 sd 7.27)  on/off +17.5 %
1st half  on 94.70              off 81.20              +16.6 %
2nd half  on 97.28              off 82.13              +18.4 %
```

Both halves agree, which is the only reason a spread this wide is
readable at all — the host sat at load 26–36 throughout. The three
mechanisms are being split into their own A/Bs so each commit carries
its own number.

**`DIF_RUN_CHUNK` is saturated, and it cuts every DMA burst into four.**
Read off the four-game JSONs, the batch sizes are *identical to four
significant figures in all four games* — `lcdPx`/`lcdRow` = 127.6,
`ssiByte`/`ssiRun` = 255.3 (127.6 words), `difTxWord`/`difRun` = 505.1 —
against `DIF_RUN_CHUNK` 128 (`dif_v1.c:862`). So the DMA hands the DIF
~505 words per run and the DIF chops them into four full chunks, each
costing its own `ssi_transfer_run`, its own `lcd_run_rows` and its own
post-chunk FIFO/overrun bookkeeping. Raising the chunk to 512 would make
that one pass and remove ~69 of each per Mi. That is worth **~0.1–0.3 %**
at a few hundred ns of fixed cost per chunk, so it is a bundling
candidate and not a headline — and it is a compile-time constant, since
`tx[]`/`rx[]` are stack arrays sized from it (512 would make them 2 KB
of frame), so it cannot be A/B'd inside one binary the way the three
knobs above can.

The same table is the cleanest statement of *why* the display bundle
generalizes: four games whose `duty` spans 0.111–0.350 drive the
DMA→DIF→LCD pipeline at literally the same shape. The chain does not
respond to the guest's workload at all, which is what "fixed wall-rate
cost" means when it is measured rather than asserted.

**What the tooling learned to do, and it is the cheapest thing in this
round.** `tools/j2mebench.mjs` now writes the **whole `wasm_diag`
counter set** into every result JSON next to `mipsCpu`, `busy`, `fps` and
`insnsPerFrame`, and `tools/diagnames.mjs` parses the counter names out
of `wasm-diag.h` at run time instead of transcribing them. Five
mechanism verdicts fell out of runs that had already happened, for no
new measurement at all — which is what let a 16-minute `smcscan`
palindrome be dropped rather than run. Per Mi, on the current build:

| counter | /Mi | reads as |
|---|---|---|
| `lookup` | 1 283.7 | helper calls surviving the inline TB cache (was 15 839 before it) |
| `pccFill` / `lcCall` | 508.4 / 531.4 | its refills |
| `lcdRow` / `lcdPx` | 92.3 / 11 784.9 | 128 px per row call — the row walker is live |
| `difTxWord` / `difTxfast` | 11 786.9 / 11 784.9 | ~100 % of TX words take the bswap16 path |
| `difRxskip` | 11 692.6 | ≈1 RX-tail skip per word |
| `dmacRun` = `dmacCoal` = `difRun` | 23.3 | ~505 words per scheduling walk |
| `smcMiss` / `slowNotdirty` | 424.8 / 426.2 | 99.7 % take the notdirty skip |
| `tpuRamW` / `tpuRamSkip` | 545.5 / 545.5 | every TPU-RAM write is skipped |
| `armIrq` / `excSwi` / `excIrq` | 707.8 / 698.1 / 9.8 | one SWI per ~1 430 guest insns |
| `tbGen` = `specMiss` = `irecN` | 3.37 | ~277 new TBs/s in steady state |
| `modCount` = `closeN` | 0.011 | ~277 TBs and ~267 KB per module |

**The C-side pcc buys ten hits per Mi and pays five hundred fills.**
`pccHit` is **10.3 /Mi** against `pccFill` **504.3 /Mi**, and the
structural reason is in the source rather than the numbers:
`w64_pcc_idx()` *is* `tb_jmp_cache_hash_func()` (`cpu-exec.c:575-578`),
so the pcc is a direct-mapped table carrying the jump cache's own hash.
It aliases the jump cache exactly, which is the same root cause as
`lookupConfl` being ~70 % of qht traffic: same hash, same conflicts, so
the second table conflicts wherever the first one did.

Read that as a hypothesis, not a verdict, because this counter has the
round's favourite trap on it. `pccHit` is the **third** layer — the
emitted inline chain probes the same `w64_pcc` array first
(`w64_pcc_shape()` hands `shape.tab = w64_pcc` to the generator) — so a
low C-side hit count is partly "the layer in front already took them",
in exactly the way `lcCall` is the miss path and not the probe count and
`difTxfast += chunk` is a word count and not a call count. Three
counters in this round have now been misread that way on first
inspection; the fills, though, are paid on the miss path no matter who
hit in front of them.

**What has never been run** is the A/B that would settle it.
`W64_NOPCCIN` has one (round thirty-one, plus a confirmation
palindrome); `W64_NOPCC` has only ever appeared *bundled* inside a
three-knob config where it is redundant with `W64_LC_VERIFY`. Nothing
has priced the C-side table alone, and nothing has priced removing the
layer outright — `W64_NOPCC=1` alone leaves the emitted chain still
generated and always missing, so only `W64_NOPCC=1 & W64_NOPCCIN=1`
together is "the pcc removed". Both are disabling knobs, so both read
with ordinary polarity.

### Four games, and which of these costs actually generalize

A single game cannot say what "J2ME performance" is, so the same 45
virtual-second window was run on four games out of `CX70_games.bin`.
The first thing it says is that **the games are not one workload**:

| | game 1 | game 2 | game 3 |
|---|---|---|---|
| `duty` | 0.350 | 0.152 | 0.111 |
| `MIPS/cpu` | 99.8 | 96.3 | 123.8 |
| v/wall | 2.17 | 4.88 | 8.51 |
| Mi in the window | 1 966 | 853 | 625 |

`duty` is the fraction of virtual time the guest is not halted, so games
2 and 3 are **85–89 % idle** and finish the window in 9.2 s and 5.3 s of
wall against game 1's 20.7 s. Only game 1 is compute-bound, and only
game 1 is the case the user is complaining about: at v/wall 2.17 and the
established "phone = desktop v/wall ÷ 5", it lands at ~0.43× real time on
the handset while games 2 and 3 have headroom to spare. **That is the
correction to make to every A/B in this round that quoted game 2 as its
non-overlapping arm** — pccin's did — because a knob measured on a
workload that is halted seven eighths of the time is being measured
against the idle path, not against J2ME compute.

The second thing it says is which costs are *general*. Normalising per
Mi (cost per unit of guest work) rather than per second separates them
cleanly:

- **Scales with idleness, not with the game.** `lcdPx`, `difTxWord`,
  `difTxfast`, `difRxskip`, `ssiByte` all rise 2.4× from game 1 to game
  3, exactly inverse to `duty`. Converted back to absolute rates they
  are 558 k / 419 k / 421 k pixels per virtual second — near enough
  constant. The display chain is a **fixed wall-rate cost**, so it is a
  larger share of a cheaper game, which is why the display bundle
  measured +17.5 % and why it is worth shipping regardless of game.
- **Scales with guest work, in every game.** The exception rate is
  698 / 1 109 / 802 / 444 per Mi across games 1–4 — a 2.5× spread across
  workloads whose *device* rates swing the other way, and all of it in
  the same band. One guest exception per roughly 900–2 250 instructions
  is a property of the **JVM**, not of any game.

  `armIrq` is the right counter for that rate, and it is **not** an
  independent event to be added to `excSwi`: it counts
  `arm_cpu_do_interrupt` calls, so it is the dispatch entry for every
  taken exception and equals `excSwi + excIrq` — verified exactly, delta
  zero, in all four games. Adding the two double-counts the path.
- **The guest takes only two kinds of exception.** `excUdef`, `excPabt`,
  `excDabt`, `excFiq` and `excOther` are **zero** in every game, and SWI
  is 95.9–98.5 % of what remains (the rest is `excIrq`, 11–33 per Mi).
  So the exception path here is a syscall path with a rounding error
  attached, and anything aimed at it can specialise for SWI.
- **`hflagsCalls` is the exception path's tail, not a separate cost.**
  1 923 / 2 936 / 2 224 / 1 205 per Mi, and against the exception rate
  the ratio is **2.76 / 2.65 / 2.77 / 2.71** — constant to 2.4 % across
  four games that agree on nothing else. Each guest exception costs
  about 2.7 hflags rebuilds. Its ~1.4 % belongs to the exception
  cluster's ~5.7 %, not chased on its own.

So the one mechanism that is uniformly expensive across all of J2ME,
rather than an artefact of which game was picked, is **the guest's own
exception path** — the same cluster round twenty-eight left unpriced.
Treat the profile's ~5.7 % for the cluster plus hflags' ~1.4 % as an
**upper bound and not a budget**, exactly as the round-23 rule below
says; the corrected `excns2` leg and a calibration pad inside
`arm_cpu_do_interrupt` are what turn it into a price.

Two things the four games settle about that path for free:

- **`execLjmp` is zero.** Not small — absent from all four result JSONs,
  and `j2mebench.mjs` drops a counter only when its window delta is
  exactly 0, while the increment in `cpu_exec_longjmp_cleanup` is live
  under plain `CONFIG_TCG_WASM64` and not `WASM_DIAG_HOT`-gated. So
  across 45 virtual seconds of play in four games, at 444–1 109
  exceptions per Mi, the exception path unwound **not once**. This
  confirms on J2ME what round twenty-eight found on an S75 boot, and it
  retires the unwind for this workload: at the ~15 µs an emscripten
  JS-exception unwind costs, even one per exception would be 10.3 ms/Mi
  against a total of 10.5 ms/Mi — the whole program. Whatever the
  exception path costs, none of it is the longjmp.
- **`hflags` needs no further work either.** `rebuild_hflags_a32_el`
  already carries the pre-v6 short path (hflags.c:316) with a
  `-DHFLAGS_FAST_VERIFY` build that computes both answers and counts
  disagreements, and `HELPER(cpsr_write)` and `HELPER(cpsr_write_eret)`
  already suppress their own second rebuild via the `CPSR_HFLAGS_INPUTS`
  mask test. The 2.7 rebuilds per exception are not duplicates that a
  previous round missed; they are one on entry
  (`take_aarch32_exception`), one on the `eret`, and ~0.7 from the
  handler's own `msr`.

That leaves `arm_cpu_do_interrupt` → `take_aarch32_exception` itself as
the only unaddressed part of the cluster, which is what the paragraph on
pricing it further down was written for — and the four games now say it
is worth pricing on J2ME and not just on a boot, because the exception
rate is the one thing they all agree on.

A cross-game regression of `ms/Mi` on the exception and pixel rates was
tried and **does not identify**: display comes back with a negative
coefficient against an A/B that measured +17.5 %, and exceptions at
5.8 ns each imply 38 % of game 1's cost against a profile that says
5.7 %. Four points, three parameters, and every per-Mi device rate
collinear with `duty` by construction. The spread across games is good
for choosing *what* to A/B and useless as a price; see lessons.md.

The module pipeline, by contrast, **retires for J2ME**. It was 12.5 % of
boot in round nineteen; in steady-state play `modNs` is 27 464 ns/Mi on
game 1, which is 54 ms across a 20.7 s window at ~0.76 cores busy — well
under 1 % — and no compile or instantiate frame appears anywhere in the
in-play profile. `tbGen/Mi` is 1.7–3.5 across the four games. Translation
is a boot cost; nothing in this round should be aimed at it.

Note that the inline TB cache is **silent by design** — it bumps no
counter, so that its hit costs no read-modify-write in emitted code. It
is confirmed by the *survivors*: `lookup` fell 15 839 → 1 283.7 per Mi,
so 92 % of `goto_ptr` lookups never reach the helper. Read that as a
confirmation that the mechanism **fires**, and nothing more — the next
entry is the same mechanism failing to **pay**.

**The inline TB probe is a reversal: switching it off reads faster, and
this corrects a claim made earlier in this round.** The round log below
once said "mechanism K confirmed" on the strength of the `lookup` drop
above. A counter cannot say that. `W64_NOPCCIN=1` stops the emitted
second way being generated at all, so the mechanism is A/B-able inside
one binary; the polarity is `cpu-exec.c:517` (`on = getenv("W64_NOPCCIN")
== NULL`), so the leg labelled "off" is the one **without** the probe.
Four legs, two games:

```
all       inline on 90.54 (n=4 sd 14.44)   off 97.81 (n=4 sd 10.14)   -7.4 %
1st half            87.87                     90.40                   -2.8 %
2nd half            93.22                    105.23                  -11.4 %
```

Both halves are negative, which is what separates this from the
CHAINLOOP tie. But the per-game split is where the honest reading is:

```
g1: inline-off 102.44   inline-on 102.22   -0.2 %   overlap=yes
g2: inline-off  93.19   inline-on  78.87  -15.4 %   overlap=yes
```

**One game is a dead tie and the other loses 15 %**, and neither game's
legs separate. So the whole-battery −7.4 % is a mean carried entirely by
game 2 — and the next entry shows that game 2's number is carried
entirely by one leg that measured a different workload. **After the
guard below, pccin reads g1 −0.2 % and g2 −8.7 % (n=1 vs n=2, still
overlapping): no evidence either way.** The eight-leg confirmation is
still queued; nothing ships off either number.

**Why a reversal here is not surprising, which is the thing to hold in
mind when the eight legs land.** Every leg on disk carries the counter,
and tagging them separates the two arms cleanly — the probe's effect on
helper entries is enormous and completely unambiguous:

```
                 lcCall/Mi     lookup/Mi    qht/Mi
g1  probe off    14738, 14730  1276, 1287   524, 533
g1  probe on     516 .. 608    1256 .. 1337 506 .. 596   absorbed 96.3 %
g2  probe off     7787,  7736  1562, 1522   377, 338
g2  probe on     293 .. 794    1180 .. 2850 309 .. 803   absorbed 94.2 %
```

`lookup/Mi` and `qht/Mi` do **not** move. The probe changes neither how
many lookups happen nor how many reach the qht — only how many cross
the helper boundary. So the A/B isolates one thing: the cost of an
inline check in emitted code against the cost of a helper entry.

And that trade is close to even *by construction*. The probe removes
~14.2 k helper entries per Mi on game 1 and adds one inline check to
every one of the ~14.7 k exits per Mi — it buys 0.96 of a removed call
per check performed. It therefore wins only if a check in emitted code
is cheaper than a helper entry, and the standing lesson is that emitted
TB code runs in the baseline tier at roughly **2× the cost of the same
work in the main module's optimized C, while the call boundary itself
is only ~2 ns** (`doc/lessons.md`, "move work INTO helpers"). A
near-tie, or a loss, is exactly what that lesson predicts. The −7.4 %
is not an anomaly needing a special explanation; it is the ordinary
consequence of doing per-exit work on the slow side of the tier split.

This does not decide anything — a counter confirms a mechanism, a clock
prices it, and the clock here is still two overlapping legs. It says
only that the eight-leg result should be read without a thumb on the
scale for "the cache must help".

### A fixed guest-time window does not fix the workload

Every leg measures the same 45 **guest**-seconds, which is what makes
MIPS/cpu comparable across legs of different wall length. It does not
make the *workload* the same. Across every 45 s leg on disk, game 2's
fifty-two legs fall into three separate modes, and **12 of them (23 %)
are not the game being played**:

```
duty 0.147-0.153   40 legs   mi  825-859   fps 39-49   halts/s 1170-1961   MIPS/cpu 63.6-101.4
duty 0.087-0.091   10 legs   mi  487-509   fps 58-61   halts/s 2382-3098   MIPS/cpu 65.9- 85.3
duty 0.282          2 legs   mi     1588   fps 36      halts/s      738    MIPS/cpu      81.8
```

The last column is the one to read: every contaminated leg's rate falls
**inside** the played legs' range — the played distribution *contains*
both others. No outlier rule on the rate, and no amount of repetition,
can separate them; only a statistic about the workload can.

The light legs are runs where **the start keys missed and the game never
left its title screen**. The heavy one is worse: `duty` 0.282, 36 fps,
738 halts/s and 2.18 M insns/frame is **game 1's shape wearing game 2's
label** — the walk through the menu went somewhere else and the leg
played a different game. The window collected its 45 guest-seconds in
all three cases. Game 1 is unimodal (0.341–0.397), so this is a property
of one game's walk, not of the harness clock.

MIPS/cpu at duty 0.087 is not comparable to MIPS/cpu at 0.150 — the
fixed costs (module compiles, timer interrupts, halt handling) are spread
over half the work. The four light legs read 85.29, 83.76, 72.61 and
72.56, so the contaminant is mostly *variance*, not bias; that is exactly
why it survived the palindrome and inflated game 2's sd instead of
announcing itself. With n=2 per arm, one light leg decides the verdict.
It hit `pccin` on the on-arm, `chain` on the on-arm and `nested` on the
off-arm — three of the round's five A/Bs.

`scratchpad/verdict.py` recomputes any verdict from the saved sweep
JSONs, keeping only legs whose duty is within ±25 % of that game's
median, and printing the raw figure beside the guarded one with the drop
count. The band has to be two-sided: a floor catches the title screens
and passes the wrong-game leg, which is the more dangerous of the two
because its *rate* is unremarkable (81.79, mid-range) while its workload
belongs to another game. It touches nothing that runs, works
retroactively on every leg ever measured, and **should be used for every
verdict in this round in place of the number `ab.sh` prints.** Re-read
with the guard:

```
disp       g1 +17.4 % (n=4/4)   g2 +17.7 % (n=4/4)   dropped 0   <- separates
nested     g1 +17.4 % (n=2/2)   g2   all legs dropped            sd 11 on off
noliftoff  g1  +1.3 % (n=2/2)   g2 -13.6 % (n=2/2)   dropped 0
pccin      g1  -0.2 % (n=2/2)   g2  -8.7 % (n=1/2)   dropped 1   overlap
chain      g1  -5.5 % (n=2/2)   g2  +9.5 % (n=1/2)   dropped 1   overlap
txfast     g1  +3.5 % (n=2/2)   g2  +8.7 % (n=1/2)   dropped 1   <- separates
```

`txfast` is the guard's clearest single demonstration. Its raw
whole-battery read was **+10.7 %** and its raw g2 **+20.2 %**, both
inflated by one leg that measured game 2's title screen (`Mi=487.9`,
`duty` 0.087). With that leg dropped the mechanism still wins — g1
**+3.5 %** at n=2 per arm with the arms not overlapping — but at a
third of the advertised size. Same direction, different magnitude:
contamination here did not invent a result, it exaggerated a real one,
which is the failure mode that survives a sanity check.

The three display mechanisms together are the round's one clean result:
both games agree to within 0.3 points, at n=4 per arm, with no overlap.
`nested` reads large and in the direction of the shipping default, but
its off-arm legs are 91.03 and 75.35 — a 15-point spread at n=2 — so it
confirms a default rather than establishing a size.

**`noliftoff` is the one row in that table whose sign is inverted, and
nothing in the row says so.** Every other line carries an `env=` knob on
the off-leg, so "off" means the knob is applied and a minus sign means
the knob lost. `noliftoff` carries no knob at all — its off-leg is a
*Chrome argument*, `--js-flags=--no-liftoff`, and the "on" arm is the
shipping default. So g2's **−13.6 %** says the default is 13.6 % slower
than forced TurboFan, i.e. **forcing the optimizing tier buys +15.7 % on
game 2**, at n=2 per arm with the arms not overlapping (on 63.63, 73.90;
off 76.75, 82.39) and nothing dropped. Game 1 is a wash (+1.3 %,
overlapping). Read as a knob that lost, this row closes the tier lever;
read correctly, it is the only ceiling probe in the round that *opens*
one. Tabulating an argument-leg beside knob-legs in one column is the
defect — the polarity is a property of the leg, not of the table.

Two cautions before it is spent. `--no-liftoff` forces TurboFan for the
**main module too**, so the win may be the main module tiering up sooner
on a lighter workload rather than anything about emitted TB code, and
game 2 is the lighter workload (`Mi` ≈ 850 vs game 1's ≈ 1955 in the
same 45 guest-seconds) — which is the shape that reading predicts. The
module-compile counters do **not** separate the two: `modCompileNs/Mi`
is 25640 and 12073 on the forced legs against 20687 and 23770 on the
default legs, noise with no direction, and `tbGen/Mi` ≈ 3.6 with
`modCount/Mi` ≈ 0 says this window creates almost no new modules and
runs long-lived ones. So the ceiling is real but unattributed.

`W64_MERGE` is the shippable mechanism aimed at that ceiling — merging a
batch of TBs into one function raises that function's call count and
tiers it up 277× sooner — which makes **queue7's merge verdict the
round's highest-value pending item**, and makes this row the thing to
re-read against it. If merge wins, the ceiling was emitted code; if
merge loses while this ceiling holds, the +15.7 % was the main module
and the emitted tier is not where the round should go next.

The runner-side fix is **prepared but not applied**: the battery is in
flight and `tools/j2mebench.mjs` is read fresh per leg, so editing it now
would split legs before and after the edit. The guard is analysis-side
for that reason. `scratchpad/runner-duty.py` holds the patch — exact
anchors, idempotent, refuses to half-apply — and `scratchpad/queue7.sh`
applies it after the battery drains and before the next rebuild. It adds
`--duty <v[,v...]>` (one value per `--game` entry), rejecting a window
outside ±25 % of the expectation and redoing the walk, and prints `duty`
in the sweep line so contamination is visible in every future log without
opening a JSON. The measured expectations are g1 **0.348** and g2
**0.150**, which are the medians of 131 and 52 legs.

Two properties make this the right statistic rather than a convenient
one. `duty` is `insns × 8 ns / virtual-ns`, so under icount it is a
property of the guest alone: **a faster build does not move it**, which
is why the guard cannot quietly delete the winning arm's legs (`disp`,
the round's largest effect, dropped zero). And the runner had already
written the invariant down at `tools/j2mebench.mjs:728` — "legs whose
`mi` disagrees played different games, and their wall times are not
comparable" — while the accept test three hundred lines earlier was
`fps >= 2`, which a 60 fps title screen passes. The rule was stated and
never enforced.

The mechanism, if it holds: a six-word compare chain emitted into every
`goto_ptr` costs more than the optimized-C helper call it avoids,
because **emitted code runs in the baseline tier and the helper does
not** — the same asymmetry 0050 found, pointing the other way for once.
The forward-looking half matters more than the verdict: this makes the
inline probe wrong *until tier-up is fixed*, not wrong forever. If the
module-local dispatch loop lands and TBs reach the optimizing tier 277×
sooner, the compare chain gets cheap and the helper call does not, and
the probe should be re-measured rather than assumed dead.

This also closes `W64_LC2` honestly. That item wanted a second way to
catch the 8 % of lookups the first way misses. Switching the first way
*off* prices the entire surviving lookup path at once, and at 1 283.7
helper calls per Mi against 10.03 ms/Mi the whole of it is ≤ ~0.8 % of
wall. A second way cannot win a fraction of 0.8 % back; the item is
closed, not deferred.

**A ceiling, measured: the baseline tier is worth 3–6 % on a running
game.** `--js-flags=--no-liftoff` read **+6.3 %** over the shipping
default on a four-leg palindrome (on 77.23 n=4, off 82.10 n=4; game 2
separated cleanly, game 1 did not), and the flag is provably live —
`modCompileNs` per module went 1.06 → 1.76 ms. Read with 0050's +3 % as
the same number's lower end. A browser flag is not a shipping lever, so
this is a *ceiling* on tiering rather than a win — but 3–6 % is larger
than every remaining device item except the display, which promotes
**tier-up latency** to a first-class target and is why the module-local
dispatch loop is now item one of the open list.

**CHAINLOOP was predicted to be the round's biggest lever and it is a
tie.** The prediction was ~108 k TB boundaries per Mi moving from
`return_call_indirect` at 27.9 ns to a driver loop's `call_indirect` at
12.7 ns — ~1.6 ms against 10.03 ms/Mi, i.e. ~16 %. Measured, on a
four-leg palindrome over two games and read inverted (the knob defaults
off, so the leg labelled "off" is the one *with* the mechanism):

```
all       CHAINLOOP on 87.00 (n=4 sd 11.14)   off 87.08 (n=4 sd 7.11)   -0.1 %
1st half                 79.79                    90.04                -11.4 %
2nd half                 94.22                    84.13                +12.0 %
```

The halves disagree by 23 points in opposite directions, so the spread
is a statement about the window, not the mechanism. The mechanism is
worth nothing.

**Why, and it is a lesson about the synthetic rather than about the
emulator.** `tests/wasm/dispatchbench.mjs` prices `loop`
(`call_indirect` from a driver in the *same module*) at 12.7 ns and
`xtail` (cross-module `return_call_indirect`) at 27.9 ns — and the
12.7 ns leg was the one the prediction used. But `w64_driver()`
(`wasm64.c:975–1009`) builds the driver as **its own module** and
reaches TBs through the shared table, so a CHAINLOOP transition crosses
the instance boundary **twice** — the TB returns across it into the
driver, the driver calls across it into the successor — where
`return_call_indirect` crosses once. The real thing is the synthetic's
`xloop`, not its `loop`. Two crossings at ~14 ns is one at ~28 ns, and a
tie is exactly what that arithmetic predicts.

So the rule is: **a synthetic leg prices the real thing only if it has
the real thing's module topology.** `xtail` vs `stail` was already on
the page saying instance crossing is the expensive part; the prediction
read past it. Check this directly when the host is quiet — if
`xloop ≈ xtail`, the tie is fully explained and nothing else is needed.

The consequence for the ranked list is not "dispatch is not a lever" but
"the *call opcode* is not the lever, the instance crossing is" — which
is an argument for the merged function at the top of the open items,
whose intra-module transition crosses nothing and is not a call at all.
It also means that item's win (a) is now **unproven**, and its measured
half is win (b), tier-up amortisation, at 3–6 %.

CHAINLOOP is being committed **default-off and labelled a tie**, not
because it earns its place but because the merged function reuses its
exit protocol (`W64_EXIT_CHAIN`, the successor index returned in a
local) and re-deriving that costs a round. That is a judgement call and
is flagged as one; it ships nothing.

**Still in flight at the time of writing** (each a four-leg palindrome
over games 1 and 2): `pccin`, `nested`, `txfast`, and the three display
mechanisms split out as `lcdrow` / `dmacoal` / `rxtail`. Losers get
reverted, not committed.

## Update (2026-09-17, round twenty-nine: the wake that was published too early — 0117)

**Not a perf round.** KE800 did not boot on Android at all: the splash
logo came up and the HUD sat at `1.00× · 0.0 MIPS · 0 fps · 0 halt/s`
forever. The cause was a **lost main-loop wakeup in the wasm build**, and
it has been on this port since the futex wait was written.

**The protocol.** Emscripten's `poll()` cannot sleep, so
`os_host_main_loop_wait` sleeps in `emscripten_futex_wait(&ml_futex_seq,
ml_wait_seq, timeout)`, with `ml_wait_seq` snapshotted in
`main_loop_wait()` *before* the timeout is computed. Every waker goes
through `qemu_main_loop_wake()`. Two defects, each of which loses an
edge:

- `qemu_main_loop_wake()` incremented the sequence word with a **read, an
  add and a store in the open**. Wakers run concurrently as a matter of
  course — `qemu_notify_event()` issues one itself and a second through
  `aio_notify()`, and the vCPU notifies on every `timer_mod` — so a waker
  preempted between its read and its store writes back a value the waiter
  has already snapshotted, erasing its own wake.
- `aio_notify()` issued its wake at the **top of the function**, before
  the `smp_wmb()` / `qatomic_set(&ctx->notified, true)` that publish the
  work. The main loop can wake on it, look, find nothing published and
  sleep again — and the store that follows carries no wake of its own.

**Why it is fatal on KE800 and invisible on the Siemens boards.** The LG
boards boot with **icount off** (`site/app.js`), and with icount off the
main loop is the only thing that runs `QEMU_CLOCK_VIRTUAL` deadlines —
the vCPU never exits for a virtual deadline (the comment at
`main_loop_wait` already says so, from the *previous* hang this caused).
So a lost edge is not a delay, it is a stop: the loop sleeps out its
timeout, `INFINITY` when no timer is armed, the vCPU blocks on the device
completion that timer owed it, and the guest is dead. Under icount the
vCPU runs those timers itself and the same defect never shows.

**How it was proven, which is the transferable part.** A race you hit
once every few boots cannot be A/B'd on a clock. The first attempt — 14
boots per arm under CPU contention, two dists — read **2/14 frozen
against 0/14**: directional, not a result. What settled it was
`W64_AIOLAG=<n>`, a temporary probe that **reinstates the wrong order and
widens its window**. On a completely idle machine:

| `W64_AIOLAG` | order | result |
|---|---|---|
| 0 | wake after publish (the fix) | boots, 44–108 MIPS |
| 20 | wake before publish, widened | **frozen at 977 M insns, 0.00 MIPS, 0 halt/s, vratio 1.00** |
| 200 | same | **frozen at 912 M** |

That is the phone's exact signature, including the occasional
0.12–0.16 MIPS sliver, produced deterministically with no load. **When
the suspected mechanism is a race, do not try to make the race more
likely — build the knob that makes it certain**, and let host speed be
the thing that decides only how often the natural window is hit. Also
worth keeping: during a natural freeze **every** diag counter is still,
`execIter` and `mlWake` included — vCPU and main loop both parked, which
is what rules out a timer storm without another build.

**Ruled out along the way**, each cheaply: the module budget; memory
(KE800 RSS 1.70 GB against S75 1.65 GB, within 50 MB despite KE800's
128 MiB flash); the real-time cap (**inert without icount** — `-icount`
is not passed for LG, so `icount_configure()` never runs); the dist
default (already `dist-jit`); the SCU watchdog (it reboots, it does not
freeze); plain host slowness (`W64_INTERP_ALL=1` at 12.7 MIPS boots
fine). Two tool traps cost real time: **`taskset` does nothing to
Chrome** (it resets its own affinity — `taskset -cp` reads back `0-31`),
so CPU contention is the only way to model a slow host; and a
`pgrep -f <script>` waiter **matches its own command line**, so a chained
run never starts.

**`site/app.js` §6b is the other half of the fix.** The page claimed
"Running · 0:21" over a corpse and surfaced nothing — on a phone there is
no console to read. It now calls a stall when instructions, halts *and*
display reads are frozen **together** for 15 s (all three, because a
guest asleep in WFI stops retiring instructions but its halt count still
moves; 15 s because a slow phone boot must never be called dead), shows
an overlay with the last line qemu managed to print, marks the pill
`· stopped`, and puts `stalled`/`fatal`/`log` into **Copy diagnostics**.
Worker deaths are captured too: a pthread that aborts or traps surfaces
only as a main-thread `error` event, and without that hook the vCPU dying
is completely silent.

**Still open on the phone.** If a KE800 boot stalls again with the fix
in, `?icount=shift=3,sleep=off` is a one-URL, no-build experiment that
implicates the timing model instead, and would argue for changing the LG
default.

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

  **That 90/Mi does not transfer to J2ME.**  In play the rate is six
  times higher and stable across games, configs and reruns: `lookup`
  1260–1340/Mi, of which the jump cache serves 730–760 and the qht
  510–600, with `lookupConfl` 356–377 — so **two thirds of the qht
  traffic is a conflict miss, not a cold pc**, and on game 2 it is 85 %.
  The spread across twenty stored runs is under 6 %, which makes it a
  property of the working set against a 16384-entry direct-mapped cache
  rather than noise.  Reading the idle figure as "the lever is closed"
  was the wrong comparison, and so was my first attempt to close it on
  the *absolute* qht rate being below the boot rate the 14-bit peak was
  measured at: what a bigger cache removes is the conflict fraction, and
  that fraction is what idle and in-play disagree about.

  It closes anyway, on a price rather than a rate.  In the in-play
  profile `qht_lookup_custom` is **296 ms of a 40 613 ms vCPU thread —
  0.7 %**, and the rest of the probe (`tb_htable_lookup`, the
  comparator) is static and inlines into it, so that 0.7 % is the whole
  qht path and not one frame of it.  Removing *every* conflict is
  therefore worth 0.675 × 0.7 % ≈ **0.5 %**, and no cache size removes
  every conflict.  `TB_JMP_CACHE_BITS` is build-time, so testing it
  costs two builds and four legs to chase half a percent that the guard
  band would not even separate.  Left closed, now for a measured reason;
  if it is ever reopened, 2-way at the same size is the better shape to
  try, because the misses are conflicts and not capacity.

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
