# Performance hand-off

Where the work stands, what is open, and what binds. Patch numbers are
commits on the `qemu/` submodule branch (the tip is pinned in
`versions.env`);
the per-patch numbers live in the commit messages on that branch, the
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
thirty-eight): both native builds, `build/qemu-wasm64`, `site/dist-jit`,
`tools/node_modules`, and the `qemu/` submodule at `c067e9b4ca`, which
matches `QEMU_PMB887X_REV` in `versions.env`. **`site/dist-jit` is the
`-sMEMORY64=2` build** — round thirty-six's +19 % is the default now, and
every measurement in rounds thirty-six onward sits on top of it.
**Rounds thirty-three to forty-two are uncommitted** in both trees. Round
forty-two adds no behaviour change: `TB_PAGES` is 2, as it has always
been, and the page-tracking sites are merely written for N of them now
(`exec/tb-pages.h`) — the third page was built, measured and rejected, and
the `translator_use_goto_tb` lever it found was reverted with its
stability unsettled. Also uncommitted, from earlier rounds:
the SMC range check (round thirty-seven, `tb-maint.c`/`cputlb.c`), the
mem32 build change, and nine diagnostic counters. Run `gate.sh close`
before committing — `configure`, `tcg.c`, `tcg.h`, `translate.c`,
`w64-interp.c`, `wasm-diag.h` and the wasm backend have all been
edited. `site/dist` carries only the guest
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

**Since the 2026-09-22 review the port carries no counters, knobs or
tool-only exports.** `videobench` needs `tools/perf/bench-hooks.patch`
applied to *both* arms, and a census is a temporary patch. Read round
forty-eight § 1 before measuring anything; much of what follows still
names counters and `?env=` knobs that no longer exist.

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
- **This is a container, and the co-tenant is large.** `/proc/loadavg`
  and `free` report the *host*. Round 35 measured the size of what is
  invisible: our whole process table is ~1.5 GB RSS against `AnonPages`
  **70.8 GB** with 29.8 GB swapped — **~100 GB belongs to another
  namespace**, and it arrives in bursts (24 k pages/s swapped out and
  ~1 GB/s of block reads at 18:00, flatly zero five minutes later). The
  damage is real: `base` read 4.151, 4.209 and **4.543** ms/Mi across one
  sweep, a 9.4 % spread on the control against the 1.4 % this file
  quotes — and rejecting the three legs the burst hit restored the 1.4 %
  and every number derived from it. Run `tools/perf/hostmon.sh` alongside
  any sweep and **reject** legs that overlapped a burst rather than
  correcting them; a within-round ratio is not a defence, because a burst
  is shorter than a round. See lessons, "A host burst inflates a
  contiguous run of legs". Do **not** trust `load=` alone; it was 4–6
  through both the quiet and the thrashing samples.
- **A hard wasm trap is never host pressure**, and a bisect that "fits"
  can fit because the bug predates both revisions.

**Landing a change:** one mechanism per commit on the `qemu/` submodule
branch with the measured numbers in the message, bump
`QEMU_PMB887X_REV` in `versions.env`, `scripts/gate.sh keep` before the
commit and `close` before the session's last one. Whatever happened,
it gets a row — **REJECTED** in the playbook with its numbers if it
did not ship (if it shipped, the numbers go in the commit message),
so nobody retries it blind.

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

**There is a second measurement workload since round thirty-nine: video
playback** (`tools/videobench.mjs`, SL65v49 TIM, My stuff ▸ Videos ▸
Berlin.3gp). Use it for anything aimed at the *guest's exception path*,
because it takes one every 424 instructions — 2 360 `excSwi`/Mi against
J2ME's 444–1 109 — while doing 6× fewer TB lookups per Mi, so the two
workloads rank levers in opposite orders. Its number is `rt` (virtual s
per wall s, 1.0 = real time on a real SL65). It stands at **2.76–2.89**
(ms/Mi 2.77–2.90) on this desktop at `hostBusy` ≈ 0.1 after round
forty-seven, and round forty-eight's inline `msr` takes another 2.2 % off
ms/Mi — **rounds 45–46 ran a capcom build that had dropped it to
0.38; see round forty-seven's first item before trusting any video
number from those two rounds**. Round forty-one read 2.66–2.68; round forty's build
was 2.46–2.49 and round thirty-nine's 1.8 on the same host state), i.e.
roughly half real time on a phone: the user's "video is below real time
on Android" is this number. `duty` = 1.000 and `halts/s` = 0 there too.
Since round forty the guest page is 4 KB (`W64_PAGEBITS`), `CF_PCREL` is
off, the SVC is taken inside the TB and direct calls are inlined
(`W64_INLINE`); round forty-one added the `msr cpsr` continuation and the
cross-page absorb.

**Round forty-nine took another 20 % (video) and 15 % (J2ME) off ms/Mi,
not by changing what the code does but by telling TurboFan which arm is
cold.** Its § 2 is how to read the x64 V8 actually runs; do that before
pricing any emitted-code idea. With the TLB probe cheaper, the TB
boundary below is a larger share of wall than when round forty-one
measured it.

**Read round forty-one's opening before planning a round against this
meter.** A TB boundary is 8–9 ns and the 88 316 of them per Mi are 22 %
of wall — the only large row left. Everything else is the emitted code
doing the guest's work, at ~1.5× what native-TCG-quality output would
cost, so **there is no single remaining change worth 30 %**; the ranked
list at the end of that round is three items worth 5 %, 2 % and "nobody
has an idea yet".

**The J2ME measurement workload is `fullflashes/CX70_FW56_clean.bin`**,
not `CX70_games.bin`. All four of its titles play at **`duty = 1`,
`halts/s = 0`** — the guest never idles, so the window needs no
bin-by-bin unpicking and `perMi:` is a single regime. It runs at
3.58–4.66 ms/Mi against the 5.686 that most percentages below are quoted
against; re-base before trusting a share. Start plan
`center:10000,center:10000,center:10000,center:8000`, and see § *The
image the user asked for is a better workload than the one we used*.

**Read this before running a single A/B on it.** The window is a fixed 45
*virtual* seconds under icount, so `Mi` lands on 5624.7–5625.9 every time
(0.02 %) and the guest instruction stream is identical in every leg —
which means `ms/Mi` contains **nothing but host speed**, and the host is
shared and drifts. Two legs of the same binary and the same knob, fifteen
minutes apart, read **4.604 and 4.126 ms/Mi**. Consequently:

- `Mi` is the workload guard. **`insns/frame` is not** — `fps` is the
  browser's wall render rate, pinned at ~62.4, so `insns/frame` is
  algebraically `1e9/fps ÷ ms/Mi` and tells you only what `ms/Mi` already
  said. Using it to screen games is circular.
- **Never compare legs that ran at different times.** Rotate the arms and
  repeat rounds (`tools/perf/ftsweep2.sh` is the template), score each arm
  against the baseline *inside its own round*, print the baseline's own
  round-to-round spread as the error bar, and carry a positive control so
  a null can be told apart from a lack of resolution.
- Round 32's load correction (`tools/perf/verdict.py`, log-log slope −0.29
  on 1-minute load, fitted within-config) is the post-hoc fallback when a
  leg cannot be re-run. It is a repair, not a licence.

**Two changes have shipped against this workload, and they compose to
about +26 %**: round thirty-six's `-sMEMORY64=2` addressing
(**+19.16 % ± 2.47 %**, paired across games and repeats) and round
thirty-seven's SMC granule mask (**+5.47 % ± 1.97 se** across the
five-title catalogue, **+15.5 %** on the CPU-bound title). Both are in
`site/dist-jit` and in the working tree, uncommitted. Round thirty-eight
then measured and closed three more candidates — the TLB mask/table
hoist, the `v128.load` probe fusion, and branchless A32 predication — so
the open list below is shorter than it looks. The guest-register row was
the last item on it that had never been measured; round forty-one closed
it by bounding it from the census (**≤ 13 % of wall, ≤ 7 % reachable**)
after finding that `W64_GDUP`, the probe built for it, was inert — see
that round's § 5. The knob has since been removed.

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
- **TB entry is 14.6 % of J2ME wall, band 10.1–18.7 %** (round 35,
  fitted): `ms/Mi = 3.4845 + 6.188/len` over ten clean FTMAX legs, slope
  6.188 ± 0.767, R² = 0.891, against a measured 55,385 exits/Mi — ~11.8 ns
  an entry, ~18 executed guest instructions between entries. Four rounds
  and a position term later it reads **5.756/len, 14.6 %, band
  10.1–18.7** — the row held. The intercept matters as much as the slope:
  **3.49 ms/Mi of the 4.15 survives arbitrarily long TBs**, so the whole
  TB-length family of levers is bounded at ~15 %, and **nothing has been
  shown to collect any of it**: `ft4` and `ft6` both fail to clear zero
  once position is modelled.
  *The band is new; the 15.8 % is unchanged and was briefly and wrongly
  restated as "~20 %, band 9–28" mid-round.* Three legs of round 3 had
  been inflated ~9 % by a host memory burst; including them collapsed R²
  to 0.47 and dragged the estimate up. With them rejected the fit is the
  original one, and a per-round intercept now finds k1 3.496, k2 3.484,
  k3 3.481 — **no drift remains to correct for**.
- **TB→TB transitions are 9.1 % of EL71 wall** — *EL71, not J2ME; the
  two boards' exit counts differ by 4×, and multiplying one board's unit
  cost by another board's count is how the TB-entry row went wrong
  twice.* 240.6 k per Mi at ~7.7 ns
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

### The J2ME budget, summed — where 4.15 ms/Mi goes

CX70 `CX70_FW56_clean.bin`, game 1, 45 virtual seconds, `dist-jit`.
Rows are independent measurements taken in different rounds and are
**not** all disjoint, which is the first thing to know about the table:

| block | share | how it was measured | status |
|---|---|---|---|
| wasm memory bound checks | **25.3 %** | `--no-wasm-bounds-checks`, 4-round Latin-square fit | **open — the only large one left; wasm32 collects the dependent-load part, see below** |
| TB entry | 14.6 % (10.1–18.7) | 14-leg fit over `W64_FTMAX`, position held out | bounded and **robust to the position confound**; **`ft4` collects nothing resolvable** (−2.09 ± 1.81) |
| guest-register env traffic | **≤ 13 % of wall, ≤ 7 % reachable** — 1.99 memory ops per guest instruction | `tcgGst`+`tcgGld` ÷ `tbIcount`, bounded from the census | **closed by bound, round forty-one** (the `W64_GDUP` probe was inert — adjacent duplicate accesses to one address are exactly what TurboFan folds — and has been removed): EXIT 37.6 % / BBEND 31.6 % / **BBCOND 15.8 %** / SE 14.3 % / CBR 0.7 % / CALL 0.0 %. EXIT is structural (TBs hand off through memory) and SE is required before a fault, so BBEND+BBCOND at 47.4 % is the lever. **Round thirty-eight closed the predication third of it** — see below. (Shares are of sync *demands*; against `tcgGst` they do not partition — see the denominator note.) |
| — of which A32 predication | **reachable part ≈ 2.0 % of the row** | `gsyncBbcond` ÷ BBEND, × `predSel`/`predA32` | **closed, round thirty-eight**: predication is 33.3 % of label/br blame but 61.4 % of predicated instructions are branches and 17.4 % are loads/stores, neither convertible; only 16.7 % is selectable data processing |
| inline TLB probe: mask/table pair | **+2.6 % ceiling, ~1.7 % realizable** | `W64_TLBHOIST`, 16 legs, host-quiet fit | **closed, round thirty-eight — do not build**; `ldstRun`/`ldstGen` = 66.2 %, and a cached `fast->table` is a wild pointer after any flush |
| inline TLB probe (whole) | ~5 % | `W64_TLBDUP` slope, EL71 | mostly *inside* the check row |
| V8 baseline tier | 3–6 % | `--no-liftoff` | uncollectable from inside the binary |
| display DMA→DIF→SSI→LCD | 1.74 % | in-binary timer, round 34 | closed |
| exception entry | 1.04 % | three in-binary spans, round 34 | closed |
| `arm_rebuild_hflags`, whole | **0.8–2.3 %, by game** | 31.6 ns/call timed, `(hflagsNs−hflagsCal)/hflagsNsN`, `nsclock` | **closed — the build already existed**; range is the SWI rate, not the cost |
| whole lookup path | ~1–2 % | counter census | ~solved; see the pcc item |
| notdirty stores | **5.5 % ± 2.0 % catalogue-wide; 6.5 % ± 1.0 % on game 5, 15.5 % on its longest chains** | 10 counterbalanced pairs over 5 titles + 6 on game 5, `W64_NOSMCMASK` | **collected — `code_mask`, round thirty-seven**; the old "~0.5 %, structural" reading was a census that never counted the 6–67-TB list walk inside each call |
| global next-TB cache, **emitted** probe | **worth ~3 % (removing it costs that)** | `pcc_on`/`pcc_off` A/B, 2026-09-17 | **closed — keep it**; `lookup` ×8.9 without it |
| global next-TB cache, **C-side** re-probe | **~5 % on module-churn legs** (0.1–0.35 % on video legs) | `W64_NOPCC`-alone env ABBA, round 45 | **closed — keep it**; the census number was video-workload-specific |
| module pipeline | **0.07 %** | `modNs` 2844 ns/Mi | irrelevant here |

**Read the overlaps before adding these up.** The TLB-probe row is
largely the check row seen from the other side (three of its loads are
checked accesses); the TB-entry row also carries checks in its prologue.
The rows that are genuinely disjoint and genuinely closed — display,
exceptions, module pipeline — come to **2.85 %** together.

**The register-traffic row is new and it is the one to look at next.**
`tcgGst` is 9.46 stores and `tcgGld` 7.18 loads per generated TB against
`tbIcount/tbGen` = 9.73 guest instructions, so the emitted code performs
**1.71 linear-memory accesses for every guest ARM instruction** purely to
move guest registers in and out of `env`. Against the ~1.9 ns per guest
instruction that the remainder row attributes to "real work", even a
conservative third of a nanosecond per access puts this in the same
double digits as TB entry.

> **On J2ME the ratio is higher, not lower: 1.99** (round thirty-eight,
> CX70 game 5 — 9.90 stores and 7.69 loads against 8.82 guest
> instructions per generated TB). Both games agree that this is a
> property of the translator rather than of a workload, and the J2ME
> stream skews it *up* because a bytecode dispatch loop translates
> shorter TBs (8.82 guest instructions against 9.73), so the same
> fixed per-TB entry and exit traffic is divided by fewer instructions.
> Everything the rest of this section says about 1.71 holds for 1.99,
> including that it is a static count.

**`bcprobe` has now settled the disjointness question, and the answer is
that this row is disjoint after all.** The doubt recorded here was that
these accesses are bounds-checked today, so wasm32 would collect part of
the row and leave only a residue. Kernel 1 measures exactly this shape —
one opaque base, eight constant offsets — and finds **i32 0.220 ns
against i64 0.219 ns per access, a +0.4 % difference in the wrong
direction**. An engine is allowed to check such a group once and share
the result across all eight, and V8 evidently does: with checks disabled
the same i64 leg moves only 0.219 → 0.208. So the memory model buys
nothing here, **wasm32 collects none of this row**, and all 1.71 ops per
guest instruction (1.99 on J2ME) survive the migration. At kernel 1's 0.219 ns and the
~4.2 ns per guest instruction of a base leg, the row is worth on the
order of **9 % of wall** — but see the caveats: 1.71 is a *static*,
translation-time count, and a microbenchmark with perfect locality gives
a floor on per-access cost, not the real one. The estimate above is still
arithmetic, which is exactly the move that priced TB entry at 43 % for
three rounds. What exists instead is the split: `GSYNC_SE` and
`GSYNC_CALL` are semantics and cannot be removed, `GSYNC_CBR` and
`GSYNC_BBEND` are code shape and can. The first postsweep leg reports
that ratio, and it decides whether this row is a lever or a law.

> **The leg landed (2026-09-17, `gsync.log`, CX70 games 1 and 2) and the
> answer is: neither of the two outcomes the counter header predicted.**
>
> | | BBEND | EXIT | SE | CBR | CALL |
> |---|---|---|---|---|---|
> | game 1 | **41.5 %** | 37.3 % | 20.4 % | 0.8 % | 0.0 % |
> | game 2 | **42.4 %** | 32.5 % | 22.7 % | 2.2 % | 0.1 % |
> | game 5, round 38 | **47.4 %** | 37.6 % | 14.3 % | 0.7 % | 0.0 % |
>
> Round thirty-eight splits that `BBEND` column in two with
> `GSYNC_BBCOND`, the part charged at a label `arm_gen_condlabel` made:
> **BBEND 31.6 % / BBCOND 15.8 %**. So a third of label-and-branch blame
> is A32 predication — and the round then measured that the predicated
> stream is 61.4 % branches and 17.4 % load/store, which no select can
> replace. See the round entry; that third is closed and the other two
> thirds are not.
>
> `wasm-diag.h:634` sets the decision rule: "If SE dominates there is
> nothing here; if CBR does, there is." **Neither does.** `BBEND` — a
> label, `br` or `goto_tb` — is the largest cause in both games, and it
> is the one the header named without pricing. The two games agree
> closely despite differing 3.3× in translation volume, so this is a
> property of the *guest ISA and the translator*, not of a game.
>
> Two rows are settled by it. `SE` at 20–23 % is a floor: a faulting
> guest access must leave env coherent and no code shape changes that.
> `EXIT` at 33–37 % is the TB-boundary cost already priced by the TB-entry
> row, and it is the part that falls as TBs lengthen — so this split and
> the `FTMAX` lever are the same lever seen twice, not two.
>
> **The blame counts exceed the stores by 1.32–1.35×**, consistently
> across both games. The header expects the sum to "track `TCG_GST`" and
> reads a residue as allocator pressure; here it overshoots instead,
> which means a global is blamed at a sync site more often than a store
> is actually emitted for it — a global already resident in memory is
> blamed but costs nothing. So these shares are reliable as *relative*
> weights and are an upper bound in absolute terms.

**And 1.71 is a static count, not an execution rate.** `TCG_GST`,
`TCG_GLD` and the six `GSYNC_*` counters all increment in `tcg.c`
during *code generation*, so they are per generated TB and divide by
`tbGen` — the same denominator, and the same trap, as `tbIcount/tbGen`.
The executed mean TB length on this workload is **18.05** against a
translated mean of ~9.5, so executed TBs are nearly twice the length of
the average translated one and are emphatically not a random sample of
them. Whether that pushes the per-instruction rate up or down is not
obvious either: `gsync.sh` records that stores per guest instruction
*rise* with TB length (0.939 at `FTMAX` 1, 0.972 at the default, 1.026
at `FTMAX` 4), because folding through a branch adds the brcond that
forces the write-back. So the dynamic number could exceed 1.71 rather
than fall below it. Anyone converting this row into a percentage needs
an executed-weighted count, which nothing currently emits.

> **`W64_TBSTATS` cannot supply it, and the attempt is instructive.**
> `after.sh` ran a `tbs_base`/`tbs_ft4` pair with `W64_TBSTATS=1` to get
> executed length directly and the FTMAX 3→4 ratio with it. The knob
> disables the thing being measured: `tcg-target.c.inc:3311` records that
> arming `wasm_tb_stats` "switched off TB lengthening — the fold target
> and the conditional loop back-edge merge both". `tbs_base` duly came
> back with `tbIcount` **5.555** against the sweep base's 12.83 and
> 182,786 exits/Mi against the census's 55,385 — a self-consistent
> measurement of a configuration nothing ships. Both censuses are
> correct and they are not comparable; **the 55,385 figure below stands**
> because the census leg ran `W64_XCOUNT=1&W64_XWHY=1` and left TB
> formation alone.
>
> The partner leg then confirmed it to four digits. `FTMAX` 3→4 moved the
> exit count by **+0.01 %**:
>
> | | `tbs_base` | `tbs_ft4` |
> |---|---|---|
> | `xGototb1` | 95,383.4 | 95,363.8 |
> | `xGototb` | 51,401.4 | 51,364.5 |
> | `xGotoptr` | 36,001.5 | 36,076.6 |
> | **exits/Mi** | **182,786.3** | **182,804.9** |
> | ms/Mi | 5.582 | 5.551 |
>
> r = 1.0001, so `dt/(1 − 1/r)` divides by 0.0001. It would have returned
> a number, and the number would have been enormous and meaningless —
> the same failure that priced a TB entry at 43 % of wall two rounds
> earlier, reached by a different road. The general form: *a measurement
> knob that changes code generation must be checked against the mechanism
> under test before the pair is run, not after it returns a ratio of 1.*
>
> **The executed-length question is still open, still worth answering,
> and the fix for the instrument is already written.** Round 34's
> refund patch does exactly one relevant thing:
>
> ```c
> -    return w64_tbhist_on() || w64_tbstats_inline() || icount2_enabled();
> +    return w64_tbhist_on() || icount2_enabled();
> ```
>
> It takes `wasm_tb_stats` out of `w64_tb_icount_exact()` — the gate that
> was suppressing TB lengthening — and refunds the count through
> `w64_tb_acct_insns()` instead. **It is in the working tree, uncommitted
> and unbuilt, which is why the legs above ran on a binary that still had
> the bug.** `postsweep.sh` rebuilds from that tree, so after it lands:
>
> 1. Re-run the `tbs_base`/`tbs_ft4` pair. `tbIcount` should come back at
>    ~12.8 rather than 5.555 — that is the check that the refund works,
>    and it is available from the first leg alone.
> 2. The exit ratio between them is then the real fold-through benefit,
>    on a guest-side counter with no host drift in it. That resolves in
>    three legs what 24 legs of wall could not.
>
> If the rebuild is not wanted first, `W64_XCOUNT` alone at `FTMAX` 3 and
> 4 measures the same ratio on today's binary, because it counts exits
> without touching TB formation.

**If it is a lever, "branchless predication" is not the shape of the
fix — it is a symptom of it.** TCG syncs globals to `env` at a basic-block
boundary because a hardware backend cannot guarantee that the same
physical register holds a value on every path into a label: the two
paths may have allocated differently, so memory is the only agreed
rendezvous. **That premise does not hold on wasm.** A wasm local is
function-scoped and survives any branch inside the function, and this
backend maps a TCG register to a local by a pure function of its index
(`w64_local32`/`w64_local64`), so the mapping is fixed for the whole TB.
A global pinned to its own local would be consistent at every join *by
construction*, and `la_bb_sync` would have nothing to do.

Three objections, all of which a design has to answer rather than
dodge. The sync at a **TB exit** must stay, because the next TB is a
different wasm function with different locals — `GSYNC_EXIT` is real.
So must `GSYNC_SE` and `GSYNC_CALL`: a faulting access or a helper
reading `env` needs coherent memory whatever the locals hold. And this
is a **TCG core change**, not a backend one — nothing in `tcg.c`
currently lets a target say "my registers survive a branch", so
`la_bb_sync` has no switch to turn off. Note also that raising
`TCG_TARGET_NB_REGS` does *not* approximate it: the syncs are
liveness-driven, not pressure-driven, and `TCG_SPILL` is already 2 in
3920 Mi. Untested reasoning, recorded because the counters are about to
make it either worth designing or worth dropping.

Three conclusions the table is for:

1. **After wasm32 there is a second large lever, and it is register
   traffic — and `bcprobe` has now shown the two do not overlap.** Every
   *priced* open row is single-digit and most are under 2 %; TB entry
   tops out at 18.9 % even at the top of its band, well under the check
   row. An earlier version of this conclusion read "there is no second
   large lever", and that was true of the table as it then stood — but
   the table had no row for the 1.71 env memory accesses per guest
   instruction, which is not a small number. It is still not *timed*, but
   it is no longer discountable against wasm32: kernel 1 of `bcprobe`
   puts i32 and i64 within 0.4 % of each other on exactly that access
   shape, so the migration collects none of it and the whole row
   survives. Everything *else* is a percent at a time; this one is not.
   `GSYNC_*` still has to split it into the removable and the semantic.
2. **The module pipeline is 0.07 % on a running game.** Several rounds
   optimized it. They were right for *boot*, where it is 12–19.5 %, and
   irrelevant here. `tbGen` is 1.295/Mi, so each translated instruction
   is executed ~79,000 times: on J2ME steady state, **translation cost
   is not a cost.** Do not re-open anything in that family for games.
3. **The remainder — roughly 45 % — is TurboFan-compiled emitted code
   doing real work**, about 1.9 ns or ~5.6 host cycles per guest ARM
   instruction. Note that this contradicts a naive reading of the
   baseline-tier bullet above: if emitted code were uniformly 2× slower
   than optimized C, that 45 % would imply a ~25 % prize from tiering,
   and the measured `--no-liftoff` is 3–6 %. The resolution is that hot
   TBs *do* tier up — 3.6 % of entries run baseline, not most of them.
   There is no 2× hiding in the remainder, and nobody should go looking
   for one.

## Open items (ranked)

### ~~KE970: the flash write-behind flushed a block request per ~30 programmed words, and every programmed word flipped ROMD twice~~ — TAKEN in round fifty-one (1000 M milestone 15.8 → 10.7 s)

Still open on KE970:
- **EFA/OTP saves** (`flash_save_file`) are synchronous `lseek` +
  `write` calls from the vCPU: 8.6 k per boot, ~0.7 %.
- **The default `parallel0` vc console:** the pmb887x machine doesn't
  set `no_parallel`.
- **The main loop still iterates ~118 k times per boot.** Re-profile it
  first.

### ~~`-ftrivial-auto-var-init=zero` costs video 4.2 %, J2ME 1.5 %~~ — TAKEN for the wasm build only in `0a3e5f2ce3` (round fifty-one §3; native keeps it)

### ~~The final link ran at `-O0`~~ — TAKEN in round fifty (video −3.2 %, J2ME −5.3 %, wasm 28 → 11 MB; `-O3` another −1.8 % on video)

> `-O2` was a compile flag only; `emcc`'s link had none, so it linked at
> `-O0`: `ASSERTIONS=1` (an Asyncify state check after every call,
> 173 k of them) and no Binaryen pass over the linked module. The link
> args in `scripts/build-qemu-wasm64.sh` now start with `-O3`. See round
> fifty in the log. Still unpriced on the same axis:
> `-ftrivial-auto-var-init=zero` (upstream hardening, `qemu/meson.build`)
> and `b_lto`. `b_ndebug` is impossible (QEMU `#error`s on `NDEBUG`).

### ~~Native s75/el71 no longer boot at the pin~~ — FIXED in `da835da585`

> The review restored upstream's exit-to-loop in `gen_set_psr` and
> `gen_rfe` but missed the third exception return, `do_ldm`
> (`ldm {…, pc}^`). That site kept the wasm continuation, whose IRQ kick
> is compiled for emscripten only, so on native an IRQ that the return
> unmasked waited for the next unrelated exit. Both sites now go through
> `gen_eret_end_tb()`. See round forty-eight, § 4.

### ~~`msr cpsr_c` without a mode change: an emitted fast path~~ — TAKEN in round forty-eight (−2.16 % ± 0.85 on video)

> The census found 5 331.7 inline writes per Mi and 1 205.0 helper calls
> left, 1 204.2 of which change mode. See round forty-eight in the log.
> What it leaves on the table: a mode-changing `msr` now always exits
> through the stub, where the in-line guard used to continue when hflags
> stayed equal. That is ≤ 1 204 × ~9 ns ≈ 0.36 % of video. Collecting it
> needs a forward diamond with a join label on every fast-path write,
> because a backward branch drops the TB out of the backend's nested
> mode. It is also below what this meter resolves (±0.85 % at 16 legs),
> so it is not worth building blind.

### ~~A chained exit for a branch inside an inlined callee — +1.3 %, blocked on one invariant~~ — TAKEN in round forty-three

> **Taken.** Round forty-three widened the chain to every fetched page and
> shipped it (see its entry in the round log); the text below is the
> round-forty-two statement of the item, kept for its reasoning.

The best-measured unclaimed lever in the tree. `translator_use_goto_tb`
allows a direct chain only to `pc_first`'s page, so every branch inside an
inlined callee leaves as an indirect exit instead. Widening it to any page
the TB has fetched from converts 3 695 indirect exits per Mi into chained
ones on video at an unchanged boundary count, gates GREEN, and measures
**+1.34 % pooled / +2.2 % at matched host load**; the diff is six lines
(round forty-two's entry in the round log has it, and the reasoning sits
in a comment at the call site).

Two things block it, in order. **First**, decide whether SMC registration
is the right invariant: it covers *writes* to a page, while a direct chain
is patched once and thereafter bypasses `tb_lookup_cmp`, including the
`w64_inl_vpage` check that validates a TB's non-entry pages. If same-page
is buying something stronger, this is unsound and the answer is no
regardless of the clock. **Second**, if it is sound, settle stability on a
quiet host: `key-el71` went flaky during round forty-two's attempt, on
*every* build including the reverted one, so nothing was learned either
way. Take it only with a control that is passing at the same time.

### ~~The whole emulator compiles at `-O2`, not the `-O3` the build script asks for~~ — closed, `-O3` rejected

**Verdict: keep `-O2`.** Round thirty-six built the `-O3` arm (2240 `-O3`,
zero `-O2`) and measured a noisy tie against `-O2`, both on mem32; see
"And `-O3` is rejected, on the tightest A/B this project has run" below.
The mechanism below is kept because the cross-file trap it documents still
governs every flag this build script tries to pass, and because the two
sibling settings it turned up (`b_lto`, `b_ndebug`) are still open.

Found 2026-09-17 while debugging why the mem32 variant would not link.
`scripts/build-qemu-wasm64.sh` passes `--extra-cflags="-O3 …"`, configure
writes it into `config-meson.cross`, and **meson discards it**: a second
`--cross-file` (`qemu/configs/meson/emscripten.txt:2`) sets
`c_args = ['-pthread']`, and the later file replaces the earlier list
instead of extending it. The deployed `build/qemu-wasm64/build.ninja` has
**2240 `-O2` and 0 `-O3`**. See `doc/lessons.md`, "A second `--cross-file`
replaces the first one's built-in options".

Of the flags that were dropped, only `-O3` has any effect: `-DWASM_BIGINT`
is inert (no source tests it), and `-sMEMORY64` rides the binary spec.

So every number in this document was measured on an `-O2 -g` build. That
does not invalidate any of them — both arms of every A/B were built the
same way — but it means **an optimization level nobody has ever tested is
sitting one line away**. It touches every C helper, `cputlb`, the softmmu
path and the translator; it does not touch the JIT's emitted code, which
this backend generates itself.

The `-O2` itself is not a stray flag and would have survived even if
`--extra-cflags` had arrived: `meson configure build/qemu-wasm64` reports
**`optimization = 2`**, pinned by qemu's own configure through meson's
built-in option. So the knob is that option, not `c_args` — it *replaces*
the flag instead of appending a second `-O` whose winner depends on
emission order (a command-line `-D` beats both cross files):

```sh
( cd "$BUILD" && meson configure -Doptimization=3 -Dc_link_args="$LA" … )
```

Do **not** fold a build flag in while another A/B is in flight — it changes
both arms and confounds whatever is being measured. Run each as its own
single-variable A/B. For `-O3` that was done and it came back a tie: it
inlines harder, which on a 28 MB module costs about as much in code size
and engine compile time as it returns, and it never reaches the JIT's
emitted code, which is 70.9 % of the vCPU.

The same readout also shows **`b_lto = false`** (and `b_lto_mode = default`,
`b_thinlto_cache = false`). Link-time optimization is the one knob here
that changes no semantics, so it looks like the free win of the three — but
it is the most dangerous one in *this* build, and the reason is
`-sASYNCIFY_ONLY=@configs/meson/asyncify-only.txt`. That list names
functions **in the final wasm**, and instruments exactly those frames for
the coroutine unwind. LTO's whole point is to inline across translation
units, which deletes names. Any listed function that LTO inlines into an
unlisted caller stops being instrumented, and an unwind through an
uninstrumented frame does not fail loudly — it corrupts. So LTO is not a
build-flag A/B here: it needs `scripts/gate.sh` in full, and the coroutine
paths specifically, before any number it produces means anything.
`-Db_lto_mode=thin` is the cheaper build if it is tried at all.

The same `meson configure` readout turned up a second untested setting:
**`b_ndebug = false`**, so `NDEBUG` is never defined and every `assert()`
in the tree is live in the deployed build — `cputlb`, `memory.c` dispatch,
the QOM and coroutine paths. (`tcg_debug_assert` is not affected; it is
gated on `CONFIG_DEBUG_TCG`, which is off.) `-Db_ndebug=true` prices it.
Like the flag below this is a **trade, not a free win**: upstream QEMU
keeps asserts on deliberately, using them as real checks rather than
development scaffolding, so a measurable win here is a decision and not a
patch. Measure before arguing about it.

A sibling candidate from the same compile line, listed here because it is
found the same way and costs the same to test: QEMU's own `meson.build`
puts **`-ftrivial-auto-var-init=zero`** on every file, which zeroes every
trivial automatic variable on entry — a real per-call cost in functions
with large locals, and the hot C helpers are exactly that shape.
`-ftrivial-auto-var-init=uninitialized` would price it. Unlike `-O3` this
one is a **trade, not a free win**: it is a hardening flag, and turning it
off makes an uninitialized read observable instead of deterministic. Price
it first; it is the user's call whether a browser-sandboxed emulator wants
to spend that, and it should not be switched off merely because it is
faster.

Round 35's `nobc` arm (`--js-flags=--no-wasm-bounds-checks`) is
**−25.29 % ± 1.79**: about three host cycles of every guest instruction
are spent proving wasm memory accesses in range. It is the largest single
cost this workstream has found, and it is inside the existing budget rows
rather than additive to them — the boundary row, the TLB-probe row and
the TB-entry row each carry a share.

The whole sweep, fitted as a Latin square over all 24 legs — arm + round
+ linear position, `tools/perf/square.py` — rather than as within-round
ratios, because the sweep has a position effect of +0.87 % ± 0.32 per
slot that `ratios.py` cannot see and that biases the small arms (see
"Fold-through does *not* have a resolved optimum"):

| arm | vs base | ± | 95 % | resolved at 2σ |
|---|---|---|---|---|
| `nobc` | **−25.29 %** | 1.79 | [−27.9, −22.6] | yes |
| `pg12` | **+6.31 %** | 1.79 | [+2.6, +10.2] | yes |
| `ft1` | **+6.18 %** | 1.79 | [+2.5, +10.0] | yes |
| `ft6` | −2.34 % | 1.84 | [−5.9, +1.3] | **no** |
| `ft4` | −2.09 % | 1.81 | [−5.6, +1.5] | **no** |

Read these as effects within a round, never as the absolutes behind them:
the absolutes carry the host's drift and the fit holds it out explicitly.
Only the three large arms resolve; the two small ones do not, and the
earlier version of this table claimed they did.

**`bcprobe` now says which half of the 25.3 % wasm32 actually collects,
and the control proves it.** Two kernels, each run twice — once normally,
once under `--js-flags=--no-wasm-bounds-checks` as a control that must
collapse the gap if the gap really is the check:

| kernel | i64 | i32 | i32 vs i64 | same, checks off |
|---|---|---|---|---|
| one opaque base, 8 constant offsets — *register traffic* | 0.219 ns | 0.220 ns | **+0.4 %** | i64 → 0.208 |
| load a pointer, then follow it — *the inline TLB probe* | 0.146 ns | 0.118 ns | **−19.6 %** | i64 → **0.121** |

The second row is the finding. Disabling checks moves the i64 leg from
0.146 to 0.121 ns, landing it on the i32 leg's 0.118 — so that 19.6 %
gap **is** the bounds check, and wasm32 removes it legitimately rather
than by turning safety off. The mechanism is that a wasm32 index cannot
exceed 4 GiB, so an engine reserves a guard region and lets the hardware
trap; a wasm64 index must be compared explicitly, and when the base is
itself a loaded value no check can be shared with a neighbour. **i32
*with* checks ≈ i64 *without* them.**

The first row is the constraint. Where the bases are constant offsets off
one pointer, V8 checks once and shares it eight ways, the check is
already nearly free, and i32 is not faster at all. Guest register traffic
has exactly that shape, which is why the register-traffic budget row
above survives the migration intact instead of being absorbed by it.

So the 25.3 % splits by access shape, not evenly: **wasm32 should collect
close to the full check cost on guest memory accesses** (which go through
`w64_tlb_haddr`, the shape of kernel 2) **and close to none of it on
guest register traffic** (kernel 1). That makes the two largest open
items genuinely additive, which is new — before this measurement the
register-traffic row had to be discounted against this one.

**It cross-checks against the hardware.** The counters already say how
many checks a guest instruction pays for, from `k1_base`
(`tcgGst=12.255 tcgGld=9.298 ldstGen=6.25 tbGen=1.295 tbIcount=12.604`):

| source | per guest instruction | how |
|---|---|---|
| `CPUState` traffic | 1.710 | `(tcgGst+tcgGld)/tbIcount` |
| guest loads/stores | 2.479 | `ldstGen/tbIcount` = 0.496, ×5 |
| **total** | **≥ 4.19 checks** | |

> Mind the denominator. `tbIcount` is the **sum** of `tb->icount` over
> translated TBs (`wasm-diag.h:112`), and `perMi` has already divided by
> executed instructions (`j2mebench.mjs:776`). So a per-instruction rate
> is `x/tbIcount`; mean TB length is `tbIcount/tbGen` = **9.73**, not
> 12.60. Dividing by `tbGen` *and* `tbIcount` counts the TB twice, which
> is how an earlier pass of this section understated every rate by ~29 %.
>
> And mind what the counters count. All of these are *emitted ops at
> translation time*, so `tcgGst/tbIcount` is a ratio of emitted stores to
> emitted instructions — a property of the translated mix, not of what
> ran. Reading it as an executed rate assumes every translated TB is
> executed equally often, which is false in detail. It is good enough
> here because the conclusion only needs the order of magnitude: even a
> factor of two on 4.19 leaves ~0.5 ns a check, still inside what a
> compare-and-predicted-branch can cost. Do not build a ns budget on it.

The ×5 is what one guest memop on the hit path actually touches:
`w64_tlb_probe` loads the mask (`:2029`), the table pointer (`:2036`)
and the comparator (`:2043`), `w64_tlb_haddr` loads `addend` at offset
24 (`:2236`), and then the data access itself is a fifth. It holds for
the ~94.7 % that hit; a miss takes a helper instead.

Dividing the measured 1.08 ns by 4.19 gives **0.258 ns per check —
about 0.9 host cycles at 3.5 GHz**, which is what a fused compare and
well-predicted branch costs, with 4.19 extra branches per guest
instruction of predictor pressure on top. And 4.19 is a *lower* bound
(chain-table, diag and prologue accesses are in neither bucket), so
0.258 ns is an upper bound on the per-check price. A −26 % arm implying
twenty cycles a check would have been an artifact; this one implies
about one, and is therefore not.

It also says where the checks are: **59 % of them are on the guest
memory path**, 41 % on env traffic. (Translation-time counters weight by
translated rather than executed code, so 0.496 is an estimate of the
executed mix.)

**That split, crossed with `bcprobe`, turns the ceiling into a forecast.**
The two access shapes do not pay the same check price. `bcprobe`'s
kernel 2 — a loaded base, the guest memory path's shape — pays
0.146 − 0.121 = **0.025 ns per access** for its check; kernel 1 — constant
offsets off one base, env traffic's shape — pays 0.219 − 0.208 =
**0.011 ns**, because V8 checks the group once and shares it. Memory-path
checks are therefore ~2.3× the price of env checks, and **wasm32 removes
the expensive kind and leaves the cheap kind alone.** Weighting the 59/41
count split by that ratio:

```
memory path   0.59 × 2.3 = 1.36        →  77 % of the check cost
env traffic   0.41 × 1.0 = 0.41        →  23 %
```

So wasm32 should collect between **59 %** (if every check costs the same,
the flat assumption) and **~77 %** (if the microbenchmark's cost ratio
transfers) of the 25.3 % arm — **15–19 % of wall**, before the
trap-point discount in the note below pulls it down further.

> **The weak link is the transfer, and it is worth stating plainly.**
> `bcprobe`'s per-check costs (0.011–0.025 ns) are an order of magnitude
> below the ~0.258 ns the in-situ arithmetic gives, because a
> microbenchmark has perfect branch prediction, no I-cache pressure and
> no competition for the predictor from 4.19 other checks per guest
> instruction. **Do not multiply `bcprobe`'s absolute deltas into the
> budget** — that would put the whole check cost at 0.08 ns/insn against
> a measured 1.08. Only the *ratio* between the two shapes is being
> carried across, and only because both kernels were mispredicted and
> cache-resident in the same way. The 59 % end of the range needs no such
> assumption and is the one to plan against.

The cost is the memory's *type*, not a V8 setting. A wasm32 memory is
bounded by a guard region and its check costs no instructions; a wasm64
memory is indexed by i64, which no guard region covers, so the check is a
real compare and branch. This emulator has never needed a 64-bit address
space — only 64-bit pointers — and its memory is 2 GiB.

> **`nobc` is a ceiling, not a forecast.** The flag deletes the checks;
> wasm32 *relocates* them into a guard region. The instruction cost goes
> either way, but the flag additionally removes the trap points, and a
> memory access that cannot trap is one V8 may reorder, hoist out of a
> loop or drop entirely — freedoms a guard-region access does not grant,
> because it still traps at exactly the right instruction. So wasm32
> should collect most of the arm and not all of it, and the shortfall is
> not evidence that the migration went wrong. The same caveat runs the
> other way for the two TLB items below, whose prize is the *instruction*
> half only, and which therefore survive wasm32 at reduced value rather
> than being subsumed by it. Judge the migration against a rebuilt
> `nobc` leg on the wasm32 binary — checks already free, so that leg
> should read ~0 — not against this number.

emscripten separates those, and QEMU's configure already has the switch:
`-sMEMORY64=2` keeps i64 pointers for clang/lld and lowers the memory to
wasm32 in Binaryen (`emsdk/upstream/emscripten/src/settings.js:246`),
exposed as `configure --wasm64-32bit-address-limit`
(`qemu/configure:246`, used at `:490`, defaulting to `1` at `:187`).

> **`[compile+link]` does not mean the dependencies must be rebuilt, and
> an earlier draft of this item said it did.** The annotation
> (`settings.js:251`) says the flag must be *passed* at both stages for
> the driver's own consistency checks — it does not say the two values
> produce different object code, and they do not. Every compile-side use
> of the setting branches on truthiness, not on the value:
> `get_llvm_target()` returns `wasm64-unknown-emscripten` for both
> (`tools/shared.py:725`), `building.py:293` appends `-mwasm64` for both,
> and `cache.py:114` files the system libraries for both under one
> `wasm64-emscripten` lib dir. emscripten therefore treats `=1` and `=2`
> objects as one ABI itself; the difference is entirely the two Binaryen
> passes at `link.py:437`. `build-deps.sh` is **not** an edit site, and
> `build/deps/target` is reused as-is — which removes a ~40-minute
> dependency rebuild from this migration. Only the QEMU build carries the
> flag.

> **The main module needs no source change, and the evidence argues
> loudly that it does.** Reading outward from the emitted modules leads
> straight to `site/dist-jit/qemu-system-arm.js:687`, which declares
> `new WebAssembly.Memory({..., 'shared': true, 'address': 'i64'})`
> with BigInt page counts — which looks like proof that the memory's
> 64-bitness is baked into the whole emscripten module and that wasm32
> means rebuilding all of QEMU with 32-bit pointers. It is not. That is
> the *point* of `MEMORY64=2`: clang and lld keep the wasm64 ABI and
> 8-byte pointers, and only Binaryen lowers the memory at link time, so
> no QEMU source assumes anything different. And that JS file is a build
> output — `site/dist-*/` is gitignored — so emscripten regenerates the
> declaration to match. Nothing under `site/` is an edit site. The
> manual work is confined to the wasm **this backend emits itself**,
> which is what the list below is.

Because this project emits its own wasm, both sides must agree:

1. The imported memory's limits byte `0x07` (`64-bit | shared | max`)
   becomes `0x03`. `W64_MEM_PAGES` is 32768, inside wasm32's
   65536-page ceiling.

   **There are two of them, in two live emitters, and an earlier draft
   of this item named only the first.** This backend builds modules by
   two paths and each writes its own import section:

   | | builds | memory import |
   |---|---|---|
   | `tcg_out_tb_finalize` (`tcg-target.c.inc:3582`) | the single-TB module, instantiated at `wasm64.c:2649` | `:3674` |
   | `w64_assemble_instantiate` (`wasm64.c:1375`) | the batched/merged module — called from `:2115`, `:2297`, `:2389` | `:1519` |

   The second is the one that matters more: batching is the production
   path and a batch averages 4.9 TBs, so most modules come from
   `w64_assemble_instantiate`. Changing only `:3674` leaves it importing
   a 64-bit memory from a 32-bit one. That still fails loudly, but not
   the way the rest of this section promises — it is an *import type
   mismatch* at instantiation, not a validation error on an operand, so
   it reads as "imported memory does not match expected type" and points
   at the module boundary rather than at a missed wrap. Grep the tree
   for the byte, not the file: these two are the only occurrences.
2. An i32 address operand at every emitted access: an `i32.wrap_i64`
   before each of the 39 `w64_memarg` sites, or i32 address locals. One
   ALU op replacing a compare and a branch. The address is always an i64
   already on the stack immediately before the opcode, so this is
   mechanical; constant addresses can become `i32.const` and pay nothing.

   38 of those 39 are real sites (`:1059` is the definition), spread over
   18 functions rather than one funnel, but the weight is concentrated
   and a third of the functions are cold:

   | where | sites | what |
   |---|---|---|
   | `tcg_out_tb_start` | 8 | TB prologue — env register loads, the hottest |
   | `w64_tlb_probe` | 3 | the inline probe's three loads |
   | `w64_load` / `w64_store` | 4 | the general env accessors |
   | `tcg_out_sti`, `_goto_tb`, `_goto_ptr`, `_call` | 8 | boundary code |
   | `w64_ld_fast`, `w64_st_fast`, `w64_tlb_haddr`, `w64_tlb_hit_emit`, `w64_tlb_dup_emit` | 6 | guest access fast path |
   | `w64_diag_bump`, `w64_tbhist_emit`, `w64_emit_pad`, `w64_tlb_cheap_probe`, `w64_tlb_simd_probe` | 9 | diagnostics and the retired cost probes |

   `w64_addr` (`:1046`), `w64_load` (`:1065`) and `w64_store` (`:1084`)
   are the three primitives the rest build on, so a `w64_get_addr()`
   (get + wrap) and an i32 `w64_const_addr()` collapse most of the diff
   into one-line substitutions. Wrapping *after* an address computation
   is safe: `wrap(a+b) == wrap(a)+wrap(b)` mod 2³².

   **The wrap does not go where the memarg goes, and for stores it
   cannot.** A load is `addr, opc, memarg`, so the wrap can be inserted
   immediately before the opcode — next to the `w64_memarg` call that
   makes the site greppable. A *store* is `addr, value, opc, memarg`:
   the value is pushed between them, so a wrap emitted at the opcode
   would wrap the value. **Grepping `w64_memarg` finds the sites but
   does not locate the edit**; 15 of the 38 need it several lines
   earlier. The validation error is still loud — an i64 where an i32 is
   wanted — but it would appear as a *type* error on the value operand,
   which reads like a backend bug rather than a missed wrap.

   The split, by the opcode each `w64_memarg` belongs to, so the next
   session does not have to re-derive it:

   | | lines |
   |---|---|
   | **23 loads** — wrap at the opcode | 1071, 1075, 1524, 1532, 1592, 1720, 1863, 1890, 1949, 2029, 2036, 2043, 2098, 2102, 2136, 2177, 2236, 2263, 3452, 3461, 3481, 3494, 3513 |
   | **15 stores** — wrap at the address push | 1091, 1096, 1203, 1208, 1613, 1711, 1867, 1894, 1957, 2145, 2227, 2280, 3458, 3467, 3488 |

   Three of those sites carry a `0xfe` prefix and are **not** an RMW:
   `tcg_out_tb_start` emits `i64.atomic.load` (`0xfe 0x11`) at `:3481`
   and `:3494` and `i64.atomic.store` (`0xfe 0x18`) at `:3488`, for the
   icount2 deadline. Each takes an i32 address like any other, and the
   store one is a store for wrap-placement purposes. `:2177` is a
   `v128.load` (`0xfd 0x00`, the retired SIMD probe) and is likewise
   just a load.

   Two sites are worth naming individually because they are the hot
   ones and because a list of *functions* hides them. `:2263`
   (`w64_ld_fast`) and `:2280` (`w64_st_fast`) are the guest fast path
   itself, and both take their address from `w64_tlb_haddr`. Wrapping
   inside `w64_tlb_haddr` therefore covers a load and a store at once
   and is the only address edit on the hottest path — see the note
   below on dropping the zero-extend there.

   **The opcode split says where a wrap may legally go; it does not say
   how big the diff is.** What decides that is which expression pushed
   the address, because a wrap belongs *there* and many sites share one
   pusher. Classified that way (`tools/perf/addrsrc.py`, which walks back
   from each `w64_memarg` and takes the last push for a load, the
   second-to-last for a store):

   | address comes from | sites | cost of the migration |
   |---|---|---|
   | `w64_const_i64` | **24** | none — becomes `i32.const` and gets *shorter* |
   | `w64_get_i64` (in `w64_load`/`w64_store`/`tcg_out_sti`) | 4 | one edit in the primitive |
   | `w64_addr` (same three, the >4 GiB arm) | 3 | one edit in the primitive |
   | `w64_tlb_haddr` (`:2263`, `:2280`) | 2 | one edit, the hot path |
   | scratch/frame locals `W64_L_SCR0`, `W64_P_TP`, `W64_P_SP` | 5 | retype the local |
   | unresolved (`:2227`, a retired probe) | 1 | read it |

   So an earlier draft's "six push a constant address" was low by 4×:
   it is **24 of 38**, and they are free. The remaining 14 collapse into
   roughly four edits — two primitives, `w64_tlb_haddr`, and a local
   retype — because 18 functions share a very small number of address
   pushers. Introducing `w64_const_addr()` makes the 24 a one-token
   substitution that greps cleanly in review; the diff is far smaller
   and far less error-prone than "38 sites across 18 functions" suggests.

   **A scan that ignores the store shape will misplace the wrap, and
   this is not hypothetical — the first version of `addrsrc.py` did it.**
   Taking the nearest push before the opcode puts the address at
   `:3457`, `:3466`, `:3487` and `:2275`, all of which are the *value*.
   `w64_st_fast` is worse than the general case: its value push is a
   two-branch ternary (`:2275`/`:2277`), so even skipping one push lands
   on the other branch rather than on `w64_tlb_haddr` at `:2273`. Verify
   the hot pair by reading, not by scanning.

   Both the 39-site list and the load/store split above were re-checked
   against the source by opcode byte and agree exactly; the nine sites
   whose opcode is a function parameter (`w64_load`, `w64_store`,
   `tcg_out_sti`, `w64_ld_fast`, `w64_st_fast`) were confirmed by hand.

   The one place the migration can *remove* an instruction from the
   hottest code is the guest fast path, but not for the reason an
   earlier draft of this item gave. `w64_tlb_haddr:2231-2238` emits four
   ops — `local.get al`, `local.get scr0`, `i64.load offset=24`
   (`addend`), `i64.add` — and making the add i32 saves nothing on its
   own: you either add in i64 and wrap the sum (5 ops) or wrap both
   halves and add in i32 (6). The saving is one level up. This guest is
   32-bit, so `tgen_qemu_ld:2328` snapshots the address with
   `w64_get_i64(addr)`, which **zero-extends** it (`:2346` says so in as
   many words) purely because the memory wanted an i64. Under wasm32
   `W64_L_SCR2` can hold the guest address as an i32 and that extend
   disappears; `w64_tlb_haddr` then reads the addend's low half with
   `i32.load offset=24` and adds in i32, staying at four ops. Net −1 on
   every guest access, against +1 nearly everywhere else.

   Two conditions on that. The addend is `uintptr_t`, still an 8-byte
   field under `MEMORY64=2` (clang keeps the wasm64 ABI; only Binaryen
   lowers), so reading its low half is a little-endian assumption that
   holds only because every host address fits in 32 bits — which is the
   premise of the whole migration. And the *miss* arm still calls a
   helper whose signature is `(env*, uint64_t addr, ...)`, so it has to
   extend the address back (`:2344`). That arm is cold, and the probe
   index computation in `w64_tlb_probe` becomes i32 shifts and ands
   alongside.

   **A missed site cannot ship silently.** wasm is strongly typed and the
   memory's index type is part of the module: feeding an i64 address to a
   32-bit memory is a *validation* error, so the module fails to
   instantiate rather than reading the wrong address. The failure mode of
   this migration is a loud, immediate, first-TB abort — not corruption.

   ---

   **As built.** The emitted-code side is done, behind `-DW64_MEM32`, and
   the default build is byte-identical: without the macro the three new
   primitives degenerate to exactly the calls they replaced.

   | added | in | does |
   |---|---|---|
   | `W64_MEM_LIMITS` | `wasm64.h` | `0x03` or `0x07`, used by **both** emitters |
   | `w64_wrap_addr` | `tcg-target.c.inc` | `i32.wrap_i64`, or nothing |
   | `w64_const_addr` | " | `i32.const` or `i64.const` |
   | `w64_get_addr` | " | `local.get` + wrap |
   | `w64_addr` | " | now wraps the folded sum |

   All 38 sites resolve to a narrowed address push.
   `tools/perf/addrcheck.py` is the gate: it re-derives the load/store
   shape from the opcode byte rather than carrying a line list (so it
   survives editing this file), reports the pusher per site, and exits
   non-zero on any that is still 64-bit. Six functions defeat the
   push-counting heuristic and are named in the script with the reason
   each was cleared by reading. Run it before any build in this mode.

   > **Two items in the table above were wrong, and both would have been
   > found only at link or run time.**
   >
   > "Retype the local" does not apply to `W64_P_TP` and `W64_P_SP`.
   > Those are not locals — they are *parameters 2 and 1* of the emitted
   > thunk, whose type is the signature `(i64 env, i64 sp, i64 tp, i32
   > tidx) -> i32` written at `wasm64.c:1502-1510` and matched by the C
   > dispatcher that calls it. Under `MEMORY64=2` the C side still holds
   > i64 pointers, so narrowing the parameters would break the call, not
   > fix an address. They stay i64 and get a wrap at each use.
   >
   > `W64_L_SCR0` *is* a real local and could be retyped, but should not
   > be. It carries the TLB entry pointer, which `w64_tlb_probe` builds
   > with i64 pointer arithmetic (`table + index`) and `w64_tlb_haddr`
   > later re-reads. Keeping it i64 and wrapping at its three uses leaves
   > that arithmetic alone; retyping would push the narrowing up into the
   > index computation, which is the separate optimization below.

   The batched assembler emits **no memory instructions of its own** —
   it splices already-emitted bodies and builds sections — so its limits
   byte is its entire surface. Neither emitter uses `memory.size`,
   `memory.grow`, `memory.copy` or `memory.fill`, the other instructions
   whose operand type follows the index type.

   > **But the emitted wasm was not the whole surface, and the checklist
   > above did not have this item at all.** `--table64-lowering` ships
   > with `--memory64-lowering` (`link.py:437`), so under `MEMORY64=2`
   > **the table narrows too** — and emscripten's `wasmTable` is read by
   > hand from JS in three places in `wasm64.c`, each of which wrapped the
   > index in `BigInt(...)`. On an i32-indexed table a BigInt index is a
   > `TypeError`, and two of the three sites are the per-module import
   > resolution loop: the mode would have failed at **every TB
   > instantiation**, not regressed.
   >
   > The authority is `parseTools.mjs:992`, which is unambiguous and worth
   > quoting because it is the whole rule:
   >
   > ```js
   > function toIndexType(x) {
   >   if (MEMORY64 == 1) return `BigInt(${x})`;
   >   return x;              // MEMORY64 == 2 as well
   > }
   > function to64(x) {
   >   if (!MEMORY64) return x;
   >   return `BigInt(${x})`; // both 1 and 2
   > }
   > ```
   >
   > **An index narrows under `=2`; a pointer does not.** Emscripten
   > switches its own glue on exactly this (`runtime_init_memory.js` emits
   > `'address': 'i64'` under `#if MEMORY64 == 1` only, which is also what
   > makes `W64_MEM_LIMITS = 0x03` correct), but hand-written JS has to
   > switch itself. The three sites now probe once and cache
   > (`globalThis.__w64t64`: `wasmTable.get(0)` throws `TypeError` on an
   > i64 table), because an `EM_JS` body is stringified and cannot see
   > `#ifdef W64_MEM32`.
   >
   > The generalisable form: **`addrcheck.py` audits the wasm we emit, and
   > that is not the same set as the things that change type.** The other
   > set is every JS-side handle on a wasm index — table reads,
   > `Memory`/`Table` construction, `grow`. `__w64tab` happened to be safe
   > (created with no `index`, so i32 in both modes, and the TB modules
   > import it with limits `0x00`), which is luck, not design.

   **The −1-op fast path is deliberately not in this change.** Holding
   the guest address in `W64_L_SCR2` as an i32 and dropping the
   zero-extend (the paragraph above) is a real saving, but bundling it
   with the memory-type switch would make the first A/B unattributable:
   a single number would then mix the bound-check removal this migration
   is forecast on with an instruction-count change. Land the memory type,
   measure it against the 15–19 % forecast, then take the op.

   Build and select it:

   ```
   W64_MEM32=1 scripts/build-qemu-wasm64.sh     # -> site/dist-jit-mem32
   ```

   `?dist=dist-jit-mem32` in the page. It gets its own build and dist
   directory because `build-qemu-wasm64.sh` does not reconfigure an
   existing build dir — a shared one would silently keep the other mode's
   flags — and because the A/B wants both artifacts on disk at once.

`--table64-lowering` rides along with `-sMEMORY64=2`, but **the table
needs no work**, and both halves of that were checked. The emitted
module's chain-table import declares `0x00` limits — min only, 32-bit —
against the memory's `0x07` two lines above it
(`tcg/wasm64/tcg-target.c.inc:3681-3684` vs `:3674`), and `w64_chain_go`
wraps the target index with `i32.wrap_i64` before
`return_call_indirect` (`:1464`, and again on the chainloop return path
at `:1454`). The other half is that the table is **ours**: it is created
in JS as a plain `new WebAssembly.Table({element:'anyfunc', initial:
1<<14})` (`tcg/wasm64/wasm64.c:69`, again at `:903` and `:1091`) and
imported as `e.t`, so it is not emscripten's
`__indirect_function_table` and `--table64-lowering` never sees it. The
exact idiom the memory change needs is therefore already in this
backend, used for the table.

Do not read the `i64.eqz` in `tcg_out_goto_ptr` (`:1588`) as a table
index surviving in i64. That tests the *high half of the descriptor
word* — the `W64_TIDX_TAG` discriminator that separates a table index
from a heap pointer — and the index it guards is wrapped at `:1464`
like every other.

**`tools/bcprobe.mjs` has been run, both legs, and its result is the
table above** (`tools/perf/round35/bc-on.log`, `bc-off.log`,
Chrome/153). This paragraph used to read "do `bcprobe` first" and was
left standing after the probe was done — the same stale-instruction
failure as the `arm_rebuild_hflags` row, in this same document. **Check
whether a prescribed measurement has already produced a log before
scheduling it.**

What it does, for whoever re-runs it: crosses i64/i32 against
shared/unshared in four hand-assembled modules and reports ns per access,
in Chrome rather than node (`--chrome`), because the verdict is about the
engine that runs the emulator. It is self-validating: re-run with
`--js-flags=--no-wasm-bounds-checks` and the i64 leg must collapse onto
the i32 leg, or the kernel is not exposing a check and the numbers are
void. **Both halves of that control came back as required** — kernel 2's
i64 leg fell 0.146 → 0.121 onto its i32 leg, and kernel 1's did not fall
at all, which is the positive finding below, not a failure. The unshared
arm exists because sharing is the other candidate for disqualifying the
trap-handler path; it moved −1.6 %, so **sharing is not the
discriminator** and the item does not close on that account.

**The Binaryen half is verified, and it hides no check.** Lowering a
shared 64-bit memory by hand with the toolchain's own `wasm-opt`
(version 123, emsdk 4.0.10):

```wat
;; in
(memory $m i64 32768 32768 shared)   (i64.load (local.get $p))
;; out, after --memory64-lowering --table64-lowering
(memory $m     32768 32768 shared)   (i64.load (i32.wrap_i64 (local.get $p)))
```

Three things had to be true and all three are. The memory **stays
shared** while becoming 32-bit, so `-pthread` is not an obstacle at the
lowering step. The explicit 2 GiB max survives. And the pass emits
`i32.wrap_i64` **and nothing else** — no range compare, no trap guard, no
branch — so it does not substitute its own check for the engine's, which
is the whole premise. That opcode is the one this backend already emits
at `tcg-target.c.inc:1464`.

`link.py:437` applies those two passes for `MEMORY64 == 2`, and the only
combinations emscripten refuses are ASAN (`:1685`) and wasm2js
(`:1799`) — neither of which this build uses. Nothing in the linker
forbids `-pthread`, `ASYNCIFY` or `PROXY_TO_PTHREAD`.

What is still unproven is the part no static reading can settle: whether
V8 gives a **shared** wasm32 memory of 2 GiB the guard-region treatment,
so that the check really does become free rather than merely cheaper.
That is precisely what `bcprobe`'s shared/unshared axis measures, and its
i32 legs emit the `i32.wrap_i64` too, so what it reports is the *net* of
removing a check and adding a wrap — the number the build would actually
get.

### What a TB entry costs: 14.6 % of wall, band 10.1–18.7 %

Fitting wall against inverse TB length over the ten clean FTMAX legs
(`tools/perf/entryfit.py`, ft1/base/ft4/ft6, R² = 0.891):

> **ms/Mi = 3.4845 + 6.188 / len**, slope ± 0.767

> **Updated to four rounds, and it held.** Fourteen legs give
> **ms/Mi = 3.586 + 5.719/len**, slope ± 1.010 — **14.4 % of wall, band
> 9.8–18.6**. Adding the sweep's position effect as a linear term
> (`tools/perf/entrypos.py`) moves it to **14.6 %, band 10.1–18.7**,
> with position itself at +0.44 %/slot ± 0.0124, not significant on this
> subset. **This row is robust to the confound that withdrew `ft4`**, and
> the reason is worth keeping: this fit is anchored by `ft1`, whose
> translated length differs from base by ~28 %, while a position trend is
> worth ~1 % per slot. `ft4` moves length by 7 % and so sits at the same
> scale as the confound; `ft1` is four times larger than it. **A
> regressor much bigger than the nuisance is safe; one the same size as
> it is not** — which is the general rule this sweep paid to learn.

Entries per Mi go as `1/L`, so the second term *is* the entry cost. At
the base length that is **0.652 ms/Mi = 15.8 % of wall**, and the
intercept says **3.48 ms/Mi would survive infinitely long TBs** — the
lever's own ceiling, and a reminder that TB length cannot reach 84 % of
this workload no matter how far it is pushed.

**The band is the addition this round: 12.3 … 18.9 % at 95 %.** The
slope is eight standard errors from zero, so both the mechanism and,
unusually for this row, its size are settled. Nothing in that band
rivals the 24.5 % check row.

**Two legs were rejected to get here, and the reason generalises.**
Adding round 3's `base` and `ft1` — inflated ~9 % each by a host memory
burst, see "A host burst inflates a contiguous run of legs" in
[lessons.md](lessons.md) — collapsed R² from 0.891 to 0.472 and moved
the estimate to ~20 % with a useless 9–28 % band. **Three bad legs in
eighteen were enough to make a settled number look unsettled and a good
fit look like small-`n` luck.** The tell was not statistical: it was that
`base` alone read 4.151, 4.209 and 4.543 across three rounds, and a
control does not move 9.4 %.

Two corrections were tried before rejection and both were wrong. A
time-detrend (+0.111 %/min, which became +0.156 %/min on one more leg)
*lowered* R² to 0.63, because the driver is bursty and a linear model
cannot fit it. A per-round intercept barely moved the slope, because the
FTMAX arms already run adjacently within a round. **Once the burst legs
are gone the per-round intercepts read k1 3.496, k2 3.484, k3 3.481 —
there was never any drift to correct, only legs to drop.**

**This retracts the 43 % that stood in this section earlier in round
35.** That number came from one pair of arms, base→ft4: a Δt of 82.2
µs/Mi divided by `1 − 1/r` with `r` = 1.048. The arithmetic was right and
the conditioning was hopeless — translated length within the *same* arm
varies by more than the difference between arms (ft4 alone reads 9.449,
9.927 and 10.481 across three rounds), so the denominator's error bar
spans zero and the quotient can be anything. Three other pairings of the
same legs give 18 %, 20 % and 22 %; only the pair with the smallest and
noisiest denominator gave 43 %, and that is the one that got written
down. **ft1 is the only leg whose length change (−28 %) dominates its own
noise, so no estimate that excludes it is worth reading.**

The retraction restores two older numbers rather than overturning them.
The standing budget said 13.6 %; round 23 measured a TB→TB transition at
7.7 ns on EL71 and called it 9.1 % there. 15.8 % sits with both, and the
12.3–18.9 % band contains the first while excluding the second — which
is the right outcome, since 9.1 % was EL71 and this is J2ME.

**Per entry, the fit needs an entry count, and that is still the open
question.** The ms/Mi term does not: if executed length is `k ×`
translated, `k` is absorbed into the fitted slope and `b/len` is
unchanged. The ns figure is not so lucky:

| executed `L` | entries/Mi | ns per entry | source |
|---|---|---|---|
| 9.49 | 105,418 | 6.2 (4.8–7.4) | translated mean — a compile-time histogram |
| **18.05** | **55,402** | **11.8 (9.2–14.1)** | **J2ME exit census, measured** |

The census is the one to believe. On J2ME game 1, `xGotoptr` 38,394 +
`xGototb` 9,710 + `xGototb1` 7,281 = **55,385 exits per Mi**, and the
`xw*` family sums to `xGotoptr` exactly (14,787 + 17,166 + 1,630 + 3,326
+ 419 + 1,067 = 38,395), so `xw*` is a breakdown of `goto_ptr` and the
three counters together are the whole exit population. It has been in
`tools/perf/xcensus.out` since the census ran.

That ~18 is nearly **twice the translated mean**, and the gap is the
point: `tbGen` counts each TB once however often it runs, so
`tbIcount/tbGen` is a histogram over *compilations* in which a cold TB
translated once weighs as much as the interpreter's inner loop. Hot code
is loops and loops are long. Reading it as an executed length is the same
error as reading `tbIcount` as a mean, wearing a new costume.

One step is still an assumption — that entries and exits are the same
population — and the queued `W64_TBSTATS=1` legs settle it by counting
both in the same run (`wasm_tbs()` returns 0 on this backend under icount
unless that knob is set, `ui/wasm.c:166`, which is why every J2ME result
JSON carries `insnsPerTb: null`). Those legs' own ms/Mi is spoiled — two
RMWs join every prologue — but per-Mi rates stay exact, which is all a
ratio needs.

**Is there anything left to investigate?** Round 23 found ~6 ns to be
this engine's floor for a `return_call_indirect`. At 11.8 ns per entry,
roughly half is the tail call itself and ~6 ns is everything else: the
chain-table lookup (`lookup` 963/Mi against 55 k exits — the inline cache
serves 98 %), the wasm prologue and its locals frame, the register
reload (~1.8 loads, ~1.1 ns), and the epilogue. That is a normal-looking
budget with no missing 26 ns in it, which is a much weaker case for
building a per-phase timer than the retracted 43 % made. **The band's
top is 14.1 ns, so even the pessimistic end leaves nothing unexplained:
do not build the timer.** That is now a decision, not a deferral.

One older number still does not reconcile and should not be quietly
dropped: `tools/exitrate.sh` read 110.4 k exits/Mi on EL71 after
0111–0113, against `W64_XCOUNT`'s 240.6 k on the same board, when those
rounds claimed only ~12 % fewer exits between them. The two are not
counting the same event, and the J2ME census above uses the `W64_XCOUNT`
family, so whatever that discrepancy is, it is inherited.

### ~~Hoist the TLB mask and table out of the per-memop probe~~ — CLOSED in round thirty-eight

**Verdict: do not build.** Measured with `W64_TLBHOIST` over sixteen
counterbalanced legs: the ceiling is **+2.6 % of wall** for deleting the
pair on every memop (host-quiet legs, r=+0.82; the all-legs fit reads
+3.34 % but `ms/Mi` tracks `hostBusy` at r=+0.730). Only **66.2 %** of
memops follow another with no call or label between — `ldstRun` 3.527 of
`ldstGen` 5.325 — so the realizable figure is **~1.7 % gross**, before
the reloads the scheme must add at every barrier and slow-path return.
That is inside this rig's demonstrated noise band, for a change whose
failure mode is a wild store through a freed `fast->table`. The
prediction below that the item "shrinks to the load traffic alone" once
wasm32 lands was correct; this is that re-derivation. Everything from
here down is the original proposal, kept for its hazard analysis.

The larger version of the item below, and the largest non-wasm32 lever
found. `mask` and `table` are re-loaded from `env` for **every** guest
memop, but they are invariant between TLB flushes — so a TB could load
the pair once into two locals and every memop after the first would skip
two checked loads.

**Sequence this after `bcprobe`.** Most of the prize is the bound checks
on those loads, so if the wasm32 migration lands the checks are free and
this item shrinks to the load traffic alone — a much smaller number, and
one that has to be re-derived rather than scaled. Both TLB items are
sub-items of the 26 %, not additions to it, and neither should be built
until it is known whether the 26 % is reachable by a build flag.

The prize, in the same units as everything else: a guest memop goes from
5 checked accesses to 3. At 4.83 memops per TB (`ldstGen/tbGen`) and
9.73 instructions per TB, hoisting saves `2×4.83 − 2` = 7.66 loads per
TB = **0.79 of the 4.19 checks per guest instruction**, i.e. 18.8 % of
the check budget ≈ **4.9 % of wall** from checks, plus 0.79 fewer memory
operations per guest instruction on top. Projection from the per-check
price, not a measurement.

**Why wasm and not upstream.** No native backend does this; tcg/i386
re-loads the pair per memop. On x86 two extra L1 loads off a hot line
are nearly free, so the hazard below is not worth managing. On wasm64
those same two loads also cost two compare-and-branches, which is what
changes the trade. This is a case where the wasm backend should
*diverge* from the native ones rather than imitate them.

**The hazard is real and verified.** `tlb_mmu_resize_locked` does
`g_free(fast->table)` then `fast->table = g_try_new(...)`
(`accel/tcg/cputlb.c:268`, `:274`), and `tlb_flush_by_mmuidx` runs
*synchronously* when the target is the calling CPU — so an ARM `MSR` to
`TTBR`/`SCTLR`, or any other helper that flushes, can free the cached
pointer in the middle of the very TB holding it. A stale `table` is a
wild pointer, not a slow path.

So the cache must be invalidated, not merely refreshed: reload at every
`tcg_out_call`, at every label or branch target, and on return from the
slow path. With those invalidations the win shrinks toward the
straight-line runs between calls — which is where most ARM load/store
traffic lives, but the shrinkage is the thing to measure first. A
counter over `ldstGen` that reports how many memops follow another memop
with no intervening call or label, per TB, prices this before a line of
it is written, and is a translation-time counter like the rest.

Combine with the item below rather than choosing: hoist the pair with
**one `v128.load`** in the prologue and extract twice into locals, and
the whole per-TB cost is a single checked access.

### ~~Fuse the TLB probe's mask and table into one `v128.load`~~ — CLOSED in round thirty-eight

**Verdict: do not build.** The item's own sequencing rule closed it:
*"build this only if wasm32 does not land"* — wasm32 landed in round
thirty-six, and with the checks free only the load count remained. Round
thirty-eight measured load count directly. Duplicating the mask/table
pair costs +0.230 ms/Mi for the first extra pair and **−0.004** for the
second, so memory operations on this path are nearly free after the
first and removing one buys nearly nothing. That agrees with round 23's
`W64_TLBSIMD` reading (one-load `v128` 4.09 % against two-load 2.33 %):
*its cost is not its load count, and SIMD lane extraction is expensive.*
The unexplained tension the item asked to settle is settled the same way
— the probe's checks, not its loads, were the disputed term, and wasm32
removed them. Original proposal follows.

QEMU aligns `CPUTLBDescFast` deliberately and says so
(`include/exec/tlb-common.h:47`): *"The structure is aligned to aid
loading the pair with one insn."* It is `{ uintptr_t mask;
CPUTLBEntry *table; }`, 16 bytes, `QEMU_ALIGNED(2 * sizeof(void *))`.
Native backends load the pair together. The wasm64 backend does not — it
emits two `i64.load`s from the same base at memarg offsets 0 and 8
(`tcg-target.c.inc:2029` and `:2036`).

One `v128.load` plus `i64x2.extract_lane 0` / `1` replaces them.
Semantics identical, no new state, same base, same offsets — this is a
peephole, not a redesign. SIMD is already available in emitted modules;
`w64_tlb_simd_probe` emits `0xfd 0x00` today.

Two implementation notes that are easy to get wrong. **It needs one new
`v128` local** (`0x7b`), because wasm has no stack `dup` and a v128 is
consumed by its first `extract_lane` — `local.tee $v; extract_lane 0;
local.get $v; extract_lane 1`. That is affordable: the locals-pad probe
prices a declared local at ~0.56 ns per *baseline-tier* entry and only
~3.6 % of entries run baseline, so ~0.02 ns an entry. And **use memarg
align 3, not 4**, unless `CPUArchState`'s own allocation is known to be
16-byte aligned in linear memory; the align immediate is only a hint and
an over-claim is not a trap, but there is no reason to assert what has
not been checked.

There is one unexplained tension to settle with the same leg that builds
it. Round 23 priced the *entire* inline probe at 5.07 % of EL71 wall,
i.e. ~0.42 ns for three loads and the index arithmetic — yet 0.258 ns a
check says the bound checks on those three loads alone are ~0.77 ns.
Both cannot be right. The likely reconciliation is that `W64_TLBDUP`'s
duplicate probe had its *checks* folded by V8 even though its loads were
kept distinct (it varies `mmu_idx ^ 1`, which changes the address but not
the engine's ability to see the accesses as one range), in which case
round 23 measured loads-without-checks and is an under-estimate. If so
the probe is worth more than 5.07 % and this item is worth more than
3.1 %. Do not resolve it by argument.

Worth **~3.1 % of wall at today's wasm64 memory**: it takes a guest
memop from 5 checked accesses to 4, so 0.496 of 4.19 checks per guest
instruction = 11.8 % of the check budget × 26.04 %. Plus one fewer
memory operation, which is the part that survives everything. Cost is
roughly one extra host instruction (`movdqa` + `movq` + `pextrq` against
two `mov`s).

**It is a substitute for part of the wasm32 item, not a complement.** If
the memory moves to wasm32 and checks go free, the 3.1 % evaporates and
only the load saving remains. Sequence accordingly: `bcprobe` first, and
build this only if wasm32 does not land.

Two things it is *not*. It is not `W64_TLBSIMD`, which prices a
different redesign — a per-site cache keyed on a generation counter,
reading a fakeslot — and is a cost probe emitted *in addition* to the
real probe. And it is not blocked by the "a duplicate-probe prices
deletion, never insertion" lesson: that failure was putting a *branch in
front of* existing code, whereas this replaces two instructions with
three in place, on the same path, with no branch added.

The fusion stops there. The comparator and `addend` are 24 bytes apart
for reads and 16 for writes (`CPUTLBEntry` is 32 bytes, fields at
0/8/16/24), so no 16-byte load spans the pair either path needs; only
`addr_code` happens to sit adjacent to `addend`.

### Give the LG boards back their TB lengthening (live since round 34, never measured on ke800)

The fold target and the conditional loop back-edge merge are gated on
`w64_tb_icount_exact()`, which included `w64_tbstats_inline()` — armed on
exactly the boards icount is **off** for (`site/app.js:1449`: Siemens gets
`icount=shift=3,sleep=off`, LG gets `icount=none`). So every LG board has
been running with both mechanisms dead *and* paying two RMWs per TB entry,
to keep the `wasm_tbs`/`wasm_insns` MIPS display exact. Round 27 measured
FTMAX 1→2 at **+4.7 %** on a board where it is live, so the loss is
plausibly several percent across a family that also runs J2ME.

Patched in round 34 by making the counter refundable instead of blocking:
`w64_tb_acct_insns()` (backend) plus `w64_acct_charge()` (frontend) move
it by a signed amount on the paths where one prologue entry stops meaning
`tb->icount` instructions. No-op wherever the counter is not charged
inline, so **Siemens emits not one extra byte**. Exactness traced for all
three shapes; see the round-34 entry. **Not built, not measured** — the
J2ME bench cannot see this change; use `tools/uibench.mjs` on ke800.

The follow-on question, deliberately kept separate: those two per-entry
RMWs (~5 M/s) exist only to feed a display. If the MIPS readout can be
derived another way on non-icount boards, the prologue gets shorter for
the whole LG family.

### TB length is the Siemens lever, and the reason is register sync

Arithmetic worth having in one place. The J2ME exit census measures
**55,385 TB entries per Mi**, and fitting wall against `1/len` over the
FTMAX legs puts the whole row at **15.8 % of wall, band 12.3–18.9** —
see "What a TB entry costs" above — i.e. ~11.8 ns an entry.

(It used to read "a TB entry costs ~7.7 ns and there are 81,096 of them
per Mi = 13.6 % of wall". The 13.6 % was very nearly right; both of the
numbers it was built from were not. The count came from reading
`tbIcount`'s per-Mi value, 12.331, as a mean TB length, and it is a *sum*
over translated TBs; the price came from a different board. Two errors
of opposite sign is not a method.) On a Siemens board the emitted prologue
contains *nothing* — no accounting, no icount2, no lockstep (read
`tcg_out_tb_start`: every block is gated off) — so that 7.7 ns is the
`return_call_indirect`, the wasm function entry, `gen_tb_start`'s icount
check, and **register sync**: `tcgGst/tbGen` = 9.46 global stores and
`tcgGld/tbGen` = 7.18 loads, ~17 env accesses per TB. TCG already syncs
only dirty globals, so 17 is liveness-limited, not waste.

Against an average TB of **9.73 guest instructions**
(`tbIcount/tbGen`), that is **1.71** env memory operations per guest
instruction *before the guest's own work*.

> **Corrected in round thirty-five.** This paragraph used to continue
> "both costs are per-TB and neither grows with TB length, so they
> amortise directly: doubling the average TB halves both". Measured
> across a 60 % change in TB length, stores per guest instruction
> (`tcgGst/tbIcount`) are 0.939 at ft1, 0.972 at base and 1.026 at ft4 —
> they do not fall as TBs lengthen, they **rise**. Register sync is not
> demanded at the boundary at all: it is demanded inside the TB, by ops
> that can fault and by predication brconds, and folding through a
> branch to lengthen a TB *adds* brconds. Lengthening TBs buys more
> sync, not less.
>
> **Refined, same round.** Loads and stores are not the same kind of
> cost, and averaging them hid both. Regressing per-TB counts on TB
> length over seven legs spanning 6.83–10.91 instructions per TB
> (R² ≥ 0.99, `tools/perf/envfit.py`):
>
> | | fixed per TB | per guest insn | reading |
> |---|---|---|---|
> | env loads | 1.77 | 0.555 | 25 % fixed at base — prologue reload, amortises |
> | env stores | −1.45 | 1.149 | negative intercept: super-linear, no boundary term |
>
> Only the *loads* carry a boundary term, and it is small against its own
> lever: 1.77 reloads at ~0.6 ns is ~1.1 ns against a TB entry of 7.4–17.3
> ns, so **register reload is between a seventh and a sixteenth of what TB
> lengthening buys**. The rest of the entry is dispatch, not registers.
> Both ends of that range are soft in the same direction: 1.77 is *emitted
> ops per translated TB*, while the entry price is *ns per executed
> entry*, and an entry runs only the reloads on the path it takes. Treat
> it as an upper bound on the register share. (`ldstGen` fits an
> intercept of 0.84 too, but there is no mechanism for guest memops to
> have a per-TB term — read that one as a mix artifact of which code
> folding pulls in, not as a fixed cost.)
>
> **Both tables were wrong once.** The first pass used `tbIcount` as the
> mean TB length. It is the *sum* of `tb->icount` over translated TBs
> (`wasm-diag.h:112`) against a denominator `perMi` has already applied,
> so mean length is `tbIcount/tbGen` = 9.73, not 12.60, and a
> per-instruction rate is `x/tbIcount`, not `x/tbGen/tbIcount`. Both
> versions fit at R² ≈ 0.99; the wrong one inverted the store trend.
> `tools/perf/gsync.sh` carried the same error and is fixed.

That leaves the entry cost as the case for the fold target, the join,
absorb and the loop merge. Round 27 measured FTMAX 1→2 at +4.7 % and
round 35 measured 3→4 at −2.0 % with 6 worse than 4, so the lever is real
and close to exhausted.

**The unexplored end of it: pass guest registers as call parameters.**
Each TB is its own wasm function with signature `(i64, i64, i64) -> i32`,
so nothing can stay in a local across a chained `return_call_indirect` —
which is *why* there are 17 env accesses. Widen the signature and the
chain carries the guest register file in parameters, touching memory only
when a helper, an exception or a chain break needs it. Unlike the
module-merge (closed at +27 %: a `br_table` at every entry), this keeps
one function per TB and adds no dispatch.

> **Round thirty-five caveat, and it is a large one.** This can only
> remove the write-backs demanded *at* the boundary — `GSYNC_BBEND` and
> `GSYNC_EXIT`. It cannot touch the ones a faulting guest access
> (`GSYNC_SE`) or a helper (`GSYNC_CALL`) demands, because those must
> leave env coherent no matter where the registers otherwise live. Since
> env traffic is now known to be flat in TB length, most of it is *not*
> at the boundary, so "17 env accesses per TB" badly over-states what a
> wider signature would buy. The `GSYNC_*` counters measure the reachable
> share directly; read them before pricing this, let alone building it.

It is also a very large change with exception-path exposure, so **price
it before building it**: a
`dispatchbench.mjs`-shaped probe comparing a 3-param chain that does 17
env accesses against a 16-param chain that does none, at the real module
topology (lessons.md: a synthetic leg prices the real thing only if it
has the real thing's module topology).

### Price `arm_rebuild_hflags` — CLOSED at 31.6 ns/call, 0.8–2.3 % of wall depending on the game

> **Corrected 2026-09-22 (round forty-seven): 12.3 ± 1.6 ns a call, not
> 31.6.** A same-binary duplication probe (n extra rebuilds per inline
> SVC, +18 876 calls/Mi verified by `hflagsCalls`, fitted on `hostBusy`)
> read 2.6 % of video and 0.3 % of J2ME game 1. The 31.6 ns below is a
> difference of two 1 ms-quantized clock sums and was 2.6× high. A memo
> is not worth it (playbook § REJECTED).

> **Closed 2026-09-17 on data that was already on disk.** This section
> spent its length arguing that the number needed "one build with
> `-DWASM_DIAG_TIME_PHASES`" and was "still owed". It was not: the
> `nsclock` and `nsrate` legs at 16:10 and 16:12 that same day were run
> from a build that carried the flag, and both logged `hflagsNs`,
> `hflagsNsN` and `hflagsCal`. What was true is the narrower claim that
> *the 18:38 `postsweep.sh` rebuild* did not carry it — and that got
> generalised into "the measurement does not exist". **Grep the logs for
> the counter before declaring a measurement owed**; the cost of not
> doing so was nearly a whole rebuild.
>
> From `nsclock` (the cleaner of the two — `nsrate` also had
> `W64_LDSTCOUNT`/`W64_LSMCOUNT`/`W64_TLBCHEAP` on and ran 17 % slower):
>
> ```
> (hflagsNs - hflagsCal) / hflagsNsN
>   = (26278.339 - 17801.456) / 268.326 = 31.6 ns per call
> ```
>
> **Subtracting `hflagsCal` is not optional.** The raw
> `hflagsNs/hflagsNsN` is 97.9 ns, so the two clock reads are two thirds
> of the measured span and the uncorrected number is ~3× the truth. This
> is the same 1 ms-quantized browser clock with a ~66–75 ns floor that
> `calNs/calNsN` reports generically (68.9 ns on this leg, which
> independently brackets the per-phase figure).
>
> The cost is then `31.6 ns × hflagsCalls`, and **`hflagsCalls` is the
> variable, not the cost per call**:
>
> | workload | calls/Mi | ms/Mi | hflags cost |
> |---|---|---|---|
> | CX70 game 1 (clean legs, `census`/`k*_base`) | ~1065 | ~4.4 | 0.034 ms/Mi = **0.77 %** |
> | `nsclock`'s own leg | 2147 | 5.738 | 0.068 ms/Mi = **1.18 %** |
> | the SWI-heavy game 2 (`g2fix`, `g2probe`, `phase-g2`) | ~5155 | ~7.2 | 0.163 ms/Mi = **2.26 %** |
>
> So **0.8–2.3 % of wall, set by the guest's SWI rate**, which varies 5×
> between games on the same firmware. The estimate this section opened
> with (0.6–1.6 %) was right in shape and slightly low at the top.
> It is a real row, it is not the 11 % the profile claimed, and the
> lever named at the end of this section is still the right one.

**Found on counters already on disk, round 35, unpriced.** `hflagsCalls`
= **1066.833/Mi** on J2ME game 1, against `excSwi` 402.722 + `excIrq`
5.343 = ~408 exceptions/Mi. That is **2.6 rebuilds per exception**.

Round 34 priced exception *entry* at 1.04 % with three spans — the
unwind (`EXC_LJ_NS`), the BQL round trip (`EXC_BQL_NS`) and
`arm_cpu_do_interrupt` (`EXC_DO_NS`). The rebuild on the entry side is
inside the third: `take_aarch32_exception` calls it
(`target/arm/helper.c:8969`, reached from `arm_cpu_do_interrupt` at
`:9698`). **The other ~659 calls per Mi are inside none of them** —
exception *return* (a CPSR write from SPSR), `msr`, mode switches, of
21 call sites in `target/arm/`.

At any believable cost per call this is the same size as the two blocks
round 34 measured: 659/Mi × 40 ns = 26 µs/Mi = **0.6 %**; at 100 ns it is
1.6 %. That range brackets both "smaller than display" and "larger than
exception entry", which is exactly why it needs a number and not an
estimate.

**The timer already exists and is switched off.**
`target/arm/tcg/hflags.c:779-791` times `arm_set_hflags(env,
rebuild_hflags_internal(env))` against its own empty interval
(`HFLAGS_NS`, `HFLAGS_NS_N`, `HFLAGS_CAL`), sampled one call in eight —
so the mean is `hflagsNs/hflagsNsN` and the total is that mean times
`hflagsCalls`, with `hflagsCal/hflagsNsN` subtracted as the clock's own
floor. Unlike `W64_DISPNS` and `W64_EXCNS`, which are `getenv` knobs and
therefore A/B-able inside one binary, this one is
`#if defined(WASM_DIAG_TIME_PHASES)` and **that macro is defined
nowhere** — not in `scripts/`, not in any `meson.build`. So it needs one
build with `-DWASM_DIAG_TIME_PHASES`, not a knob.

**The source comment next to the counter argues the opposite, and it is
stale.** `hflags.c:770-777` reasons: "called 11.6 k times a second,
which at any believable cost per call is under 0.3 %". That rate is
from an **idle CX70**. On J2ME game 1 the same counter gives
`1059.481/Mi × 230.67 MIPS = 244,000 calls/second` — **21× higher** — and
at 100 ns/call that is 2.4 %, not 0.3 %. The comment is correct about
what it measured and wrong as a general dismissal; a reader who meets
it while chasing this row will drop the row. **Fixed in
`hflags.c:766-786` on 2026-09-17**, which now carries the 31.6 ns figure
and the 0.8–2.3 % range rather than a single game's rate — and states
the workload beside it, which is the rule this row exists to teach.

**The 2026-09-17 18:38 `postsweep.sh` rebuild did *not* carry the flag**
— but an earlier build that day did, which is how this got closed
without a rebuild at all. See the note at the top of this section.

The advice that came with it still holds for the next such row: **do it
as part of the next rebuild, not as a rebuild of its own**, and read the
timing counters in the same run as everything else — they are per-Mi
rates, so a build carrying extra timers still gives exact ratios even
though its wall is spoiled. `nsclock` vs `nsrate` shows both halves of
that: their per-call costs differ by 56 % because `nsrate` carried three
more counter sets, while their `hflagsCalls/excSwi` ratios agree to
2 %. The lever, if the number
justifies one, is that a CPSR write which changes only mode or the IT
bits does not need the full `rebuild_hflags_internal` walk over CP15;
but **do not design that before the number exists** — this file has a
round-34 precedent in both directions, where display came in 7× above
its estimate and the module pipeline came in at 0.07 %.

### Delete the global next-TB cache — it is a cache behind a cache

> **A/B'd on 2026-09-17 and the wall went the other way. Do not delete
> the emitted probe.** `pcc_on` vs `pcc_off` (both knobs, back to back):
> `tbBytes/tbGen` 1051.6 → 911.5 (**−13.3 %**, inside the 7–14 %
> predicted below, so the knob engaged and the leg is readable), and
> **ms/Mi 4.335 → 4.503, +3.9 % slower without it**. Per this section's
> own read-instruction, that means the section is wrong, and the
> counters say precisely where: `lookup` went 972.7 → **8688.4 /Mi, a
> factor of 8.9**, and `tbGen/Mi` 1.357 → 1.496.
>
> **The error is that `pccHit` does not count the emitted probe.** It
> counts the *C-side* helper's hits — the redundant re-probe — and that
> half really is redundant, so everything below about `HELPER(lookup_tb_ptr_lc)`
> stands. The emitted probe's hits were never counted at all: they are
> the lookups that **never happen**, and they are visible only as the
> 7,716 lookups/Mi that `lookup` does not see while it is on. A 0.28 %
> hit rate was read off a counter wired to the wrong half, and the
> proposal to delete both halves as one item followed from that.
>
> The decisive leg is cheap and still owed: **`W64_NOPCC=1` alone**, C
> halves off, emitted probe kept. If it is wall-neutral and leaves
> `lookup` near 972, the C half is free to delete and the emitted half
> must stay. No rebuild needed. Until that leg exists, treat the
> emitted probe as load-bearing and the C probe as unproven-but-likely
> free.
>
> Two cautions on the wall figure itself: it is n=1 per arm, and the
> legs were adjacent, so ~0.9 % of the 3.9 % is the +0.87 %/position
> drift — call it ~3 % directional. The 8.9× on `lookup` is not a wall
> measurement and carries none of that.

**Found on counters already on disk, round 35, not yet A/B'd.** From
`k1_base` (per Mi): `pccFill` 460.814, `lcFill` 460.766, `lcCall`
463.649, `lookup` 962.943, **`pccHit` 2.746**.

`pccFill` tracks `lcFill` to three digits. The global table is filled on
exactly the occasions the *per-TB slot* is filled — and the slot is what
answers the next time that exit site runs. A cache placed behind another
cache sees only the first one's misses, which is the one population a
pc-keyed table cannot predict.

The C-side probe is worse than ineffective, it is **redundant by
construction**. On the `lc` path the emitted probe
(`gen_goto_ptr_pcc`, `target/arm/tcg/translate.c:1553`) has just missed
on the identical pc, generation, cpu_index and 3-word key, microseconds
earlier, against the same 16384-slot table — and then
`HELPER(lookup_tb_ptr_lc)` probes it again in C (`cpu-exec.c:885`). It
cannot hit. `pccHit` = 2.746/Mi against 962.943 lookups is that fact
measured: **0.28 %**.

Its own header names the ceiling it was built against — "`lookupJc/lookup`
= 96.5 %" (`cpu-exec.c:570`). On J2ME that ratio is 441.281/962.943 =
**45.8 %**. The mechanism is aimed at less than half the target it was
designed for, and collecting 0.28 % of that.

Two costs, and the second is the one worth having:

- **Runtime**, and it is small: ~963 probes/Mi of a 512 KB table that
  answer "no", plus ~461 32-byte fills into it. Call it 0.1–0.35 % of
  wall — under the 1.4 % round-to-round spread of `base`, so the wall
  legs alone can neither confirm nor refute it.
- **Emitted code at every `goto_ptr` site**, and this one is measurable.
  `gen_goto_ptr_pcc` is ~30 TCG ops — a six-op hash, an address
  materialisation, three to six loads each with a branch, and a
  five-store slot refill on the hit that does not come. Against 1059
  bytes of emitted wasm per TB, one such site is plausibly 7–14 % of
  every TB. `tbBytes/tbGen` has a **0.04 % spread** (lessons.md, the
  mechanism meter), so it reads this directly even though the wall
  cannot.

**No rebuild is needed to test it.** `W64_NOPCC=1` disables the C halves
and `W64_NOPCCIN=1` the emitted one; both are read once via `getenv`.
The matched pair is queued in `tools/perf/after.sh` as `pcc_on` /
`pcc_off`, reporting `msPerMi`, `tbBytes/tbGen` and the four counters
above.

**Read the result this way.** `tbBytes/tbGen` must fall, or the knob did
not engage and nothing else in the leg means anything. If it falls and
the wall does not move, the item is still worth taking — it deletes a
mechanism, 512 KB of resident table and ~30 ops from every exit site for
no measured return, and *not* taking it means carrying all of that for a
0.28 % hit rate. If the wall *rises*, the emitted probe is doing
something the counters do not show and this section is wrong; say so
rather than re-deriving.

One caveat against over-claiming: these counters are from one game on
one board. `pccHit` is a measured count, not a derived one, so it does
not carry round 35's denominator problem — but "0.28 % on J2ME game 1"
is not "0.28 % everywhere", and the boot and idle workloads are exactly
where a 96.5 % `lookupJc/lookup` was once measured. **Check the other
boards before deleting the code, not before running the A/B.**

> **And the wider point, which is why no successor to this item should be
> built.** The whole lookup path is now a ~1 % problem. Against **55,385
> exits/Mi** the emitted per-TB slot already answers 98.3 %, leaving
> `lookup` = 962.943/Mi for every mechanism behind it to share: the
> global table (0.28 % hit), the jump cache (`lookupJc` 441.281, a 45.8 %
> hit) and the QHT (`lookupQht` 520.293, of which `lookupConfl` 494.813 —
> **95.1 % conflict misses**, a number that looks like a bad hash and is
> worth understanding, but is worth at most ~0.9 % of wall even if it
> went to zero). Three caches deep is already one too many. Nothing in
> this neighbourhood can return more than about a percent, so **spend the
> effort on the 24.5 % instead** and treat every lookup-path idea as a
> tidy-up, not a lever.

### Closed in round 34: the display chain and the exception path

Both priced with in-binary timers against their own clock-read floors,
games 1 and 2: **display 1.74 % of wall** (not the 0.25 % this file
carried — that estimate mixed legs and was 7× low) and **exception entry
1.04 %**, 2.78 % together. Inlining ARM `SWI` entry into emitted code is
therefore not worth its correctness exposure, even though 98.7 % of
exceptions are guest SWIs. Do not re-open either without a new mechanism.

### The module-local dispatch loop — merge a module's TBs into one wasm function

> **CLOSED 2026-09-17 (round thirty-three), on arithmetic already in this
> file.**  The item survived round 32 by retreating to "tier-up
> amortisation alone", but the retreat does not work: the merge is not
> free to *enter*.  One function can only select its TB with a `br_table`,
> so every TB entry pays that dispatch — which is exactly the cell round
> 32 measured.  At a realistic body size (pad 144, strided) `merged` reads
> **51.13 ns against `xtail`'s 35.73**, i.e. **+15.4 ns per entry**, and
> the emulator's bodies *are* that size: `tbBytes/tbGen` = **1025 bytes of
> emitted wasm per TB** on the J2ME workload.  At the measured **55,385
> entries/Mi** (the J2ME exit census) the merge costs **0.85 ms/Mi
> against a 4.151 ms/Mi budget = +21 %**, to collect a prize of 3–6 %.
> Dead by a factor of four to seven.
>
> (Round thirty-five, twice.  It first read "81,096 entries/Mi … +27 %"
> from `tbIcount` misread as a mean TB length; the correction to that
> overshot to "~240 k … +89 %", using `W64_XCOUNT`'s EL71 exit rate as if
> it were this workload's entry count.  The census settles it at 55,385.
> All three verdicts are "dead", which is why this stays a footnote — but
> the swing from +27 % to +89 % to +21 % across one round is the honest
> record of how little the entry count was pinned down, and the lesson is
> in lessons.md under "A difference is only a denominator".)
>
> This is the third refusal and they should be read together: round 27
> already priced it at "~3 % of wall for a module-assembler rewrite"
> because a `br` removes only ~39 % of a hand-off; round 32 closed the
> boundary half; lessons.md had already written "the fix they proposed was
> a regression".  Only this section had not been reconciled with them.
>
> **The consequence worth carrying forward: V8's baseline-tier share is
> structurally uncollectable from inside the binary.**  It is real (3–6 %,
> `--no-liftoff`) and the only in-binary mechanism that reaches it costs
> more than it returns.  Treat it as part of the floor, not as headroom.
> Reopen only if a scheme appears that keeps one function per TB *and*
> shares a tier-up budget — nothing in the wasm or V8 surface offers that
> today.

**Superseded framing, kept because the feasibility work below is still
correct and reusable.**  (It may also address the TB boundary; that half
is unproven — see below — and the item does not rest on it.)  A module holds
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
   from each body and declares the run once.  (The run count is a
   constant four now that `W64_LOCALPAD`'s fifth run is gone.)
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

## Update (2026-09-24, round fifty-three: the qht path was mis-priced, a code page's ram_addr from its TLB entry, TB bodies out of the code buffer)

The owner asked for new areas, "not what is already there". The round
started from two V8 `--prof` profiles at `967f88004e` (J2ME game 1 in
play, 55 s window; S75 cold boot, first 12 s), split by tier and by
subsystem with `tools/perf/v8tick.py` and a grouping pass over its top
400 rows.

### What the J2ME profile says (vCPU isolate, in play)

| group | share of the vCPU |
|---|---|
| TB code, TurboFan | 69.2 % |
| main-module C | 18.2 % |
| TB code, Liftoff (+ `WasmLiftoffFrameSetup` 1.6 %) | 6.3 % |
| V8 builtins, chrome C++, libc | 6.3 % |

Of the 18.2 % C: exec loop and lookup 6.8 % (`helper_lookup_tb_ptr_lc`
2.58, `qht_lookup_custom` 1.23, `tb_htable_lookup` 0.79), mmu/tlb 4.45 %
(`qemu_ram_block_from_host` 2.69, `probe_access_internal` 1.02),
translation 3.33 % (`tb_lookup_cmp` 1.39, `get_page_addr_code_hostp` 0.78,
`tcg_gen_code` 0.64), devices 1.24 %, exception/cpsr 0.78 %. The module
pipeline (`w64_assemble_instantiate`) and the interpreter tier do not
register in play at all; they are boot costs (boot: ~26 % V8 compile,
~18 % translation, 33 % TB code in the first 12 s).

**The qht path is 7.9 % of the J2ME vCPU, not the 0.7 % round fifteen
closed it at.** That closure priced `qht_lookup_custom` alone on the
assumption that "the rest of the probe inlines into it". It cannot:
`qht_lookup_custom` takes the comparator as a function pointer, so
`tb_lookup_cmp` (1.39 %) is its own frame, and each two-page candidate it
compares — plus every `tb_htable_lookup` — pays `get_page_addr_code_hostp`
→ `probe_access_internal` → `qemu_ram_addr_from_host_nofail` →
`qemu_ram_block_from_host` (0.78 + 1.02 + 2.69 %). With the helper's own
2.58 % the goto_ptr miss path is ~8 % of the vCPU, and round fifteen's
own census said two thirds of that traffic is conflict misses in a
16384-entry direct-mapped cache. The jump-cache/pcc lever reopens on
that price (below).

### `5f450abf1b`: a code page's ram_addr from its TLB entry

`get_page_addr_code_hostp()` had the number in hand —
`CPUTLBEntryFull.xlat_offset` is ram_addr − vaddr for RAM and the offset
within the region for a ROMD device, whose RAM block starts at the
region's ram_addr — and recomputed it with an RCU read lock and a walk
of the RAM block list, on every jump-cache miss that reached the qht.
Now `addr + xlat_offset` (+ `memory_region_get_ram_addr(mr)` for ROMD).

J2ME game 1, 3-round ABBA against `967f88004e` at tb-size=768
(`tools/perf/j2abba.sh`, scored by `vgfit.py` against host load):
**−8.9 % ± 4.2 % ms/Mi** at mean busy 0.53. The host was busy 0.08–0.82
across the twelve legs (other jobs on the machine; slope 3.0 ms/Mi per
unit busy, residual sd 0.25 ms/Mi), and the two quiet legs (busy
0.08/0.11) tie within that residual — so the fitted number is the honest
one, and the mechanism is read off the profile rather than the timing: in
a `--prof` leg of the new build `qemu_ram_block_from_host` is gone from
the vCPU's top 400 rows (it was the largest C row, 2.69 %),
`probe_access_internal` reads 0.24 % and `get_page_addr_code_hostp`
0.06 % (that leg ran under gate load, duty 0.34, so its shares are not
otherwise comparable with the HEAD profile). Gate keep GREEN.

### N9 closed: compiling the batch module off the vCPU thread

Two facts close it, both measured. (1) V8 has no cross-isolate module
cache for a synchronous `new WebAssembly.Module`: in node v22.22.1 the
same bytes compiled first in a worker then on the main thread cost
93.7 µs against 128.7 µs fresh (5 functions) and 135.9 against 141.7 µs
(40 functions) — a warm allocator, not a cache; only the *same isolate*
recompiling the same bytes is cheap (9.8 / 64.5 µs; instantiate 8.7 /
48.2 µs). So a helper thread cannot hand the vCPU a compiled module. (2)
The vCPU worker never pumps its event loop — the port uses only
`emscripten_futex_wait/wake` and Asyncify fibers (`util/coroutine-wasm.c`),
no `emscripten_sleep` — so an async `WebAssembly.compile()` has no turn
to land on, and an event-loop turn costs ≥ 1 ms against the 83 µs a module
costs to create.

### `8bacd9370c`: TB bodies leave the code buffer once staged

A translated TB used to stay in the code buffer whole: the 16-byte
descriptor plus ~1.7 KB of wasm function body, which nothing read again
once the batch module had landed — except an eviction, which re-assembled
the module from it. That is what made the 256 MB buffer flush every
~120-140k TBs (the cleanup entry below found the flush inside a J2ME
window), and it is why a retaddr could be a pointer into the body.

Now `tcg_out_tb_finalize` hands the batch a heap copy of the body and
rewinds `code_ptr` to the descriptor: `tcg_gen_code` returns 16, the
unwind data lands right after the descriptor, and a TB costs the buffer
the TranslationBlock, 16 bytes and its search data — a few hundred bytes,
so the flush is ~5× rarer for the same buffer, or the buffer can shrink.
The copy is freed when the batch lands (the module holds the code), when
a member is withdrawn (`w64_batch_unstage`, now also on the
`existing_tb != tb` discard path) and at `tb_flush`. Three consequences,
each with its own line in the change:

- **A retaddr is an encoding, not a pointer.** `w64_pc()` bakes
  `descriptor << 20 | offset + GETPC_ADJ` (exec/translation-block.h
  `W64_RA_*`; the body is ≤ 64 KB and a real pointer is < 2 GB, so the high
  word tells them apart). `tcg_tb_lookup` decodes to the descriptor,
  `cpu_unwind_data_from_tb` rebuilds `tc.ptr + offset`, and
  `cpu_restore_state`/`cpu_unwind_state_data` test the decoded descriptor
  against the buffer. Every other consumer — `cpu_io_recompile`,
  `tb_check_watchpoint`, the precise-SMC path, `w64_tb_insn_index`, the
  interpreter tier's records — funnels through those.
- **An evicted member is retired, not re-instantiated.** Its module and
  body are gone, so the dispatcher does what `cpu_io_recompile` does:
  `tb_phys_invalidate` + `cpu_loop_exit_noexc`, keeping the loop's
  `cflags_next_tb` request for the retranslation. Nothing can still reach
  the old TB: eviction unlinked its incoming chains and bumped the
  generation that retires the inline caches. Proven with a scratch build
  at `W64_LIVE_MAX 48`, where eviction and retire run throughout a boot:
  S75, EL71 and KE800 boot, and the wasm-vs-native lockstep comparison
  (one-insn-per-TB, so thousands of modules) matches.
- **The chain table is bounded by the same flush.** Every translation
  takes an index (`w64_alloc_tidx`), recycled only by `tb_flush`, and past
  `W64_TIDX_N` (2²¹) the interpreter tier silently dropped records. With
  ~120k TBs per flush that was unreachable; at a few hundred bytes per TB
  a 768 MB buffer holds ~2M. `tb_gen_code` now treats a nearly full table
  like a full buffer (`w64_tidx_left`).

Timing, J2ME game 1, 3-round ABBA at tb-size=768 (so neither arm
flushes inside the window; both arms carry the census hooks): **−2.8 % ±
2.4 % ms/Mi** at mean busy 0.51, slope 2.4 ms/Mi per unit busy, residual
sd 0.12 — no steady-state cost, and a small gain that is consistent with
the descriptors and TranslationBlocks now being packed 4.8× denser (the
dispatcher reads one descriptor word per TB, and the loop the TB struct).
The three quiet N1 legs (busy 0.05-0.08) read 1.93-1.98 ms/Mi against
the one quiet HEAD leg's 2.52 at busy 0.12; suggestive, not claimed — the
fit is the number. Video (SL65 Berlin.3gp, 2-round ABBA, 8 legs): **−2.6 %
± 1.3 % ms/Mi** at mean busy 0.66, residual sd 0.06 — the same size, on
the workload whose code buffer bytes never came near a flush, which is
what the packing explanation predicts.

What the census says about play (both arms carry the eight
`tools/perf/bench-hooks.patch` slots, read per 45 s game-1 window): ~10.3k
translations and **10 modules** per window — batches fill to their 1024
members in play, so the module pipeline is not a steady-state cost at
all; mean live modules ~350 against the 6144 cap, so **eviction never
runs in play** and the retire path is a boot/long-session concern only;
`tb_flush` 0 at tb-size=768; invalidations 108-131 per window; and the
code buffer consumed **1812 bytes/TB before, 378 after** — the flush
cadence stretches 4.8×, or the buffer can lose four fifths of its 256 MB
for the same cadence. One leg per arm at the default 256 MB buffer
(census only, the host was busy 0.76): 1729 → 361 bytes/TB and no flush
inside either 45 s window, so the cleanup entry's "both arms flush once
per run" happens before the window opens; the cadence claim rests on the
bytes, not on a flush caught in the act.

The first build of it died at once with `tb_tc_cmp: a->size == b->size`:
rewriting `tcg_tb_lookup` had lost the `.size = 0` that marks a lookup key
to the region tree's comparator, so every lookup went down the insert
branch. An adversarial read of the diff by a second agent found no
corruption path and the two cold-path gaps fixed above (`cflags_next_tb`,
the discard path's unstage) plus the chain-table bound.

### V8 facts that reprice three levers (sources: V8 source at github.com/v8/v8, v8.dev)

Fetched from the V8 sources by a research agent (the web tools 400 on
this model; `curl` against the raw files works), all verified:

- **Liftoff compilation is lazy by default** (`wasm_lazy_compilation`
  true; `GetDefaultTiersPerModule` hands every function `kNone` for a
  synchronous `new WebAssembly.Module`). Module creation compiles no
  function bodies; each TB function is Liftoff-compiled on its *first
  call* through the lazy-compile stub. So the ~83 µs "module cost" is
  decode + validate + instantiate, and the boot's V8 compile share is
  paid per TB at first execution — which is what the interpreter tier
  competes with: a body interpreted N times against one per-function
  Liftoff compile plus N cheap runs, not against a per-module compile.
  That is also why the `W64_INTERP_THRESH` sweeps (16-1024, flat, rounds
  above) found nothing: the threshold never moved a compile that was not
  going to happen anyway, only the point at which a body that *is* run
  gets compiled.
- **The tier-up budget is billed in executed machine-code bytes**
  (`LiftoffCompiler::TierupCheck`: at loop back-edges `pc_offset −
  loop_start`, at `return`/tail-call `pc_offset + 40`, +20 per check,
  capped at budget/4; `--wasm-tiering-budget` 13 000 000 per function).
  A TB whose Liftoff code is ~6 KB tiers up after ~2 000 executions; a
  *leaner* body bills fewer bytes per run and tiers up **later**. The
  in-play Liftoff share (6.3 % + 1.6 % frame setup) is therefore the tail
  of TBs under ~2 000 runs plus background-compile latency, and it
  cannot be bought with smaller code. Tier-up lands at the next call
  (jump-table patch), never mid-frame; compilation hints are not
  reachable from content (Phase 2, V8 test-only); branch hints are
  spec v3.0 and unconditional in V8.
- **Linear memory costs RSS as it is written**, not as it is grown
  (`BackingStore` reserves guard space `kNoAccess` and `memory.grow` only
  changes protections). A code buffer therefore costs RSS up to its
  high-water mark and a flush frees nothing; after `8bacd9370c` a 64 MB
  buffer would still hold ~170k TBs (more than the 256 MB one held
  before) while capping that RSS at a quarter — a memory lever for the
  phone, priced below as a follow-up.

### Priced by reading, queued behind the measurements (design studies)

Four read-only studies ran while the A/Bs occupied the host. Their
conclusions, with the numbers they rest on:

**Video mode switches — ~8.7 % of the video vCPU (estimate from
measured anchors).** Per crossing: SVC ≈ 50 ns (import call 14.5 ns
measured, `take_aarch32_exception` → `switch_mode` → `cpsr_read` →
`arm_current_el` → `arm_rebuild_hflags` 12.3 ns measured, plus the
goto_ptr key), eret ≈ 60 ns (`cpsr_write` with the exception-return
mask, `aarch32_cpsr_valid_mask` recomputed from realize-constant inputs,
rebuild, the shared handler-exit TB's pcc probe), mode-changing `msr`
≈ 38 ns; 2 360 + 2 369 + 1 205 per Mi against 3.5 ms/Mi. No longjmp, no
jump-cache or generation traffic on either path (verified). The
redundancy: **hflags depend on the mode only through EL** under the
fast-path feature guard (`hflags.c:214-257` reads `el == 0`, SCTLR,
CPSR.PAN/IL/E and nothing else), so every EL1→EL1 switch (SVC↔SYS/IRQ)
recomputes an identical value and the change test in `cpsr_write` /
the unconditional rebuild in `take_aarch32_exception` fire for nothing.
Ranked: (A) EL-aware rebuild skip, 12.3 ns × 1 205-5 937 /Mi = **0.4-2.1 %
of video**, census first (count identical results); (C) cache
`aarch32_cpsr_valid_mask` at realize, 0.2-0.3 %; (D) flatten the five
internal calls per entry (`always_inline`), 0.6-1.5 % unverified; (B)
inline the EL1→EL1 mode-changing `msr` with the bank swap in emitted
code, ~1.0 %, medium risk; (E) SVC entry template, 0.3 %. J2ME sees
≤ 0.3 % of any of it. Already closed and not to be redone: the hflags
memo (100 % hit, no movement), the BQL pair, the longjmp.

**The 16-bit jump cache's flush cost.** `tcg_flush_jmp_cache` clears
the table with one `qatomic_set` per entry — a locked `xchg` on x64 —
so a full clear is ~130-460 µs at 16 bits (33-115 at 14), 3-100× the TLB
memsets it accompanies; and `tlb_flush_by_mmuidx_async_work` runs it
even when nothing was dirty. J2ME flushes 0.011-0.036 /Mi (round-35
logs) → 0.03-0.4 % of wall, an order of magnitude under N4's gain; LG
boards flush 0/s at idle and in menus. **CX70 at idle flushes 3.07 /Mi**
(unconditional DACR writes, never idempotent) → 1-10 % of that board's
idle vCPU at 16 bits against 0.3-2.6 % at 14 — the one place it can
bite. Fix, C-only (emitted code never reads `CPUJumpCache`): stamp the
per-CPU generation into the unused upper half of the 32-bit guest pc
(entries stay 16 bytes), compare `pc | gen << 32` in `tb_lookup`, and
make a full flush `gen++` (loop only on wrap); the per-page clear keeps
its 256-slot loop, since a global bump on TLBIMVA would drop the live
set. Not `tb_key_gen`: that one moves on every `tb_phys_invalidate`
(~200 /Mi). Queued as N4b, before N4 ships to a Siemens idle meter.
Also seen: `tlb_reset_dirty_range_all` at 0.33 % is the fill-grown TLB
(up to ~38k entries) being walked per code-page protect.

Built as `741597d60a` and measured on S75 boot+idle (idlebench, three
runs per arm, census hooks on both): milestones equal within noise (1 G guest
insns at 17.2 s against 17.8 s; the arms differ only when a full flush
happens), so it is a correctness-of-cost change for the CX70 class
rather than an S75 win.

**A census artefact, recorded so it is not repeated.** The variant hooks
built for this A/B added counters to slots 5 and 6 — but the committed
`bench-hooks.patch` already increments slot 5 with "live modules summed
per translation" and slot 6 with code-buffer bytes. Slot 5 therefore read
~1 000-1 800 /Mi (≈ 140 live modules × 7-13 translations/Mi), and three
successive censuses read that as "1 840 / 740 / 990 per-page jump-cache
clears per Mi" — a flush storm the S75 firmware does not have. A fourth
census, on slots the base patch leaves alone, put the per-page TLB
flushes reaching `tlb_flush_page_by_mmuidx_async_0` at **~0 /Mi** on
S75 boot+idle, full flushes at 0.05 /Mi. The 838 qht lookups and 531 pcc
misses per Mi at S75 idle are the working set, not retires. Rule: a
repurposed census slot must be one the base patch never touches (or the
base arm's value must be subtracted); read the slot map in the patch
header before believing a number.

**Boot translation cost (18 % of the first 12 s: `tcg_gen_code` 8.5 %,
`liveness_pass_1` 4.4 %).** Read against the round-25 split (frontend
4.5 µs, optimize+liveness 5.3, regalloc+emission 8.0, batch close 3.7,
bookkeeping 4.1 per TB). The backend has 13 allocatable registers, a
call-clobber set of {R0, R1} and ~0 spills, yet `liveness_pass_1` runs
its O(nb_temps) sweeps at every side-effect op — `la_cross_call` on each
`qemu_ld/st` (they carry CALL_CLOBBER) as well as on calls, `la_bb_end`/
`la_bb_sync` at every label and brcond — and TEMP_TB temps are never
recycled inside a TB, so nb_temps grows with TB length and the sweep
term is quadratic in it (the fork lengthens TBs). Estimated split of
the pass: sweeps ≈ 70 %, of which `la_cross_call` ≈ 25 % — and that one
only trims register *preferences*, which with R0/R1 last in the
allocation order changes nothing here. Second item: `tcg_func_start`
calls `g_hash_table_remove_all` on both constant-interning tables per
TB, and GLib 2.84 shrinks the table to 8 buckets on every clear and
regrows it 8→16→32 during the next TB (realloc + rehash each step), plus
two indirect calls per `tcg_constant_*` lookup — the ~1 %
`g_hash_table_*` self time and its malloc children. Ranked, all
exactness-preserving: (1) skip `la_cross_call` on wasm64 (tcg.c
`liveness_pass_1`, two sites) ≈ −1.1 % of boot vCPU, verify with a
spill counter on both arms; (2) an open-addressed constant table inside
TCGContext cleared by a generation stamp ≈ −1-1.5 %; (3) bound the
sweeps by a high-water temp index recorded in `liveness_pass_0`
(−0.9 %) or a live-set bitmap (−2.5 %, ~10 sites), checkable by
comparing `op->life` per op against the old pass in a debug build; (5)
an arena for staged bodies and IR records per batch (1-1.5 % of
translation). Closed and not to be retried: dropping `tcg_optimize`
(the allocator asserts its canonicalisation; `W64_NOOPT` measured
nothing), deferring wasm emission for cold TBs, the recorder
duplication (< 1 µs/TB). Meter: idlebench boot milestones in ABBA order
(≥ 4 pairs) with census slots for Σ nb_ops, Σ nb_temps, sweep
iterations and spills.

**What the hot J2ME TBs' x64 says (capture: `tools/perf/wasmgrab.mjs`
on the played game, TurboFan output via Node's `--print-wasm-code`).**
The hot code is the phone's native graphics library, not the KVM's
bytecode loop: a 1-bpp glyph blit (three TBs, 9.4 % of the vCPU: one
inlined `put_pixel` per pixel, 45 guest insns, 3 TB boundaries and one
helper call per pixel), a 16-bpp colour-keyed blit self-loop (6.7 %, 17
insns/pass), a halfword fill self-loop (7.4 %, 6 insns/pass, 65 x64 per
pass of which 30 are the two TLB probes and 11 per-pass bookkeeping),
and the IRQ/SWI stubs (9 %). Round 49's fixes hold: cold-arm spills sit
in the miss arms, `i32.wrap_i64` collapses, no bounds checks, no
tiering-budget code. What remains is structural, per execution:
- every TB spills its three parameters (env, sp, tp) at entry and
  reloads two for its tail call — 5 x64 per TB execution, plus env
  rematerialised up to 4× — although all three are per-process
  constants (one vCPU; `w64_frame` and `&w64_tb_ptr` fixed); a
  zero-parameter TB type with the three baked as constants also turns
  every env access from base+index+disp into base+disp and frees a
  register in a convention with none callee-saved (**N6**, next);
- every `push/pop/ldm/stm` word pays its own 12-instruction TLB probe
  (8 of 10 stack accesses in the hottest TB share a page with their
  neighbour: ~36 % of its hot path) — a fused cluster probe with a
  straddle guard is the largest lever seen, and the most work
  (frontend cluster hint + backend + interpreter records);
- `lsls r1, r5` is a `helper_shl_cc` call on the blit's hot path: 42
  x64 of call overhead per pixel (~1.3 % of the vCPU) — inline the
  flag-setting variable shifts;
- helper arguments round-trip through the frame (`tcg_target_call_iarg_regs`
  is empty): 8 x64 per 3-argument call;
- the goto_ptr exit: inline-cache hit 34 x64, pcc probe 65, of which
  the tail call is 17-21 (V8's bounds + signature check on
  `return_call_indirect`; a typed table could drop the 4-instruction
  signature check — unverified); small fixes: pcc entry address in i32
  (2 instrs), key32 re-load at refill (1), a sign-bit tag test (1),
  `tgen_movcond` as `select` instead of `if/else` (2 + a branch per
  refund);
- self-loop bookkeeping per pass: PC store and `can_do_io = 0` that only
  the exit arm needs (3 of 65 instructions in the fill loop).

**Upstream convergence (owner's request; report only).** Against the
real merge base `c551b96e6e` the branch is 180 commits, +14 487 / −356
in 104 files. Safe deletions today are small — the devirtualised
`arm_get_tb_cpu_state` lookup call (`cpu-exec.c:400-444`, measured flat
in 62bdab8192, callers now 101 /Mi: −45 lines), two ifdef folds and a
logging-branch return (−7), lab-notebook comments in upstream files
(−60-100). The real shrink is reshaping with zero behaviour change:
translate.c's wasm64 frontend (~950 lines, `1333-1446`, `1582-2191`,
`2299-2463`, `translate.h:120-217`) into `translate-w64.c.inc`; the
accel/tcg blocks (`cpu-exec.c` pcc + lookup helper ~190, `tb-maint.c`
code_mask/inl/covers ~265, `cputlb.c` `do_ram_*_1p` 79, the io-barrier
set) into `*-w64.c.inc`; the W64 types and codec out of
`translation-block.h` (~110) into a backend header; the Asyncify-safe
`QemuCond` into `util/qemu-thread-wasm.c` (~100); and upstreaming the
~1 900 lines of device-model work not yet in `pmb887x-upstream-v2`
(dif_v1 burst, dmac windows, capcom, gptu, lcd blit, lazy ROMD — each
with its measured win). Churn inside upstream files would fall from
~7 700 to ~3 800 lines. Instrumentation remnants: none left (the
lockstep fold and `QEMU_COSTACK` are gate hooks kept by the review; the
stale `_wasm_*` references are in tools, not in C). Kept-for-speed list
verified against the doc's numbers; see the agent's report in the
session log.

### N6: TB functions take no parameters — measured, not taken

Every TB function took `(env, sp, tp)` and every chain passed them on:
V8's wasm convention has no callee-saved registers, so each execution
spilled the three at entry and reloaded two for its own tail call, and
`env` was rematerialised up to four times per TB as an index register.
All three are constants of the translating thread — the frontend state
(one vCPU; the DSP JIT has its own, see below), the C call frame
`w64_frame + 16`, and `&w64_tb_ptr` — so the TB type is now `() -> i32`:
the emitter declares the three as the first locals (every other local
index is unchanged), the prologue sets them from `w64_tbc[]` with
`i64.const`, the run thunk is `(tidx) -> i32`, `w64_chain_go` and the
dispatcher pass only the table index. TurboFan folds the constants: an
env access becomes base+disp instead of base+index+disp, and a register
is freed in a convention that has none to spare. The interpreter tier is
untouched (it takes env/sp/tp from C).

The pmb887x DSP JIT is a second frontend on the same backend, running
and translating on its own thread with its own state, so the constants
are per thread (`__thread`), the DSP binds them at thread entry
(`dsp_runtime_thread_enter` → `w64_tbc_bind(&runtime->core.state)`),
the vCPU thread binds itself from `current_cpu` at its first
translation, and `tcg_qemu_tb_exec` aborts if handed an env other than
the one its thread's TBs were compiled for. That also gives the DSP
thread a call frame of its own, which the shared `w64_frame` never was
(the "latent DSP-thread JIT race" the memory notes carried). Found by
the adversarial read before the A/B, not after it.

First S75 boot on the build: 1 G guest instructions at 9.2 s against
17.2-17.8 s for the two arms measured just before it (a quiet-host leg
earlier managed 12.8 s, so the A/B decides the size).

**J2ME game 1, 3-round ABBA at tb-size=768, quiet host (busy 0.05-0.13,
residual sd 0.026 — the cleanest fit of the round): +0.97 % ± 0.80 %
ms/Mi.** A loss, small and significant. Five fewer x64 instructions per
TB execution and a freed register do not show up in the clock; what the
boundary costs is V8's `return_call_indirect` machinery (bounds and
signature check, frame setup, the stack check), not the arguments it
carries. Video (2-round ABBA, 8 legs, busy 0.05-0.75, residual sd 0.023):
**−1.14 % ± 0.69 %** — the opposite sign, the same size. Video has ~2×
J2ME's helper-call density (mode switches, `*_mmu` misses), and the
arguments those calls reload from the frame are what the change removes;
J2ME's boundaries are chains, where nothing was saved and the three
`i64.const` writes per entry cost their bytes. S75 boot + idle (three
runs per arm): the 9.2 s leg was the host, not the change — under
matched load the pairs read 16.7 vs 16.1 s and 8.8 vs 9.1 s to 1 G
instructions, flat. Three workloads, one small loss, one small gain and
a tie: **not taken**, and the tree reverted to the three-parameter TB.
What the round keeps from it is the lesson (a TB boundary's cost is V8's
`return_call_indirect` machinery — bounds and signature check, frame
setup, stack check — not the arguments it carries; the x64 audit's
remaining per-boundary item is the typed-table signature check), and the
per-thread call frame the audit of it surfaced, taken on its own below.

### V1: the mode switch rebuilds hflags only when the exception level moves — measured, not taken

Video (Berlin.3gp), 3-round ABBA vs `8273aafd5c`, both arms hooked:
**+0.6 % ± 1.7 %**, flat. The census on the mechanism arm says why: of
8 905 184 mode-moving writes plus exception entries per 45 s window
(5 937 /Mi, the study's number to the digit) only 1 821 076 — 20 %, i.e.
the 1 214 /Mi mode-changing `msr` — stay inside EL1 and skip the
rebuild; the SVC/eret pair, 4 700 /Mi, crosses between USR and SVC,
where hflags genuinely change (the firmware's applications run
unprivileged). 1 214 × 12.3 ns is 0.5 % of 2.7 ms/Mi, under the band,
and the valid-mask cache and the flattening did not lift it above. The
study's estimate assumed the crossings were EL1→EL1; they are not. Not
taken; the patch is kept with the round's scratch files.

From the mode-switch study above. `rebuild_hflags_a32_fast` — the path
every ARM926 rebuild takes — reads the exception level, `sctlr_el[1]` and
CPSR.{E, IL, PAN} and nothing else, so on a core without
`HFLAGS_A32_FAST_FEATURES` a mode change between two privileged modes
(SVC ↔ SYS/IRQ/ABT/UND/FIQ) leaves hflags exactly where they were; only
USR ↔ privileged moves the level. Three changes, one commit:
(A) `cpsr_write`'s change test and `take_aarch32_exception`'s
unconditional rebuild both ask `arm_a32_hflags_moved(old, new)` on such a
core (v6+ cores keep the old test verbatim, which also keeps the v8
bad-mode-switch IL path on the conservative side); (C) the
realize-constant `aarch32_cpsr_valid_mask()` is computed once into
`ARMCPU.aarch32_cpsr_mask` instead of on every exception return and SPSR
load; (D) `take_aarch32_exception` and `cpsr_write` are `QEMU_FLATTEN`,
folding `switch_mode`, `cpsr_read`, `bad_mode_switch` into their callers
(the round-49 profile had them as separate wasm functions, five calls per
entry). The study's price: 12.3 ns per skipped rebuild (measured, round
47) × 1 205-5 937 /Mi on video, 0.4-2.1 %, plus C's 0.2-0.3 %; a census
on the mechanism arm counts how many of the mode-moving writes and
exception entries skip. Verified by the lockstep gate (register state per
instruction against native) and `tests/tcg-isa/t_psr.c` through the
op-suite.

### B1: `la_cross_call` is a no-op on wasm64 (built, in test)

From the boot-translation study. `liveness_pass_1` sweeps every temp at
each call *and* at each memory op (they carry `TCG_OPF_CALL_CLOBBER`) to
strip call-clobbered registers from the temps' *preferences*; the
allocator frees the clobbered registers at the call regardless, so the
sweep is quality-only. The wasm64 backend clobbers R0 and R1 alone, the
last two in its allocation order, and spills there are all but
nonexistent, so the sweep — estimated at a quarter of the pass, and the
pass at 4.4 % of a boot's first 12 s — changes no allocation. Compiled
out on wasm64. Meter: idlebench boot milestones in ABBA order (≥ 4 pairs)
with a census slot counting `tcg_reg_free` syncs on both arms, which is
where a preference the sweep used to trim would show up as a spill.

Its second part, prepared and compile-checked with it (B1b): the two
constant-interning `GHashTable`s that `tcg_func_start` cleared on every
translation — GLib shrinks a cleared table to 8 buckets and regrows it
8→16→32 through the next TB's inserts, a realloc and a rehash each step,
plus two indirect calls per `tcg_constant_*` lookup — become 256
open-addressed slots inside `TCGContext`, valid while their stamp equals
`const_gen`, cleared by bumping the stamp. Interning is a space saving,
not a requirement, so the probe is eight slots and a TB with more distinct
constants than that gets a fresh temp for the surplus. Same meter, its
own commit.

### F1: one TLB probe per same-page access cluster (built as a backend memo, in test)

Built in a different shape than designed below, needing nothing from the
frontend and no duplicated cluster body: a TLB memo in the backend. A hit
that another access of the same kind (mmu_idx, load or store) follows
leaves the entry's page (zero-extended, i64 `$mkey`) and addend (i32
`$madd`) in two new locals; the next access tests
`((addr ^ mkey) & (PAGE_MASK | a_mask)) == 0` (an access that cannot
straddle) or `(addr ^ mkey) < PAGE_SIZE − adj` (an unaligned one, a_mask
0) and on success adds `$madd` without probing. The probe's miss arm
writes −1 to `$mkey`, which no zero-extended address matches, so the
runtime never uses a memo the slow path may have invalidated; at
translation time any call (`w64_call` bumps `W.epoch`) or label ends the
memo, so it lives only across straight-line code where nothing can
change the TLB. A scan at TB start (in `w64_scan_labels`, which already
walks the ops) marks the accesses another same-kind access follows before
any call or label, and only those store to the locals, so a lone access
emits the same code as before. An entry that hit is clean for the whole
page, so its flags (MMIO, NOTDIRTY, watchpoint, TLB-only alignment) hold
for the second access too. Cost per memo'd access: one xor, an and/compare
and a branch against ~12 x64 and three dependent loads. It also covers
same-page pairs the design did not (`ldr r0,[r1]; ldr r2,[r1,#4]`, byte
loops unrolled in a TB). The widened window between a cross-thread TLB
dirty reset and the store it misses is the same race class upstream
accepts between probe and store; the pmb887x boards use no dirty logging
(the LCD is fed over SPI). A census arm counts memo tests and hits
(slots 3 and 4, near zero in the base patch at tb-size=768).

The original design:

The largest item the hot-TB read left: every word of a `push/pop/ldm/
stm` pays its own 12-instruction inline probe, and in the hottest blit
TB 8 of 10 stack accesses share a page with their neighbour — ~36 % of
that TB's hot path. The frontend knows the cluster (`op_stm`/`do_ldm`
loop over the register list with `addr += 4` between words; PUSH/POP
route through them); the backend emits one probe per `qemu_ld/st` from
the address alone. Design: the frontend emits a page-straddle guard once
per cluster, `((addr ^ (addr + 4n − 4)) & ~PAGE_MASK) == 0`, and under
it marks words 2..n with a spare MemOp bit meaning "same page as the
previous access"; the backend keeps the first word's TLB entry in a
reserved local and, for a marked word, skips the probe and forms the host
address from that entry's addend. Same page means the same entry, so the
first word's fast-path verdict (permissions, NOTDIRTY, MMIO) holds for
the rest; the guard's other arm emits today's per-word sequence. The
interpreter tier ignores the bit (its records run the slow path). Cost
of the guard: three ops per cluster; code size doubles for the cluster
body. Estimated 3-6 % of J2ME and video (stack traffic is everywhere in
ARM code), a day's work with the lockstep gate as the judge. Below the
meter and not pursued: the pc-cache entry address in i32 and the
single-CPU `cpu_index` compare (3 x64 per pcc probe, ~0.2 %).

### Probe: a typed chain table drops the signature compare (T1, not built)

Three 60-byte modules compiled by Node's V8 with `--print-wasm-code`:
`return_call_indirect` through a `funcref` table (what the port does),
the same through a table of type `(ref null $t)`, and `table.get` +
`return_call_ref`. The funcref tail call is bounds check, two loads for
the expected canonical signature, the compare, two loads for the callee,
jump. The typed table replaces the signature load-and-compare with a null
check on the entry (`cmpl [rbx+0x67],0xff; jz`): **two x64 and one
dependent load fewer per TB boundary**, of the ~17-21 the tail call
costs. `return_call_ref` is far worse (`table.get` is a builtin call).
The JS API cannot create a typed function table, so the shared chain
table would be exported by a tiny owner module and imported by the
batches with typed element segments; V8's iso-recursive canonicalisation
makes every batch's `(i64, i64, i64) -> i32` the same type, and Firefox
has typed function references since 120. Worth ~0.5-0.8 % of wall on the
round-41 boundary price. Prototype written (a 34-byte owner module in the
instantiation glue, the batch import as `(ref null 0)`, element segments
in the typed `ref.func` form) and validated offline in V8 — instantiate,
call through, `grow`, `set(null)`, a null entry traps; queued for its A/B
behind V1/S1/M1/B1, with the Firefox gate as the extra check.

### S1: the flag-setting register shifts inline (video −1.1 %)

Video (Berlin.3gp), 2-round ABBA on a quiet host (8 legs, busy
0.042-0.052, residual sd 0.014): **−1.09 % ± 0.52 % ms/Mi**. J2ME game 1,
3-round ABBA at tb-size=768: −0.72 % ± 1.20 % — the host carried load
21-25 through the first six legs (busy 0.70-0.73) and was quiet for the
last six, where the pairs alone read −1.1 %; the fit's slope across that
spread leaves the ± wide. The size is the study's 1.3 % of the J2ME vCPU,
and video pays it too (its codecs use the same register shifts). Taken;
gate keep GREEN.

From the hot-TB read: `lsls r1, r5` was the one helper call left on the
glyph blit's hot path — `helper_shl_cc` through an import, 42 x64 of
argument stores, spills and reloads per pixel, ~1.3 % of the J2ME vCPU —
because upstream keeps the four `*_cc` register shifts as helpers for
their ≥ 32 semantics. Inline on wasm64: a 64-bit shift by the count
clamped to 63 gives the result in the low half and the carry out at bit
32 (LSL) or at bit 0 after shifting a copy left by one (LSR; ASR's sign
fill yields CF = x[31] past 32, as the helper does), a count of 0 leaves
CF alone through a movcond, and ROR takes its count mod 32 with CF from
the result's top bit. Nine TCG ops and one movcond, one written global
(CF) instead of a call that syncs every global. Native keeps the helpers.
The formulas were model-checked against the four helpers' C over every
count 0-255 (and a few wider ones), 207 operands and both CF states: no
mismatch. Then the lockstep gate (CPSR per instruction against native).

### M1: `movcond` as `select` (built, in test)

`tgen_movcond` emitted `if (result t) vt else vf end`, which TurboFan
compiles to a compare, a jump and a join — the refund blocks at every
early TB exit paid 9 instructions and two jumps for it. Both arms are a
register or a constant, so nothing is skipped: `select` (0x1b) is a
cmov. Two x64 and a branch per movcond.

### `0bb467886e` + `8273aafd5c`: cleanup of the wasm branch (owner's request, from the convergence review)

What the review marked as removable without a performance argument
against it, done while the A/Bs ran and gated on its own:

- the devirtualised lookup shortcut in `accel/tcg/cpu-exec.c`
  (`W64_GET_TB_CPU_STATE` → `arm_get_tb_cpu_state`, `curr_cflags_fast`):
  measured flat when it was added (62bdab8192, "on its own it measures
  flat"), and its callers run 101 /Mi in J2ME play after the 16-bit
  table, so an indirect call there is below every meter in use; back to
  the upstream `tcg_ops->get_tb_cpu_state` / `curr_cflags()` — the one
  place a target-independent file named an ARM symbol;
- one ifdef fold in `gen_set_psr` (two back-to-back `CONFIG_TCG_WASM64`
  blocks);
- lab-notebook comments in upstream files trimmed to intent — dates,
  round numbers, per-Mi rates, `see doc/performance-handoff.md` pointers
  and review tags in `cpu-exec.c`, `translate.c`, `icount-common.c`,
  `cpu.h`, `cpu-timers-internal.h`, `memory.c`; the reasoning stays, the
  numbers live here;
- `W64_ACCT_TBSTATS` / `w64_tbstats_inline()` renamed to what they gate,
  `W64_ACCT_GUEST_INSNS` / `w64_guest_insns_inline()`: the guest
  instruction counter the page reads on boards without icount, not TB
  statistics.

Taken separately, from N6's audit: the dispatcher's call frame is now
per thread (`__thread w64_frame`). The pmb887x DSP JIT runs its TBs
through the same dispatcher on its own thread and shared the vCPU's frame
— helper arguments and the goto_ptr handoff slot — which the memory notes
had carried as a latent race since the DSP JIT was added; it never fired
on the bench workloads (0 DSP JIT entries) and now cannot.

J2ME game 1, 2-round ABBA of the whole set against `741597d60a`
(busy 0.05-0.62, residual sd 0.07): **+1.5 % ± 2.5 %** — flat within the
band, as the lookup shortcut's own commit had measured. Gate keep GREEN.

Not done here, listed for the owner: the zero-behaviour extractions
(~1 750 lines out of upstream files into port-owned `.c.inc`/`.h`) and
the device-model upstreaming (~1 900 lines) from the review.

### N4c: a per-page flush of a page no TB came from retires nothing — built, dropped

Built on the artefact above: a bitmap of guest virtual pages a TB was
translated from (entry page, spanned page, inlined callee's page; set in
`tb_gen_code`, cleared at `tb_flush`), tested by
`tlb_flush_page_by_mmuidx_async_0` so a flush of a page with a clear bit
skips the jump-cache clear, the generation bump that empties the pc cache
and every inline cache, and the inlined-list walk; a set bit retires the
whole jump cache by generation (which would also have closed a
pre-existing gap the adversarial read found: an inlined TB whose callee
lies on the flushed page but whose own pc is on neither that page nor the
previous one kept its jump-cache entry). The first draft asked the TLB
for the page's ram page and its TB list; the read showed that unsound (a
guest that touches a page between rewriting its PTE and the TLBIMVA
refills the entry with the new mapping), hence the bitmap. Sound, cheap —
and with no board issuing per-page flushes at a rate any meter sees
(S75 ~0 /Mi, J2ME 0, LG boards 0), it has no number, so it is not
committed. The design stays here for a guest that does.

### `3fb2c66465`: the pc cache and jump cache at 16 bits

`TB_JMP_CACHE_BITS` sizes both the jump cache and the pc cache the
emitted goto_ptr probe reads first (`cpu-exec.c` `w64_pcc`, same hash,
same size). 14 was the peak measured on a boot; round fifteen's census
said two thirds of the in-play qht traffic was conflicts and closed the
lever on the mis-priced 0.7 %. With the census hooks carrying two extra
slots for this A/B (qht lookups, `helper_lookup_tb_ptr_lc` calls — the
pcc misses), one 45 s game-1 window at matched host load reads:

| | 14 bits | 16 bits |
|---|---|---|
| pcc misses (helper calls) | 7 431 044 (1 321 /Mi) | 569 852 (101 /Mi) |
| qht lookups | 7 878 486 | 910 567 |
| translations | 10 597 | 10 568 |

**Ninety-two per cent of the helper calls and 88 % of the qht lookups
were conflicts in a 16384-entry direct-mapped table**, not cold PCs: the
J2ME working set simply does not fit. The 1 321 /Mi is the same number
round fifteen measured, so that census was right and its price was
wrong. Over all six legs per arm the averages are 7 420 396 → 573 201
helper calls and 7 878 574 → 918 997 qht lookups per window, with equal
translations (10.8k) and invalidations (85 vs 83).

Timing, J2ME game 1, 3-round ABBA at tb-size=768 (both arms hooked):
**−5.6 % ± 4.0 % ms/Mi** at mean busy 0.39 (slope 2.35, residual sd
0.19); the two quiet pairs read 1.99/1.88 against 2.18/2.16 ms/Mi (busy
0.08-0.11), the loaded pair 3.63 against 3.78. That is the size the
profile predicted: the miss path was ~5 % of the vCPU after `5f450abf1b`
and nine tenths of it is gone. The boot-side worry ("16 is worse again",
the old header comment) does not reproduce: idlebench on the default
board, two runs per arm, puts the instruction milestones within noise
(median time to 1 G guest instructions 14.6 s at 16 bits against 14.7 at
14; 0.5 G 11.8 vs 12.1; RSS 1885 vs 1888 MB — the 1.5 MB of extra table
is invisible). Video (2-round ABBA, 8 legs): **+2.2 % ± 4.0 %**, flat —
its goto_ptr miss path is 172 /Mi (round-49 census), so there was
nothing for a bigger table to buy there, and the quiet pair ties
(2.05 against 2.10/1.99 ms/Mi). Gate keep GREEN.

## Update (2026-09-24, cleanup: what neither wasm nor performance needs, and a flush that looked like a regression)

The owner asked for everything that is unnecessary for either performance
or getting wasm to work to come out of the qemu branch. Six commits
(`7538f05950..967f88004e`, 38 files, +538 / −2117):

| commit | what went |
|---|---|
| `dc6e227014` | N-page TB tracking (`TB_PAGES`, `tb-pages.h`). It was built to price a third page, which was rejected in round 42. Back to upstream's two-page form, which also fixes the arm-linux-user build it had broken. |
| `9b7f9c3398` | accel/system leftovers: `io_prepare` and `notdirty_write` back to upstream shape, `icount2_ticks_now`, dead stubs and exports, three stale onlylist names, the `HEAPU32` export. |
| `ecffdcb4b3` | target/arm: the helper-side hflags rebuilds are folded into `cpsr_write`. Its change test now covers PAN, the one input it missed. Also write-only DisasContext/TCGLabel fields. |
| `f36417f69f` | tcg/wasm64: the temp-module path (every TB already joined a batch), per-TB type/import tables and the 256-byte prelude, the MEMORY64=1 paths (configure now requires `--wasm64-32bit-address-limit`), `TCG_REG_TMP` (15 regs, 6 fewer declared locals per TB), interpreter ops the backend never records. |
| `231eb98b8e` | pmb887x: TPU `armed_valid`, CAPCOM's cached T0/T1 copies (and a divide by zero at `T0REL = 0x10000`), a DIF v2 array that held one value, the flash-blk vmstate field, whitespace-only hunks. |
| `967f88004e` | comments: the backend header describes batches and the interpreter tier as they are. |

Kept on purpose: the DMAC same-width branch and its `QEMU_UNINITIALIZED`,
`lcd_flush_partial_command` (upstream), both DIF v1 fallbacks, and the
20 onlylist names that the -O3 link inlines (a lower-opt link needs them).

### The +21 % that was a flush

The first J2ME ABBA against `7538f05950` read **+21 % ms/Mi**. Bisecting
the timings pointed at `f36417f69f`. A census, with counters patched onto
both arms, then showed:

- `tb_gen_code` ran 7.3/Mi instead of 2.7/Mi, with no `tb_phys_invalidate`
  and no `do_tb_flush`;
- the icount-expiry and partial-TB request rates were identical (78/Mi,
  66.7/Mi);
- 4.9/Mi of the translations were keys translated before, whose old TB
  was intact (pc, flags, cflags, cs_base, page) but no longer in the qht.

The TB-alloc overflow path in `tb_gen_code` calls
`tb_flush__exclusive_or_serial()` directly, not `do_tb_flush`, so a counter
on the latter reads 0. Counting at the real flush showed the whole story.
The wasm code buffer is 256 MB (`phys_mem / 8`), and game 1 translates
about 120-140k TBs over boot + play, so **both arms flush exactly once**:

| arm | bytes/TB | flush at | window |
|---|---|---|---|
| `7538f05950` | 2256 | TB 118 950 | after the flush's re-translation peak |
| cleanup | 1954 (−13 %) | TB 137 333 | inside it |

Smaller TBs (no prelude, no per-TB import table) moved the flush into the
measurement window. The +21 % is the re-translation and re-interpretation
of the working set. With `EXTRA_Q='qargs=-accel%20tcg,tb-size=768'`
neither arm flushes, and both read 1.87-1.91 TBs/Mi.

### Numbers (two binaries, bench hooks on both, `tb-size=768` on both)

- J2ME game 1, quiet batch of 8 legs: **−0.80 % ± 0.78** (sd 0.023).
  All 16 legs pooled: −0.07 % ± 1.83. The first batch ran at hostBusy up
  to 0.18.
- SL65 video, 8 legs: **−0.11 % ± 0.70**.
- gate keep green after each commit; close green before the pin bump.

**Lesson.** Any change to emitted bytes per TB moves the J2ME flush point.
A/B J2ME with the `tb-size=768` qarg, or check `tb_flush__exclusive_or_serial`
first when a leg's translation count jumps. At the default size, the
cleanup fits 16 % more TBs before the (single) flush a user meets.

Latent and not fixed: the DSP worker thread can run wasm64 TBs, and the
backend's frame, tidx allocator, landed/live lists and IR store are
process-wide. A probe counted 0 DSP JIT entries across S75 boot, SL65 boot
and SL65 video.

## Update (2026-09-24, round fifty-two: the store-to-code-page path, re-priced after the 4 KB page switch)

### 1. `code_mask` was still sized for 1 KB pages (`cb4dbe103f`)

**Where the time went.** On J2ME game 5 the V8 sampler put
`notdirty_write` at 13.1 % self. The whole store-to-code-page path
(`helper_st*_mmu` → `mmu_lookup` → `mmu_watch_or_dirty` →
`notdirty_write`) was ~25 % of the vCPU inclusive; on game 1 it was
~4 %. The page walk in `tb_page_covers` is inlined, so its time shows up
as `notdirty_write` self time.

**Census** (temporary counters in `tb_page_covers`; diff kept out of the
tree):

| per Mi | calls | mask rejects | walks | list steps | covers |
|---|---|---|---|---|---|
| game 5, 256-bit mask | 6703 | 6444 | 259 | 38 577 | 0.06 |
| game 5, 1024-bit mask | 6703 | 6702 | 0.7 | 3.4 | 0.04 |
| game 1, 256-bit mask | 479 | 266 | 213 | 8 317 | 1.2 |
| game 1, 1024-bit mask | 485 | 462 | 22.7 | 378 | 1.4 |

**Cause.** Round 37 sized the mask at 256 bits, which is four bytes per
bit at 1 KB pages. Round 40 moved to 4 KB pages and the mask stayed at
256 bits, so each bit covered 16 bytes. Data words started sharing
granules with code again: game 1 was back to the 55 % rejection rate the
round-37 comment warns about. On game 5 a page of 149 TBs was walked
259 times per Mi and never found a covering TB.

**Fix.** 1024 bits, four bytes per bit again. PageDesc grows by 96 bytes.

**Two-binary ABBA** (both arms with the bench hooks, ms/Mi):

| workload | before | after | change |
|---|---|---|---|
| J2ME game 5 | 2.822, 2.893 | 2.591, 2.557 | −9.9 % |
| J2ME game 1 | 2.982, 3.147 | 2.859, 2.875 | −6.4 % |
| SL65 video | 2.084, 2.090 | 2.058, 2.066 | −1.2 % |

**Lesson.** Every size tied to the guest page size needs re-checking
whenever that size changes. The mask comment still said "at this board's
1 KB pages" two rounds after that stopped being true.

### 2. Stores to a code page's data skip the NOTDIRTY path (`7538f05950`)

With the mask fixed, game 5 still sends 6 700 stores per Mi through the
generic slow path. A page keeps TLB_NOTDIRTY while it holds any TB, and
only 0.04-0.06 of those stores per Mi touch a TB. Each one paid for
`mmu_lookup` → `mmu_watch_or_dirty` → `notdirty_write`, a read of the
CODE dirty bit and `tb_page_covers`, just to learn "no".

**Fix.** `do_ram_notdirty_1p` in cputlb.c (wasm only) runs after
`do_ram_1p` misses in each `do_stN_mmu`. It takes a store only when all
of these hold:
- the TLB comparator is exactly the page plus TLB_NOTDIRTY, so there is
  no FORCE_SLOW and there are no slow flags;
- the store is aligned, within one page and not byte-swapped;
- `tb_store_misses_code()` says the page holds TBs and `code_mask` is
  clear for the bytes stored.
It still sets the DIRTY_CLIENTS_NOCODE bits, then stores through the
addend. An empty page answers "no" and goes the generic way, which is
where `notdirty_write` lifts the protection.

**Two-binary A/B** (both arms with the bench hooks, ms/Mi):

| workload | before | after | change |
|---|---|---|---|
| J2ME game 5 (ABBA) | 2.721, 2.666 | 2.479, 2.428 | −8.9 % |
| J2ME game 1 (ABBAAB, fit vs hostBusy) | | | −1.8 % ± 0.9 |
| SL65 video (ABBAAB, fit vs hostBusy) | | | 0.0 % ± 0.6 |

Dirty-bitmap atomics were priced on their own at ~1 % and left alone:
the fast path keeps `physical_memory_set_dirty_range`.

### 3. Closed this round

- **The V8 Liftoff tail.** J2ME spends 18-25 % of TB ticks in Liftoff
  code: thousands of lukewarm TBs that never burn V8's 13 M per-function
  tier-up budget. Video spends only ~2 %. A ceiling probe with
  `--wasm-tiering-budget=200000` gave game 1 −7.5 % and game 5 −2 %, but
  production cannot reach it. Each exit (return or tail call) charges
  `pc_offset + 60`, each check is capped at budget/4, and compilation
  hints are experimental and off by default. This stays closed unless the
  backend pools TBs into shared functions.
- **`do_ld4_mmu` / SCCU on video.** `--prof` shows 3.7 % self. A counter
  plus a calibrated timer gives 68 calls/Mi × 143 ns ≈ 0.45 %. The
  0.57 % for `sccu_io_read` at 0.24-2 calls/Mi is not real either. Same
  trap as round 47: count calls before believing a leaf's share.
- **Translation on game 1.** 4.2 translations/Mi and 1.37 SMC
  invalidations/Mi, about 9 % of the busy vCPU at ~64 µs per TB. This is
  inherent to the guest's own JIT.
- **Timing inside the vCPU.** `get_clock()` costs 0.4-0.7 µs per read
  and inflated nested ms/Mi timers by 10-500 %. Use one outer interval
  minus an empty back-to-back interval.
- **j2mebench's `tbGen/Mi` is dead.** The review removed the counter,
  so it always reads 0; do not diff it.

**Tooling fixed on the way.**
- `ninja-fast.sh` now stops when a meson regeneration drops the `-O3`
  link args. The symptom was a 45 MB wasm that passes every gate.
- The build scripts compared the abbreviated qemu pin with the full
  `rev-parse HEAD`, so `checkout -B` ran on every build. Under
  `gate.sh`'s concurrency, the `checkout -f` fallback wiped uncommitted
  qemu edits. They now compare full hashes and refuse to force a dirty
  tree.

## Update (2026-09-23, round fifty-one: KE970 is the target; the flash write-behind was a block request per 30 words)

### 1. Where a KE970 boot goes

A V8 `--prof` run over a KE970 boot (the vCPU isolate and qemu's main
thread, grouped with a stack walker) showed three things:
- **The vCPU waits on the BQL** for 25–30 % of wall in the busy phase,
  while the main loop runs for 20–25 %.
- **The main loop's largest item is the flash write-behind:** a
  block-layer coroutine and a thread-pool request per flush. Around
  50 pool workers were spawned, each one a new Web Worker.
- **The menu is not a target:** the vCPU is 98 % halted there, so it is
  firmware-paced.

**Census** (temporary `wasm_bench_ctr` slots, one boot):

| | per boot |
|---|---|
| `pmb887x_flash_blk_pwrite` calls | 2 782 335 |
| flush generations | 90 267 |
| AIO requests (ranges) | 131 100, 12.1 MB, ~92 B each |
| EFA/OTP synchronous saves (`flash_save_file`) | 8 576, ~240 ms (1 ms clock) |
| `main_loop_wait` iterations | 250–320 k |
| thread-pool spawns | 45 |

### 2. Batch the write-behind (`920348722a`)

The first write of a batch now arms a 50 ms `QEMU_CLOCK_REALTIME`
timer. The flush then:
- sorts the batch;
- merges ranges across gaps of up to 64 KB (the storage holds the gap
  bytes, so writing them is exact);
- writes the ranges **one request at a time**.

**Census after:** 138 batches, 617 requests, 118 k main-loop iterations,
2 pool spawns.

| KE970 boot, 4 interleaved rounds (median) | before | after |
|---|---|---|
| 1000 M insns | 15.8 s | **12.4 s (−22 %)** |
| 1500 M insns | 26.5 s | **22.0 s (−17 %)** |

- **Delay:** 20, 50 and 200 ms tie.
- **The tail doesn't move.** The busy phase now ends at ~15 s instead of
  ~19 s. After it comes ~12 s at 4–30 M insns/s, the same length in both
  arms. The LG boards run icount=none, so that tail is the firmware
  waiting on real time.
- **Correctness:** a temporary read-back verifier compared each range
  with the MEMFS file after every drained batch: KE970 230/230 and KE800
  56/56 equal. `gate keep` GREEN.

**Two traps on the way:**
- **Coroutine from a timer callback:** `unreachable`. A coroutine started
  from a timer callback has `timerlist_run_timers()` on its stack, and
  that isn't on the Asyncify onlylist. The timer now only schedules the
  existing BH.
- **All ranges at once:** `Aborted(OOM)`. Every concurrent
  `blk_aio_pwritev` holds a coroutine stack.

Also: **`g_array_sort()` traps on wasm** ("function signature
mismatch"). glib calls the 2-argument comparator through a 3-argument
`GCompareDataFunc`. Use `qsort`.

**Tool change:** `tools/uibench.mjs` prints a `BOOT … 250M= 500M= 1000M=
1500M=` milestone line, plus the `bench0..7` totals when the hooks are
applied. `CONSOLE_GREP=<re>` echoes matching page-console lines.

### 2b. Flash partitions return to ROM lazily (`bacb430bb6`)

**The profile, re-taken after §2** (KE970 busy phase 2–16 s, vCPU):
- **`flash_io_write`: 18 % inclusive.** 12.8 % of that is
  `memory_region_transaction_commit` → `address_space_update_topology_pass`,
  and `tcg_commit_cpu` / `tlb_flush_phys_ranges` add ~3 %.
- **The cause:** every command write took the partition off the ROM
  mapping, and every `0xFF` reset put it back. A program loop does both
  per word, so a boot made **327 k ROMD flips** at ~6 µs each.
- **A second cost:** the EFA scan set a sticky `io_mode` on its
  partition, so that partition served **1.3 M array reads per boot**
  through MMIO for the rest of the session.

**The change:** back in read-array mode, a partition stays on the I/O
path until 16 array reads arrive with no command in between.
`flash_io_read` already serves array reads correctly. `io_mode` is
gone.

**Result:** flips 327 k → 7.4 k.

| KE970 boot, 3 interleaved rounds (median) | before | after |
|---|---|---|
| 1000 M insns | 12.94 s | **10.73 s (−17 %)** |
| 1500 M insns | 22.37 s | **19.89 s (−11 %)** |

Thresholds 16, 64 and 256 tie. `gate keep` GREEN, and KE970 and KE800
boot to idle and cycle the menu.

### 2c. The buffered-program duplicate scan (`e546579764`)

With the transactions gone, `flash_io_write` still had **3.7 % self**.
- **Not the cause:** the linear block search. A binary search changed
  nothing (3.81 → 3.68 %) and was reverted.
- **The cause:** `flash_buffer_add()`. For every word it scanned all
  `buffer_size` slots for an earlier entry at the same address, so a
  buffered program of n words cost n² compares.
- **The change:** the scan now stops at `buffer_index`, and it is skipped
  for a word above every earlier one, which is the order firmware writes
  them in.

**Result:** self 3.7 → 0.57 %. The 1000 M milestone is 10.46 → 10.35 s
(−1.1 %, 3 of 4 rounds lower); 1500 M is a tie.

**Checked and ruled out: V8's lazy wasm compilation.** With
`--no-wasm-lazy-compilation`, Chrome's C++ share of the busy phase
falls from 17.4 % to 8.0 %. But the vCPU then waits on the compile
threads instead (vmstate EXTERNAL, libc), and the milestones don't move.
It is compile cost moving around, not a lever. Translation itself
(`tb_gen_code`) is 30 % inclusive, and `tcg_gen_code` 10.8 % self.

### 2d. What is left on KE970, and what was closed

**Re-translation: none.** Census in `tb_gen_code`: 89.4 k TBs per boot,
88.2 k distinct (phys_pc, flags, cflags), no `tb_flush`, and 6 one-shot
TBs executed from I/O.
- **Cost per TB:** `tb_gen_code` is ~34 µs inclusive, plus ~11 µs of V8
  compile.
- **The profile is flat.** An `-O1` link with no-inline `tcg.c` (the
  `-O3` Binaryen inliner folds every single-caller function into
  `tcg_gen_code`) splits it into `tcg_reg_alloc_op` 2.7 %,
  `tcg_optimize` 2.1 %, liveness 2.5 %, wasm emission (`w64_uleb`/`u8`/
  `ir_w`/`sleb`) ~3.5 %, `w64_batch_*` 2.3 %, interpreter 1.3 %. No
  single hot spot.

**`W64_INTERP_THRESH` sweep on KE970:** 16/64/256/1024 give 1000 M at
10.36/10.07/10.05/10.19 s (3 rounds, medians). Flat, so 64 stays.

**The early-boot interpreter share** (~27 % of the vCPU's first second)
is many cold TBs, not one stuck loop. A faster interpreter would save
~0.3 s once per boot.

**The UI after boot is firmware-paced:**
- `tools/keylag.mjs` now has `ke970`.
- Across a 30 s `left_soft`/`end` cycle the vCPU runs TB code 8–20 % of
  the time. Of its wait ticks, 97.7 % are halted in `qemu_process_cpu_events`
  and 1.7 % are waiting on the BQL.
- Only the *first* open of a screen is emulator-bound (translation).
- Typical press bursts are 100–300 ms. keylag's v/wall reads 1.0 by
  construction under icount=none.

**What remains for KE970 is first-time code:** the translate + compile
pipeline, at ~45 µs per TB. The large lever there is a persistent
translation cache, which is a project of its own.

**Rounds 51 §2 + §2b together:** the KE970 busy phase is ~19 s → ~13 s,
and the 1000 M milestone is 15.8 → 10.7 s.

### 3. `-ftrivial-auto-var-init=zero`: dropped on wasm, kept on native (owner's call)

`qemu/meson.build` adds upstream's hardening flag
`-ftrivial-auto-var-init=zero` to every file. It zeroes every
uninitialized local on every call. A full rebuild with
`=uninitialized` (bench hooks on both arms):
- **Video:** −4.19 % ± 2.88.
- **J2ME:** −1.45 % ± 1.18.

This is a security/robustness trade: an uninitialized read becomes a
deterministic zero instead of stack garbage. The owner chose to drop it
for the emscripten host only (`0a3e5f2ce3`), the whole build rather than
the narrower per-directory form:
- The browser build already runs inside the tab's sandbox, which is
  where the flag's exploit-hardening case is weakest.
- Native keeps the flag, so if the wasm build ever starts depending on
  an uninitialized value, lockstep-wasm (wasm vs native) sees the two
  disagree.
- `-fzero-init-padding-bits=all` stays on both.

## Update (2026-09-23, round fifty: a precise sampler, the window's real C profile, and the link that was never optimized)

### 1. V8's own `--prof` is the precise sampler here

`perf` is out: seccomp blocks `perf_event_open`, even for software events.
V8's tick log is not:

```
CHROME_ARGS="--no-sandbox --js-flags=--prof,--prof-sampling-interval=250,--logfile=$D/v8.log" \
  node tools/videobench.mjs --dist dist-x --hold 150
cp site/dist-x/qemu-system-arm.js.symbols $D/     # the map of *that* build
tools/perf/v8tick.py $D/isolate-<vcpu>-v8.log $D/qemu-system-arm.js.symbols 140 sccu_io_read 0.002
```

- **Picking the log:** the vCPU isolate is the log with the most
  `code-creation` records.
- **Decoding wasm records:** they read
  `code-creation,JS,5,t,addr,size,wasm-function[N],<module base + N>,<tier>`,
  so the module is that pointer minus N. The tier field is `*` for
  TurboFan and empty for Liftoff.
- **What v8tick.py reports:** buckets for TB modules by tier,
  main-module C (named from the symbol map), builtins, Chrome C++ and
  libraries.
- **The last two arguments** drop every 1 s bin where the named C
  function holds more than the given share. That removes the phases
  after the clip ends, see § 2.

**The DevTools profiler misattributes:** it charged `tcg_qemu_tb_exec`
2.44 % where the pc sampler reads 0.20 %.

### 2. `do_ld4_mmu`'s profile share was the player idling between clips

Each `--hold` profile ran past the end of the clip. After playback, the
SL65 firmware:
- calibrates the SCCU reference continuously (`SLPCTRL` REFEN, 73.8 ms
  virtual each, restarted at once);
- busy-polls `SLPCTRL` at ~11 000 `do_ld4_mmu` calls/Mi.

The meter's 12 s window never sees this phase. A timed census in the window
(`doc/attic/loop-census-round50.diff`) reads, per Mi:

| | video | J2ME game 1 |
|---|---|---|
| `do_ld4_mmu` calls | 48 | 89 |
| `do_ld4_mmu` time | 15.3 µs (0.57 %) | 19 µs (0.7 %) |
| C loop entries | 33.6 | 114 |

Of video's 33.6 loop entries:
- 27.4 are icount `TB_EXIT_REQUESTED`;
- 5.9 are chained;
- 5.2 take the interrupt's full path;
- 0.7 are `tb_gen`.

That closes round 47's "do_ld4_mmu artifact". SL65 standby, capped, is
1.1 MIPS at 3.1 % of one thread (`videobench --idle N`), so there is no
idle problem either.

**Playback-only profile** (119 of 141 bins kept, 380 k ticks):

| bucket | share |
|---|---|
| TB code, TurboFan | 80.7 % |
| TB code, Liftoff | 1.9 % |
| `WasmLiftoffFrameSetup` | 0.56 % |
| main-module C | 14.1 % |

The C is the SVC/eret cluster, already sized in round 49:
- `arm_rebuild_hflags` 2.90
- `switch_mode` 1.44
- `cpsr_write` 1.31
- `take_aarch32_exception` 0.85
- `arm_take_svc_aarch32` 0.75
- `helper_cpsr_write_eret` 0.67

Then the TB lookup (`qht_lookup_custom` 0.43, `tb_lookup_cmp` 0.20) and
the store slow path (`do_st4_mmu` 0.36).

### 3. The link ran at `-O0` (build-script change, no qemu commit)

Reading `arm_rebuild_hflags` in wasm showed `global.get 55 … i32.ne …
unreachable` after every call: Binaryen's `asyncify-asserts`. meson's
`-O2` reaches the compiles only, and the link line
(`-Dc_link_args` in `build-qemu-wasm64.sh`) had no `-O`. So `emcc`
linked at `-O0`. That means `ASSERTIONS=1`, 173 326 state checks, no
`--post-emscripten`, no Binaryen `-O2` and no memory packing.

**Two arms**, each only a relink of the same objects:

| arm | wasm | video (shared-slope fit) | J2ME |
|---|---|---|---|
| `-sASSERTIONS=0` | 26.9 MB | −0.22 % ± 1.73 (8 legs): the checks are free | — |
| `-O2` | **11.3 MB** | **−5.00 % ± 2.59 and −2.11 % ± 1.19; pooled −3.24 % ± 1.85** (16 legs) | **−5.28 % ± 1.44** (8 legs, every B leg below every A leg) |

- **Code:** 9.8 → 7.8 MB, 26 738 → 20 500 functions (Binaryen
  inlining and DCE).
- **Data:** 18.5 → 3.4 MB. The `-O0` link shipped its zero runs.
- **Gzipped download:** wasm 4.13 → 3.49 MB, JS 87 → 40 KB.
- **Export names are minified at `-O2`.** Nothing reads them raw:
  EM_JS uses `wasmTable`, the page imports the factory, and the tools go
  through `Module._x`. `MINIFY_WASM_EXPORT_NAMES` is internal and can't
  be turned off from the command line.
- **Pass order:** Binaryen runs `-O2` *before* `--asyncify` in the same
  invocation. Inlining is consistent with an onlylist that is closed
  over callers. The boot gates exercise the coroutine switches.
- **Gates:** `keep` GREEN 11/11; `close` GREEN 15/15 (`firefox` PASS),
  on the clean tree at the pin.

**Then `-O3` on the link, against `-O2` (both with bench hooks):**
- **Video:** −1.80 % ± 0.67 (8 legs, residual sd 0.019) and −4.02 % ±
  3.89 (8 legs, a busier host); pooled −2.17 % ± 1.90.
- **J2ME game 1:** −0.21 % ± 1.17, a tie.
- **Wasm:** 11.31 → 11.19 MB. The link takes ~54 s instead of ~36 s.

It is never slower, so `-O3` is what the script passes now. (Round 37's
`-O3` tie was the *compile* level, and it is still `-O2`.)

**`b_ndebug` is closed without a measurement:** `include/qemu/osdep.h:311`
is `#error building with NDEBUG is not supported`.

### Traps this round paid for

- **`meson` is not on `PATH`** in a fresh shell: use
  `build/qemu-wasm64/pyvenv/bin`. A `meson configure` with a bad link arg
  breaks every compile probe, and the failure names the wrong thing
  ("library 'rt' not found").
- **`ps` %CPU on a zombie `chrome-headless` is a lifetime average.**
  Those processes had already exited.

## Update (2026-09-23, round forty-nine: reading TurboFan's x64 — the TLB miss call was spilling on every guest access, and branch hints move it out of the way)

### 1. The helper census says the call lever is spent

A temporary patch (`doc/attic/helper-census-round49.diff`) counted every
helper call a TB makes on SL65 video, per Mi: **eret 2 369, svc 2 360,
mode-changing `cpsr_write` 1 205, `shl_cc` 719, store-miss `*_mmu` 334,
`lookup_tb_ptr_lc` 172, load-miss `*_mmu` 48**. Rounds 40, 47 and 48
already took the inline forms of all of these that do not change mode.
What remains is the guest's own mode switching, around 6 000 calls per Mi,
each doing real work. There is no fourth "take the call inline" round in
this list.

### 2. How to read what V8 actually runs

The wasm we emit is not what executes; TurboFan's x64 is, and nobody had
looked at it. `tools/perf/modcap.mjs` plus the capture patch in
`doc/attic/modcap-round49.diff` copy every batch module's bytes into a
C buffer in shared memory. The page's main thread reads the buffer out
(a worker `evaluate()` on the vCPU thread hangs, because it never
yields). Then:

```
node --no-liftoff --no-wasm-lazy-compilation --experimental-wasm-branch-hinting --print-wasm-code \
     -e 'new WebAssembly.Module(require("fs").readFileSync(process.argv[1]))' 0150.wasm
```

prints the same TurboFan output Chrome runs; Node's V8 is close enough
to Chrome 153's for codegen shape. **Without
`--experimental-wasm-branch-hinting`, Node ignores the hint section
without a word**, and a hinted module compiles to unhinted x64. `wasm2wat` (wabt, `apt install
wabt`) pairs it with the source. What the x64 showed:

- **V8's wasm calling convention has no callee-saved registers.** A
  `*_mmu` call on the inline probe's miss arm therefore clobbers
  everything live across the `if`. TurboFan puts the spill at the value's
  *definition*, which is on the hit path, so every guest load and store
  paid for its own miss handling. An `stmdb` with four store probes did
  four rounds of spills and reloads.
- **`movl r,r` (the `i32.wrap_i64` of an address) is 4.2 % of the static
  x64**, three of them on each access's dependency chain (§ 5).

### 3. Branch hints on the inline TLB probe (`23914e9052`)

Wasm branch hinting is the custom section `metadata.code.branch_hint`.
It is placed before the code section and holds
`vec(funcidx, vec(offset, 1, hint))`, where the offset is from the start
of the function body after its size LEB. Chrome 153 applies it by default
and engines that don't know the section ignore it. Hinting the probe's
`if` as likely makes TurboFan defer the else arm, and the spills and
reloads move into it. `tools/perf/wasm-bhint.mjs` injects hints offline
into a captured module. On module 150 (821 TBs, 3 868 probes) it took
the probes' hot-path spill and reload traffic to zero before anything
was built.

In the backend, `w64_hint()` records a hint position as a member's
call-fixup record under two sentinel import indices (`W64_CFIX_LIKELY` /
`_UNLIKELY`), so landing, compaction and re-assembly carry hints with no
new bookkeeping. `w64_assemble_instantiate` emits the section only when
some member has a hint.

- **Price:** SL65 video, two ABBA ×2 series (15 legs; one leg where the
  clip wasn't playing was dropped), shared-slope fit on hostBusy:
  **−21.2 % ± 5.3 and −19.0 % ± 5.3, pooled −20.0 % ± 3.4 ms/Mi**. The
  host was 0.50–0.95 busy from another tenant, which is why the error
  bars are wide.
- **Gates:** `keep` GREEN, `firefox` PASS. The section is advisory, so an
  engine that doesn't apply it runs the same code as before.

### 4. Cold-label hints: no resolvable effect (rejected)

The same mechanism was tried on every other "almost never taken" branch:
- the icount exit request;
- the misses of round 40's inline return and round 48's `msr` fast path;
- the not-linked branch of `goto_tb`/`goto_ptr`.

A `w64_cold` bit on `TCGLabel` made `w64_br_to_label` hint them as
unlikely. Over 17 valid legs in two series it reads **−1.35 % ± 1.89**,
so it isn't in the tree. The playbook row explains why so little was
there to find.

The first series' dist-cold legs mostly "failed". They were the phone
sitting on the main menu, whose animation draws 2–3 fps of guest time
and passed videobench's old 2 fps floor. A playing clip draws about 13,
so the floor is now 6. `vgfit.py` also drops a leg whose Mi is more than
5 % off the median, and it says so.

### 5. The TLB probe in i32 (`6f5ead34a8`)

Every address this backend pushes is an i64 host pointer, narrowed with
`i32.wrap_i64` where it is used (`W64_MEM32`). V8 emits each narrowing
of an i64 sum as `movl r,r`. The probe had three of them on the chain
of every guest access:
- the fast-table pointer: `env + fast_ofs`, a negative offset;
- the entry: `table + index`;
- the host address: `addr + addend`.

For a 32-bit guest (`s->addr_type == TCG_TYPE_I32`) under `W64_MEM32`,
`w64_tlb_probe32` does all of it in i32. It narrows `env` and the address
once, loads only the low halves of mask, table, comparator and addend,
and compares with `i32.eq`. The low halves are exact:
- the mask, the table pointer and the addend are all correct mod 2^32;
- a comparator with a nonzero high half is −1 (invalid), and its low
  half has the bits between the alignment and the page set, which no
  key has;
- a key whose `addr + adj` wraps past 2^32 to page 0 is compared against
  the last page's slot, never page 0's.

QEMU's own x86-64 backend compares 32 bits for a 32-bit guest.
`w64_addr` (negative env offsets: the icount decrementer on every TB
entry, the `sp−8` handoff slot) narrows the base first and adds in i32.

- **x64** (module 150 of an S75 boot, TurboFan with hints): self-`movl`
  **4.16 % → 0.22 %** of instructions; hot prefix **169 → 152
  instructions per TB** (a different capture of the same boot, so the mix
  differs slightly).
- **Price:** SL65 video, ABBA ×3 (12 legs, all valid), shared slope:
  **−3.60 % ± 1.01 ms/Mi**. A second series, ABBA ×2 on a quieter host
  (busy 0.63–0.96), read −0.30 % ± 1.74. **Pooled over 20 legs:
  −2.64 % ± 0.97.** The x64 is the firmer evidence here; the clock only
  bounds the size.
- **Gates:** `keep` GREEN (11/11) on the tree without the bench hooks.

### 6. J2ME gets most of it too

`tools/perf/j2abba.sh` is the J2ME twin of `vgabba.sh` (CX70_FW56_clean
game 1, a 45 s virtual window, Mi 5624–5625 in every leg). It is scored
with `VGFIT_KIND=j2me tools/perf/vgfit.py`. The review had broken
`j2mebench` too (an unconditional `_wasm_memstat` call and a hard import
of the deleted `wasm-diag.h`); both are now tolerant, as videobench's
are.

- **Round 49 as a whole** (`dist-a` = `da835da585`+hooks against
  `6f5ead34a8`+hooks), ABBA ×2, 8 legs, busy 0.71–0.95: **−15.4 % ±
  1.74 ms/Mi**. The bytecode interpreter is load- and store-heavy, so the
  TLB hint is most of that. The two changes weren't priced separately on
  J2ME.

### 7. The hot TBs after both changes: nothing left to take from the x64

`tools/perf/wasmgrab.mjs <devtools port> [secs] [modules] [outdir]`
attaches to a running page (`videobench --devtools 9333 --hold 600`),
profiles every worker and keeps the vCPU. It finds the vCPU as the worker
whose samples span the most wasm scripts, because two helper workers spin
inside one function and outweigh it on raw samples. It saves the hottest
TB modules' bytes with `Debugger.getScriptSource`, from that same worker,
so a profile URL and a saved file are the same script by construction.
It also writes `hot.json` (per-function self time). Grab last: enabling
the debugger tiers the page's wasm down.

On the playing clip, `6f5ead34a8`: **TB code 78 %, main-module C 21 %.**

- **The hottest TB function** (3.6 % of the vCPU, 1 692 x64
  instructions) has no spill traffic on its hit path and no self-`movl`
  narrowing (4 left, all cold). Of its 109 `movl r,r`, 105 are
  two-operand copies, which move elimination makes nearly free. Env
  loads and stores are 4.0 % and 3.5 % of its instructions. The loads
  are TCG reloading globals after a label, which is how TCG's allocator
  works: keeping a global in a register across a label would mean
  intersecting register state over every edge into it, a TCG-core
  change. A bound of about half those loads is ~2 % of instructions,
  and on L1 hits at that, so it is below this meter. The per-access
  mask and table reloads are round 38's closed hoist. The
  64-bit loads at odd offsets (`[r11+0x1f]`) are V8 instance and table
  fields around the cold helper calls. The TB exit is the emitted
  next-TB probe followed by `return_call_indirect`: a bounds check, a
  signature check, a jump. That is the dispatch floor rounds 21–33
  closed.
- **Main-module C** is the guest's own SVC/eret round trip:
  `arm_rebuild_hflags` 2.28, `cpsr_write` 1.31, `switch_mode` 1.25,
  `take_aarch32_exception` 0.95, `helper_cpsr_write_eret` 0.63,
  `arm_take_svc_aarch32` 0.62, `helper_svc_inline` 0.24,
  `helper_cpsr_write` 0.16. That is ≈ 7.4 % over 4 729 crossings/Mi,
  about 30 ns of C per crossing. `do_ld4_mmu` 2.67 % is round 47's
  profile artifact (48 calls/Mi). The code is already lean: hflags
  rebuild only when M/E/IL move, and the hook lists are skipped when
  they are empty. What is left is the call and the bank switch
  themselves. A specialised USR↔SVC path could not remove the rebuild
  (12.3 ns, round 47) or the call (~14.5 ns in situ), so its reachable
  share is ≈ 1–2 %, below what a 16-leg ABBA resolves (±0.9 %).
- **Wasm compilation hints are closed without building them.**
  `metadata.code.compilation_priority` would have let a module ask for
  TurboFan up front: 3.6 % of TB entries run the baseline tier at 2×
  (round 21), and `--wasm-tiering-budget=1000` bought 3.1 %. But the
  Chrome the benches and users run (Chrome for Testing 153.0.8010.12)
  reports `--no-wasm-compilation-hints` as the default, unlike branch
  hints, so the section would be ignored. Re-check on a Chrome that
  ships it (`chrome-headless-shell --js-flags=--help | grep -A1
  compilation-hints`).
- The LG TB-lengthening item in *Open items* is live code (since round
  34, `w64_tb_icount_exact()` is `icount2_enabled()` alone). What was
  never done is measuring it on ke800.

## Update (2026-09-23, round forty-eight: the meter after the review, `msr cpsr` goes inline, and the native red it exposed, fixed)

### 1. What the 2026-09-22 review took from the measurement workflow

The review (`qemu/20260922-review.md`, owner decisions) removed
`wasm-diag.h`, every counter, every `W64_*` knob and the tool-only
exports, `wasm_rtcap_set` among them. `videobench` needs that export: the
walk runs capped and the window runs uncapped. Without it every leg reads
`rt` 1.000.

- **`tools/perf/bench-hooks.patch`** puts back `wasm_rtcap_set` and eight
  census slots (`wasm_bench_ctr[]`, read as `bench0..7` in `perMi:`). It
  is a *local* patch: apply it to both arms of an A/B and never commit it
  to `qemu/`. It is in the qemu working tree right now, uncommitted.
- **A census is now a temporary patch plus a separate dist.** This
  round's is in `doc/attic/msr-census-round48.diff`. Under icount a count
  does not depend on host load, so a census leg can overlap a gate.
- **There are no `?env=` knobs.** An A/B is two binaries: build arm B,
  `git apply -R` the change, build arm A, re-apply, and check with md5
  that `dist-jit` matches the measured B before gating it.
- **`tools/perf/vgfit.py`** fits one hostBusy slope shared by both arms
  over any number of tags. `vgan.py`'s slope per arm cannot be pinned
  down by four legs. On series 1 it read −2.12 % where the shared slope
  read −1.91 % ± 1.63.

### 2. `msr cpsr` that leaves the mode alone is written inline (`e2976ebbfe`)

Round forty-seven's open item. `w64_cpsr_write_inline()` in
`gen_set_psr` applies when the mask is within NZCV|Q|AIF|M, there is no
EL3, and `w64_psr_can_continue()` holds. It checks in emitted code that
the masked mode bits of `uncached_cpsr ^ (val | M4)` are zero and that
`interrupt_request` is 0. Then it writes the four flag globals, `QF` and
the low word of `daif`, and translation carries on. Otherwise it branches,
before writing anything, to an exit stub at `tb_stop` that calls
`helper_cpsr_write` with the same value and leaves like the guard's miss
(refund, pc, `goto_ptr`). The `M4` term matters: `cpsr_write` ORs 0x10
into the value before it compares modes.

- **Census** (SL65 video, per Mi): fast path **5 331.7**, helper calls
  left **1 205.0**, of which **1 204.2** change mode and **0.54** have an
  IRQ pending. That is round forty-seven's 5 331 non-mode msr exactly.
- **Price:** ABBA ×2 twice, 16 legs, shared-slope fit on hostBusy:
  **−1.91 % ± 1.63 and −2.44 % ± 0.47; pooled −2.16 % ± 0.85 ms/Mi**.
  Mi was 1499.7–1501.2 in every leg. This session's base read 2.93–3.44
  ms/Mi (`rt` 2.33–2.74) at hostBusy 0.10–0.36.
- **Gates:** `quick` green; `keep` green on every wasm job, including
  `lockstep-wasm` against a native reference rebuilt at the pin. The red
  `native` job is § 3.

### 3. The native reference was stale, and at the pin it was red

`build/qemu-native-build` was still `4e60f930b2`, from before the
upstream merge; the review had said so. Rebuilt at `b9971ade2e`, the
`native` job fails deterministically: s75 and el71 abort in `l1bbcsg` at
~9 s. Bisect: the merge `7c5f87096a` passes; flipping the review's three
native CPSR-exit guards back passes too. § 4 has the cause.

### 4. The cause: one exception return the review did not convert

Pristine origin/master (`c551b96e6e`), built natively, passes with
upstream's exit-to-loop semantics. So the bug was ours, not upstream's.
Under `-icount shift=3,sleep=off` the `-d int` stream is deterministic for
the first ~295 k lines, run to run. Pin and flipped builds split at line
14 073, and upstream follows the flipped one. A one-line log of
`interrupt_request` in `cpsr_write_eret` showed `CPU_INTERRUPT_HARD`
pending with I clear at an `ldm {…, pc}^` into sys mode. The pin then ran
the target's `msr` and an SVC before its loop ever saw the IRQ. `do_ldm`
had kept `DISAS_JUMP`, while upstream has `DISAS_EXIT`.
`gen_eret_end_tb()` now holds the per-build choice for both exception
returns. Native suite: all four PASS. wasm64 code is unchanged.

The method is worth keeping: **when a native boot diverges between two
builds, diff their `-d int` streams under icount before reading code.**
The first split names the instruction.

### 5. The `firefox` gate had no verdict since the review

The review's claim that "the gates use only `wasm_insns`" missed
`ffboot.mjs`. Its verdict was `temp=`, which it computed from
`_wasm_memstat`, so every `close` since the review ended "ffboot produced
no verdict". The review only ran `keep`, so it never saw this. The module
budget is now judged by its effect:
- `errors=0`;
- `progress=ok`: the guest clock reached ≥ 20 s, the screen drew, and
  insns still rose over the last 20 s. An idle S75 runs ~1 M/s.

A 10 s run reports `progress=FAIL`, so the check is not vacuous.

**`gate.sh close` at `da835da585` is GREEN.** All 15 jobs passed:
`native`, `lockstep-native` and `lockstep-full` against native and TCI
references rebuilt at the pin, `boot-ordered` in 754 s, and `firefox` on
the rerun with the new verdict.

### Traps this round paid for

- **`scripts/build-native.sh` runs `git submodule update --init` on
  `qemu/` and then `checkout -f` to the pin.** Whenever the superproject's
  recorded commit differs from the submodule HEAD, that can wipe
  uncommitted qemu work. This time an untracked file blocked the checkout
  and saved it. With a dirty submodule, move the worktree by hand:
  `git -C build/qemu-native checkout --detach <rev>`, then
  `ninja -C build/qemu-native-build qemu-system-arm`, with
  `~/.local/bin` on PATH for ninja.
- **A relative `WEB_DIST` deploys into the build directory:**
  `ninja-fast.sh` `cd`s to `build/qemu-wasm64` first. Pass an absolute
  path.
- **`pgrep -f`/`pkill -f` match their own shell** — paid twice more this
  round (a wait loop that never ended, a `pkill` that exited 144). Wait
  on a log marker, and stop background tasks by task id.

## Update (2026-09-22, round forty-seven: a device model had eaten the video meter, a flash write storm was round 46's "wake storm", the deferred BQL hold was never bounded, and `mrs cpsr` goes inline)

**Read the first item before trusting any number from rounds 45–46.**

### 1. The capcom regression — rounds 45 and 46 measured a broken build

Round 44's capcom engine (`02ada89fe6`) armed a `QEMU_CLOCK_VIRTUAL`
timer for every T0 wrap and compare. The SL65 runs T0 as an
interrupt-less PWM (T0REL 0xFF6F, 145 ticks at 26 MHz), so every
virtual second carried ~360 k timer deadlines, each an icount budget
exit: **video fell from `rt` 2.5 to 0.38** (`execIter` 34 → 15 100 /Mi,
`tbGen` 0.7 → 11.9 /Mi) and stayed there through rounds 45 and 46.
Every video price those rounds quote was taken on that build; treat
them as unmeasured. `6e361b6c8e` times only events that can raise a line
and applies the rest at the next register access (video back to `rt`
2.40 on its own leg). The tell was in every leg's census: **diff a new
leg's `execIter`/`tbGen` against the last good result JSON before
believing its clock.**

### 2. Round 46's "154 kHz wake storm" was flash-blk, not the TPU (`1a043d7c57`)

`qemu_bh_schedule()` on a BH that is already pending still
`aio_notify()`s — a futex wake of the main loop. The wasm flash
write-behind scheduled its flush per programmed word. Scheduling only on
the empty → non-empty transition: **KE970 boot `mlWake` 148 k → 31 k/s,
EL71 8.9 k → 1.5 k/s**, guest insns per window unchanged.

### 3. 16 MB phys-summary buckets (`95055ff451`)

The LG boards flip a 16 MB romd window on every flash command, and the
other half of its 32 MB summary bucket holds the running code: every
flip walked ~36 groups and dropped nothing. At 16 MB: **2 293 → 68
entries walked per flip**, C-side timer 46–51 → 6–7 ms per wall second
of the vCPU, **~4 % of the vCPU through a KE970 boot**.

### 4. The flash write-behind goes asynchronous (`4457396bbf`)

The flush BH's synchronous `blk_pwrite()` polls the thread pool **with
the BQL held**, so every flash MMIO the vCPU made meanwhile waited out
the file write (main loop in the BH ~240 ms/s; vCPU blocked on the BQL
228–234 ms/s). `blk_aio_pwritev()`, one generation in flight: vCPU BQL
wait 120–162 ms/s, **KE970 boot 3–5 s faster** (1.4 G insns at 24–25 s
against 29–30 s). Integrity checked range by range against the storage
array on EL71 and KE970, 0 bytes differ.

### 5. The exception return drops its BQL pairs — and the deferred hold turns out to be unbounded

HELPER(cpsr_write_eret) took and dropped the BQL twice per exception
return around hook lists that are empty on the ARM926 — **1.29 M
`bql_lock()` calls a second on video**, ending the vCPU's deferred hold
(round 13) twice per SVC. The first version replaced them with the lean
deferred pair; it measured **−3.3 % ± 0.8 % ms/Mi** at matched
`hostBusy` and then **hung two things**:

- **KE970 at 408 MIPS with the main loop stopped** (`mlIter` 0 for 25 s).
  An ISR acks its device by MMIO and returns into the firmware's idle
  spin; that spin is one chained loop, and without icount nothing ends
  a chain, so `cpu_exec_loop()` — the only place a wanted lazy hold was
  given back — never ran again. The main loop blocked on the BQL, and
  with it the timer interrupt that ends the spin. **The eret's real
  `bql_unlock()` was the release point that made the deferral safe**, and
  `main-loop.h`'s claim that one pass of `cpu_exec_loop()` bounds it was
  false. What shipped keeps the release (`bql_release_lazy()`) and drops
  only the locking.
- **lockstep-wasm stuck at "246 M"**: the budget stop is an `exit(0)`
  from the vCPU thread, and with the lock held lazily the page froze on
  it; the harness's last progress read was a few epochs short of the
  250 M budget. `bql_release_lazy()` before that `exit(0)` (wasm64.c).
  **Round 40's "divergence at 246 M"**, which is why these pairs were
  kept, was very likely the same freeze.

What shipped (`46d7aa3e64`, with the exit fix `c0a93d01a2` before it):
the hooks' locking only when a list is non-empty, `bql_release_lazy()`
where the second real unlock was. **SL65 video, ABBA ×2 fitted on
`hostBusy`: −5.7 % ± 1.5 % ms/Mi** (means 3.152 → 2.965) — better than
the lean pair's −3.3 %, since it drops the re-lock as well. Gate keep
GREEN, KE970 bootcheck PASS.

### 6. Timer re-arms from the main loop itself stop waking it

A wake census (temporary counters in `timer_mod_ns`, split by thread
and by whether the head deadline moved later) found round 46's question
answered the other way round: through a KE970 boot **~90 % of the
re-arm notifies came from the main-loop thread itself** — a device timer
callback re-arming its own timer — and only ~15 % moved the head later.
From the main-loop thread the notify wakes nobody (the next
`main_loop_wait()` computes its deadline before sleeping), but its
`qemu_notify_bh` made that next iteration skip the sleep: one more BQL
round trip, which also ends the vCPU's deferred hold. `18f8cd44e9` skips
it there (`qemu_in_main_loop_thread()`; `qemu_in_main_thread()` is true
on a vCPU holding the BQL, so it cannot be used). **KE970, 4+4
interleaved boots: `mlWake` −45 %, 500 M / 1 000 M / 1 500 M reached
3.9 / 4.9 / 3.5 % sooner (medians), every pair faster at every
milestone.** Siemens boards are unaffected: S75's 150 k re-arms/s are
all vCPU-side under icount (1/s from the main loop).

### 7. Closed with numbers: the hflags memo and `W64_FTMAX=4`

- **`arm_rebuild_hflags` is 12.3 ± 1.6 ns a call** (temporary
  `W64_HFDUP=n` probe: n extra rebuilds per inline SVC, video 4+4 legs,
  +18 876 calls/Mi verified by `hflagsCalls`, fitted on `hostBusy`). The
  5 937 calls/Mi are 2.6 % of video, 0.3 % of J2ME game 1. Round 17's
  31.6 ns was 2.6× high. The pre-v6 short path is already two loads and a
  few bit tests, so a memo could save only the call chain around them —
  not worth a stale-entry risk. `hflags.c`'s comment corrected
  (`520d682b91`).
- **`W64_FTMAX=4` re-ranked after inlining on video: +0.97 % ± 0.87
  ms/Mi** at matched `hostBusy` (same-binary env ABBA ×2). 3 stays.
  `tools/perf/knob-score.py` was broken (arms looked up through
  `globals()`, KeyError) and now also prints the `hostBusy`-fitted delta.

### 8. Where video's vCPU goes now — profile by module, then counted

A `wprof2` profile of the playing clip (`videobench --hold`, then
`PROF_ATTACH`), re-aggregated **by script URL** from `PROF_SAVE` (wprof2's
own per-module summary classes everything as TB code on a staged dist,
and TB-module frames get main-module names that mean nothing):
**79.7 % emitted TB code, 19.9 % main-module C**. Of the C, the
exception/PSR cluster is ≈ 9.8 % (`arm_rebuild_hflags` 2.13, `cpsr_write`
2.09, `switch_mode` 1.45, `cpsr_read` 0.92, `helper_cpsr_write` 0.91,
`take_aarch32_exception` 0.74, `helper_cpsr_read` 0.57,
`arm_take_svc_aarch32` 0.56, `helper_cpsr_write_eret` 0.46).

A temporary counter build (hot counters + six census counters, patch
kept as `doc/attic/psr-census-round47.diff`) counted per Mi: **mrs 7 710,
msr 6 535 (1 204 of them change mode), eret 2 370, SVC 2 360, effective
`switch_mode` 5 938 (= `hflagsCalls` exactly: entry + eret + mode msr)**,
MMIO loads 37, MMIO stores 331, `do_ld4_mmu` 48.

- **`do_ld4_mmu`'s 2.84 % self time is a profile artifact.** At 48
  calls/Mi it would be ~1.7 µs a call; the TIME_PHASES MMIO timer with
  every dispatch sampled (`W64_IO_SAMPLE` 1) reads **~230 ns per MMIO
  load** after the 62 ns straddle floor — ≈ 0.3 % of wall. MMIO stores
  read ≤ 184 ns, most of it the instrument's own nested clock calls
  (device ≈ 8 ns, BQL at the floor). **MMIO is not a video lever.**
- The hflags share cross-checks: 2.13 % ÷ 5 937 calls = 10 ns/call
  against the probe's 12.3, so on this path the profile's shares are
  usable as sizes.
- What the counts point at: **14 245 mrs/msr helper calls per Mi**, each
  an import call inside a TB (~14.5 ns in situ by round 27's
  `W64_CALLPAD`, spill of live locals + every global reloaded after —
  `cpsr_read` and `cpsr_write` carry no TCG call flags).

### 9. Inline `mrs rd, cpsr`

`HELPER(cpsr_read)` returns `cpsr_read() & ~CPSR_EXEC`, which needs only
`uncached_cpsr`, `QF`, `GE`, the low word of `daif` and the four flag
globals — about 20 TCG ops. On wasm64, `trans_MRS_reg` now emits them
in place of the helper call (`4e60f930b2`; native keeps the helper).
**SL65 video, two same-binary env ABBAs ×2 (16 legs), fitted on
`hostBusy`: −2.87 % ± 1.46 and −1.87 % ± 1.22; pooled −2.47 % ± 0.92
ms/Mi.** The raw means of the second screen were flat because its knob
arm drew more host load (busy 0.176 vs 0.144) — read the fitted line,
not the means. Implied saving ≈ 9 ns per mrs, which is round 27's
14.5 ns in-situ call price minus the inline ops. `gate.sh close`: 13/15
in the run; the two reds were infrastructure and both pass once fixed
(next section).

**This is the general lever the census names:** a flag-less helper
called at a high rate *inside* a TB is paying ~14.5 ns for the call
itself. Before inlining the next one, count its calls/Mi on the
workload (this round's census patch is in `doc/attic`) and multiply by
~9 ns.

### Traps this round paid for

- **`cp -r site/dist-jit site/X` copies the `.wasm.gz` with the same
  mtime, and serve.mjs serves the sidecar when it is not older than the
  wasm** — the staged dist runs the *previous* binary (diag counters
  reading 0 was the tell). `rm -f site/X/*.gz site/dist-jit/*.gz` after
  every copy. `build-qemu-wasm64.sh` ignores `WEB_DIST`.
- **A sync block write from a main-loop BH holds the BQL for the whole
  write.** Look for it wherever a device writes a backing file.
- **Never remove a real `bql_unlock()` on a vCPU path without putting
  `bql_release_lazy()` in its place**, and do not test such a change on
  icount boards only: the deadlock needs `icount=none` (LG).
- **KE970 boot meter**: insns sampled every 250 ms, wall time to
  500 M / 1 000 M / 1 500 M interpolated; discard a run that freezes
  (hang class 2). A fixed-window instruction count cannot resolve boot
  changes — the window lands on different phases.
- **A pkill pattern matches the shell running it** — `pkill -f
  vgabba.sh` from a command line that contains "vgabba.sh" kills that
  shell (exit 144) and can leave the child running. A hung gate's
  browser renderer spun at 100 % for 35 minutes under two measurements
  before it was found; `ps --sort=-pcpu` before every ABBA. The same
  goes for `until ! pgrep -f "<pattern>"` wait loops: the loop's own
  shell matches and it never exits — wait on the log's done marker
  (`SCREEN-DONE`) instead.

- **`lockstep-native` compares the native JIT against
  `build/qemu-native-tci-build`, which `build-native.sh` never rebuilds.**
  At session end it was from 2026-09-15 — older than the capcom engine —
  so the gate reported a JIT/TCI divergence (an IRQ taken at insn
  163 803 398 on one side only) that was a stale binary. Rebuild it with
  `scripts/build-native-tci.sh` whenever the pin moves past a device
  change (it needed `sudo apt-get install python3-venv`: configure's venv
  wants `ensurepip`); then 3/3 clean. The `firefox` job needed
  `npx playwright-core install firefox` (run in `tools/`) plus its GTK/cairo
  libraries (apt list printed by the installer); then errors=0, temp=0.

### Open

- **The deferred hold still has no structural bound** off the exception
  path: firmware that does MMIO and then spins in RAM without an
  exception return, on an `icount=none` board, would starve the main loop
  exactly as the KE970 did. Not observed after the fix. The robust fix is
  for `bql_lock_impl()` to `cpu_exit()` the lazy holder (published
  once per lazy epoch with a full barrier — Dekker against
  `bql_wanted`), at the price of one chain unwind per contended
  main-loop acquisition; price that before building it.
- ~~`arm_rebuild_hflags` re-price~~ — closed at 12.3 ns (item 7).
- **`msr cpsr_c` without a mode change (≈ 5 330/Mi on video)** still
  calls `helper_cpsr_write`, which kills every global. An emitted fast
  path (compare the mode bits against `uncached_cpsr`; if equal, update
  `daif` and the flag globals inline and kick `icount_decr` on a pending
  interrupt; otherwise call the helper) is the msr twin of item 9. It is
  harder to get exactly right: `cpsr_write`'s NMFI/SCR checks are dead on
  this core but must be proven dead, and the continuation
  (`w64_psr_continue`) already reads the interrupt state. At item 9's
  ~9 ns per avoided call it is worth ≈ 1.7 % of video, more if the
  helper body (`cpsr_write` ~6.5 ns) goes with it — likely the best
  next lever on this meter. The mode-changing 1 204/Mi and the eret must
  keep the helper.

## Update (2026-09-22, round forty-six: what actually paces a KE970 boot — busy phases are instruction-bound, the compile tier is worth ≤3 %, and virtual-time turbo drowns in a 154 kHz wake storm)

The round-44/45 "boot is firmware-paced" reading was an artifact: **`tools/bootcheck.mjs` never forwarded `EXTRA_Q`** (uibench and workbench do), so the `W64_INTERP`/`W64_COMPACT_LIVE` boot legs all ran the default config and "measured" nothing.  Two tools now share the wiring (`bootcheck.mjs` joins `QUERY` with `EXTRA_Q`) — an env knob that silently does not reach the page is worse than no knob.

**The corrected boot model** (haltprobe sampling mid-boot, 15–40 s):

- the vCPU is executing with **no pending interrupt in 95.5 % of
  samples** (not IRQ-starved, not halt-bound), at **50.7 MIPS** during
  busy phases; the whole boot is **1.75 G insns**, averaging ~22 MIPS
  over ~75 s wall — busy phases are instruction-bound, the gaps between
  milestones are the firmware's waits.
- menu/idle ARE firmware-paced: an all-interp menu holds fps (18.2 MIPS
  / fps 3.3 vs 17.5 / 2.6–2.7 compiled), and idle is 1.2 MIPS.

**The compile tier is worth ≤3 % on the boot** (the probe that finally
ran correctly): `W64_INTERP=1e9` (nothing ever earns a module — the
whole boot interpreted) against default, progress matched by TICK:

| t | compiled | all-interp | ratio |
|---|---|---|---|
| 5.5 s | 113 M | 79 M | 0.70 |
| 15.5 s | 276 M | 223 M | 0.81 |
| 25.5 s | 818 M | 717 M | 0.88 |
| 35.5 s | 1494 M | 1441 M | 0.96 |
| 45.5 s | 1615 M | 1569 M | 0.97 |

The interpreter tier (threshold 64, on by default) is surprisingly
competitive on this firmware — the compiled modules buy ≤30 % in the
earliest phases and ≤3 % end-to-end.  Corollary: batch/compaction
tuning for boot is bounded by that 3 % (and the earlier
"compaction-flat" legs were env-broken — disregard them; the module
table sits at ~450 live of 6144 during a boot per the wasm64.c comment,
so capacity was never the question).

**Virtual-time turbo (the honest boot-speed lever) works mechanically
and fails operationally.**  A `W64_VTSPEED=k` scale on
`cpus_get_virtual_clock()`'s !icount path (anchored, monotone, reverted
after the probe) makes every virtual deadline arrive k× sooner.  At
k=4 the boot reached only **82 M insns by 75 s wall against 1664 M
base** — not faster, 20× slower: the boot carries a **154 kHz
main-loop wake storm** (`mlWake` 154 k/s during boot vs 5.8 k/s at
idle), virtual-proportional, so k× turbo is also k× events per wall
second and the wasm main loop drowns before the vCPU gets anything
done.  **The wake storm is the lead**: something in the boot device
traffic arms µs-granularity virtual timers (TPU's eager GSM simulation
is the suspect — its counter updates arrive ~27 per µs in the trace);
lazy/deferred evaluation of whatever that is would both cut the
~15–30 % main-loop overhead during boot *and* make a k× turbo actually
pay.  That is device-model work (alula's layer), and it pairs with the
round-44 L1 assert investigation — same subsystem.

**Engine-side, KE970 has no board-specific lever left**: boot busy
phases ride the generic interpreter MIPS (rounds 35–45 collected what
there was), menu/idle are firmware-paced, and the diagnostics confirm
the interp tier already absorbs the cold-path cost.  The board's
remaining items are the L1 hang class and the wake storm.

Also this round: `haltprobe.mjs` learned ke970 (idle: 0 pending IRQ in
98.9 % of samples — the idle loop polls with nothing asserted; the
5.8 k/s idle wake storm is unchanged), and the vCPU-worker *inclusive*
profile attribution was confirmed as unreliable as the self-time one
(wprof showed tb_gen_code at 35.6 % inclusive; the time counters and
the behavioral probes put the whole translate+module pipeline at
~1–2 % — trust counters and probes, not sample attribution on this
build).

## Update (2026-09-22, round forty-five: three prices and a verdict — asserts cost 2.75 %, the C-side next-TB cache is worth 5.3 % on churn, the tbstats RMW is free)

Four short measurement series on a quiet host (load 3–7 all afternoon),
each single-variable, scored pooled + rt + hostBusy-matched:

**1. The LG tbstats RMW ceiling probe — closed, redesign NOT justified.**
`W64_TBSTATS=0` (which verifiably omits the two per-TB-entry RMWs from
every generated prologue, `tcg-target.c.inc` `w64_tbstats_inline`) was
A/B'd on ke970 uibench, ABAB, `--settle 75` on both arms (the notb arm
has no insn counter, so the rate-based quiet detector cannot run — same
protocol on both sides keeps the pair comparable):

| arm | menu fps | fills/s | tbGen/s |
|---|---|---|---|
| base ×2 | 2.6 / 2.7 | 206 / 202 | 475 / 472 |
| notb ×2 | 2.5 / 2.7 | 201 / 202 | 473 / 472 |

No separation: the RMW tax is below the ~4 % resolution of the fps
meter at ~1.7 M TB-entries/s.  Any per-exit/derived-MIPS redesign can
promise at most ~1–2 % and is not worth the complexity risk.  The
`notb` legs of earlier plans are dead; `W64_TBSTATS=0` remains a
diagnostic, not a lever.  (ke970 menu is firmware-paced, not
engine-bound — see 4.)

**2. The C-side next-TB cache re-probe — deletion REJECTED, keep it.**
The owed `W64_NOPCC=1`-alone leg ran as an 8-leg env ABBA
(`tools/perf/knob-abba.sh`, same dist both arms): **knob is +5.34 %
slower** (21.005 vs 19.941 ms/Mi, every knob leg ≥ every base leg but
one; rt 0.381 vs 0.402 agrees).  The counter census's 0.1–0.35 % was a
video-workload number; on this module-churning workload the cache
absorbs ~12.7 µs/Mi of `lookup` (15.1 → 27.8 µs/Mi with it off, modNs
30 ms/Mi, tbGen 11.9/Mi).  `w64_pcc` stays; the ledger row's ceiling
was workload-specific and the table's 0.1–0.35 % should be read as
"video legs only".

**3. `b_ndebug` priced — asserts cost 2.75 % ± 1.83, a trade, not taken.**
Upstream forbids NDEBUG (`osdep.h` `#error`), so the pricing build
temporarily neutered the guard (reverted; the build flag is the only
residue, and `build/qemu-wasm64` is back on `b_ndebug=false`).  Full
ABBA, dist rotation (`dist-jit-ndebug`, since deleted — rebuild in ~41 s
by `meson configure -Db_ndebug=true` + the osdep guard edit + `WEB_DIST=
site/dist-jit-ndebug scripts/ninja-fast.sh`):

- pooled ms/Mi **−2.75 % ± 1.83** (ndebug faster), rt **+2.81 %**,
  hostBusy-matched **+2.00 %**; wasm 27 MB vs 28 MB.
- It is the user's call, not a silent keep: in the browser fork asserts
  are the crash-diagnosis surface for user-supplied firmware.  Default
  left ON.  Do not re-run this as a lever; it is priced.

**4. KE970 after the capcom engine: boots are reliable, and the menu is
firmware-paced.**  4/4 bootcheck PASS on `dist-jit` (~1.75 G insns,
milestone ~35 s) against the 30–50 % hang rate before `02ada89fe6`.
ke800 comparison leg (uibench, same protocol): idle 1.3 MIPS like
ke970, but menu **49.8 MIPS / fps 9.6** vs ke970's 17.5 MIPS / fps 2.6
— per-frame work is comparable (5.2 vs 6.7 M insns/frame), so ke970's
menu is timer-paced by its firmware; a faster engine will not raise its
fps proportionally.  Boot to idle ~1.75 G insns is now the honest
engine-side boot metric for the board.

Not priced, by directive (no long runs until confident in a change):
`-ftrivial-auto-var-init=uninitialized` — the pricing dist built and
booted (single leg within base spread) but the ABBA was cut after one
leg.  The recipe is the meson.build hardening-flag flip under
`qemu/meson.build:686`, same WEB_DIST pattern, ~41 s rebuild.  `b_lto`
stays parked per the round-37 warning (ASYNCIFY_ONLY × LTO name
deletion) until someone can afford the full gate.

Tools this round: `tools/perf/knob-abba.sh` (env-knob ABBA, same dist
both arms) + `tools/perf/knob-score.py`, `tools/perf/ke970-tbprobe.sh`
(the ABAB probe above).

## Update (2026-09-22, round forty-four: KE970 — the capcom model was a stub; boot hangs are device-model gaps, not engine ones)

The new LG board's boot hangs (~30–50 % of wasm boots freeze forever)
are **not** a wasm-engine problem: native qemu on the same source dies
in a firmware panic at the same wait.  What was found and fixed:

**Characterization (wasm, dist-jit, this session).**  KE970 boots to
its idle screen at ~1.62–1.65 G insns (~50 s wall on a quiet host —
LG icount=none, so `rt=off` is a no-op there and the firmware's own
timer waits pace the boot).  Idle: 1.3 MIPS, `mlWake` 5 819/s.  Menu
(open/close every 2 s): 19.6 MIPS, fps 3.2.  uibench/workbench/bootcheck
rows are in (`ke970` boots PASS the bootcheck gate at `minInsns=1.2e9`,
verified at host load 20).

**Hang class 1: capcom CC compare (fixed).**  The failing boots' last
console line was `[pmb887x-capcom]: unknown reg access: 5C` — CC3.
The capcom model was a stub: `capcom_update_state()` was literally
`// TODO`, no counters, no compares, CC0..CC7 unimplemented.  The
firmware sets up T1+CC3 (CC3=0x7FFF, T1 preset 0xFEC0, `CC3_SRC` SRE,
T1R run) and waits for the compare interrupt.  Implemented now
(`02ada89fe6`): T0/T1 up-counters at fsys/RMC (26 MHz here) with TnREL
reload, OVF flags, live Tn reads, CC0..CC7 storage, compare interrupts
per CCMx ACC/MOD, edge captures latch the counter (the scroll wheel's
CC6 capture now works), GPTU-style round-up deadlines, a `cgu` link.
Verified live: T0 free-runs at 397 wraps/s, engine logs `[ON]` at
26 MHz.  **Native proof**: pre-fix 4/5 boots died in the firmware
panic `sorry died at A2649Dxx` right after the CC3 read; post-fix
0/5 die there.

**Hang class 2: L1-phase waits (open).**  Wasm boots also hang
silently at 16 M / 98 M / 104 M / 141 M / 155 M / 192 M insns —
different points, same shape: vCPU halted forever, `wasm_diag`
deltas show *nothing* ticking (not even `mlWake`), TPU IRQ1 keeps
firing every GSM frame but the vCPU never services it, and the
lost-wake canary added to `rr_wait_io_event` never fires (the
interrupt is never raised into the CPU, not lost on the way to
sleep).  With capcom fixed, **native** boots die deterministically
(5/5) in `sorry died at 00004B44 LR A27D0A88` — a deliberate L1
assert, with the TPU frame scheduler alive to the last frame (TPU_RAM
uploads, SRC1 acks, VIC threshold dance all healthy in the trace).
So the remaining layer is the GSM L1 protocol — the DSP/LLE side and
the PMB6272 RF stub (a pure SSI stub that answers every telegram with
0) — and it behaves differently at native speed than at wasm speed.
That is alula's device-model territory; the traces to resume from are
`/tmp/nat-trace.log` (native, 7 863 lines, TPU+GPTU+VIC IO+LOG) and
the `/tmp/ke970-hunt-*.log` series.

**Traps caught on the way.**
- `build/qemu-native` was stale since round 40: `arm_take_svc_aarch32`
  lived under `CONFIG_TCG_WASM64` while `helper_svc_inline` needs it on
  every target — **every native link since the svc-in-TB series
  failed**, and the gate's `native` tier had been PASSing on the stale
  Sep-20 binary.  Fixed (`02ada89fe6`); native builds again.
- `build-native.sh` reads `versions.env` and force-checks-out both the
  submodule and the worktree to `QEMU_PMB887X_REV` — with uncommitted
  device-model work in `qemu/` this can eat it (it refused this time
  only because the working tree was dirty).  Commit before building
  native.
- The trace channel names for `PMB887X_TRACE_IO/LOG` live in
  `trace_common.c`'s table (`capcom`, `vic`, `tpu`, `gptu`, …);
  `qemu_log` output reaches the page console on wasm and `-D file`
  natively.

**Perf meters while here.**  The uibench ke970 baseline (idle 1.3 MIPS
/ menu 19.6 MIPS / fps 3.2) and the `W64_TBSTATS=0` ceiling probe legs
ran but the `notb` legs cannot use the insn-rate quiet detector (the
counter is off by design) — re-run them with `--settle 75`.  The two
early baseline legs are the honest ones (`uib-base-1/2.log`).

**Not measured (blocked on a quiet host all afternoon — co-tenant at
load 15–50):** the KE970 boot/steady-state A/B after the capcom fix,
and the queued video-meter screens (`W64_FTMAX=4`, `W64_NOPCC=1`).

## Update (2026-09-22, round forty-three: the chain widened to every fetched page — taken; round-39's ghost baseline caught)

**The round-42 lever is in.** The soundness question that blocked it is
settled by reading, not by weakening anything:

- The chain-target guard in `cpu-exec.c` ("we don't take care of direct
  jumps when address mapping changes… not safe to make a direct jump to
  a TB spanning two pages") sets `last_tb = NULL` when the **target** has
  a second physical page, with a wasm64 exception for `w64_inl` TBs —
  and those chains are dropped by `tb_unlink_inlined()` at both TLB-flush
  sites, falling back to the dispatcher, whose `tb_lookup_cmp`
  re-validates `w64_inl_vpage` (the callee page, recorded as an offset
  from the entry page because the TB may be entered at any alias).  The
  guard inspects only the target; it is orthogonal to which page the
  *branch* sits on, so widening the source side cannot void it.
- A store to the target page invalidates the target and unlinks through
  its jmp list, exactly as before.  A store to the source's callee page
  invalidates the source, which is registered on every page it fetched
  (`tb_page_slots`/`tb_record`; "fetched" ⟺ `db->host_addr[n] != NULL`).
  What survives is first-page remap staleness — which system emulation
  already accepts for ordinary same-page chains — and CF_PCREL is off on
  this port (round 40), so chain targets are keyed by full virtual pc.

**Measurement.** 16-leg ABBA (`tools/perf/vgabba.sh`, scored by
`tools/perf/vgan.py` — pooled, virtual-rate, and a hostBusy fit now that
the host has no numpy): **+2.6 % pooled ms/Mi (±3.0), +2.4 % rt,
+2.1 % at matched hostBusy**, all three views agreeing in direction,
magnitude consistent with round 42's single-session +1.34/+2.2.  The
mechanism census closes exactly: `xwOther` **5 376 → 1 672 /Mi**,
`xGototb`+`xGototb1` 23 169 → 26 870 (+3 701 ≈ the converted exits),
`lookup` 59 → 58, `xwBx` 35 620 → 35 624, `tbIcount` ~10–11.

**Stability.** Gate keep GREEN five of six runs this session (the RED
was a key-s75 boot stall at a host-load spike — `insns=223M->223M`,
6/6 PASS standalone, the same class as the pre-existing key-el71 flake
from rounds 41/42, which predates this lever).  Lockstep was in every
GREEN keep.

**The trap that nearly voided the whole A/B.** `site/dist-jit-base`
turned out to be the *Sep 20 round-39 directory* — the morning's
rolled-back build — not the cherry-picked round-42 baseline it was
believed to be.  The tell was the census: `xwOther` 66 374, `xwBx`
60 616, `lookup` 2 688, `tbIcount` 7.3 — round-39's exact profile, on
a "baseline" that should have read 5 376 / 35 620 / 59 / 11.  A red
herring made it worse: `qemu-system-arm.js` is identical in both dists
(same md5 — it is unchanged loader glue; the code is the wasm), so the
file to trust is `qemu-system-arm.js.symbols` (`svc_inline` present =
round-40+) *plus* a census profile, and the mtimes of the deployed
files.  Baselines are rebuilt in-place now, never assumed.

The lever is `qemu` `e149f370ff` ("Chain direct branches to any page
the TB fetched from", on top of `4d1a392927` = the cherry-picked
round-40/41/42 series re-based onto the master merge).

**Open next:** KE970 boot/general speed (the new LG board) — uibench
and workbench rows are in; bootcheck gating after a characterized boot.
Cheap screens still owed on the video meter: `W64_FTMAX=4` (re-rank
after inlining), `W64_NOPCC=1` alone (the C-side next-TB re-probe).

## Update (2026-09-21, round forty-two: the third page priced and rejected, and a +2 % chain that is not yet safe to take)

Round forty-one left the TB boundary at 8–9 ns and 22 % of wall, with the
largest single refusal being `xwBlPage`: 9 805 per Mi of direct calls that
`w64_inline_call` turned away because the callee sat on a page the TB does
not track. This round built the third tracked page that collects them.

**Nothing from this round is in the tree as a behaviour change.** The
third page was built, gated GREEN, measured, and rejected on its numbers.
The lever it uncovered — worth +1.3 % pooled and +2.2 % at matched host
load on video — was reverted with its stability unresolved, because the
host went to load 26–32 before the question could be settled. What *is*
in the tree is the plumbing (every page-tracking site generalised from two
slots to `TB_PAGES`, which is 2), five new refusal counters, and a
`w64_pgset` census. All of it gates GREEN.

### The page refusals, split by rule and weighted at runtime

`W64_XWHY` gained `xwPgThird`, `xwPgLin`, `xwPgProbe`, `xwPgRet` and
`xwPgMore`, splitting the page refusal by which rule in
`w64_inl_pick_page` turned the stream away, for a call and an absorbed
branch alike. The answer was maximally favourable: **9 807.6/Mi all
`xwPgThird`**, every other split exactly zero. Nothing was refused for a
reason a further slot would not fix.

### The third page: green, and worth nothing

`TB_PAGES` moved into `exec/tb-pages.h` (because `translation-block.h`
cannot be pulled into `translator.h` — poisoned target identifiers), and
`page_next[]`/`page_addr[]`, the inline hulls, the page lock/unlock
protocol, `tb_lookup_cmp` and `translator_ld`'s fetch plumbing were all
generalised to N slots. `gate.sh keep` GREEN.

Census at three pages: every one of the 9 805 page refusals gone, and
total boundaries **88 301 → 87 538, −0.87 %**. That is the whole prize,
and it is nothing like the census's 11 %, because **an absorbed call
relocates its caller's boundary rather than deleting it**: the exits come
back as `xwBx` (+3 579) and `xwDefer` (+1 300), and the mix shifts from
chained to indirect (`xGototb1` −3 494, `xGotoptr` +2 272).

Clock, 8-leg ABBA, two builds of one tree differing only in that constant,
neither of them the live dist: **unresolved, consistent with zero.** The
pooled reading says −5 %, and it is an artifact — the three-page arm drew
three of the four busiest legs. Fitting each arm against `hostBusy` puts
the difference between +1.0 % and −2.3 % across the range where both arms
have data. The p2 arm produced 3.100 and 3.173 ms/Mi at *identical*
`hostBusy` 0.082, so four legs an arm cannot resolve anything under 2.4 %.

Retested on top of the `goto_tb` lever below, in case that was what ate
it: it was not. Still −0.87 % boundaries, still `xwBx` +3 579 and
`xwDefer` +1 300, and now translation work doubles (`modNs` 1 333 →
2 668, `modCompileNs` +88 %, `lcCall` 6×). `TB_PAGES` stays 2.

### The chain an inlined callee is losing — +1.3 %, and not yet takeable

`translator_use_goto_tb` tests the destination against **`pc_first`'s page
only**. So every direct branch *inside* an inlined callee is refused the
chain it would have had as its own TB, and leaves as an indirect exit.
Widening the test to any page the TB has already fetched from:

| per Mi | video | video +fix | J2ME | J2ME +fix |
|---|---|---|---|---|
| `xwOther` (branch refused a chain) | 5 376.5 | **1 672.3** | 7 076.8 | **3 816.3** |
| `xGotoptr` (indirect exits) | 65 132 | 61 437 | 50 781 | 48 298 |
| `xGototb` + `xGototb1` (chained) | 23 169 | 26 874 | 31 194 | 34 401 |
| total boundaries | 88 301 | 88 310 | 81 975 | 82 699 |

On video the boundary count is flat: a pure change of *kind*, which is the
thing the boundary census was never able to see. `lcCall`/`pccHit` halve
on both meters and J2ME's `smcWalk` drops 19 %. Absorption is not what
moved — `abCond` rose on both (+7 %, +12 %) and `tbIcount` with it
(+6.7 %, +8.4 %).

Clock: video 8-leg ABBA, **+1.34 % pooled on ms/Mi and +1.37 % on rt**,
with the fix arm having run the busier half (mean `hostBusy` 0.106 against
0.101), so that is a floor; at matched load it runs +2.2 % at 0.08 to
+1.2 % at 0.14. Both arms fit `hostBusy` with consistent slopes (2.48 and
2.97, against the three-page run's 0.44 and 3.87). On this run legs 1 and
5 of the base arm came in 0.03 % apart, so the meter was tight enough to
believe it. J2ME: **unresolved** — p2 3.816/3.804/3.964 against
3.854/3.825/3.845, the base arm's own spread five times the gap.

**Why it is reverted.** `gate.sh keep` GREEN on it. Then `key-el71`
started failing (the guest stops retiring instructions), and an
interleaved run read 5/5 for the base build against 5/9 for the fix —
which looks damning until the *reverted* build failed 3/3 twenty minutes
later and the full gate went GREEN again at load 32. The gate is flaky on
every build once this host is loaded, so the evidence is worthless in both
directions, and a +1.3 % lever is not worth taking on an unsettled hang.

Before trying it again, settle the invariant, not just the gate: SMC
registration covers *writes* to a page, while a direct chain is patched
once and thereafter bypasses `tb_lookup_cmp` — including the
`w64_inl_vpage` check that is precisely what validates a TB's non-entry
pages. Same-page may be buying something stronger than "the page is
registered".

### Lessons

- **A marginal-slot census prices one slot and no more.** `w64_pgset`
  records the pages a TB asks for, granted or refused. At two tracked
  pages it said nothing ever wants a fourth; at three, 4 740 per Mi do. A
  refused stream ends the TB there, so demand that only exists further
  along a longer TB is invisible to it.
- **An absorbed call relocates a boundary, it does not remove one.** The
  prize for a refusal counter is not the exits it counts.
- **A boundary census counts boundaries, not what they cost.** The best
  thing found this round is invisible to it: same count, different kind.
- **A census leg's wall clock is not a result**, even against another
  census leg. The counter code costs a bump per exit and the arms differ
  in exit count by construction, so the arm being helped pays less for
  being measured. The first J2ME census pair read −2.6 % this way and it
  was not a number.
- **Fit both arms against `hostBusy` before believing an ABBA.** Both A/Bs
  this round had one arm draw the busier legs; the three-page pooled
  reading said −5 % and the truth was zero. Two arms whose fitted slopes
  differ by 9× are not measuring the same host.
- **A gate that fails under host load proves nothing until the control
  fails too.** An interleaved 5/5-against-5/9 was host drift.
- The exit counters *are* load-immune: `xwSvc` held to +0.018 % between a
  leg at `hostBusy` 0.09 and one at 0.63. A census is still worth running
  on a host too loaded for any clock.

## Update (2026-09-21, round forty-one: the TB boundary priced on its own workload, and two more of it removed)

Round forty left video at `rt` 2.46 with a boundary census as the whole
cost picture and three ranked guesses about what to do next. This round
priced the census against the clock — which turned two of those guesses
into numbers — landed two mechanisms from it, and closed three
candidates, one of which had been this file's "only unmeasured item" for
four rounds.

**The short version: a TB boundary is 8–9 ns and 22 % of wall; the
boundary row is the only large one left; and no single remaining slice of
it is worth more than about 5 %.** The engine is now within ~1.5× of
what native-TCG-quality emitted code would cost per guest instruction,
so the rounds from here are 2–5 % each, not 36 %.

The two mechanisms together are **+6.3 %**, measured as a same-binary
knob flip — `W64_PSRCONT=0&W64_ABSCROSS=0` *is* round forty's behaviour —
in a four-leg ABBA on a quiet host (`hostBusy` 0.078–0.160, `Mi`
1499.8–1501.0 on every window). Both windows of both arms, off against
on: 3.108/3.209 → 2.981/3.004 and 3.364/3.573 → 3.213/3.271, i.e.
+4.3 %, +4.7 %, +6.8 %, +9.2 % on the four adjacent pairs. `rt` goes
**2.57 → 2.68** at `hostBusy` 0.08.

Note that this is **more than the boundary census predicts**: 11 764
fewer boundaries per Mi at 8 ns is +2.9 %. A longer TB does not only
delete its own boundary — it divides the per-entry costs (the locals
Liftoff zeroes, the globals TCG syncs and reloads across the hand-off)
over more guest instructions. Read the census as a lower bound on a
TB-lengthening change, not as its price.

### The boundary, priced

Two same-binary legs of the video meter, `W64_INLINE=4` against
`W64_INLINE=0`, counters on in both, `Mi` 1499.9 / 1500.4:

| | inlining on | off |
|---|---|---|
| TB boundaries /Mi | 100 080 | 168 145 |
| `ms/Mi` | 3.505 | 4.124 |

68 065 boundaries for 0.619 ms/Mi is **9.09 ns each**, and the census's
own counter bump is inside that, so the shipped figure is ~8 ns. At
100 080 /Mi that is **0.80 of 3.33 ms/Mi — 22 % of wall**. Round
twenty-eight's "a boundary is ~33 ns whatever kind it is" was an EL71
number at 9.35 ms/Mi and does not transfer; what does transfer is its
other half — **removing a boundary is worth 8 ns, changing its kind is
worth nothing.**

### 1. `msr cpsr` no longer ends the TB (+1.8 %)

`xwPsr` was 8 904 /Mi, 8.9 % of every boundary. Round twenty-eight
bounded it at 1.2 % of wall *as an exit*, before call inlining made it
also forfeit the inlined callee it was standing in.

`gen_msr_mask` clears `CPSR_EXEC`, so a CPSR write cannot move T, IT or
J: of the three key words a lookup uses, condexec and thumb are
untouchable and only **hflags** can move. `w64_psr_continue`
(`target/arm/tcg/translate.c`) tests exactly that in emitted code, plus
`cs->interrupt_request` — which reproduces the old exit rather than
approximating it. `helper_cpsr_write` has already run
`cpsr_write_check_irq`, so a pending interrupt has set `icount_decr`'s
high half and the miss exit reaches the same next TB, which stops at its
own prologue exactly as before; continuing instead would push the
interrupt to the end of this TB — architecturally legal, and a lockstep
divergence, which is the trap round forty fell into with the eret BQL
pair. A write whose mask reaches no hflags input (`msr cpsr_f`,
restoring the condition flags) skips the hflags compare entirely, and
`msr spsr` never needed to end a TB at all.

A mode change *within* EL1 (svc → irq) leaves hflags equal and is still
correct to continue through: the banked registers it swaps are values in
`env`, which the rest of the TB reloads anyway because
`helper_cpsr_write` clobbers every global. The op suite only covered
`msr cpsr_f`, so `tests/tcg-isa` gained `psr/bank_irq`, `psr/bank_svc`
and `psr/bank_mode` for exactly that case (1156 → 1159 tests, and the
wasm64 serial stream stays byte-identical to native).

Mechanism meter: **`xwPsr` 8 904 → 1 184 /Mi, boundaries 100 080 →
92 369 (−7.7 %)** at identical `Mi` and `excSwi`. Clock, ABBA on
`W64_PSRCONT` (same binary, four legs, two windows each): the two off
legs reproduce to 0.03 % (3.472/3.471 and 3.618/3.662 ms/Mi); the on legs
read 3.486/3.697 at `hostBusy` 0.33 and 3.335/3.492 at 0.17 — **+1.8 % on
the unweighted mean**, which is what 7 711 boundaries at 8 ns predicts,
and +4 % on the one leg that ran on a quiet host.

### 2. An unconditional branch may cross onto the TB's second page (+1 %)

A TB tracks two guest pages. Round forty gave the second one to an
inlined callee; unless a call claims it, it sits unused, and meanwhile
`xwOther` — an unconditional direct branch that `translator_use_goto_tb`
refused because its target is off the page — was 8 997 /Mi, 9.7 % of
every boundary left.

`w64_abs_cross_page` is the callee-inlining machinery with the call taken
out: the target is static, so there is no guard, no miss path and no
icount refund, only the bookkeeping that makes a second stream safe — the
page claimed through the same nonfault probe (`w64_inl_pick_page`, now
shared by both), a `W64InlRec` so the SMC cross-stream check knows which
stream owns the patched bytes, and the hull tracking that replaces the
linear span on both pages. One per TB, and not from inside an inlined
callee, whose depth stack restores `page_start` on return.

Census: boundaries 92 369 → **88 316 (−4.4 %)**, `xwOther` 8 997 →
**5 375**, `xGototb1` 10 053 → 8 606. It costs a little of its own
prize — `xwBlPage` rises 9 517 → 9 809 because absorb sometimes claims
the page a later call wanted — for a net −4 053 /Mi, about **1 %** of
wall at 8 ns.

### What the gates do and do not cover here

`scripts/gate.sh keep` is **GREEN 11/11** on the shipped build (four
boards boot at 1711/1611/2877/13 427 Mi, four keypad gates, native, the
op suite, lockstep identical over 249.6 M instructions).

One gap is worth stating rather than leaving implied. **The lockstep gate
cannot exercise either mechanism**: it runs one guest instruction per TB,
so `CF_COUNT_MASK` is set on every TB and both `w64_psr_continue` and
`w64_abs_cross_page` refuse — as call inlining already did in round
forty. What covers them is the op suite (which is why the new
`psr/bank_*` tests were added, and its wasm64 serial stream is
byte-identical to native over 1159 tests) and the four boot gates, whose
instruction counts land inside their usual bands. A TB-shape change on
this port needs the op suite and the boots; reading a green lockstep as
coverage for one is a mistake.

### 3. Rejected: a 64 KB guest page

`W64_PAGEBITS=16` is sound (a guest mapping smaller than the target page
gets `TLB_INVALID_MASK` and repeats the fill on every access) and it
would lift every page rule at once — `translator_use_goto_tb`,
`w64_absorb`, the one-callee-page limit and the A32 `max_insns` bound.
It is a **boot regression**: on a quiet host, in the same sweep where the
baseline reached the idle screen in ~2 minutes, the 64 KB leg had not got
there in five and was abandoned.

The mechanism is the SMC granule. `code_mask` is one bit per 1/256th of
a page — 16 bytes at 4 KB, 256 at 64 KB — and round thirty-seven already
measured that a coarser granule collapses the rejection rate ("a 64-bit
version rejected only 57 % of the stores"). A 64 KB page makes each
granule 16× coarser *and* each page's TB list 16× longer, and the two
multiply. A fixed 16-byte granule at any page size is buildable
(`TB_GMASK_WORDS` sized for the largest page; there are 16× fewer
PageDescs, so the memory is a wash) but the list walk behind it is not.
8 KB and 16 KB legs were attempted and are **inconclusive** — the host
saturated (1-minute load 8 → 37) while they ran, and neither booted.

### 4. Rejected: guessing an indirect branch from env at translation time

`xwBx` — `bx`/`blx` register — is 39 % of the boundaries left, and it
looked monomorphic: the per-TB lookup slot is refilled 24 times per Mi
against 36 345 exits. Translation runs with `env` holding the state the
TB is about to be entered with, so `env->regs[rN]` *is* the target
whenever the register was set before the TB — a callee's `lr`, a vtable
slot the caller loaded. Read it, guard it with one compare, carry
translation on into it; the guess is a hint and the compare is the
semantics.

Built, and it collects **2.5 % of its target**. With hit and miss counted
in emitted code: **750 hits against 7 241 misses per Mi — a 9.4 % hit
rate.** The sites that accept speculation are executed 7 991 times per
Mi, 22 % of all `xwBx`, so even a *perfect* predictor there is worth ~2 %
of wall, and this one is worth 0.2 %.

The reason is worth carrying: **a translation-time register snapshot is
not a branch predictor, because hot code is translated during the boot
and outlives the phase that translated it.** The slot's 99 % hit rate is
a *self-updating* cache's; a guess frozen at first translation has
nothing in common with it. A deopt-and-retranslate tier (one extra
translation per site, blacklisted after that) would fix the staleness and
is still only worth ~2 % at this coverage. Reverted; the instrumentation
it was built on stayed, and that is what found § 5.

### 5. Closed: the guest-register env-traffic row, and why `W64_GDUP` cannot price it

`W64_GDUP=2` — built in round thirty-eight, never run — emits a second
copy of every global load and write-back. On the video meter it reads
**3.473 against 3.490 ms/Mi, i.e. nothing**, and that null is about the
probe, not the row: each copy targets the same address with the same
value *adjacently*, which is the one redundancy TurboFan's store-to-store
and load-to-load elimination removes with no alias analysis at all, and
~96 % of TB entries run TurboFan code. The section that shipped the knob
anticipated the hazard and prescribed `tbBytes` as the self-check — but
that check cannot separate "the copies were emitted" from "the copies
were emitted and then folded".

The row can still be bounded from the census: `tcgGst` + `tcgGld` ÷
`tbIcount` is 1.34 linear-memory accesses per guest instruction, and an
L1-resident wasm32 access is about a cycle, so the row is **≤ 13 % of
wall** and the half a wider TB signature could reach (`gsyncExit` +
`gsyncBbend` = 52 % of sync demands) is **≤ 7 %** — against a change that
rewrites TCG's global handling and every TB entry point. A probe that
duplicated to a *different* hot address (a pad inside `env`, or a small
wrapping pool) would price it honestly; that is not worth building for a
≤ 7 % ceiling either.

### What is left, ranked

The census on the shipped build, per Mi, against round forty:

| | round 40 | now |
|---|---|---|
| TB boundaries | 100 080 | **88 316** (−11.8 %) |
| …`xwBx` (`bx`/`blx` reg) | 36 343 | 35 627 |
| …`xwBlPage` (a call whose callee needs a third page) | — | 9 809 |
| …`xwOther` (a direct branch that could not chain) | 7 391 | 5 375 |
| …`xwDefer` | 6 800 | 7 391 |
| …`xwPsr` | 8 904 | 1 184 |
| …`goto_tb` chains | 25 368 | 23 172 |

1. **A third tracked page, worth ~5 %.** `xwBl` is now split by reason
   and it is **98.5 % page** (`xwBlPage` 9 517 of 9 665 before the absorb
   change, 9 809 after; `xwBlDepth` is *zero* — nesting levels, miss
   slots and record slots never bind). Each refused call also costs its
   return, and round forty measured that inlining captures 63 % of the
   returns of the calls it takes, so the pair is ~16 000 /Mi; the
   remaining `xwOther` is the same page rule seen from a branch. Two
   routes: `page_addr[]`/`page_next[]` widened to four with a two-bit
   tag (`CODE_GEN_ALIGN` is 16, so the bits are there) and `page_lock_pair`
   generalised; or a side table of (page → TBs with that page as an
   *extra*), consulted by `tb_invalidate_phys_page_range__locked` and
   fed by `tlb_protect_code`, which leaves QEMU's own two-page structures
   alone. The second is smaller and does not touch the page locks.
2. **`xwDefer` (7 391 /Mi) has never been re-measured since inlining.**
   `W64_FTMAX` defaults to 3; round thirty-five's "ft4 collects nothing"
   predates callee inlining, and a conditional branch *inside a callee*
   now forfeits the return as well as the TB. It is a knob — screen it
   first, on a quiet host.
3. `xwBx` at 35 627 /Mi is still the largest single line and § 4 is the
   only idea anyone has had for it that does not need a profile.

### 6. The closed experiments' instruments, deleted

Fifteen knobs went with the questions they answered. The two mechanisms
above are **unconditional** — `W64_PSRCONT` and `W64_ABSCROSS` are gone,
so A/Bing them now means a build, which is the standing rule for a landed
mechanism whose price is known. The four calibration pads (`W64_LDSTPAD`,
`W64_CALLPAD`, `W64_LOCALPAD`, `W64_BYTEPAD`), the five-knob inline-TLB
ceiling family (`W64_TLBDUP`, `W64_TLBCHEAP`, `W64_TLBHIT`, `W64_TLBSIMD`,
`W64_TLBHOIST`, closed in round thirty-eight), `W64_LC2`, the unsound
`W64_NOGENBUMP` and this round's inert `W64_GDUP` went with their
verdicts, which stay in the playbook's REJECTED table and cost model.
`tools/perf/gdupsweep.sh` went too.

Every bisect switch and every live meter was kept — `W64_XCOUNT`,
`W64_XWHY`, `W64_LDSTCOUNT`, `W64_LSMCOUNT`, `W64_TBHIST`, `W64_MODBENCH`,
the `W64_NO*` legs and `W64_LOCKSTEP*`. The line is whether the knob still
answers a question, not whether it is default-off: `W64_NOSVCINL` is the
switch that cleared inlining of round forty's lockstep divergence, and
`W64_INLINE=0` is what priced the boundary in § 1.

`lc2Hit`, `padSink`, `tlbcHit` and `tlbcMiss` now read zero always. The
counter ABI is positional, so **the slots stay** and the enum is still
append-only; the header says so at each one. Gate GREEN 11/11 after the
removal, op suite 1159/1159, lockstep identical at 249 561 088 insns, and
the video meter reads 3.128/3.162 ms/Mi at `hostBusy` 0.08–0.10 — inside
the shipped band, as a deletion of default-off paths should be.

## Update (2026-09-21, round forty: the syscall taken inside the TB, callee inlining, 4 KB pages — video `rt` 1.8 → 2.5, +36 %)

Round thirty-nine left video at `rt` 2.04 with a 2.5× gap to real time on
a phone. This round took the video meter as its only judge and landed
three things: the guest's SVC no longer leaves the TB, a direct call's
callee is translated into the caller's TB, and the guest page is 4 KB.
Every number below is `tools/videobench.mjs` on the same clip and window
(`mi` 1 499.6–1 501.1 on every leg — identical guest work). The host ran
at a 1-minute load of 5–25 all night, so legs are compared at matched
`hostBusy` and the decisive A/Bs are same-binary knob flips. The final
ABBA of the shipped build against round thirty-nine's, run after the
gate: **2.488 / 2.463 against 1.683 / 1.817**; the matched-load pair
(`hostBusy` 0.124 vs 0.128) is 2.463 vs 1.817, **+36 %**, `ms/Mi`
4.40 → 3.25. `scripts/gate.sh keep` is green 11/11 on the shipped build
(boots, keys, native, the op-suite at 1156/1156 and lockstep identical).

### 1. The exception round trip was a fifth of the vCPU, and it is gone (+16.2 %)

A `wprof2` profile of the *playing* clip (the `--hold` mode, then
`PROF_ATTACH`) put **25.4 %** of the vCPU worker in the main module by
URL, and almost all of that on the SVC path: `cpu_exec_loop` 3.3 %,
`tcg_qemu_tb_exec` 1.7 %, `cpsr_write` 1.6 %, `arm_rebuild_hflags` 1.6 %,
`arm_cpu_do_interrupt` 1.5 %, `switch_mode` 1.0 %, the mutex family
(`bql_lock_impl`, `bql_unlock`, `qemu_mutex_*`, `__pthread_mutex_*`)
2.4 %, `take_aarch32_exception` 0.7 %, `helper_cpsr_write_eret` 0.6 %,
`replay_exception` 0.3 %, `arm_get_tb_cpu_state` 0.3 %, `tb_lookup` 0.2 %.
Round thirty-nine's `W64_EXCNS` timer had bracketed one 52 ns piece of a
path that costs several hundred; the profile, unusable as a *price*,
named every piece.

Two patches were built and ABBA'd together (`rt` 2.175 / 2.171 against
1.898 / 1.843 for the round-39 build — **+16.2 %**, arms disjoint); one
of them did not survive the gate:

1. ~~**`helper_cpsr_write_eret` took the BQL twice per exception return
   to walk two hook lists that are empty on any core without a PMU or a
   GICv3 cpuif**, so walk them only when they are not empty.~~
   **Reverted.** The lockstep gate (S75, one instruction per TB) diverged
   at 246 M instructions and the guest exited on an unimplemented
   CAPCOM register; a knob bisect (`W64_NOSVCINL`, and a temporary
   `W64_ERETBQL`) pinned it on this patch alone, with the SVC change
   passing. Those two lock round trips are where the main loop reliably
   gets the BQL back between exceptions, and the lean deferred release
   (`bql_unlock_mmio`) makes the vCPU hold it otherwise; the *determinism*
   of interrupt timing depends on the handoff, not just its cost. The
   profile priced the pair at ~2.4 % of the vCPU; it stays. The lesson
   is round 39's in reverse: a lock whose critical section is empty can
   still be load-bearing as a scheduling point.
2. **The SVC is taken inside the TB that executed it.** `DISAS_SWI` on
   wasm64 now calls `helper_svc_inline` → `arm_take_svc_aarch32()`
   (`target/arm/helper.c`): the `EXCP_SWI` case of
   `arm_cpu_do_interrupt_aarch32` for a core without EL2/EL3 — vector,
   mode switch, `take_aarch32_exception`, hooks under the lean BQL pair
   only if any exist — and the TB continues into the vector through
   `gen_goto_ptr` with a fully dynamic key (`W64_WHY_SVC`). No
   `CPU_INTERRUPT_EXITTB` (there is no dispatcher iteration whose
   jump-patching it would have to stop); a pending interrupt the entry
   may have unmasked is honoured by kicking `icount_decr.u16.high`, which
   ends the next TB at its start exactly as `cpu_interrupt()` does. The
   counters prove the path: `execIter` 2 387 → 28 /Mi, `lookup` (C-side)
   2 687 → 328, `armIrq` 2 363 → 4 (the IRQs), `excSwi` unchanged at
   2 360.

### 2. Callee inlining: a `bl` and its `bx lr` are no longer two TB boundaries

The census said calls (66 363 `xwOther`/Mi) and returns (60 607
`xwBx`/Mi) were 72 % of the 166 834 boundaries, and the absorb notes said
why a call could not be helped: absorbing a `bl` *skips* the return
address, so the return can never come back. The new mechanism
(`target/arm/tcg/translate.c` `w64_inline_call` / `w64_inline_return`,
default `W64_INLINE=4` levels):

- **A direct, unconditional `bl` sets `lr` and translation carries on at
  the callee.** Its `bx lr` becomes `brcond(lr != return address) →
  miss`, and translation resumes at the instruction after the call. The
  miss path, emitted at the TB's end like a deferred taken path, refunds
  the prepaid icount and leaves through an ordinary `bx`. A
  **conditional** `bx lr` is a deferred taken path to the return address
  (after the same compare), which `w64_try_join` binds when the
  unconditional return brings translation there.
- **The callee's page takes the TB's second-page slot.** A TB already
  tracks two pages for a linear crossing; an inlined TB (`w64_inl` in
  `translation-block.h`) uses page 1 for the callee's page instead, keeps
  its own linear range on page 0, and records the *hull* of the callee
  bytes it translated on each page (`w64_inl_lo/hi`). `tb_page_span`
  invalidates by those hulls; `tb_lookup_cmp` verifies the callee page's
  mapping on every hash lookup, with a nonfault probe so an unmapped
  callee page is a mismatch rather than a premature prefetch abort; the
  translator fetches page 1 from `w64_page1_base` instead of the page
  after the entry. Chains *into* such a TB are allowed (refusing them
  would have sent every `goto_tb` entry through the dispatcher) and are
  dropped by `tb_unlink_inlined()` from the two TLB-flush sites, which is
  where a mapping can change — `keyGenPage`/`keyGenFlush` are 0 /Mi at
  steady state. Callees on a third page, in the other instruction set,
  in an IT block, under single-step or an exact-count TB, or whose return
  address is off the current page, are refused (`inlRefuse`, `inlNo*`).
- **The A32 instruction bound follows the stream.**
  `arm_tr_init_disas_context` caps a TB at the instructions left on its
  *entry* page; with callee instructions charged to that cap, 153 of 276
  inlined callees in one window ended on `max_insns`. `w64_inl_rebound`
  re-bounds from the callee's page on a call and from the return address
  on a return, never past the TB's original cap.
- **Absorb rules inside a callee.** Skipped bytes cost nothing there (the
  hull only covers translated instructions), so a forward `b` may go
  anywhere on the callee's page and a backward one anywhere below
  everything translated on it; backward *into* translated code is a loop
  and stays refused.
- **Self-modifying code keeps its semantics, per stream.** ARM is not a
  precise-SMC target: the TB a store just patched runs to completion on
  its old code, and `tests/tcg-isa` pins that ("smc/self"). Inlining
  widened "the TB" to cover `str; bl callee`, and the op-suite's
  `smc/cross_*` tests caught the callee's old bytes running after the
  store. Each inlined callee now leaves a record in the code buffer
  behind the unwind data (`W64InlRec`: its instruction-index range and
  byte hull); when a store hits the TB it is executing, the invalidation
  (`tb-maint.c w64_inl_cross_stream`) asks which stream the store is in
  and which stream owns the patched bytes, and if they differ does what a
  precise-SMC target does: restores to the store and forces it to run
  alone in a one-instruction TB, after which the code is translated from
  the patched bytes. (Resuming *after* the store was the first attempt
  and skipped it: `notdirty_write` unwinds before the store has landed.)
  A stream patching itself keeps the same-TB rule, so `smc/self` still
  passes with its function inlined. `inlSmcResume` counts it.
- **Chains into inlined TBs are dropped from a list, not a walk.** The
  first version walked every TB on each TLB page flush; the lockstep
  boot, which runs one instruction per TB and so has millions of them,
  crawled to a standstill at 246 M instructions. `w64_inl_list_add`
  records the inlined TBs with a second page at link time,
  `tb_unlink_inlined` walks only those, and `tb_flush` clears the list.

The census after inlining alone: boundaries 166 834 → 104 456 /Mi,
`xwBx` 60 607 → 38 075, `xwOther` 66 363 → 17 080 + 12 135 `xwBl`
(calls refused). `W64_INLLOG=1` prints every decision, and the `INL end`
line says why a TB ended inside a callee; that trace is what found the
`max_insns` cap and the conditional returns.

### 3. Two bugs the inlining exposed, and what they say about the port

**`CF_PCREL` is off on wasm64 now.** Under it the unwind data holds a
page *offset* that `restore_state_to_opc` completes from the page
`cpu_R[15]` holds — which cannot name an instruction on a callee's page,
and no delta scheme survives a PC store earlier in the same instruction.
Round 0096 had measured the flag itself as noise (−0.7 %, +2 % lookup
misses) on a firmware that maps its code once; same-binary legs here read
2.055 / 2.065 for off / on. `W64_PCREL=1` restores it, without inlining.

**The clock a device saw must not be un-done.** The first inlining build
hung the boot: the vCPU spun in `rtc_io_read` with virtual time 32 ns
*behind* the RTC's last sync. A ring of RTC syncs with the icount state
gave the mechanism: on wasm a mid-TB device access does not rewind the TB
(`cputlb.c io_clock_window`), it sets `can_do_io` and lets the callback
read a clock that counts the whole TB — accepted as "at most one TB
ahead". A deferred exit then *refunded* the unexecuted instructions,
moving the clock backwards past what the RTC had recorded, and
`rtc_advance` walked 2⁶⁴ ticks. The hazard predates inlining (a device
access followed by a taken deferred branch in one TB), inlining just made
it routine. `w64_refund` now refunds only when `can_do_io` is clear —
the translator clears it before the first instruction and sets it before
the last, so at any deferred exit it means exactly "the clock was
observed in this TB" — and `rtc_sync` clamps a negative interval. Time
runs one TB ahead in that case, which is the deviation the design
already allows; the instruction count stays exact.

**A capture that drops lines looks like a compiler that drops ops.** The
op dump of the hanging TB, read through the page console, was missing
its `goto_ptr` ops; a count in C (`nb_ops`, then a walk of `tcg_ctx->ops`)
found all 14 present. The console forwarder loses lines under a burst.
Count in C before believing a captured listing.

### 4. 4 KB guest pages (`W64_PAGEBITS=12` is now the default)

The firmware maps only 1 MB sections — `fillLarge == tlbFill` in every
window ever measured — so ARMv5's 1 KB tiny-page default buys nothing
and costs every page rule: with inlining on, the dominant reason a callee
ended its TB was a `b` to, or a fall into, its *next* page. The existing
knob (board.c `minimum_page_bits` + cpu.c `pagebits`, sound either way
because a smaller guest page than the target's takes the slow path) now
defaults to 12. Same-binary legs at matched `hostBusy`: 4 KB + inlining
is **18–19 % faster than inlining off**, and 4 KB beats 1 KB by ~8 % with
inlining on. On J2ME (game 1, four legs under a 9–13 host load) it is a
wash within the noise; round 27's "+7 % slower" was never a verdict and
that workload's SMC concern did not materialise.

Census on the shipped configuration, per Mi, against round thirty-nine:

| | round 39 | now |
|---|---|---|
| TB boundaries | 166 834 | **100 080** (−40 %) |
| …`bx`/`blx reg` (returns) | 60 607 | 36 343 |
| …direct branches refusing a chain | 66 363 | 7 391 (+ 9 665 refused `bl`) |
| …`goto_tb` chains | 22 490 | 25 368 |
| `lookup` (helper) | 2 683 | 61 |
| `execIter` | 2 387 | 28 |
| `tlbFill` | 1.12 | 0.27 |
| `slowMiss` | 29.6 | 19.8 |
| guest insns per TB entry | 6.0 | 10.0 |

### What is left, ranked

1. **36 343 returns per Mi still exit.** `W64_INLLOG` + the boot/playback
   trace (`--log "INL "`) names the callees that never return in-TB. The
   remaining reasons are the nested `bl` past `W64_INLINE` levels, tail
   calls (`b` to another page), syscall stubs (`svc` ends the TB by
   nature), and `bx rN` indirect calls. A **third tracked page** would
   lift the "one callee page" rule; it touches `page_addr[]`,
   `tb_link_page`, the page locks and `PAGE_FOR_EACH_TB`.
2. **`msr cpsr_c` (8 900 /Mi) now ends inlined callees**, not just TBs.
   Continuing past it under a runtime hflags/thumb compare is the deferred
   machinery again (round 28 priced it at 1.2 % as an exit; inside a
   callee it also forfeits the return).
3. The C third is now under 10 % of the vCPU; everything else is the
   emitted code and its boundaries.

## Update (2026-09-20, round thirty-nine: a meter for video playback, and the exception plumbing it found — +4.9 %)

The user's report: **on an Android phone the SL65 plays video below real
time.** No meter covered that workload, so this round built one
(`tools/videobench.mjs`) and then optimised against it.

**The workload, measured.** `SL65v49lg1_TIM.bin`, Menu ▸ `8` (My stuff)
▸ Videos ▸ `Berlin.3gp` (370 KB, ~26 virtual s, 15 fps). A 12-virtual-second
window inside the steady decode, uncapped:

| | |
|---|---|
| `rt` (virtual s per wall s) | **1.94** on this desktop — so ~0.39 on a phone at the usual ÷5 |
| `duty` | **1.000** — the player *never* idles; it wants a whole 125 MHz SL65 for the whole clip |
| `ms/Mi` | 4.12 — 2.7× cheaper per guest instruction than J2ME's 11.3 |
| `excSwi` | **2 360 /Mi** — one guest syscall every 424 instructions, 2–5× the J2ME rate |
| `hflagsCalls` | 5 936 /Mi (2.51 per exception, the constant ratio § round 30 found) |
| `lookup` | 2 683 /Mi — *6× fewer* TB lookups per Mi than J2ME |
| `halt` | 0 |

Two things follow and they set the whole round's direction. `duty` = 1.0
means there is no idle to warp over, so `rt` is the honest number and
nothing but engine speed can move it. And the workload is the *inverse*
of J2ME: far cheaper straight-line code, far more syscalls — so the
per-exception fixed costs, which are ~1 % on a game, are worth several
here, while the dispatch levers that dominate J2ME are worth much less.

**Two patches, both in the syscall plumbing, ABBA-measured together:
`rt` 1.942 → 2.038, +4.9 %** (legs 1.968/1.916 vs 2.019/2.056 — the arms
do not overlap; `mi` 1 499.3–1 501.1 across all four, so the guest work
is identical to 0.12 %).

1. **`cpu_handle_interrupt()` takes `CPU_INTERRUPT_EXITTB` without the
   BQL.** Every guest exception leaves that bit set
   (`arm_cpu_do_interrupt`), and the next loop iteration spent a full
   `bql_lock`/`bql_unlock` pair plus a `cpu_exec_interrupt()` call —
   which, with no other bit pending, can only return false — to clear
   it. The fast path clears it with the same atomic-and and nulls
   `last_tb`. `exittbFast` = **2 360.4 /Mi against 2 360.7 `excSwi`**:
   it fires on every exception and on nothing else.
2. **The exception dispatch uses the lean BQL pair** (`bql_lock_mmio`/
   `bql_unlock_mmio`, cputlb.c's), so a run of syscalls with nobody
   contending costs a thread-local read each instead of a pthread mutex
   round trip. Bounded exactly as the MMIO use is — `cpu_exec_loop`
   gives the lock back on its next iteration when `bql_wanted_by_other()`.

**Pricing that was wrong before this round, in both directions.**
`W64_EXCNS=1` on *this* workload says `arm_cpu_do_interrupt` is **52.3 ns**
net of the 75.1 ns clock read and the BQL pair inside it is under the
instrument's floor — together 1.7 % of wall, not the ~9.5 % that carrying
round 30's 172 ns forward would have predicted. The 4.9 % that the two
patches actually bought is therefore mostly **the second BQL round trip,
in `cpu_handle_interrupt`, which no instrument was watching at all**.
The profile's mutex cluster (5.4 % of vCPU self time) pointed at the
right neighbourhood while being unusable as a price, exactly as
[lessons.md](lessons.md) says.

**The exit and memory census of this workload** (`W64_XCOUNT=1`,
`W64_XWHY=1`, `W64_LDSTCOUNT=2`, `W64_LSMCOUNT=1`, `W64_TLBHIT=1` — all
in-generated-code counters, so the per-Mi rates are exact and those legs'
wall times are not comparable):

| per Mi | | |
|---|---|---|
| TB exits, total | **166 834** | **6.0 guest instructions per TB entry** (J2ME: 8.4) |
| …`goto_ptr` | 144 344 | 86.5 % of exits, but only **300** reach the lookup helper — the inline cache answers 99.8 % |
| …of those, `bx`/`blx reg` | 60 607 (42 %) | a call-heavy decoder: returns are the boundary |
| …`msr cpsr` | 8 902 (6.2 %) | 3.8 per guest exception |
| executed memops | **533 989** | 0.53 per guest instruction |
| …from `ldm`/`stm` | 279 892 (52.4 %) | in only **74 331** instructions — 3.8 registers each |
| per-site page-cache hit rate | **93.1 %** | `tlbcHit` 497 390 / `tlbcMiss` 36 600 |

**Ranked next steps for this workload**, none built:

1. **One address translation per `ldm`/`stm`, not per register.** 205 561
   of the 533 989 memops per Mi (38.5 %) are the second and later
   registers of a multi-register transfer, each paying its own inline TLB
   probe and address add. This is *not* the TLB mask/table hoist round
   thirty-eight closed — that one had to survive calls and branches and
   died on a wild pointer; this stays inside one guest instruction. Price
   it by re-running that round's `W64_TLBHOIST=N` ceiling probe **on this
   workload** and multiplying by 0.385.
2. **The cheaper inline TLB check** (`W64_TLBCHEAP`, two loads to the
   addend instead of four, priced at 2.3 % on EL71) needs a site to keep
   hitting the same guest page, and here it does **93.1 %** of the time —
   the highest hit rate measured on any workload so far.
3. **The TB boundary**, which at 6.0 instructions per entry is the
   largest single thing in the budget and the subject of rounds 26–38.
   Nothing new is offered here except the rate.

**A third patch was built, validated and then reverted: memoising
`arm_rebuild_hflags`.** A 16-entry memo indexed by CPSR mode (one entry
misses on every syscall — the rebuilds alternate between SVC and the
caller's mode), keyed on SCTLR_EL1 plus four CPSR bits, which is the
*complete* input set of the pre-v6 short path. It worked exactly as
designed: **100.00 % hit rate** on 5 937 calls/Mi, and a
`-DHFLAGS_FAST_VERIFY` build that computes the generic answer as well
counted **`hflagsBad` = 0 over 8 907 736 rebuilds**. It is still not
shippable, because it does not move the meter: over eight windows the
verdict is **−1.2 %**, over the four that ran on a quiet host
(`hostBusy` ≤ 0.08) it is **+0.8 %**, i.e. nothing. The verify build is
also a free ceiling probe for the whole idea — it adds a full *generic*
rebuild to all 5 937 calls/Mi and costs ~6 %, so the short path it
replaces is worth well under 1 % and the memo can only recover part of
that. **The pre-v6 hflags short path is already cheap enough; the
`hflagsCalls` rate is not a lever.** Do not re-derive this from the call
rate alone — 5 936 calls/Mi at round 30's "31.6 ns" reads as 4.4 % of
wall, and that multiplication is what sent this round down the path.

## Update (2026-09-17, round thirty-eight: two levers measured and both closed — the TLB hoist and branchless predication)

No code shipped this round. Two items that had stood open on estimates
were measured, and the measurements closed both. The round's product is
nine counters, two verdicts and one fixed meter.

### The TLB mask/table hoist: ceiling +2.6 %, realizable ~1.7 %, and a wild pointer to pay for it

`W64_TLBHOIST=N` duplicates exactly the two `i64.load`s the hoist would
delete — `fast->mask` and `fast->table` — N−1 times per memop, and
nothing else, so the slope over N is the cost of one mask/table pair per
executed memop. Sixteen legs, four levels, four repeats, a full Latin
square (`1234`/`2341`/`3412`/`4123`) on game 5.

The pooled fit reads **+0.133 ms/Mi per pair, +3.34 % of wall**, but do
not use that number: the per-repeat slopes are +0.094, +0.077, +0.098 and
+0.263, a 3.4× spread, and `ms/Mi` correlates with `hostBusy` at
**r=+0.730** (+4.99 ms/Mi per unit). Dropping the legs that ran under
host load tightens it and raises the fit quality, which is the signature
of noise removed rather than data selected:

| kept | n | slope ms/Mi per pair | r | ceiling |
|---|---|---|---|---|
| all | 16 | +0.1331 | +0.651 | +3.34 % |
| hostBusy < 0.20 | 15 | +0.1116 | +0.588 | +2.79 % |
| hostBusy < 0.16 | 12 | +0.1026 | +0.812 | **+2.61 %** |
| hostBusy < 0.15 | 10 | +0.1038 | +0.820 | +2.64 % |

So one mask/table pair per memop is **+2.6 % of wall**. That is the
ceiling for deleting it on *every* memop, which no real hoist does — a
cached pair has to be dropped at every call, label and branch, so only a
memop that follows another memop with nothing between can use it.

`WASM_DIAG_LDST_RUN` now counts exactly that, at translation time:
**`ldstRun` 3.527 of `ldstGen` 5.325 = 66.2 %**. The realizable figure is
therefore **2.6 % × 0.662 ≈ 1.7 % of wall**, *before* subtracting the
reloads the scheme itself must emit at each of those barriers and on
slow-path return.

**Verdict: do not build it.** 1.7 % gross is inside the run-to-run band
this rig has just demonstrated (the same sixteen legs spread 3.4× on host
load alone), and the failure mode is not a slow path:
`tlb_mmu_resize_locked` does `g_free(fast->table)` and then
`fast->table = g_try_new(...)`, so any helper that flushes — an ARM `MSR`
to `TTBR` or `SCTLR`, among others — frees the cached pointer inside the
very TB holding it. A stale `table` is a wild store.

This also settles the **`v128.load` fusion** item below it. That item was
costed at ~3.1 % when most of the sum was the *bound checks* on the two
loads, and it said so: *"It is a substitute for part of the wasm32 item,
not a complement… build this only if wasm32 does not land."* wasm32
landed in round thirty-six. What remains is the load count, and this
round measures load count directly: by level, the mean ms/Mi is 3.957 /
4.187 / 4.184 / 4.402 — the second duplicated pair costs **−0.004**.
Adding memory operations to this path is nearly free after the first, so
removing one is worth nearly nothing, which is the same finding round 23
reported as *"its cost is not its load count, and SIMD lane extraction is
expensive."* Both items are closed by one sweep.

### Branchless A32 predication: the predicated stream is 61 % branches, so there is nothing to convert

`gsyncBbend` was the largest single sync demand and nobody knew how much
of it was predication, because BBEND is charged at every label and every
`br` alike. `WASM_DIAG_GSYNC_BBCOND` splits it: a `TCGLabel` gains a
`w64_condskip` bit, `arm_gen_condlabel` sets it, and liveness charges
BBCOND instead of BBEND at that label.

Predication is **33.3 % of all label/br blame** (2.442 of 7.328 per Mi) —
a third, which is what made the lever look worth building. The reason it
is not is the composition, which `w64_pred_count` now buckets by encoding
class:

| class | per Mi | share of predicated |
|---|---|---|
| `predBr` (B/BL) | 0.779 | **61.4 %** |
| `predLdst` | 0.221 | 17.4 % |
| `predDpNos` | 0.212 | 16.7 % |
| `predOther` | 0.027 | 2.1 % |
| `predDpS` | 0.020 | 1.6 % |
| `predLsm` | 0.011 | 0.9 % |

A predicated **branch** cannot be turned into a select, and neither can a
predicated **load or store** — the false case must not fault. Together
that is 78.8 % of the predicated stream, out of reach for good. The
selectable part is `predDpNos` at 16.7 % (`predSel`, the narrow filter,
agrees at 16.1 %), and widening to flag-setting data processing adds
1.6 %. So if-conversion reaches **~2.0 % of the global-traffic row**, not
of wall.

**Verdict: closed.** And the reason generalizes past this workload: a
J2ME bytecode interpreter's hot loop is dispatch, so its predicated
instructions are overwhelmingly conditional branches. The earlier reading
that this lever was "small" was right, but for the wrong reason — it
counted predicated instructions, when the thing that makes it small is
*which* predicated instructions they are.

### The guest-register row is now the only unmeasured item, and the probe for it is built

Confirmed again on this build: **`tcgGst` 11.829 + `tcgGld` 9.184 against
`tbIcount` 10.543 = 1.99 memory operations per translated guest
instruction.** The demand split, with BBCOND separated out:

| site | per Mi | share |
|---|---|---|
| `gsyncExit` | 5.811 | 37.6 % |
| `gsyncBbend` | 4.886 | 31.6 % |
| `gsyncBbcond` | 2.442 | 15.8 % |
| `gsyncSe` | 2.215 | 14.3 % |
| `gsyncCbr` | 0.113 | 0.7 % |
| `gsyncCall` | 0.005 | 0.0 % |

`gsyncExit` is structural — round 0106 established that TBs hand off
through env memory, so there is no sync to remove at an exit, only fewer
exits. `gsyncSe` is required before anything that can fault. What is
left is BBEND+BBCOND at **47.4 %**, and this round has just shown that
the predication third of it is not reachable by if-conversion.

`W64_GDUP=N` is built and unmeasured: it emits N−1 extra copies of every
global load (`temp_load`) and every global write-back (`temp_sync`), so
the slope is the cost of one whole round of guest-register traffic — the
ceiling for pinning globals to TB-lifetime wasm locals, which this
backend can do and a register-poor native backend cannot.
`tools/perf/gdupsweep.sh` and `tools/perf/gdupan.py` are written and not
run. **Check the emitted-byte count, not just the clock**: the probe
relies on V8's baseline tier doing no store-to-store or load-to-load
elimination, so a zero slope must be read as "the probe is inert" until
`tbBytes/Mi` proves the wasm grew.

Note what the register file is *not*. `tcgSpill` reads 0 over a whole
boot at 13 allocatable registers, and round 0114b *halved* the file
(32→16) for +2.05 % because every TCG register costs two declared wasm
locals and the baseline tier zeroes all of them at every TB entry. This
row is not spill traffic and more registers would make it worse, not
better.

### Also in this round

**`irecBytes` was a gauge in a counter slot.** It was assigned
`w64_irec_bytes`, a *live* total, while the harness differences
consecutive samples — so dropping a record produced a negative rate
(−219.2/Mi on game 1, −628.1/Mi on game 2). It is now cumulative bytes
recorded, with `WASM_DIAG_IREC_FREED` counting bytes released, so both
are monotonic and live is `irecBytes − irecFreed`. Reads 1056.3 and
579.7 per Mi. The general trap: **a value that can go down cannot share
a slot with values that only go up**, and the harness cannot tell them
apart.

**Two micro-optimizations checked and found already done.** Env-relative
access does not materialize an address — `w64_load`/`w64_store` already
use the wasm memarg offset for any `ofs` in `[0, 0xffffffff]`, so global
traffic can only be reduced by removing syncs, never by cheapening them.
And `la_why`/`la_charge` cannot attribute a BBEND-only duplication probe:
the blame array is written during *liveness* and holds one value per
global for the whole TB by codegen time, so a codegen-time store cannot
be traced back to the site that demanded it. That is why the row is
priced whole by `W64_GDUP` and split by demand share afterwards.

## Update (2026-09-17, round thirty-seven: the SMC scan stops walking the TB list — +5.5 % across the catalogue, +15.5 % on the CPU-bound title)

A J2ME game keeps its interpreter's data on the same 1 KB guest pages as
translated code, so nearly every guest store lands on a page the SMC
machinery is watching. `notdirty_write` runs ~130–550 times per Mi
depending on title, and each call walked the page's whole TB list —
`PAGE_FOR_EACH_TB` ignores its own `start`/`last` arguments and visits
every TB on the page — to ask a question that is almost always "no".
The chain is 5.8 to 67 TBs long depending on title.

### The result

| title | chain (off) | mask hit | speedup |
|---|---|---|---|
| 1 | 11.1 / 12.9 | 99.6 / 99.4 % | **+2.61 %** |
| 2 | 11.3 / 13.1 | 98.6 / 99.1 % | **+3.95 %** |
| 3 | 6.5 / 5.8 | 86.3 / 95.2 % | **+3.43 %** |
| 4 | 23.6 / 18.7 | 99.4 / 98.6 % | **+1.92 %** |
| 5 | 43.9 / 67.3 | 99.8 / 99.9 % | **+15.47 %** |

**Catalogue-wide: +5.47 % ± 6.24 (sd), n = 10 pairs, se 1.97 %** — every
title positive, 8 of 10 individual pairs positive, and the two negatives
(−1.6 %, −2.5 %) are both low-dose legs where the effect is smaller than
one leg's noise. **Game 5 alone, on six counterbalanced pairs: +6.50 % ±
2.54 (sd), se 1.04 %, all six pairs positive**, t ≈ 6.3. The catalogue
number is larger than the game-5 A/B's because the two repeats caught
game 5 on a longer chain (67.3 against 43.9).

### The mechanism

`PageDesc` gains a 256-bit `code_mask` under `CONFIG_TCG_WASM64`: one bit
per granule of the page, set when a TB is linked and cleared wholesale
when the page empties. A store whose granules are all clear cannot
overlap any TB, so the walk is skipped. Bits are only ever added, so the
mask is a conservative superset — **a stale bit costs a walk, never
correctness**.

**The granule size is the whole round.** At `TB_GMASK_BITS_LOG 6` (64
granules, 16 bytes on a 1 KB page) the mask hit only 45.8–57.4 % of
stores, because a data word shares a granule with nearby code; the A/B
came back **+0.97 % ± 4.61 %**, useless. At `TB_GMASK_BITS_LOG 8` a
granule is 4 bytes — exactly one ARM instruction — and only a store
landing in the same word as real code can false-hit. Hit rate went to
86–99.9 % and the game-5 walk collapsed from **24,453 to 1.4–4.5 steps
per Mi**.

### The evidence that it is causal and not drift

Regressing the gain on the walk steps actually removed, across all ten
(repeat, title) pairs: **16.88 ns per removed list step, r = +0.739**.
Within game 5's six pairs it is 9.46 ns/step, r = +0.875. The two
highest-dose legs (21.0 k and 32.2 k steps/Mi removed) produce the two
largest gains (+0.53 and +0.62 ms/Mi), and the ordering holds down the
range until the dose falls below ~3 k steps/Mi, where the effect is
under the per-leg noise. A dose-response across five titles with
different chain lengths is much harder to fake than a paired mean.

### Two design mistakes this round had to undo

**The A/B knob did not disable the whole mechanism.** `W64_NOSMCMASK`
first gated only the early-out, leaving the per-step mask rebuild and a
32-byte `memcpy` in *both* legs — so the OFF leg was slower than upstream
and the comparison flattered the change. The rebuild existed to narrow
the mask when one TB of several went away; measurement killed it, because
**stores outrun TB removals 5500:1 on this workload**. There is nothing to
narrow, and the obvious place to narrow it — the walk — is the path being
optimised. `tb_page_covers`'s loop body is now upstream's plus a counter.

**An observational slope invented a price.** Round 1's off legs regressed
at 23.43 ns/step, r = 0.861, putting "the whole walk" at 14.4 % of wall —
which agreed almost exactly with the profiler's 14.7 % for
`tb_invalidate_phys_range_fast`, and that agreement is what made it
persuasive. Six more baseline runs moved it to +3.99 ns/step, r = +0.297,
passing through **−13.57 ns/step, r = −0.644** on the way. Both lessons
are written up in [lessons.md](lessons.md).

### Also in this round

`notdirty_write` no longer calls `physical_memory_is_clean()`.
`is_clean(addr)` is `!(vga && code && migration)` and the line above it
has just set VGA and migration, so its answer is the CODE bit — which the
function already read at the top, and which the scan only disturbs when it
reports that it went the long way. The call cost three more out-of-line
dirty-bitmap probes, each an RCU guard and a `find_next_bit`, to recompute
a value already in hand. `tb_invalidate_phys_range_fast` now returns
whether it may have lifted the page's protection so the caller knows when
to re-read.

**This one is reasoned, not measured, and should be read that way.** At
~480 calls per Mi and ~15–20 ns per removed probe it is worth roughly
**0.5 % of wall** — below the ±1 % this harness resolves, so an A/B of it
would return a tie whether or not it worked. It ships because it is a
strict reduction in work with a case-by-case equivalence argument
(`code_dirty` true at the top; `p == NULL`; the mask early-out; the long
path), not because a number was produced for it. `W64_NOCLEANREUSE=1`
restores the original call, and the restored leg is byte-for-byte
upstream's work rather than upstream's plus a probe.

## Update (2026-09-17, round thirty-six: the memory model, built and measured — +19 % on J2ME)

Round thirty-five priced the wasm bound check at 24.5 % of wall and
identified `-sMEMORY64=2` as the shippable way to remove it. This round
built it and measured it on the workload it was meant for.

### The result

Against `CX70_FW56_clean.bin`, two games, three interleaved repeats,
30 s windows under icount (`tools/perf/mem32ab2.sh`, analysis
`tools/perf/mem32an.py`):

| metric | delta | se | pairs |
|---|---|---|---|
| MIPS/cpu | **+19.16 %** | 2.47 % | 5 |
| ms/Mi | **−15.92 %** | 1.78 % | 5 |

In absolute terms 4.238 → 3.561 ns per guest ARM instruction. This is
the largest single win in the workstream, and `tools/bcprobe.mjs`
forecast it (15–19 % of wall) from a microbenchmark before the build
existed — the first time a forecast in this tree has been made and then
confirmed rather than reconstructed afterwards.

**Three independent confirmations that both arms ran the same guest**,
which is what makes the number a comparison rather than a coincidence:
`mi` flat to 0.01–0.03 % across every leg (under icount the window is a
fixed span of the guest's clock, so retired instructions are a property
of the guest alone); every guest-paced counter flat (`execIter` −0.37 %,
`excSwi` −0.36 %, `armIrq` −0.35 %, `hflagsCalls` −0.34 %, and all 24
device counters identical); and the host-paced counter cluster, inverted,
independently implying +17–19 % from counts rather than from any clock.

**One pair excluded, on stated grounds.** r3/g2's *baseline* read 155.9
MIPS against 230–233 in the other repeats — a 33 % move in the control.
`mi` was normal, so it was not a different workload; `hostBusy` 0.267
against a 0.116 median, with load climbing 6.15 → 9.07 during the window,
says the host was busy. Left in it manufactures +76.7 % for that pair and
drags the estimate to +28.76 % ± 9.81. The screen is in the analysis
script (drop a pair if either arm exceeds 2× the median `hostBusy`) and
prints both figures, so the exclusion is auditable rather than tidy.

### What it took to build, which was the hard part

Three plumbing facts, each of which silently produced a wrong build first:

- **`--extra-cflags` never reaches a compile line.** meson is given two
  cross files and the later one's `[built-in options] c_args` *replaces*
  the earlier list, so `-O3 -DWASM_BIGINT -sMEMORY64=…` were all being
  discarded. `CPU_CFLAGS` survives only because `configure:1887` writes it
  into `[binaries] c`, the compiler's own argv. `-DW64_MEM32` therefore
  goes in `CPU_CFLAGS` (`qemu/configure:489`), keyed off the same
  `--wasm64-32bit-address-limit` that selects `-sMEMORY64=2` — the define
  and the memory mode cannot drift apart, and out of step every JIT module
  fails to instantiate (`cannot import i32 memory as i64`).
- **The variants must compose.** `W64_MEM32` and `W64_O3` now build
  `build/qemu-wasm64-mem32-o3` → `site/dist-jit-mem32-o3`, because once a
  knob is winning the next experiment has to be priced on top of it, not
  against a memory model nobody intends to ship.
- **Non-default builds must not touch shared artifacts.** The
  `boards.tar` / `siemens-recalc.wasm` guards key on the variant being
  empty; they previously keyed on `W64_MEM32`, so a `W64_O3` build would
  have rebuilt them underneath a running benchmark.

### Two instruments were lying, and both are fixed

- The analysis script compared five **host-paced** counters under the
  heading "should be unchanged" and they read −25 % to −32 %, which looks
  exactly like the two arms having translated different code. They had
  not: per-Mi normalisation only removes the arm's speed from a counter
  the *guest* causes. See lessons.md, "Per-Mi does not make a host-paced
  counter guest-relative". `tools/perf/ctrdiff.py` now diffs every counter
  paired, with each one's within-arm spread beside it.
- **The gate's `opsuite` job ignored `--dist`.** It hard-wired
  `dist-jit`, so `gate.sh --dist dist-jit-mem32` passed that dist to all
  ten other jobs and then reported the op-suite PASS for a binary nobody
  had built — the instrument that compares wasm64 codegen against native
  instruction-by-instruction, which is precisely what a change to emitted
  addressing threatens. `run-tcg-isa.sh` now honours `TCGISA_DIST` and
  `gate.sh` passes it.

### The open question this round creates

mem32 collected **two-thirds** of the bound check, not all of it:
0.677 ns of the 1.02 ns that `--no-wasm-bounds-checks` removes. The
intervals do not overlap (−15.92 ± 1.78 against −24.51 ± 1.53), so
roughly **8.6 % of wall is still being spent on something the V8 flag
removes and a wasm32 memory does not.** The bcprobe forecast covered only
guest loads and stores, which is consistent with it having been accurate
about its own kernel and silent about the rest.

Three candidates, in order of how much they would explain:

1. **Indirect-call / table bounds checks.** Every TB exit dispatches
   through a growing function table, and `goto_ptr` is 67.7 % of exits at
   55,385 exits/Mi. A wasm32 *memory* does nothing for a table check;
   `--no-wasm-bounds-checks` removes both.
2. **The wrap instructions mem32 itself must emit.** `-DW64_MEM32` makes
   the backend narrow each address it emits — work the nobc arm never
   pays, so part of the gap is mem32's own cost, not residue.
3. Checks on accesses that survive Binaryen's lowering.

**This is cheap to settle and should be the next measurement**: run the
`nobc` arm *against dist-jit-mem32* rather than against the old baseline.
It is a browser flag, so it needs no rebuild. If nobc still buys ~8.6 %
on top of mem32, candidate 1 is real and is worth a round of its own; if
it buys nothing, the gap is candidate 2 and mem32 is already at its
ceiling.

#### Answered, same day: there is no residue, and the question was malformed

Six paired legs (3 repeats x 2 games, same binary, `CHROME_ARGS=--js-flags=
--no-wasm-bounds-checks` as the only difference):

| meter | nobc on top of mem32 |
|---|---|
| ms/Mi | **+5.73 % +/- 6.30** — NOT resolved |
| MIPS/cpu | **-3.59 % +/- 5.11** — NOT resolved |

No pair tripped the hostBusy screen (0.126-0.270 against a 0.380
threshold), and the guest-paced counters agree to 0.4 %, so both arms ran
the same guest on a quiet host. **The flag buys nothing once the memory is
a wasm32 memory.** Candidate 1 is dead: the table check on the indirect
call is not a measurable cost here.

The 8.6 % was never real. It came from subtracting two experiments that
were not comparable — round 35's nobc was 4 single-game legs against the
mem64 build, round 36's mem32 was 6 paired two-game legs — and an interval
subtraction is only meaningful when both intervals describe the same
measurement. Stop deriving a third number from two experiments of
different shape; measure the third number.

The variance carries the confirmation. The nobc arm's legs spread 204-291
MIPS (43 %) against plain's 232-280 (21 %): **the same binary is noisier
with the flag than two different binaries were against each other.** That
is what a flag with no mean effect looks like when it still perturbs
codegen — and it retro-explains round 35's tight -24.51 % +/- 1.53. On
mem64 the flag removed explicit checks on every memory access, a large and
consistent win; on mem32 there are no explicit checks left to remove.
**mem32 collected the bound check, all of it, and is at its ceiling.**

Corollary for future ceiling probes: `--no-wasm-bounds-checks` is now a
spent instrument on this workload. It cannot resolve anything smaller than
~10 % on the current build, because its own variance is that large.

#### And `-O3` is rejected, on the tightest A/B this project has run

The build script has asked for `-O3` since it was written and has never
got it: qemu's configure pins meson's `optimization=2`, and the `-O3` in
`--extra-cflags` lands in a cross file that `emscripten.txt` replaces
wholesale. `build/qemu-wasm64/build.ninja` carries **2240 `-O2` and zero
`-O3`**. Setting `-Doptimization=3` on the meson configure line — the one
route a later cross file cannot override — inverts that exactly: **2240
`-O3`, zero `-O2`.**

| meter | -O3 vs -O2, both mem32 |
|---|---|
| ms/Mi | **+1.22 % +/- 0.72** — NOT resolved |
| MIPS/cpu | **-1.17 % +/- 0.71** — NOT resolved |

Five of six pairs negative. hostBusy 0.112-0.146 with no pair dropped, and
the guest-paced counters agree to **0.01 %** — the arms ran the same guest
to mechanism-meter precision, so this null is a well-powered one, not a
noisy tie. **Keep `-O2`.** `-O3` costs build time and binary size and
returns nothing, which is what a hot path made of JIT-emitted code the C
compiler never sees should do.

Do not re-run this experiment without a reason: at se 0.7 % it is already
about as well resolved as this host allows, and the answer was flat.

A note on `slowMiss`: it moved -5.61 % here and +3.96 % on the nobc probe
while every other guest-paced counter stayed inside 0.5 %, and its
baseline wandered 55.6-58.9 across experiments independently of the arm.
It is a low-count, timing-sensitive counter, not a mechanism. Do not read
a slowMiss delta as a result.

## Update (2026-09-17, round thirty-five: the wasm memory bound check is 24.5 % of wall, and the memory model is a build flag)

**Status: the sweep finished at 24 legs and this section's numbers have
been superseded twice.** The single-round numbers first written here were
replaced by within-round ratios over the clean legs (`tools/perf/
ratios.py`), and those in turn by a Latin-square fit over all 24 legs
(`tools/perf/square.py`) once the sweep was found to carry a position
effect that ratios cannot see. **The figures below are the ratio-stage
ones; § Open items 1 has the final table.** The `nobc` row barely moved
between the two (−24.51 → −25.29 %) but the fold-through rows did not
survive, so read nothing small from this section.

### The bound check, priced for the first time in thirty-five rounds

The `nobc` arm (`--js-flags=--no-wasm-bounds-checks`) came in at
**−24.51 % ± 1.53** against its own round's baseline, averaged over the
clean rounds (it read −26.0 % in round 1 alone, which is what this
section said first; the 24-leg fit later put it at −25.29 % ± 1.79).
That is ~1.02 ns of the 4.151 ns each guest ARM
instruction costs — roughly three host cycles per guest instruction spent
proving that wasm memory accesses are in range.

This had never been measured. It was never even *suspected*, because the
arm's own comment in the sweep script says "V8 says
`--wasm-memory64-trap-handling` defaults *on*, so the checks may already
be free". They are not free, and the measurement says why they cannot
be: if trap handlers were serving this memory there would be no explicit
checks for the flag to remove, and removing them would have changed
nothing.

Three things make this cost large here rather than incidental:

- Every `CPUState` access is one. Register write-back alone is ~1.33 env
  memory operations per guest instruction (below).
- Every guest load and store is **four**, not one: the inline TLB probe
  is three loads (mask, table, comparator) before the data access itself.
- It is not additive with the existing budget — it is *inside* it. The
  ~13.6 % boundary row, the 5.07 % TLB probe row and the 15.8 % TB-entry
  row (below) each already contain their own share of this 24.5 %.

### It is not a V8 flag, it is the memory type — and the build already has a switch

A browser flag cannot ship, so the only question that matters is whether
a property of *the module* removes the checks. It is the memory's type.
A wasm32 memory is indexed by i32, so an engine bounds it with a guard
region and the check costs no instructions; a wasm64 memory is indexed by
i64, which no guard region can cover, so the check is a real compare and
branch. This emulator's memory is 2 GiB — it has never needed a 64-bit
address space at all, only 64-bit *pointers*.

emscripten separates exactly those two things, and QEMU's configure
already exposes it:

- `-sMEMORY64=2` — "wasm64 for clang/lld but lowered to wasm32 in
  Binaryen (such that it can run on wasm32 engines, while internally
  using i64 pointers)" (`emsdk/upstream/emscripten/src/settings.js:246`).
- `configure --wasm64-32bit-address-limit` sets it
  (`qemu/configure:246`, propagated at `:490`). The build scripts pass
  `-sMEMORY64=1` and have never used it.

The catch is that this project emits its own wasm at run time, and those
TB modules import the main module's memory, so the memory's type has to
agree on both sides. That is two concrete changes:

- `tcg/wasm64/tcg-target.c.inc:3674` — the import's limits byte, `0x07`
  (`64-bit | shared | max`) becomes `0x03`. `W64_MEM_PAGES` is 32768,
  well inside wasm32's 65536-page ceiling.
- Every emitted access needs an i32 address operand: an `i32.wrap_i64`
  before each of the 39 `w64_memarg` sites, or i32 address locals. A
  wrap is one ALU op in place of a compare and a branch.

`tools/bcprobe.mjs` was written to decide this before anything is built.
It hand-assembles four otherwise-identical modules crossing i64/i32
against shared/unshared and times an access pattern the optimiser cannot
bound (the base is re-loaded from memory each iteration, which is also
the shape a TLB probe actually has — a constant mask would let V8 prove
the range and delete the very thing being measured). It validates itself:
re-run under `--no-wasm-bounds-checks` and the i64 leg must fall to the
i32 leg, or the kernel is not exposing a check and its numbers are void.
The unshared arm is there because sharing, not width, is the other
candidate for disqualifying the trap-handler path.

### Larger guest pages are a loss, with a mechanism

`pg12` (`W64_PAGEBITS=12`, 4 KB guest pages instead of ARM's 1 KB
default) is **+7.0 %** — slower, not faster, and the counters say why
rather than leaving it a mystery: `lookup` 963 → 1141, `lookupConfl`
495 → 676, `lcFill` 461 → 637, `smcMiss` 204 → 219, `tbGen` 1.295 →
1.369. Bigger pages put code and data on the same page, so a guest write
invalidates four times as much translated code and the retranslation
shows up in every one of those counters. The lever is dead, not neutral,
and the soundness argument at `target/arm/cpu.c:2166-2185` was never the
thing standing in its way.

### Fold-through does *not* have a resolved optimum — do not land `ft4`

**This section previously said `ft4` was −2.85 % ± 0.88 and ready to
land. Rounds 3 and 4 of the sweep withdrew that.** Over all 24 legs the
estimate is **−2.09 % ± 1.81**, 95 % [−5.6, +1.5]; over the 21 legs with
the k3 burst held out it is **−0.64 % ± 1.61**. It does not clear zero in
either, and `ft6` (−2.34 % ± 1.84 / −1.05 % ± 1.62) is statistically
indistinguishable from it, so there is no turnover to site an optimum on.
The one-character default change is **not supported by the data** and
must not be committed.

What changed is not the arrival of a bad leg — it is that the analysis
was wrong for the design. `ratios.py` divides each leg by its own round's
base, which removes the round effect and nothing else. The sweep also has
a **position** effect, and it is real:

```
pos:slope   +0.87 % ± 0.32 per position   (24 legs, 95 % [+0.22, +1.53])
```

Legs run later in a round are slower, by about 0.9 % per slot, and an
F-test on curvature (F = 0.26 on 4 and 10 df, p = 0.90) says the drift is
linear — one slope, not five dummies. `ftsweep2.sh` rotates the arm order
by one each round, so the six arms trace four rows of a cyclic 6×6 Latin
square; four rows do not cover six positions evenly, `ft6` averages
position 2.5 against `base`'s 4.0, and a monotone position trend
therefore lands on the arm and imitates an effect. That is the same
failure `ratios.py` was written to fix one level up, reappearing one
level down.

`tools/perf/square.py` fits the square properly — arm + round + position
on `log(ms/Mi)`, 14 parameters against 24 legs, 10 residual df, standard
errors from (X′X)⁻¹ and F-tests by pure-Python incomplete beta (no numpy
on this host). With position as one linear trend (14 df):

| arm | effect | ± | 95 % | resolved |
|---|---|---|---|---|
| `nobc` | **−25.29 %** | 1.79 | [−27.9, −22.6] | **yes** |
| `ft4` | −2.09 % | 1.81 | [−5.6, +1.5] | no |
| `ft6` | −2.34 % | 1.84 | [−5.9, +1.3] | no |
| `ft1` | **+6.18 %** | 1.79 | [+2.5, +10.0] | **yes** |
| `pg12` | **+6.31 %** | 1.79 | [+2.6, +10.2] | **yes** |

The factor F-tests agree: arm F = 77.5 (p < 1e-4), round F = 4.10
(p = 0.039), **position F = 1.32 (p = 0.33)** as five dummies but
significant as one slope — which is what a drift, rather than six
arbitrary levels, looks like. The k3 rejection is independently confirmed
here too: `rnd:k3` falls from +5.12 % to +1.83 % when those three legs
are dropped, while `rnd:k2` and `rnd:k4` do not move at all.

**Why wall cannot settle this and what would.** Per-leg rmse is 2.5–2.8 %
against an effect of at most 2 %, so the standard error shrinks as
1/√rounds and reaching ±0.5 % needs roughly 13× the rounds — about forty
hours of this host to price a lever that may be zero. The counters are
the cheaper route, and `tools/perf/mech.py` reads them, but they only
price the **cost** side: chained exits are counted solely under
`W64_XCOUNT`, and `lookup` sees just the slow lookups a chained exit
never reaches, so the benefit fold-through is supposed to deliver is not
in the sweep logs at all. What the cost side shows:

| arm | translated len | tbIcount/Mi | tbBytes/Mi | tbGen/Mi | wall |
|---|---|---|---|---|---|
| `ft1` | 6.857 | 8.6 | 1,005 | 1.255 | +5.71 % |
| `base` (3) | 9.464 | 12.8 | 1,415 | 1.357 | — |
| `ft4` | 10.146 | 14.3 | 1,570 | 1.408 | −0.20 % |
| `ft6` | 10.953 | 15.4 | 1,671 | 1.407 | −2.00 % |

Two things to read off it. First, `tbGen/Mi` *rises* with folding —
folding duplicates blocks into several predecessors, so you translate
more TBs and each is longer — but at 1.4 translations per million guest
instructions each generated TB covers ~700k instructions of execution, so
`ft4`'s +11 % translation bill is charged on a negligible base and is not
what is holding the wall flat. Second, the curve is sharply
diminishing: 1 → 3 lengthens TBs by 38 % and buys 5.4 %, while 3 → 4
lengthens by 7 % and buys at most 2 %. **The default of 3 already sits at
the knee**, which is the defensible conclusion and the reason not to
spend forty hours resolving the remainder.

To settle it anyway, instrument the benefit rather than lengthening the
sweep: build with `W64_XCOUNT` and compare exits/Mi between `base` and
`ft4` directly. Exits are a guest-side count with no host drift in it, so
three rounds of it would resolve a 5 % change in entries where 24 legs of
wall could not resolve 2 % of time.

**Do not price a TB entry from this pair.** Two attempts did and both
were wrong: "entries/Mi is 1e6/`tbIcount`, so base 79,340 → ft4 72,627,
~12.2 ns per entry, ~23 % of wall", then "1 − 9.733/10.204 = 4.62 % of
entries removed, so 1.78 ms/Mi, ~43 % of wall". The first used a sum as a
mean. The second fixed that and kept the real defect: base→ft4 moves
translated length by ~5 % while the *same arm* varies by ~11 % round to
round, so the divisor's error bar spans zero. The fitted answer, over all
ten clean legs and anchored by ft1's −28 %, is **15.8 % of wall with a
12.3–18.9 % band** — see "What a TB entry costs" above. A two-point slope
was never going to resolve this; the sweep exists precisely because one
leg is not a measurement — and, as the same section records, because
three *bad* legs are enough to unsettle a settled number.

### Register write-back is not a boundary cost, and has not been since round eleven

`tcgGst/tbIcount` is 0.939 stores per guest instruction at ft1, 0.972 at
base, 1.026 at ft4 — with ~0.74 loads on top, **1.71 env memory
operations per guest instruction, and the stores RISE with TB length**. A
cost that grows when TB length grows is not paid at TB boundaries.
`wasm-diag.h` has called it a boundary cost since round eleven on the
strength of a board averaging 8.4 guest instructions per TB; that was an
assumption, and it is wrong in the opposite direction from the one that
would have been forgivable.

Lengthening TBs therefore buys entries while *paying* sync — folding
through a branch adds a block boundary that forces the write-back —
which is both why ft4 is worth only 2 % and a candidate mechanism for the
turnover at ft6.

> **Which boundary, precisely** (round thirty-five, after the `GSYNC_*`
> split). Not "the brcond", as this paragraph said before: the brcond
> belongs to the predication that was already there. `w64_defer_taken`
> adds `tcg_gen_br` (`translate.c:1932`) and sets its fold label later,
> both `TCG_OPF_BB_END`, so the fold's own cost is charged to
> **`GSYNC_BBEND`**, not `GSYNC_CBR` — and `BBEND` is the largest sync
> cause at 42 %, larger than `EXIT` at 33–37 %, which is itself a hint,
> since every TB has exactly one exit and internal labels come only from
> predication and the fold. An internal label is also strictly worse than
> an exit per boundary: both force the stores, but the code after a label
> must *reload* the globals it killed, whereas a TB exit's reload is the
> successor's prologue either way.
>
> This does not overturn "the default of 3 sits at the knee" — that is a
> wall result and stands. It says the `FTMAX` sweep is worth **re-reading
> with the `gsync` counters**, which did not exist when it was run, to see
> how much of `BBEND` the fold owns versus predication. Same legs, same
> knob, counters that were not available the first time.

> **Corrected in round thirty-five.** The numbers above were
> `tcgGst/tbGen/tbIcount`, which divides by the TB count twice; they read
> 0.747/0.751/0.739 and **1.33**, and made the trend look flat. The
> conclusion survives — flat and rising both refute "boundary" — but the
> mechanism only appears in the corrected form.

Seven counters were added to attribute it exactly rather than guess
again. TCG liveness demands a write-back at five kinds of site, and the
split that matters is removable versus not:

- `GSYNC_SE` (an op that can fault) and `GSYNC_CALL` (a helper that reads
  env) are **semantics**. A faulting guest access must leave env
  coherent; no code shape changes that.
- `GSYNC_CBR` (a `brcond`) and `GSYNC_BBEND` (label/br/goto_tb) are
  **shape**. On this guest `CBR` is mostly A32 predication — every
  instruction with a condition other than `AL` emits a branch over
  itself, and TCG treats that as a basic-block boundary — and predication
  has a branchless `movcond` form.

`PRED_A32`/`PRED_SEL` size that lever before it is built: how many
predicated A32 instructions there are, and how many are the shape a
`movcond` could take (data-processing, `S` clear, `Rd` not PC, so there
is nothing to fault and no flags to select). If `SE` dominates there is
nothing here; if `CBR` does, there is. All seven are translation-time
counters (~4k TBs/s), so they ship always-on and do not make this a
measurement build.

> **Measured 2026-09-17 — `CBR` does not dominate, and this lever is
> dead.** `CBR` is **0.8 % (game 1) and 2.2 % (game 2)** of sync causes.
> Applying this section's own formula, `GSYNC_CBR × (PRED_SEL/PRED_A32)`:
>
> | | CBR | PRED_SEL/PRED_A32 | ceiling in write-backs | as a share of sync demands |
> |---|---|---|---|---|
> | game 1 | 0.168 | 19.7 % | 0.033/Mi | **0.17 %** |
> | game 2 | 1.408 | 25.8 % | 0.363/Mi | **0.56 %** |
>
> So a perfect branchless rewrite of every eligible predicated
> instruction removes **0.17–0.56 % of guest-register write-backs**.
> Even charging the whole env-traffic row at 9 % of wall, that is under
> 0.07 % — below this workstream's ability to measure, and two orders
> below the rows still open.
>
> **Why it is small is more useful than that it is small.**
> `PRED_A32` partitions almost exactly into two populations:
> `AB_COND + PRED_SEL = PRED_A32` to 0.7 % in game 1 and to the digit in
> game 2 (3.600 + 1.251 = 4.851). `AB_COND` is a conditional *branch*
> whose taken path `w64_defer_taken` already absorbs — 74–81 % of all
> predicated A32 instructions. **The branchless win this lever was
> chasing has already been taken by branch absorption**, and what is left
> is the data-processing remainder, which is a fifth to a quarter of a
> population that is itself only ~10 % of translated instructions.
>
> **Consequence for the `select` emitter.** The plan of record was to
> land it on `tbBytes`/`tbGen` as substrate for this rewrite, with no wall
> expectation. That rationale is now gone with the rewrite it was
> substrate for: on ARMv5TE `tgen_movcond` is reached only from
> `gen_shl`/`gen_shr`, so the emitter would serve register-controlled
> shifts and nothing else. **Do not build it for performance.** It
> remains defensible only as a code-quality change, and should be
> justified as one if it is ever landed.

> **Reopened the same day — that verdict priced only half the lever.**
> The formula above, `GSYNC_CBR × (PRED_SEL/PRED_A32)`, assumes a
> predicated instruction's sync cost lands in `CBR`. It does not. A
> predicated A32 instruction emits **two** block boundaries, not one:
> `arm_skip_unless` (`translate.c:3121`) emits the `brcond` over it, and
> `arm_post_translate_insn` (`translate.c:7621`) emits
> `gen_set_label(dc->condlabel.label)` after it. Liveness charges them to
> different counters, and the split is not arbitrary:
>
> - `tcg.c:4234` sets `ts->state = TS_DEAD` on every global an op writes,
>   **clearing `TS_MEM`**. So the blame span restarts at each write, and
>   `la_blame`'s `TS_MEM` guard (`tcg.c:3702`) does not let a label starve
>   the `brcond` behind it. The attribution is sound; the comment at
>   `tcg.c:3693` is right.
> - Which is exactly why the two halves differ. Walking backwards, the
>   label lands first and claims **the instruction's own outputs** →
>   `BBEND`. The instruction's write then clears `TS_MEM`, so the `brcond`
>   claims **only globals dirtied before it** → `CBR`.
>
> If-conversion to `movcond` removes both boundaries, so it removes both
> charges. `CBR` alone is the half it does *not* remove — the smaller one.
>
> | | old ceiling (`CBR` only) | new upper bound (`CBR+BBEND`) |
> |---|---|---|
> | game 1 | 0.17 % of write-backs | **8.3 %** |
> | game 2 | 0.56 % of write-backs | **11.5 %** |
>
> The upper bound assumes *all* of `BBEND` is condlabels, which is
> certainly too generous — `br`, `gen_store_exclusive`'s two labels,
> `gen_goto_ptr`'s slow label and `w64_try_join`'s `cont` also land there.
> The true value is bracketed by the two columns. **Neither end is
> measured, so the honest state of this lever is open, not dead.**
>
> *And do not over-invest in the reopening either.* Converting the upper
> bound to wall the same way the original verdict did: stores are 58 % of
> env ops (`tcgGst` 14.756 of `tcgGst+tcgGld` 25.474), so charging the
> whole env-traffic row at 9 % of wall puts stores at ~5.2 %, and 11.5 %
> of those is **~0.6 % of wall** — against the 0.06 % the "dead" verdict
> computed. Tenfold better and still not a headline. What changes is the
> *decision*: 0.06 % is below this workstream's noise floor and not worth
> a measurement, while 0.6 % is worth the three cheap probes below, and
> probe 1 costs nothing to run. The `movcond` emitter itself stays
> unjustified until a probe puts a real number inside the bracket —
> the "do not build it for performance" instruction above still holds.
>
> *Both numbers above were first published against the wrong denominator.*
> The verdict and the reopening alike divided a `GSYNC_*` cause by
> `tcgGst`, and those are two different populations: `la_charge`
> (`tcg.c:3990`, `tcg.c:4232`) fires once per global output arg liveness
> marks `SYNC_ARG` — a sync **demand** — while `WASM_DIAG_TCG_GST`
> (`tcg.c:4656`, `tcg.c:4666`) fires inside `temp_sync`, which emits
> nothing when the global is already coherent. Demands run 1.32–1.35× the
> stores, so the ratio printed "attributed 135 % of the stores", which no
> residue can explain and which the old wording ("the residue is allocator
> pressure") papered over. Against the demand total the five causes sum to
> 100.0 % and 99.9 % — they partition it exactly. The shares here are now
> taken that way, which is also the right lever size: removing *d* demands
> removes `d × (stores/demands)` stores, and dividing by `tcgGst` gives
> back `d/total`. It moves the bracket down by a third (11.3 → 8.3 %,
> 15.2 → 11.5 %) and changes no decision. **Two rounds running, the
> meter's denominator was the defect, not the mechanism.**
>
> *What is not evidence.* `BBEND/PRED_A32` is 5.55 and 5.64 across the two
> games — a 1.6 % spread that looks like a mechanism. It is not: everything
> translation-side tracks `tbIcount` (`BBEND/tbIcount` = 0.565 / 0.559,
> `PRED_A32/tbIcount` = 0.102 / 0.099), so the stability is shared
> denominator, not shared cause. Two games is not a discriminating sample
> here and no arithmetic on these logs will settle it.
>
> **The measurements that would**, cheapest first.
>
> 1. **No rebuild at all: re-run the `W64_FTMAX` sweep and read `gsync`.**
>    Branch absorption is not a bystander — `w64_defer_taken`
>    (`translate.c:1932`) emits `tcg_gen_br`, `TCG_OPF_BB_END`, *and* sets
>    its fold label later, *and* `arm_post_translate_insn` still places the
>    condlabel; `AB_COND` is 74–81 % of `PRED_A32`. So `BBEND` has two
>    populations in it, predication's and the fold's, and `FTMAX` moves
>    only one of them. That the fold costs sync is **already established**
>    ("Register write-back is not a boundary cost" above, and its
>    correction); what is new is that the `GSYNC_*` split did not exist
>    when that sweep ran, so the same legs now decompose the cost instead
>    of only totalling it. `W64_FTMAX` (default 3) and `W64_MERGE` are both
>    `getenv`, so this is an A/B inside one binary — the method this
>    workstream already trusts — and no rebuild is owed.
>
>    Read the counters, not the wall: the wall answer (default 3 is at the
>    knee) is settled and this probe is not trying to reopen it. `BBEND`
>    that *survives* `FTMAX=0` is predication's, and that is the number the
>    bracket above actually needs.
> 2. **~6 lines: split `GSYNC_BBEND` by opcode.** `la_bb_end` has one
>    definition (`tcg.c:3743`) and one call site (`tcg.c:4247`), with `opc`
>    in scope, so passing `opc == INDEX_op_br ? …_GSYNC_BR : …_GSYNC_BBEND`
>    down to `la_blame_kill` says whether labels dominate at all.
> 3. **If they do: tag `TCGLabel` at `gen_set_label`** to separate the
>    condlabel from the other four label sources (`gen_store_exclusive` ×2,
>    `gen_goto_ptr`'s slow, `gen_goto_ptr_pcc`'s miss, `w64_try_join`'s
>    `cont`, `emit_delayed_exceptions`). That closes the bracket outright.
>
> 2 and 3 are translation-time, so they ship always-on like the rest of the
> family. Do them **after** the `dist-jit-mem32` A/B — that build is
> chained behind a running benchmark and must stay flag-identical to its
> baseline. 1 needs no rebuild and so can run as soon as the machine is
> free.

**Read them as static shares, not as a prize.** Being translation-time
is what makes them cheap, and it is also what limits them: every one of
these counters weights by *compilation*, never by execution (see
lessons.md, *A translation-time counter weights by compilation, never by
execution*). `w64_pred_count` fires in `translate.c:7194`, once per
instruction translated; `GSYNC_CBR` is counted in liveness. So
`PRED_SEL/PRED_A32` is the share of predicated instructions *in the
generated code*, and `GSYNC_CBR × that share` is the stores *emitted* —
neither is the stores executed. A TB translated once and entered twice
weighs the same here as one entered fifty thousand times, and the exit
census has already shown this workload is extremely re-entrant
(55,385 entries/Mi against 1.36 TBs generated/Mi, i.e. ~40,000 entries
per TB generated).

That does not sink the measurement — it fixes what it is for. Use the
ratio to decide **whether the shape is worth rewriting** (is `CBR` the
dominant kind of sync, and is a useful fraction of it the `movcond`
shape?), and do not convert it into a percentage of wall. The dynamic
number needs an execution weight this counter family does not carry,
and the honest way to get it is the A/B after the rewrite, not
arithmetic on these two counts.

For the record, `PRED_SEL`'s exact predicate (`translate.c:1994`):
data-processing immediate (`insn & 0x0e000000 == 0x02000000`) or
immediate-shifted register (`insn & 0x0e000010 == 0`), `S` clear,
`Rd != 15`, and opcode not in 8..11 (`TST`/`TEQ`/`CMP`/`CMN`, which are
compare-only and always set `S` anyway). Register-shifted-register
forms are excluded by the `bit 4 == 0` test, so the count is a true
lower bound on the shape.

**Before that lever is built, `movcond` has to become branchless — it is
not.** `tgen_movcond` (`tcg/wasm64/tcg-target.c.inc:2759-2790`) emits the
comparison and then a structured `if (result t) … else … end`
(`0x04` / `0x05` / `0x0b`), so a `movcond` in this backend is a *branch*.
Rewriting A32 predication from `brcond` to `movcond` against that
emitter would trade a branch for a branch: it would still collect the
`GSYNC_CBR` write-backs, because a `movcond` is not a basic-block
boundary and `la_bb_sync` never fires for it, but the branch the lever
is named after would still be there. Size the lever with that in mind —
the reachable prize is the *stores*, not the control flow, unless the
emitter changes too.

The emitter change is small and is worth doing on its own. wasm has a
branchless `select` (`0x1b`): it pops `val1, val2, cond` and pushes
`cond ? val1 : val2`. It is valid here unconditionally — `vt` and `vf`
are each a `local.get` or a constant, so evaluating both is free of
side effects and cannot trap, which is the only thing `select` requires
and the usual reason a compiler cannot use it. The edit is to push `vt`
and `vf` *before* the comparison rather than inside the arms, then emit
`0x1b`; note the operand order, since the current code computes the
condition first and `select` wants it last. That replaces four bytes of
block structure with one byte and removes a branch from every `movcond`
the frontend already emits today. `grep` finds no `0x1b` anywhere in the
backend, so nothing else has to change.

Two cautions. This is a code-shape change with no measured wall effect
yet, and `movcond` may be rare enough today that it reads as zero —
`tbBytes/tbGen` (0.04 % spread) will resolve the size half regardless,
which is the right way to land it. And it becomes *load-bearing* only if
predication is rewritten on top of it, so the honest order is: emitter
first, counters, then decide.

### Every conditional *value* in this backend is emitted as a branch, and one of them is dead code

`movcond` is not the only one. Grepping the backend for `0x04` (`if`)
finds three places where a value is selected, and none of them uses
`select`:

| site | lines | shape |
|---|---|---|
| `tgen_movcond` | 2759-2790 | `cmp; if(result t) vt else vf end` |
| `tgen_clz`/`tgen_ctz` | 2672-2693 (macro) | `op; eqz; if(result t) r2 else scr end` |
| `tgen_clzi`/`tgen_ctzi` | 2694-2715 (macro) | same, with a constant |

The `clz`/`ctz` fixup exists because wasm returns the *width* for a zero
input while TCG wants the caller's `arg2`. **For the constant form that
fixup is provably dead on ARM.** `tcg_gen_clzi_i32` does not fold
anything — it just wraps the value in a `tcg_constant_i32` and hands it
to the backend (`tcg/tcg-op.c:715-718`) — and every ARM `CLZ` calls it
with exactly the width: `tcg_gen_clzi_i32(tmp, tmp, 32)`
(`target/arm/tcg/translate.c:4414`, and likewise `gengvec.c:2379`,
`translate-a64.c:9011/9033`). When `i2 == 32` for `TCG_TYPE_I32` (or 64
for `I64`), wasm's native answer for zero is already `i2`, so the whole
`eqz; if; const; else; local.get; end` is emitting a branch to replace a
value with itself.

Eleven emitted ops become three:

```
 local.get r1; i32.clz; local.set scr;        local.get r1; i32.clz;
 local.get r1; i32.eqz; if (result i32);      local.set r0
 i32.const 32; else; local.get scr; end;
 local.set r0
```

The non-constant forms still need the fixup, but they can have it
branchlessly with `select`, as can `movcond`. So the family is one
patch: add a `select` emitter, use it in all three, and short-circuit
`clzi`/`ctzi` when `i2` equals the type's width.

Low risk and self-checking: `select` requires only that both operands
be side-effect-free and non-trapping, which holds at every one of these
sites (each operand is a `local.get` or a constant), and a mistake is a
wasm *validation* error, not a wrong answer. Land it against
`tbBytes/tbGen`, whose 0.04 % spread resolves the size effect even if
the wall effect is under the noise.

**Both claims above were re-verified against the source, and the
`clzi` one holds at every link.** ARM32 has exactly one `clz` call site
(`translate.c:4414`, `tcg_gen_clzi_i32(tmp, tmp, 32)`); `tcg_gen_clzi_i32`
does not fold (`tcg-op.c:715`); and the optimizer does not either —
`fold_count_zeros` folds only when the *input* is constant, and when it
is not it merely refines masks. So `clz r0, r1, $32` reaches the backend
intact and `tgen_clzi` emits the branch. Nothing upstream will do this
for us.

**What the verification adds is a reason to expect zero that is
stronger than the TurboFan one below: on this guest `tgen_movcond` is
currently reached from almost nowhere.** Of the seven ARM files that
emit `tcg_gen_movcond_i32`, six are dead on an ARM926EJ-S — `gengvec.c`
and `translate-sve.c` are NEON/SVE, `translate-a64.c` is A64,
`translate-vfp.c` needs VFP, `translate-m-nocp.c` is Cortex-M — and of
`translate.c`'s four sites, `:5752` is SMLAD (ARMv6), `:6619` is MVE
VCTP (Cortex-M) and `:6973` is CSEL (ARMv8.1-M/v8-A32). The only live
one is `GEN_SHIFT` at `:546`, reached from `gen_arm_shift_reg`
(`:628`/`:631`) — i.e. **`LSL`/`LSR` by a register, S clear, and nothing
else**; `gen_sar` uses `umin` and emits no movcond at all.

So measuring the `select` patch on today's workload measures the cost of
register-controlled shifts, which is not why anyone wants it. This is
not an argument against landing it — it is the argument for the order
stated above: the emitter is worth having *because A32 predication will
be rewritten onto it*, and until that rewrite exists there is almost no
`movcond` in the instruction stream for it to improve. Land it on
`tbBytes/tbGen` as a correctness-and-size change, and do not expect,
seek, or wait for a wall result from it on its own.

**Expect the `select` half to read zero on wall, and do not be
surprised.** TurboFan if-converts simple value diamonds, so an
`if(result t) a else b end` whose arms are a `local.get` and a constant
very likely already becomes a `cmov` in optimized code — which is why
this round found it by reading rather than in a profile, and why
emitted-byte count was closed as a *lever* several rounds ago while
staying useful as a meter. The part that is not merely a shape change
is the `clzi`/`ctzi` short-circuit: there the branch is not selecting
between two different values, it is selecting between a value and
itself, and TurboFan would have to prove wasm's `clz(0) == 32` to
delete it. That one deletes eight emitted ops *and* a compare that
almost certainly survives to machine code. Rank the family accordingly:
the short-circuit is the finding, `select` is tidiness that comes along
with it.

Three levers were retired without spending a leg on them: `icount` does
not truncate TBs (`max_insns` comes from `CF_COUNT_MASK`, set only at
slice boundaries, `cpu-exec.c:1868`); `TCG_TARGET_NB_REGS` = 16 is not
the cause of env traffic (`TCG_SPILL` is 2 in 3920 Mi); and the memory
already declares an explicit 2 GiB maximum, so the bound-check question
was never a missing build flag.

## Update (2026-09-17, round thirty-four: two blocks priced, and a counter that was costing a whole board family its TB lengthening)

Round thirty-three left the J2ME bench usable only in rotated, paired
form, and a rotated six-arm sweep is running as this is written. The work
below is what got done *without* the clock: two census blocks priced with
in-binary timers (which the drift does not touch, because each ships its
own calibration counter), one measurement of what the emitter actually
emits, and one real bug found by reading.

### DISPLAY is 1.74 % of wall and EXCEPTION is 1.04 %, so both are closed

`W64_DISPNS=1&W64_EXCNS=1`, games 1 and 2, 45 virtual seconds each:

| block | gross ns/Mi | calibration | net ns/Mi | % of wall | rate | unit cost |
|---|---|---|---|---|---|---|
| display | 77,876 | 2,045 | **75,831** | **1.74 %** | 40.5 bursts/Mi, 20,478 px/Mi | 1810–1933 ns/burst, 3.59–3.83 ns/px |
| exception | 142,594 | 32,448 | **45,250** | **1.04 %** | 410 exceptions/Mi | 104–116 ns each |

The display number matters because **the standing estimate was 0.25 %,
and it was 7× low**. That estimate came from round thirty-one's post-fix
burst time (638.8 ns) multiplied by a burst rate taken from a different
leg; measured in one binary against its own clock-read floor, a burst is
1810–1933 ns. It is still not a lever — 1.74 % is the *entire* DMA
display chain, deletion included — but the census row was wrong and is
now right.

The exception number retires a specific plan. 98.7 % of the 410
exceptions per Mi are guest `SWI`s (`excSwi` 402.7 vs `armIrq` 408.1
against `execIter` 502.0 — nearly every return to the C dispatcher is an
exception), which made "inline ARM exception entry into emitted code"
look like several percent. The whole path, entry plus BQL plus the
`do_interrupt` body, is **1.04 %**. Inlining part of a 1 % path is not
worth the correctness exposure. Note the floor correction is most of the
raw number here: the spans are ~110 ns and the browser clock read is
~66–75 ns, so the naive reading would have been 3× the truth.

Together the two blocks are **2.78 % of wall**. With the boundary at
~13.6 %, the inline TLB probe at 5.07 %, V8 baseline at ~3 %, hflags at
~0.6 % and the module pipeline at 0.07 %, roughly **25 % of this
workload is accounted for and ~75 % is TB-body guest work**, at about 11
host cycles per guest ARM instruction.

### What the emitter emits, measured rather than assumed

First direct measurement of emitted-code density (wabt on five saved TB
dumps): **37–61 wasm instructions and 119–245 bytes per guest ARM
instruction**; the J2ME TB average is 1025 bytes over 9.73 guest
instructions, so ~105 bytes per guest instruction. (Both terms are per
*translated* TB, which is the only pairing that divides: `tbBytes/tbGen`
over `tbIcount/tbGen`. The 12.3 this used to divide by was `tbIcount`'s
per-Mi value read as a mean.)

That looks damning and is not. At ~11 host cycles per guest instruction
the port is already in native-QEMU territory, which can only be true if
V8 folds most of that plumbing away. **Emitted verbosity is not the cost
driver**, and the ideas that follow from it should be priced against that
fact before being built. Concretely it retires the `$envneg` idea — wasm
memarg offsets are unsigned, so every `env->neg.*` access (icount
prologue, TLB fast table) emits `local.get $env; i64.const <negative>;
i64.add`, two extra instructions and a ~10-byte LEB constant. TurboFan
folds the add into the addressing mode and only ~3.6 % of entries run
baseline: **≲0.1 % weighted, not pursued.**

### The LG boards have had fold-target and the loop merge switched off, to protect a MIPS readout

Found by reading, not measuring. `w64_tb_icount_exact()` gates both
TB-lengthening mechanisms in `target/arm/tcg/translate.c` — the fold
target (`w64_defer_taken`, `W64_FTMAX`) and the conditional loop
back-edge merge (`w64_back_edge`). It was:

```c
return w64_tbhist_on() || w64_tbstats_inline() || icount2_enabled();
```

and `w64_tbstats_inline()` is `!icount_enabled() || getenv("W64_TBSTATS")`.
So the gate is armed **exactly on the boards icount is off for**.
`site/app.js:1449` gives Siemens/pmb887x `icount=shift=3,sleep=off` and
LG `icount=none`, which means:

- **Siemens (CX70, the J2ME target): both mechanisms live**, in the bench
  and in production alike — the sweep's `ft1`/`ft4`/`ft6` arms are
  meaningful, and round twenty-seven's FTMAX 1→2 = +4.7 % was real.
- **LG: both mechanisms dead**, unconditionally, and every TB entry pays
  two read-modify-writes anyway — all to keep `wasm_tbs`/`wasm_insns`
  (the MIPS display) exact. A whole board family, which also runs J2ME,
  has been paying for TB lengthening and not receiving it.

The counter is refundable, which is what the icount side already does.
Fixed in three pieces:

1. `tcg/wasm64/tcg-target.c.inc` — drop `w64_tbstats_inline()` from
   `w64_tb_icount_exact()` (keeping `w64_tbhist_on()`, a measurement
   build that ships nothing, and `icount2_enabled()`, whose counter
   drives virtual time rather than a display), and expose the
   instruction half of the counter as `w64_tb_acct_insns()`.
2. `target/arm/tcg/translate.c` — `w64_acct_charge(int insns)`, the
   `w64_lsm_count()` absolute-address RMW pattern, moving that counter
   by a signed amount. It is a no-op whenever nothing charges the
   counter inline, so **the Siemens path emits not one extra byte**.
3. `w64_refund()` now charges `-skipped` as well as handing back
   `icount_decr` (and no longer early-returns on non-icount boards,
   where the second half is the only half that applies); `w64_back_edge`
   charges `+num_insns` on the looping path, because a loop pass re-runs
   the body **without** re-entering the prologue and would otherwise
   *under*-count.

Traced for exactness in all three shapes. With a body of L instructions,
a tail of R, and k taken back-edges: prologue charges L+R, back-edges
charge kL, the conditional loop exit refunds R → L(k+1) executed,
L(k+1) counted. The non-conditional back-edge has R=0 and exits through
`exitreq` with no refund → L+kL = (k+1)L. Fold-target exits keep the
existing `num_insns − ft[i].insns` arithmetic, which the lockstep gate
already validates. `w64_absorb` needs nothing: it moves `pc_next`
forward without incrementing `num_insns`, so skipped instructions were
never charged.

**Not yet built or measured** — the sweep owns `dist-jit`. Measure with
`tools/uibench.mjs` (the LG bench), not the J2ME bench, which cannot see
this change at all.

### Trap: `kill -0` on an orphan never returns false in this container

A queued chain sat dead for ten minutes on

```sh
while kill -0 $PID 2>/dev/null; do sleep 20; done
```

`$PID` had become `Zs [bash] <defunct>` with ppid 1, and **PID 1 here is
`sleep infinity`, which never reaps**. A zombie keeps its pid slot, so
`kill -0` succeeds forever. (Same cause as the ~10,000 zombies on this
host.) Chain background work by putting it in one shell —
`(setsid nohup bash -c "a.sh; b.sh" &)` — never by waiting on a pid.

## Update (2026-09-17, round thirty-three: round thirty-two's lesson, relearned at full price)

**Everything this round measured with a sequential A/B is withdrawn.** The
numbers below are the diagnosis, not a retraction of the method — round
thirty-two had already fitted the confound and written the corrector, and
this round ran an uncorrected A-B-A sweep against it anyway and quoted the
result to a tenth of a percent.

### The J2ME bench is a fixed-work meter, and that is exactly what indicts it

`Mi` — guest instructions retired inside the window — reads **5624.7 to
5625.9 across all nine legs on disk, a 0.02 % spread**. icount is on and
the window is a fixed 45 *virtual* seconds, so the guest executes the same
instructions in the same order in every leg of every arm. There is no
guest-side variance left for a difference to hide in: `ms/Mi` is
`1000/MIPS` and it is **pure host speed**.

Which makes this the whole story:

| leg | binary | knob | game 1 | game 2 | load |
|---|---|---|---|---|---|
| pgbase  | same | default | 4.604 | 4.654 | 4.35→4.89 |
| pg12    | same | `W64_PAGEBITS=12` | 4.750 | 4.800 | 5.47→5.27 |
| pgbase2 | same | default | **4.126** | **4.313** | 3.56→3.75 |

Two legs of the *same binary with the same knob*, fifteen minutes apart,
differ by **10.4 %** on game 1 and **7.3 %** on game 2, in the direction
the host's 1-minute load moved. That is round thirty-two's "identical-
config repeat spread, median 12.0 %" reproduced on the new bench, and it
is three times the effect that was being reported.

### `insns/frame` is `1e9/fps ÷ ms/Mi`, and it was used as a workload guard

`fps` in the J2ME line is the browser's **wall-clock** render rate, pinned
by vsync at 62.0–62.4 in every leg. Therefore

```
insns/frame × ms/Mi  =  (Mi·1e6/F) × (wall_ms/Mi)  =  1e9 · wall_s/F  =  1e9/fps
```

and in all nine legs the product lands between 16.02 and 16.12 — constant
to 0.6 %. So `insns/frame` is `ms/Mi` inverted, carrying no independent
information whatsoever.

This round used it to decide which games were admissible: games 3 and 4
were dropped because they "diverged 19 % and 7.9 % on insns/frame" while
games 1 and 2 "matched to within 3.6 %". That test is circular — it drops
exactly the games whose `ms/Mi` moved most, which is the measurement, not
a defect in it. **The four-game mean was the right statistic all along**,
and the argument that it "lied" was the artefact.

**The workload guard on this bench is `Mi`, with `duty` and `halts/s`
beside it.** `Mi` constant to 0.02 % *is* the guarantee that the guest did
identical work. Never use `insns/frame`, and never use `fps`, for that job.

### The page-bits verdict is withdrawn — it is unresolved, not negative

Reported as "4 KB costs 3.1 % on matched games". Re-read three ways
against the drift above:

- **raw, against `pgbase`**: +3.2 % / +3.1 %
- **time-linear A-B-A interpolation** (the two defaults bracket `pg12`):
  **+7.7 % / +6.3 %** — because the host was getting *faster* through the
  battery, so the middle leg is charged for it
- **regressed on load** with round thirty-two's slope (−0.29 on log load):
  **+3.0 %** against `pgbase2`, **−1.3 %** against `pgbase`

Three defensible corrections spanning −1.3 % to +7.7 % is not a verdict.
The lever is re-queued as one arm of the rotated sweep described below.

The mechanism itself stands and is worth keeping: a guest page size needs
**two** edits, not one — `board.c` sets `mc->minimum_page_bits`, and
`cpu.c`'s realize raises `pagebits` so `set_preferred_target_page_bits`
does not refuse. `W64_PAGEBITS` is default-off and harmless.

### The repair: rotate, repeat, pair

`tools/perf/ftsweep2.sh` is now a rotated block design rather than a
sequence of blocks. Five arms (`base`, `ft1`, `ft4`, `ft6`, `pg12`), one
leg each per round, **the arm order rotated one position each round** so
no arm sits systematically early or late in the drift; each arm is then
scored against `base` *within its own round*, where the two legs are
minutes apart instead of half an hour. Four rounds, twenty legs, ~35 min.

Two things make it readable rather than merely longer:

- **`base`'s own spread across the four rounds is printed as the error
  bar.** Nothing smaller than it is a result.
- **`ft1` is a sensitivity control, not a candidate.** Round 27 measured
  FTMAX 1→2 as +4.7 %; if the design cannot see that, a null on the real
  candidates means nothing. A sweep with no positive control cannot
  distinguish "no effect" from "no resolution", which is precisely the
  mistake above.

### `W64_FTMAX`'s documented mechanism is void, so its default is untested

The default is **3** (`target/arm/tcg/translate.c:1884`,
`n = e ? MIN(atoi(e), W64_FT_MAX) : 3`, hard cap 32). Round 27 moved it
1→2 for +4.7 % and stopped at 3, explaining the peak as a TB with too many
labels falling into the `$bp` dispatch loop where forward branches cost
O(n_labels).

**That explanation cannot be operating here: `tbNested == tbGen` in every
window measured on this workload, so every TB is nested and the `$bp` mode
never runs.** The empirical peak may still stand, but its stated mechanism
does not, and an optimum with no mechanism behind it is a property of the
workload that produced it — EL71 boot, not a J2ME game. Values above 3
have never been measured at all.

### Also closed this round

- **The module-local dispatch loop is dead** — see the CLOSED block on the
  open item. It is priced at **+27 % of wall** on this workload against a
  3–6 % prize, from `tbBytes/tbGen = 1025 bytes/TB` putting the emulator
  in dispatchbench's pad-144 regime where `merged` costs +15.4 ns/entry.
  The consequence to carry: **V8's baseline-tier share is part of the
  floor, not headroom.**
- **Jump-cache crowding is real and worth ~0.1 %.** `TB_JMP_PAGE_BITS` is
  `TB_JMP_CACHE_BITS/2` = 7, i.e. 128 slots per page block *independent of
  page size*, so 4 KB pages put 8 PCs per slot instead of 2. Measured:
  `lookupConfl` +48.6 %, `lcFill` +49.6 %, `pccFill` +49.8 %, `lookupJc`
  flat — but +289 events/Mi at ~30 ns is **0.11 %**, and it would need
  505 ns per event to explain the clock. It cannot; the clock was drift.
- **The false-SMC prediction was wrong.** 4 KB pages were expected to make
  code and data share pages and drive `slowNotdirty`/`smcMiss` up ~4×.
  Measured **+1.5 %** (210.09→216.04). Coarser SMC granularity costs
  nothing on this firmware.
- **The display path is confirmed closed at 0.25 %**, and the claim that
  round 31's fix "cannot transfer to a game that blits every frame" was
  wrong: the cost is per *burst*, not per pixel. `dmacBurst` is 39.4/Mi
  with 127.6 px/row and coalescing on — squarely the cluster round 31
  already fixed, at 1.27 ns/pixel.

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

Re-derived with the correction and the duty guard (`tools/perf/verdict.py`,
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

### The image the user asked for is a better workload than the one we used

`CX70_FW56_clean.bin` — the firmware the user named, and which an earlier
handoff had written off as "does not boot under j2mebench" on no evidence
at all — boots, walks `center,3,1` and plays. All four of its titles, one
boot, 45 virtual-second windows, `--tag cxc`:

| game | MIPS/cpu | ms/Mi | duty | halts/s | tbGen/Mi |
|---|---:|---:|---:|---:|---:|
| 1 (AMF Xtreme Bowling) | 230.51 | 4.34 | **1** | 0 | 1.41 |
| 2 | 214.84 | 4.66 | **1** | 0 | 2.24 |
| 3 | 240.67 | 4.16 | **1** | 0 | 0.835 |
| 4 | 279.45 | 3.58 | **1** | 0 | 0.59 |

**`duty = 1` with `halts/s = 0` on every one of them.** That is the thing
the section above had to go hunting through a trace to find five bins of:
a guest that never halts, so virtual time and executed instructions are
the same series and the `perMi:` rollup is not an average over two
regimes. `CX70_games.bin` game 1 reads 0.95 at best and 0.12–0.22 for 27
of its 32 bins; game 2 reads 0.086 and measures nothing.

Three consequences, and the first two are corrections:

- **Re-base the shares.** Every boundary percentage in this round is
  quoted against 5.686 ms/Mi, which came from `games.bin` game 1. This
  workload runs at **3.58–4.66**, so a fixed per-event cost is worth
  *more* of it, by 1.22× to 1.59×. Nothing about a mechanism changed;
  the denominator did — the same trap the withdrawn `bql_unlock()` row
  was caught by.
- **The trace-bin discipline is unnecessary here.** "Profile the bin,
  not the window" exists because `games.bin` mixes an idle title screen
  into its own window. With `duty = 1` throughout, the window *is* the
  bin, and `--trace` is back to being a sanity check rather than the
  primary reading.
- **It is four different titles from a different dump**, not `games.bin`
  minus its games: 86.4 % of the bytes differ, and the catalogue is AMF
  Xtreme Bowling, Siemens 3D Rally, Photo Editor, Download Assistant,
  my-photos online. `tbGen/Mi` spanning 0.59 → 2.24 across them says
  they are genuinely different code, which is what "profile on many
  different games" was asking for.

**Use this image for J2ME measurement from here on.** The start plan that
works is `center:10000,center:10000,center:10000,center:8000` — presses
spread across the whole span rather than front-loaded, because a long
splash swallows everything pressed into it (the lesson game 2 of
`games.bin` cost five legs to learn).

### The census on that image: half the boundaries, the same shape

`W64_XCOUNT=1 W64_XWHY=1`, clean image, 45 virtual s per title. The
counters are the result; the clock on this leg is not comparable.

| per Mi | game 1 | game 2 | EL71 (§ 0h) |
|---|---|---|---|
| `xGotoptr` | 38 394 | 38 420 | |
| `xGototb` | 9 710 | 8 970 | |
| `xGototb1` | 7 281 | 7 306 | |
| `xSelf` | 7.5 | ~7 | |
| **total exits** | **55 393** | **54 703** | **107 960** |
| **guest insns / TB entry** | **18.05** | **18.28** | **8.47** |
| `goto_ptr` share | 69.3 % | 70.2 % | 66.7 % |
| `xwOther` (of indirect) | 44.7 % | 44.7 % | 41.5 % |
| `xwBx` | 38.5 % | 38.6 % | 38.1 % |
| `xwDefer` | 8.7 % | 8.6 % | 9.8 % |
| `xwPsr` | 4.2 % | 4.2 % | 6.7 % |
| `xwPcst` | 2.8 % | 2.8 % | 2.1 % |
| `xwRfe` | 1.1 % | 1.1 % | 1.7 % |

Three results, two of which overturn something.

1. **The interpreter-dispatch hypothesis is refuted.** I expected a J2ME
   MIDlet to be a bytecode interpreter whose dispatch is `ldr pc, [rX,
   rY]` and therefore to pile up in `xwPcst`. `xwPcst` is **2.8 %** —
   statistically the same as EL71's 2.1 %. Whatever this workload is, it
   is not dispatching through a PC store.

2. **The census is a property of the firmware, not of the game.** Games 1
   and 2 are different titles with different `MIPS/cpu` (238.09 vs
   226.55) and different `tbGen/Mi` (1.472 vs 1.712), yet agree to four
   significant figures on `xwOther` (17 166 vs 17 170), `xwBx` (14 787 vs
   14 817), `xwPsr` (1630.3 vs 1630.9) and `excSwi` (402.2 vs 402.5).
   The exits are being generated by shared code — the phone's own JVM and
   graphics stack — which is why the shape survives changing the title.
   That makes the census reproducible, and it means **a boundary win here
   is a win for every MIDlet**, which is exactly the generality the user
   asked for.

3. **The lever is half the size the old numbers implied, and the TB
   shaping is already twice as good.** 55 393 exits/Mi against EL71's
   107 960, and 18.05 guest instructions per TB entry against 8.47. At
   ~33 ns an exit that is 1.83 ms of a 4.25 ms/Mi wall: boundaries are
   **43 % of wall here, not 68 %**. The handoff's standing target —
   "raise guest insns per TB entry from 8.47 to 12" — is already
   *exceeded by half again* on this workload without anyone doing
   anything. It was a statement about EL71.

Calls + returns (`xwOther` + `xwBx`) are 83.2 % of indirect exits =
**57.7 % of all exits ≈ 24.8 % of wall**, still the largest block.

### Why converting an exit's *kind* is worth even less here than the 0.3 % on record

`xwOther` is the residual bucket — `w64_why` defaults to 0 and only
`gen_bx`, the PC store, PSR, RFE, defer and nochain label themselves — and
the one unlabelled site that matters is `gen_goto_tb`'s `else`: when
`translator_use_goto_tb()` refuses (1 KB pages, so most of the time), it
falls through to `gen_goto_ptr`. So 31 % of all exits are direct branches
wearing an indirect exit, and `set_preferred_target_page_bits(12)` would
convert them. The counters say not to bother:

- `lookup` is **1000/Mi against 38 394 indirect exits/Mi**, so **97.4 %
  of indirect exits never reach the helper at all** — the per-TB `lc`
  slot answers them in 3 loads and 2 branches, ~1 ns. `pccHit` is 2.72/Mi;
  the global PC cache is almost never even consulted.
- So the difference between a chained `goto_tb` and a slot-hit `goto_ptr`
  is that ~1 ns plus one PC store. 17 166/Mi × ~1 ns ≈ **0.4 % of wall**,
  which reproduces the 0.3 % already on record from `W64_CHAINLOOP`
  (−0.1 %) and from dispatchbench's finding that every mechanism lands at
  16–17 ns for predictable targets.

**Do not spend a round on pagebits.** It is sound for this firmware
(`tlbFill == fillLarge`, so the guest never uses ARMv5 1 KB tiny pages)
and it is worth a third of a percent.

### The absorb family is closed, including for calls

Worth stating plainly because it is easy to re-derive: `trans_BL` →
`gen_jmp` → `gen_jmp_tb` → `w64_absorb`, so **a call already inlines into
its caller's TB** when it is forward, within `W64_ABSORB` and on the same
page. "Inline the callee" is not an unbuilt lever; it is a throttled one,
and every throttle is already settled:

| refusal | status |
|---|---|
| `abCond` (46–72 % of them) | not a refusal — hands off to `w64_defer_taken`/`w64_try_join` |
| `abBackout` | **structurally blocked**: a TB's invalidation range is `[tb->pc, tb->pc+size)` and `tb->pc` is its lookup key, so it can never contain instructions *before* its entry point |
| `abFar` | doesn't respond — 512/1024/4096 all within 0.7 % of 256 (round 0110) |
| `abIset`, M-profile | correctness guards; without them 31 % of absorbs are wrong |
| `abPage`, `abBackin` | 0.4 % and 0.2 % |

And absorbing a `bl` removes only the *call* exit: the callee's `bx lr`
still leaves, because the return address `pc_curr+4` was skipped over by
the absorb and is not in the TB. The return half of the pair — 27 % of
all exits — has no mechanism in this design that can reach it.

**And the knob that looks untested is not.** Per *generated* TB the
refusals read `abCond` 0.80, join 0.166, absorb 0.10, `abBackout` 0.098,
`abFar` 0.068: the conditional branch is the dominant TB-ender by 5×, and
the only thing between it and the fall-through is a free deferral slot.
`w64_defer_taken` bails on `s->w64_ft_n >= w64_ft_max()` and does not
count that, so no counter shows it — which makes `W64_FTMAX` look like an
open lever. It is not: § *Fewer boundaries — already at its peak* has the
four-point sweep, and 3 is a **real** peak, for a reason that is a
property of the backend rather than of the workload. Each extra deferral
is another label, and 0109 established that label count is what drops a
TB out of the backend's nested-label mode into the `$bp` dispatch loop
where every forward branch costs O(n_labels). A workload with *bigger*
TBs already carries more labels, so raising `W64_FTMAX` here should reach
that cliff **sooner**, not later. Re-measured on this image anyway
(cheap, `?env=W64_FTMAX=N`, no rebuild) only because the tree's own rule
is to re-measure a rejected result when the workload changes — expect it
to confirm, not to open.

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
  and never once run. Queued as `tools/perf/lever-chain.sh` step 2.

**The merged module is not that lever, and the sweep that was supposed
to gate it killed it instead.** The reasoning that pointed here was:
the boundary is ~53 % of wall, and the merge is the only scheme that
removes the *instance crossing* rather than changing which call opcode
performs it — an intra-module successor becomes a `br` back to a
`br_table` cascade head, with no call at all. The gate was whether
`merged` still beat `xtail` at the ~277 TBs a real module holds. It was
run (`tools/perf/lever-chain.sh` step 1, swept properly over body size
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

`tools/perf/verdict.py` recomputes any verdict from the saved sweep
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
for that reason. `tools/perf/runner-duty.py` holds the patch — exact
anchors, idempotent, refuses to half-apply — and `tools/perf/queue7.sh`
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

**What that rejection does and does not close.** It closes the *helper
call*, because the 14.5 ns is the call. It does not close batching the
probe **inline**, which pays no call and spills nothing — and that
variant has never been built or priced. Re-measured 2026-09-17 on
`CX70_FW56_clean.bin` game 1 with `W64_LDSTCOUNT=2&W64_LSMCOUNT=1`:
`ldstExec` 428,840.7/Mi (**42.9 % of guest instructions are memory
ops**), `lsmExec` 141,444.3/Mi from `lsmN` 35,688.4/Mi — **3.96
registers per ldm/stm, 33.0 % of all executed guest memory ops**,
consistent with the 33.7 %/3.61 above. Collapsing to one translation
per instruction deletes 105,756 probes/Mi; at the 1.16 ns/probe used
above that is 123 µs/Mi = **~2.7 % of wall** at 4.48 ms/Mi.

**But the blocker is structural, not a matter of effort.** A backend
peephole cannot see the group: `target/arm` walks an ldm/stm with
`tcg_gen_addi_i32(addr, addr, 4)` between accesses, so each `qemu_ld`
arrives with its own temp and no static relation the backend can
recover. Doing it inline therefore needs *new TCG machinery* — a way
for the frontend to say "translate this address once, then N accesses
at fixed offsets from the result" — which is a target-independent
change, not a wasm64 one. The C-side equivalent already exists
(`probe_access` / `tlb_vaddr_to_host`, as `sve_helper.c` uses) but
reaching it means a helper, which is the thing already rejected.

So: **~2.7 %, real, and behind a larger door than it looks.** It also
overlaps the bound-check row — every probe deleted is bounds-checked
accesses deleted — so wasm32 collects part of it first. Do not start
here; re-price it *after* the migration, when what remains is known.
The same-page guard is the other thing to design then: 4·n bytes from
an arbitrary base can straddle a page, so the fast path needs a
"base and base+4n−1 in one page" test with a per-word fallback.

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
parts are the playbook's **REJECTED** table (per-experiment numbers +
why), the per-patch numbers in the commit messages on the `qemu/`
branch, and
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
