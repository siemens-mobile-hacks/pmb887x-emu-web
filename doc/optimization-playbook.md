# WASM performance optimization playbook

The working method of the optimization sessions since 2026-09-07:
**profile → hypothesize → small patch → measure → keep or revert →
document**, tuned for the shortest loop that can still reject a bad
change.  Read with [performance-handoff.md](performance-handoff.md)
(current targets/plan) and [tests/tcgbench/README.md](../tests/tcgbench/README.md)
(tool ladder).  The conclusions behind these rules — timing model,
io-recompile accounting, emscripten traps, measurement traps — are in
[lessons.md](lessons.md).

qemu tree is the `qemu/` submodule: a "patch" is
a commit on its branch (numbering continues as before), and
`versions.env` pins the tip.

## Measure, then gate — they are different activities

Two kinds of run, and confusing them is what makes a session both slow
and wrong:

- **A measurement** answers "how fast". It reads a wall clock, so host
  load changes the answer. Run one at a time, on a quiet host, A and B
  interleaved inside a single invocation.
- **A gate** answers "is it still correct". Nothing in it reads a wall
  clock as a result, so host load cannot change the verdict. Gates can
  therefore all run **at once** — which is what `scripts/gate.sh` does,
  and it is the difference between a 20-minute step and a 3-minute one.

Never take a measurement while a gate tier is running.

## The iteration ladder (cheapest reject first)

Every candidate climbs this ladder and stops at the first rung that
rejects it. Costs are wall-clock on this host (32 cores, quiet).

| rung | command | cost | detects | cannot see |
|---|---|---|---|---|
| 0 build | `scripts/ninja-fast.sh` (wasm64 → site/dist-jit) | ~8 s | compile errors | — |
| 1 knob A/B | `idlebench "dist-jit@env=K=V,dist-jit"` — same wasm both legs | ~2 min | whether the mechanism is worth building at all | anything without a knob |
| 2 fixed work | `node tools/workbench.mjs --board <b> --to <Mi>` | ~30 s/leg | **the default keep/revert meter**: wall time over identical guest work | steady state, boot phases |
| 3 op-suite | `scripts/run-tcg-isa.sh` | ~3 s | any TCG/memory/exec value divergence; every built backend byte-identical against the native JIT | perf |
| 4 counters | `node tools/diagall.mjs [secs]` / `counters.mjs --board` | ~1 min | every `wasm_memstat` index by name + per-second deltas — mechanism confirmation at 0.04 % spread | attribution to a function |
| 5 board meter | `node tools/uibench.mjs --board <b> --state both` | ~3 min/board | per-board steady state; the only meter that sees a board-specific mechanism | boot phases |
| 6 full boot | `node tools/idlebench.mjs --runs 2` | ~2.5 min/dist | tIdle, t1.3G, LCD idle screen, crash/stall classes | — |
| 7 gates | `scripts/gate.sh quick\|keep\|close` | **152 s / 152 s / 719 s** | correctness, everything at once | perf |

`quick` and `keep` cost the same wall time — both are bounded by the one
150 s board boot that every other job overlaps with, which is what
running gates concurrently buys: the eleven jobs of `keep` sum to 846 s
one after another, and `close`'s fifteen sum to 2274 s. `close` is
bounded instead by its longest single job — `boot-ordered` (602 s: four
boards as consecutive pages of one browser, where the *sequence* is the
test condition, so it cannot be split). The 2.5e9 lockstep runs its
three comparisons `--par 3`: 363 s against 1024 s serial, which is what
took `close` from 1175 s to 719 s.

Rules that keep the ladder honest:

1. **No change lands without a measurement**; a rejected change gets a
   row in § REJECTED with its numbers so it is not retried blind.
2. **One mechanism per commit** on the `qemu/` submodule branch, the
   message carrying the measured numbers; bump `QEMU_PMB887X_REV` in
   `versions.env` when it lands.
3. **Prefer a knob A/B to a build A/B.** One binary, two query strings,
   one invocation: no rebuild, no build-directory skew, no chance of
   comparing against a mid-state tree. Build the knob first when the
   mechanism allows one.
4. **A/B inside one invocation, never against yesterday's number.**
   Before the first candidate deploy: `cp -a site/dist-jit
   site/dist-jit-base`. Then `idlebench dist-jit-base,dist-jit` or
   `workbench` alternating legs — same host state, ratios printed.
   Counters too: compare legs within one invocation, never runs —
   a device's traffic varies ~2× with the guest's phase.
5. **Use the meter that matches the board.** The SGOLD boards (EL71,
   CX70) have no steady state — idle animates and the GSM stack cycles,
   so idle MIPS swings ~15 % between runs of the same build and cannot
   resolve a patch. Fixed guest work (rung 2) is the meter there.
   S75/KE800 idle is stable enough for uibench.
6. **Repeat only what is close.** Ratios beyond ±10 % on a quiet host
   (loadavg < 4) are decided by one pair; inside ±10 % run the pair
   again with the order swapped and require both to agree. Run-to-run
   spread is ±3–5 % on t0.5G, ±5–8 % on the window, ~2–3 % on uibench,
   and **0.04 %** on a counter — which is why a mechanism is confirmed
   with counters and only its *value* with a clock.
7. **Gate by change class**: rung 3 for anything touching TCG/memory/
   exec; `gate.sh keep` before a commit; `gate.sh close` at session
   close. Backend-only (`dist-jit`) changes skip the `dist` legs.

## The loop, as commands

```bash
# 0. serve the dists (keep running; gate.sh starts one if none answers)
PORT=8080 node serve.mjs &

# baseline once per session.  REBUILD IT FIRST — build/qemu-wasm64 may
# have been left mid-state by the previous session, and an incremental
# build over that produced a 5 %-slow "baseline" on 2026-09-13 that
# faked a win for four invocations (§ Measuring, "phantom win").
bash scripts/ninja-fast.sh
cp -a site/dist-jit site/dist-jit-base

# 1. edit qemu/ (the submodule)  ->  2. rebuild + deploy (~8 s)
bash scripts/ninja-fast.sh

# 3. decide: fixed guest work, the board the change is aimed at
PORT=8080 node tools/workbench.mjs --board el71 --to 1300
#    ...or, when the mechanism has a knob, one binary and no rebuild:
PORT=8080 node tools/idlebench.mjs "dist-jit@env=W64_SPEC_N=64,dist-jit" --quick

# 4. confirm the MECHANISM with counters before believing the clock
PORT=8080 node tools/diagall.mjs 45

# 5. profile only when choosing the next target (~40 s)
PORT=8080 node tools/wprof2.mjs 40 "" 100          # PROF_DELAY=<s> picks the phase
#    a name here is a NEIGHBOURHOOD, not a function — confirm with a
#    counter or a volatile-spin probe before you optimise it

# 6. gates for a keeper, then commit
bash scripts/gate.sh keep
git -C qemu commit -a                              # measured numbers in the message
git -C qemu push origin wasm-browser-port:wasm-patches
# then set QEMU_PMB887X_REV in versions.env to the new tip

# 7. before the session's last commit
bash scripts/gate.sh close
```

**Before believing a keep verdict on a close call**, build both revisions
pristinely (own worktree, own build dir — no inherited objects) and
re-A/B. Hashes differ between build dirs for identical source (absolute
paths are embedded), so identify a dist by behaviour, not hash:

```bash
git -C qemu worktree add --detach build/wt-<rev> <rev>
#   configure that worktree into build/qemu-wasm64-<rev> exactly as
#   scripts/build-qemu-wasm64.sh does (it needs EM_PKG_CONFIG_PATH set
#   as well as PKG_CONFIG_PATH), deploy to site/dist-pristine-<rev>
PORT=8080 node tools/idlebench.mjs dist-pristine-old,dist-pristine-new --quick --runs 4
```

Deploy hygiene: never plain-`cp` over a live-served wasm (a torn file
gets served) — the deploy scripts do tmp+rename; and refresh the
`.symbols` sidecar in `site/<dist>/` after a deploy or wprof2 profiles
garbage.

## Measurement methodology (and its traps)

- **Count the browsers on the host before believing any number**
  (2026-09-17, round 30).  A run that dies before its own `close()` —
  a timeout, a `pkill`, an OOM — leaves its headless Chromium behind,
  *still emulating a phone*, reparented to a PID 1 that is
  `sleep infinity` and never reaps.  This host had accumulated **8 958**
  of them, the oldest three days old, and the live ones among them were
  holding ~20 cores and 30 GB of swap.  Two separate damages, and the
  second is the nasty one:
  1. every leg runs on a busier host than the leg before it, which is
     monotone drift that looks exactly like a regression in the second
     half of a palindrome;
  2. `j2mebench`'s own CPU denominator was **counting them**.
     `chromeTree()` has to sweep every chrome process on the host,
     because chromium's zygote children reparent away from the launcher
     and a run's real vCPU thread would otherwise be missed — so it
     also swept the survivors, and `MIPS/cpu` is `insns / max-thread
     CPU` over that set.  Fixed by snapshotting the live chrome PIDs
     *before* launch and excluding them, by killing `ppid == 1` chrome
     at startup (`J2ME_NOREAP=1` opts out), and by closing the browser
     from `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException` so the tool
     stops being the thing that creates them.  `hostLoad` and
     `hostPids` now go into every result JSON.
  `ps -eo comm | sort | uniq -c | sort -rn | head` is the whole check,
  and `top -bn2` separates *this* container's load from the host's:
  28.8 % of these cores were `ni`ced work belonging to nobody in the
  container, which no amount of local hygiene can quiet.  That is the
  real argument for palindromic interleaving and for a CPU-time
  denominator — but the denominator only works if it is *this run's*
  CPU.
- **Measure the phase before optimising the loop inside it.** The
  single cheapest habit here, and the one most often skipped. Round
  nineteen's import-object cache was sound reasoning on an unmeasured
  premise: the loop it optimised turned out to be **0.7 %** of the phase
  it sat in, because a module has 2.1 imports and not the twenty the
  code's shape implied. A twenty-line split settled it — and the same
  split then found the 83 µs. Cost a phase first; optimise second.
- **Metric by question.**  A keep/revert verdict → `workbench.mjs`,
  wall time over a fixed stretch of guest work on the board the change
  targets (icount makes that stretch identical across builds, so the
  meter has no guest-side variance at all). Mechanism confirmation →
  counters (`diagall`, 0.04 % spread). Device-path work → tcgbench
  mirrors (`mmiopoll`/`rampoll`/`mmiow` ns/access; checksum
  cross-checked). Attribution → wprof2, then verify the name.
  Boot speed → idlebench guest-work milestones: the S75v40lg1 boot
  executes a fixed ~1.345e9 guest insns to the idle screen (±0.3 %
  across builds/hosts/load), so `tNG` = wall s until N insns is a
  deterministic per-phase speed number with no LCD, no grid and no
  real-time gating; `window` = wall s between v=2 and v=7
  (interpolated).  Attribution → wprof2.
- **`insns` at a fixed wall time is a different meter after the guest
  reaches idle** (2026-09-17, round 28).  In a 20 s S75 window the four
  legs of a palindrome read `ram1p` 5 687 776 / 5 688 068 / 5 691 220 /
  5 689 916 — identical to four digits — and `halt` 70 267 / 70 255 /
  70 272, while `insns` swung **1975 M to 2363 M, 18 %**.  Both facts
  are true: the counters are boot-burst quantities that *saturate*
  (the interpreter tier stops seeing new TBs, the device traffic
  stops), and after that the instruction meter keeps accruing in the
  guest's own idle spin, whose length is however much of the window is
  left over.  So the swing is not noise to be averaged down and more
  rounds will not resolve it — **the meter is measuring a different
  thing in each leg.**  Either shorten the window to stay inside the
  boot, or use the fixed-guest-work milestones (`tNG`) above, which
  ask the opposite question and cannot be contaminated this way.
  Matching `halt` proves the legs are paced alike; it does **not**
  prove they measured the same work.
- **The boot has three phases** (per-second MIPS in the idlebench
  JSON `samples`): new-code heavy to ~0.5 G insns (JIT 7–20 MIPS in
  2 s intervals with 5–10k new TBs/s, 30–45 MIPS when translation
  drops below 2k/s — translation-heavy, though **not "compile-bound"**:
  round seventeen priced the whole translate-and-compile pipeline at
  19.5 % of boot wall with a C-side timer, against the ~50 % the early
  phase's profile had implied), the display-DMA stretch
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
- **A per-Mi rate is not window-independent — match the Mi, not the
  seconds (2026-09-17).**  Counter rates are exact under icount for a
  *given* stretch of guest work, and it is tempting to read that as
  "normalizing per Mi removes the window".  It does not: the boot's own
  mix changes as it runs, so the same binary reads **exits/Mi 100 759 at
  1018 Mi and 114 857 at 839 Mi** — a 14 % spread from the window alone.
  A `W64_FTMAX` sweep read −12.3 % on one such mismatched pair and
  −1.6 % / −4.2 % once the legs were paired at ~1000 Mi and ~850 Mi.
  A faster leg reaches further in the same 20 s, so **the knob that wins
  the clock automatically gets the flattering window** — the confound
  points the same way as the hypothesis.  Either pair runs by insns
  (`--to <Mi>`) or read the rate at two windows and compare like with
  like.
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
  in the optimized function — plus, for anything touching icount or
  TB shape, `halt` counts that match between legs (double-charging
  icount runs the virtual clock fast and a fixed-wall instruction
  meter then reads work that is not there).  Counters beat profiles: ≥1 % leaf
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

**The one number a profile here is reliable for is the split.**  A 20 s
S75 vCPU profile reads **generated TB modules 35 %, main-module C 51 %**
(the rest is JS trampolines and the engine).  That ratio is robust
because it aggregates thousands of frames; the *per-function* self-times
inside it are not — round 23 measured `arm_rebuild_hflags` "at 11 %" and
a counter put the same function at 9.5 µs per call for a 76 ns function.
So use a profile to decide **which side of the wall** to look at, and a
counter times a per-call cost (or a calibration pad) to decide anything
else.  A profile also goes stale the moment a mechanism lands: the one
this round started from predated `do_ram_1p`, which deleted most of what
its second-largest entry (`do_st4_mmu`) was doing.

**A `wasm://wasm/<hash>` URL means a JIT'd TB module, and its name is
noise.**  `wprof2` symbolicates every `wasm-function[N]` through the
main module's symbol map, so a frame from a TB module comes back wearing
whatever name sits at that index in an unrelated binary — round 30 read
`invoke_ijjj` at 2.7 %, `helper_gvec_umax8` at 3.5 % and `__wasi_fd_seek`
at 0.8 % on a board with no SIMD, no SjLj and no filesystem.  **Bucket
by URL before believing any name**: `jit/qemu-system-arm.wasm` is the
main module and is symbolicated correctly; everything under
`wasm://wasm/` is generated guest code and the only honest thing to do
with it is sum it.

**Never pipe a profiler through `tail`.**  `tail` buffers to EOF, so a
backgrounded `prof.sh | tail -80` prints nothing for four minutes and
then hands back the *bottom* of the table — the small entries — having
discarded the top self-times the run existed to produce.  Redirect to a
file and set `PROF_SAVE` so the raw profile can be re-rendered without
re-running the game.

## What was tried and REJECTED (do not retry without new ideas)

Rows below name the probe each verdict came from. Where a row's question
is settled, round forty-one deleted the probe with it — the pads
(`W64_LDSTPAD`, `W64_CALLPAD`, `W64_LOCALPAD`, `W64_BYTEPAD`), the inline-
TLB-probe ceiling family (`W64_TLBDUP`, `W64_TLBCHEAP`, `W64_TLBHIT`,
`W64_TLBSIMD`, `W64_TLBHOIST`), `W64_LC2`, `W64_NOGENBUMP` and `W64_GDUP`
are gone from the tree. Retrying one of these means rebuilding its
instrument, which is the point: the numbers here are the reason not to.

| Experiment | Result | Why |
|---|---|---|
| **Memoize `arm_rebuild_hflags` across the SVC round trip** (2026-09-22, round 47; priced only, temporary `W64_HFDUP=n` probe: n extra `arm_rebuild_hflags()` per inline SVC, A/B inside one binary) | **Priced at 12.3 ± 1.6 ns a call** (video, 4+4 legs of n = 0 vs 8, +18 876 calls/Mi verified by `hflagsCalls`, fitted with `hostBusy`): the 5 937 calls/Mi are **2.6 % of video**, 0.3 % of J2ME game 1.  Round 17's 31.6 ns (a difference of two quantized clock sums) was 2.6× high | **Not worth a cache.**  The pre-v6 fast path is already two loads and a few bit tests; a memo must compare the same inputs, so it saves only the call chain around them — ≤ ~1.5 % on video at best — and a stale entry is a wrong translation.  Back-to-back duplicates run hot, so treat 12.3 ns as a floor, not a ceiling, if this is ever revisited |
| **Skip the timer notify when a re-arm moves the list head *later*** (2026-09-22, round 47; census only, temporary counters in `timer_mod_ns`).  `timer_mod_ns_locked()` reports "rearm" whenever the modified timer ends up at the head, including when the head deadline only moved later — a wake nobody needs, since the sleeper's deadline is already earlier | **Not built: the census closes it.**  KE970 boot: 15 % of rearm notifies are head-moved-later (0.4–1.5 k/s).  S75 idle: 45 k/s of 150 k/s, but every one is a vCPU-thread rearm under icount, where `qemu_timer_notify_cb` already returns after one deadline compare — ≤ 0.2 % of the vCPU | **The wakes are elsewhere.**  ~90 % of KE970's rearm notifies were issued by the main-loop thread itself (a timer callback re-arming its own timer), which is what round 47 took instead (`qemu_timer_notify_cb` skips the notify on that thread) |
| **A per-TB TLB page memo in wasm locals** (2026-09-22, round 47; `W64_TLBMEMO`, diff in `doc/attic/w64-tlbmemo-round47.diff`).  Two i64 locals per kind (load / store) hold the page tag and addend of the last inline-probe hit on the TB's dominant mmu index; a later memop on the same page skips the probe's four loads (mask, table, comparator, addend) behind one compare.  Sound without a flush hook because only the vCPU thread changes its TLB mid-TB and only inside helpers, and every call and slow path kills the memo | **Built, 1159/1159 op suite, census 59.2 % of executed memops served by the memo — and flat.**  12-leg same-binary env ABBA on video: 3.198 (memo) vs 3.192 (off) ms/Mi, **−0.18 %** at matched hostBusy, arms fully interleaved (sd ~3 %).  Reverted | **The probe's loads are not what a memop costs.**  They hit L1 and V8 schedules them in parallel with the address arithmetic; the compare-and-branch put in front replaces them with a dependent branch and grows every memop.  This is round 23's per-site cache result (−4.4..5.0 % on EL71) arriving from the other side: removing the probe's *work* on most executions buys nothing, so no cheaper-probe idea is worth building until something prices the probe's *latency* on the critical path rather than its instruction count |
| **Guessing an indirect branch's target from `env` at translation time** (2026-09-21, round 41) | **Built, measured at a 9.4 % hit rate, reverted.**  `xwBx` is 39 % of the TB boundaries left and looks monomorphic — the per-TB lookup slot is refilled 24 times per Mi against 36 345 exits — and translation runs with `env` holding the state the TB is about to be entered with, so `env->regs[rN]` *is* the target whenever the register was set before the TB.  Guarded with one compare, it collected **750 hits against 7 241 misses per Mi**; the accepting sites run 7 991 times per Mi, 22 % of all `xwBx`, so even a perfect predictor there is ~2 % of wall and this one was 0.2 % | **A translation-time register snapshot is not a branch predictor: hot code is translated during the boot and outlives the phase that translated it.**  The slot's 99 % hit rate belongs to a *self-updating* cache and says nothing about a guess frozen at first translation.  A deopt-and-retranslate tier (one extra translation per site, blacklisted after) would fix the staleness and is still capped at ~2 % by the coverage — price the coverage before building the predictor |
| **A 64 KB guest page (`W64_PAGEBITS=16`)** (2026-09-21, round 41) | **Boot regression, abandoned.**  It is sound — `tlb_set_page_full` marks any guest page smaller than the target with `TLB_INVALID_MASK` and repeats the fill on every access — and it would lift `translator_use_goto_tb`, `w64_absorb`, the one-callee-page limit and the A32 `max_insns` bound in one move.  On a quiet host, in the same sweep where the baseline reached the idle screen in ~2 minutes, the 64 KB leg had not got there in five | **The SMC granule scales with the page and the TB list scales against it.**  `code_mask` is one bit per 1/256th of a page — 16 bytes at 4 KB, 256 at 64 KB — and round 37 already measured that a coarser granule collapses the rejection rate; a 64 KB page makes each granule 16× coarser *and* each page's TB list 16× longer.  A fixed 16-byte granule is buildable (`TB_GMASK_WORDS` sized for the largest page, 16× fewer PageDescs, memory a wash); the list walk behind it is not.  8 KB and 16 KB legs are **inconclusive** — the host saturated while they ran |
| **`W64_GDUP` as a price for the guest-register env-traffic row** (2026-09-21, round 41) | **The probe is inert, and the null it produces is not about the row.**  `W64_GDUP=2` reads **3.473 against 3.490 ms/Mi** on the video meter.  Each duplicate targets the same address with the same value *adjacently*, which is the one redundancy TurboFan's store-to-store and load-to-load elimination removes with no alias analysis, and ~96 % of TB entries run TurboFan code | The knob's own comment anticipated the hazard and prescribed `tbBytes` as the self-check — **but an emitted-byte count cannot separate "emitted" from "emitted and then folded".**  A duplication probe must target a *different* address that is equally hot (a pad inside `env`, or a small wrapping pool), never the same one.  The row can be bounded without it: 1.34 accesses per guest instruction at ~a cycle each is **≤ 13 % of wall**, and the half a wider TB signature reaches is **≤ 7 %** |
| **Memoising `arm_rebuild_hflags`** (2026-09-20, round 39) | **Built, validated, and it does not move the meter — reverted.**  A 16-entry memo indexed by CPSR mode (one entry misses on every syscall: the rebuilds alternate between SVC and the caller's mode), keyed on SCTLR_EL1 plus CPSR's M/PAN/IL/E, which is the complete input set of the pre-v6 short path.  It hit **100.00 %** of 5 937 calls/Mi on the video workload and a `-DHFLAGS_FAST_VERIFY` build counted **`hflagsBad` = 0 over 8 907 736 rebuilds**, so it is correct and it fires — and the A/B reads **−1.2 %** over eight windows, **+0.8 %** over the four that ran quiet.  Nothing | **The call rate was the trap.**  5 936 calls/Mi × round 30's 31.6 ns reads as 4.4 % of wall, and that multiplication is what justified building it.  The verify build then priced the idea for free in the other direction: it adds a whole *generic* rebuild to every one of those calls and costs only ~6 %, so the **short path** it replaces is worth well under 1 % and a memo recovers part of that.  When a fast path already exists, price *it*, not the function it replaced |
| **Every cheaper TB-boundary *mechanism*: the merged module's boundary half, `W64_CHAINLOOP`, `stail`, and `W64_BATCH`-as-a-locality-knob** (2026-09-17, round 32) | **All of them tie, and the merge is a regression.**  `tests/wasm/dispatchbench.mjs` was swept properly for the first time — over body size (`DB_PAD`), table size (`DB_NFUNC`), module count (`DB_NMOD`) and, the knob that turned out to matter, **target order**.  In the *strided* order every mechanism costs the same **16–17 ns at every module count**; only in the *unpredictable* (LCG) order does a 42 ns spread open up, and there `merged` — the no-crossing variant the whole merge case rested on — reads **51.13 ns against `xtail`'s 35.73** at pad 144.  The emulator's own knob had already settled which order it is in: `W64_CHAINLOOP` swaps the call mechanism and keeps everything else, and it measures **−0.1 %**, falsifying the unpredictable regime's prediction at ~7 sd | The benchmark's header described its LCG target sequence as "what a guest interpreter's dispatch looks like", and a TB chain is not that — a chained successor is **per-site predictable**, which is why round twenty-three's `dispatch-probe.mjs` read 7.7 ns and the LCG read 27.  **A dispatch benchmark has two independent knobs, the mechanism and the target sequence, and the second dominates.**  The 27 ns then propagated: three sections of the handoff sized proposals against it, and the four-point `w64_ft_max()` fit agreeing at 27.9 ns looked like confirmation when it was coincidence — see the lessons file, *A slope fitted across configurations is a bundle price*.  **When a knob in the real system already performs the synthetic's A/B, believe the knob** |
| **Replacing emscripten SjLj with native wasm exception handling on the `cpu_loop_exit` path** (2026-09-17, round 30) | **Right that it is 2.2× cheaper, wrong that it matters: ≈ 0.13 % — rejected on the rate, not the price.**  A standalone microbenchmark (`tests/wasm/sjljbench.c`, `tools/sjljbench.mjs`) put one emscripten-SjLj `longjmp` round trip at **595.7 ns** and the same unwind under `-fwasm-exceptions` at **269.2 ns**, a real 326 ns saving per event.  But 0116 had already counted the events: `execLjmp` is **23 per Mi** in the J2ME window, so the whole lever is 23 × 326 ns = **7.5 µs/Mi against 13 471 µs/Mi** | The ARM exception path — the only thing on this workload that unwinds often — **does not longjmp at all**: it leaves through a normal TB exit and `cpu_handle_exception` picks `exception_index` up on the next pass (0116's third finding).  Price × rate, always in that order; this one was priced first and the rate then closed it |
| **`bql_unlock()` on the ARM exception entry path** (2026-09-17, round 30) | ~~**~0.1 % — priced and dropped without building it.**~~  **WITHDRAWN 2026-09-17 (round 32): it is ~1.33 %, and both halves of the original arithmetic were wrong.**  The `excBqlNs` sampler measures the release at **98.4 ns**, not the ~20 ns assumed below — a factor of 4.9 — and the denominator has since halved, 13 471 → **5 738 µs/Mi**, for another 2.35×.  The sampler's own total is **1.33 % of wall**; 679/Mi × 98.4 ns is 66.8 µs/Mi = 1.16 %, and the balance is the IRQ entries, which take the same path.  `excSwi` is 679/Mi, and the *lock* half really is free: `bql_lock_impl()` adopts the deferred `bql_mmio_lazy` hold at no cost (round 13), so what is left is the `pthread_mutex_unlock` at `cpu-exec.c:1586` | **Two ways to mis-price a lever, in one row.**  The first is the one this table warns about elsewhere and this row did anyway: **the 20 ns was assumed, not measured** — "what an uncontended wasm mutex release costs" is a plausible number with no instrument behind it, and the instrument says five times that.  The second is subtler and applies to every percentage in this file: **a share is a ratio, and the denominator moves.**  Nothing about this cost changed; rounds 0104–0118 removed half the wall around it, and that alone turned 0.1 % into 1.16 %.  Re-price a rejected row against the current wall before trusting its verdict — the rejections that age are exactly the small ones.  Next step is not to build the deferral but to explain the 98.4 ns: an *uncontended* release should not cost that, so either it is waking the main thread (emscripten's `pthread_mutex_unlock` calls `emscripten_futex_wake` when a waiter is registered, which is round 12's expensive half arriving by a different door) or the sampler brackets more than the call.  Settle that first; the fix differs completely between the two |
| **An inlinable fast path for `bql_lock_mmio()`** (`QEMU_DEFINE_STATIC_CO_TLS(bool, bql_locked)` makes `get_bql_locked()` `noinline` with an `asm volatile("")` in it, so the lock/unlock pair around every MMIO access is two calls the backend cannot fold) (2026-09-17, round 28) | **~1 ns a call, ≈ 0.06 % of wall — rejected on the price, never built.**  Priced with a calibration pad, `W64_BQLDUP=N` adding N *sound* extra lock/unlock pairs: at N=32 over a 25 s controlled window the guest reads **−1.5 %**, i.e. ~1 ns per pair, against ~800 k MMIO accesses/s | The profile's `bql_lock_impl` 1.4 % is self-time on a small leaf and is an upper bound, not a budget (§ the `arm_rebuild_hflags` row below).  **The pad at small N is unreadable**: N=8 first read −3.1 % and N=32 read *faster than base* on a 12 s window — extend N until the slope is unambiguous before believing any of it |
| **`W64_NOBQL=1` as a ceiling probe** (skip `bql_lock_mmio()` entirely to price the pair by deletion) (2026-09-17, round 28) | **The guest stalled at 15 M instructions.**  No number came out of it | An unsound ceiling probe has to leave the guest *running* to be read at all, and deleting a lock does not: device state races and the boot dies before the meter's first sample.  Round 13's "ceiling-probe by deletion" works on **redundant work** (a second advance, a duplicate rebuild), not on a mutual exclusion someone relies on.  For a lock, the sound instrument is the other direction — a **calibration pad** that adds more of the same, which is the row above |
| **A fourth and eighth deferred taken path** (`W64_FTMAX` 4 and 8 against the landed 3) (2026-09-17) | **The mechanism fires and the change still loses.** Exits per Mi at matched instruction counts: ft3 107 960, ft4 106 706 (**−1.16 %**), ft8 106 140 (**−1.69 %**), three rounds each — and instructions per TB 6.73 → 7.15.  The clock disagrees: ft8 against ft3, five palindrome rounds, **−1.06 %, only 2/5** (+2.1 / −9.3 / −0.2 / +6.4 / −3.7 %), and ft4 read −1.4 % (2/5) in an earlier run.  **Three slots is the peak.**  Re-ranked after inlining on the SL65 video meter (round 47, same-binary env ABBA ×2, 4+4 legs): ft4 **+0.97 % ± 0.87 ms/Mi** at matched `hostBusy` — still no better than 3 | The exits meter predicted +0.5 % and the clock delivered −1.1 %, so something costs more than the removed exits are worth.  The candidates are both per-TB: each extra deferred path is another label, and 0109 found that label handling is what drops a TB out of the backend's nested-label mode into the `$bp` dispatch loop where every *forward* branch is O(n_labels); and a TB carrying 7.15 instructions emits more bytes, which buys modules.  **The calibration is the point: `tools/exitrate.sh` is a mechanism meter, not a verdict meter.**  It prices the exits a change removes and is silent on what the change adds — the same shape of error as the round-15 hit-rate probe that was silent on the cost added to the path that still missed.  Use it to confirm a mechanism and to *size* it; keep the clock as the verdict |
| **One helper call for a whole ldm/stm** (`W64_LSM=N`: a block move of at least N registers becomes `helper_w64_ldm`/`w64_stm`, which translates the address once with `probe_access` and runs the transfer as optimized C) (2026-09-16, round 27) | **-11.7 %, then -6.3 % after the obvious fix.**  Sizing said it should win: `ldstExec` 331 028 000 against `lsmExec` 111 449 385, i.e. **33.7 % of every executed guest memory op is inside an ldm/stm**, at 3.61 registers each, and collapsing them removes 80.6 M of 331 M inline TLB probes.  Two 4-round interleaved sweeps, 20 s windows, `halt` and `tbIcount` matched to 0.5 % throughout: first build (the transfer loop scanned all 16 bits) off 2132.5 vs lsm2 1882.5 Mi, **-11.7 %, 0/4 rounds**; with the loop reduced to set bits only, off 2028.8 vs lsm2 1900.3 (**-6.3 %, 1/4**) and lsm6 1888.0 (**-6.9 %, 1/4**).  Correctness was never the problem -- `lockstep-wasm --insns 250e6 --env W64_LSM=2` is clean | **It could have been rejected on paper, from a number already in this table.**  0106 priced a wasm->wasm import call placed in a real TB at **~14.5 ns** (`W64_CALLPAD`), and the probes the mechanism deletes are ~1.16 ns each (5.07 % of wall over 331 M of them) -- so it spends 14.5 ns to save 3.61 x 1.16 = 4.2 ns, every time.  `tools/import-probe.mjs` says 2.1-2.4 ns for the same call, and that is the trap: a microbenchmark has nothing live across the call, while a call inside a TB makes the engine spill every live wasm local *and* makes TCG treat all globals as written, so each guest register the rest of the TB touches is reloaded from env.  **Price a helper by what it deletes in nanoseconds, not in operations**; the same arithmetic already sits behind the `$tlb` hoist rejection below.  One real bug worth remembering: `op_addr_block_post()` computes the writeback from the address *the emit loop left behind*, so a helper path that passes the un-advanced base must add `(n-1)*4` itself -- without it the guest corrupts SP on every push, which shows up as the main thread wedging, not as a crash |
| **Merging a module's TBs into one wasm function** (one function per *batch*, bodies behind a `loop { block* br_table }` so a TB hands off with a `br` to a depth instead of a `return_call_indirect` through the shared table) (2026-09-16, round 27) | **Worth ~5 ns of an ~18 ns hand-off, and nothing at all when the target is predictable.**  `tools/merge-probe.mjs`, 1024 members with realistic bodies (66 locals, 20 env load/add/store of live work), hand-off cost over the work floor: `direct-c` **2.60 ns**, `ind-in-c` **4.48 ns**, `ind-in` **13.38 ns** (this calibrates the probe against production's ~22 ns), `merged-c` **4.91 ns**, `merged` **8.18 ns** | 55 % of indirect exits already land in the module they are leaving, so the mechanism *does* apply -- but the price of the transfer was never the problem.  A TB boundary is worth **~44 ns** and the call instruction is only ~6-8 ns of it; the rest is the prologue, the PC store and the inline lookup-cache check, none of which merging removes.  So the ceiling is ~3 % of wall for a module-assembler rewrite (depth fixups, group ids, packed chain words, eviction).  Consistent with round 23's "a cheaper indirect call is worth nothing -- ~6 ns is this engine's floor".  **Price the prize before building the machine**: the probe cost an afternoon, the build would have cost a week |
| **Turning off TCG's optimizer for wasm64** (`W64_NOOPT`: the backend emits a stack machine and V8 optimizes again downstream, so `tcg_optimize` looked like translation time bought twice) (2026-09-16, round 26) | **No effect, and it cost three wrong verdicts on the way.**  Read as -2.3 %, then +1 %, then -14.5 % on successive small samples.  An 8-leg interleaved sweep settled it: **the same configuration read 1830 Mi and then 2122 Mi** -- noise of the same magnitude as every "effect" claimed above it.  The optimizer stays | The lesson is about the meter, not the knob: at 20 s windows this workload's spread between identical legs is ~15 %, so **any single-pair A/B below ~15 % is unreadable**.  Interleave at least an ABBA and read the pairing, never the two numbers.  (`tcg/tcg.c` reverted with `git checkout` -- the knob was never committed.) |
| **Deferring more than one conditional fall-through per TB** (`W64_FTMAX` > 1, on top of 0108) (2026-09-16, round 26) | **Flat.**  ins/tb rises 5.35 / 5.77 / 6.13 / 6.23 at N = 1/2/4/8 while throughput reads 412 / 427 / 412 / 424 Mi | The extra deferrals land in **cold** code -- the first branch in a TB is the hot one -- and every deferral past the two `goto_tb` slots pays a `goto_ptr` lookup instead of a chain.  Also the round's cleanest methodology failure: **static ins/tb is not a proxy for dynamic work.**  It moved 16 % while the clock did not.  The `w64_ft[]` array stays sized 8 so a future attempt starts from a measurement, but the default is 1.  **SUPERSEDED by 0112 (same round, later the same day):** once 0111 lets a deferral end at a join, the slot is usually free again within a few instructions and `N = 2` is worth +4.7 %.  The rejection was correct *for the code it was measured on* -- and that is the warning worth carrying: **a knob rejected against one mechanism has to be re-measured after the next one lands**, because what made it flat was the cost of holding the slot, and 0111 deleted exactly that cost |
| **Serving inline-cache misses from the jump cache** (`w64_lc_jc`, `W64_LC_JC`: on a miss, look the target up in `CPUJumpCache` without recomposing the TB key) (2026-09-16, round 26) | **+0.10 %** -- below the noise floor established above | The inline cache already hits ~82 % of `goto_ptr` exits (`lookup` 13.9 M against 76 M exits), so the helper path it shortens is a sixth of a sixth.  Kept only as a counter (`WASM_DIAG_LC_JC`); the fast path itself was not worth the branch |
| **Raising the successor-walk budget** (`W64_SPEC_N` / `W64_BATCH_N`: a close costs ~86 µs fixed and carries only 4.85 members, so more members per close is the whole prize) (2026-09-16, round 24) | **The budget is not what binds.**  `W64_SPEC_N` 4 / 32 / 64 gives 2.64 / 4.85 / 5.39 members per close and 5.514 / 3.543 / 3.519 s of module time: doubling the budget from the shipping 32 buys **0.5 members and 24 ms**, for 7 % more translations.  `W64_BATCH_N` 16 / 32 / 128 is likewise 4.41 / 4.81 / 4.85 — the cap is reached by ~10 % of closes at 16 and never at 128 | The successor walk exhausts: `w64_explored` prunes a node whose successors all exist, and after a few hops everything does.  The batch closes on the **first execution of a member**, not on fullness, so the close count is pinned to the miss count no matter how the walk is tuned.  **The only way to unpin it is another way to run a TB before its module exists** — the interpreter tier, since landed (0101).  (Also settles the handoff's older "`W64_SPEC_N` 8 == 128" as too strong: 4 is clearly worse, 64 is a tie.) |
| **A cheap corner in `new WebAssembly.Module`** — a function-count or size threshold, or a cost hiding in imports/exports rather than compilation (2026-09-16, round 24, probed before building) | **There is none.**  `tools/modshape-probe.mjs`: cost is linear in function count with a per-call intercept over **1 → 256 functions and 23 B → 236 KB**, no knee anywhere; 64 imports add 0.09 µs each, exports are free; an empty module still costs the intercept.  Sub-timers in the app agree — `Module` is 83.8 µs of a 106.4 µs module, Instance 9.0, addFunction 2.8, the GC nudge 0.45 | The API offers exactly one lever, the number of calls.  **Found on the way and worth more than the negative result**: both this probe's and round 19's "warm" numbers were compiling *identical* wire bytes, which V8 serves from its compiled-module cache — distinct bytes cost 2.0–3.8× more (§ 0f).  Round 19's "four fifths of the 80 µs is cold cache" is withdrawn |
| **Turning off `CF_PCREL`** (set unconditionally on every ARM system-mode TB; it makes every PC materialisation a read of `cpu_R[15]` plus an add instead of a constant, and on ARMv5 every 32-bit literal is an `ldr rX, [pc, #imm]`) (2026-09-16, 0096, `W64_NOPCREL`) | **-0.7 %, 2/3 pairwise — inside noise — and +2 % lookup misses**, which at ~96 µs a module cancels most of it.  `tbGen` does not move (158–160k either way) | The saving is not there because **`cpu_R[15]` is a TCG global, and the wasm64 backend keeps globals in wasm locals for the life of the TB** — the "read" is a `local.get`, not a memory load, so `addi` costs about what the constant would.  Generalises: do not price a TCG global access as a load on this backend.  Same shape as round 21's "a load from a compile-time-constant address is not on the critical path".  The misses rise because TBs key on the virtual pc once PCREL is off and stop being shared between aliases; that `tbGen` is flat says this firmware maps its code once, so CF_PCREL's generality is unused here and still not worth removing |
| **Compaction granularity as a dispatch-locality lever** (`W64_COMPACT_MEMBERS` 256 / 1024 / 4096 — fewer live wasm instances should make a `return_call_indirect` cheaper) (2026-09-16) | **Flat.** Five interleaved pairs over a **4.6× range in compaction events** (compact 602 / 194 / 130): 20.63 / 20.87 / 20.37 ms per Mi, and a follow-up 3 pairs of 1024 vs 4096 read +1.0 % the other way.  A wash | `tools/dispatch-probe.mjs` really does show 1024 functions per module dispatching **38 % cheaper** than 128 over a 32768-function working set (60.3 vs 96.5 ns) — but that is a **uniformly random draw**, which is the worst case and not where the emulator lives.  Real guest execution has a hot set of a few hundred TBs that were translated together and therefore share a module.  **Calibration worth keeping: the probe's `live` knob is a worst case; do not read its absolute ns as the emulator's dispatch cost.**  Also measured there and not pursued: a *direct* `return_call` instead of an indirect one, at identical access patterns, saves only 1.1 ns at 128 functions per module (7.5 ns at 1024) |
| **Speculating the address after an unconditional transfer** (`b`, `bx lr`, `pop {pc}` -- the next basic block, which goto_tb never records because it notes only the branch target and an indirect exit notes nothing) (2026-09-16, 0095, `W64_LINSPEC`) | **Rejected twice over.** Performance: **+89 % speculative translations** (specMade 143k -> 271k) and **no change in the miss count**. Soundness: guessing after an *indirect* exit panics the EL71 firmware in ~4.5 s, deterministically, at a fixed guest pc ("sorry died at A04D103C"); after an unconditional branch it does not, and s75/cx70 survive it -- EL71 is the one board that programs its flash file system while booting | The economics looked inviting and are worth recording: a speculative translation is ~12 us against ~96 us for a module, so an extra edge pays at a **12.5 % hit rate**, and the edges the walk already has convert at **66 %** (`W64_SPEC_N` 0 vs 32 on a fixed-work el71 window: 127k extra translations remove 84k misses, 117881 -> 33621 — solve the two-point system, do not guess). There is headroom; this is not the edge that fills it. **The panic is unexplained and matters more than the experiment**: w64_speculate is documented as a hint that cannot change guest behaviour, and it can. Ruled out, each by experiment: tb_flush (the shipping build survives 11 and 38 flushes forced with `?qargs=-accel tcg,tb-size=24`/`=8` — which also exercises 0091's tidx recycling across a flush for the first time and finds it sound); ISA alignment (filtering the guess on `s->thumb` alignment changes nothing); and a stale TB over reprogrammed flash (adding the missing `tb_invalidate_phys_range` to the pmb887x program/erase paths does not stop it). **Recorded separately**: `hw/arm/pmb887x/flash.c` and `hw/block/pflash_cfi01.c` both write their rom device's backing RAM directly and neither invalidates TBs for the range, which `hw/nvram/nrf51_nvm.c` shows is required. Latent, not currently reachable, and `memory_region_flush_rom_device` cannot be used as-is — it asserts the region is in romd mode, which a CFI part never is while being programmed |
| **Dense `goto_tb` chain-slot arena** (16 B per TB keyed by tidx — four translations to a cache line — instead of `tb->jmp_target_addr[n]` inside a TranslationBlock allocated in the code buffer at ~1 KB stride) (2026-09-16, on top of 0091) | **A wash.** Six interleaved fixed-guest-work pairs across two sessions: −3.2, −1.1, +2.1, −7.2, +4.2, −0.0 % — mean −0.9 %, SE 1.6 %.  Op suite green, so it was correct, just worth nothing | The generalizable half: after 0091 the slot address is a **compile-time constant**, so the load issues early and its latency is hidden.  0091 won by removing a load whose address *depended on another load* — the second hop of an indirect-branch dependency chain.  **Locality only pays on a dependent load.**  That also kills the matching idea for the `w64_lc` inline-cache slots, whose address is likewise a constant the emitter knows |
| **Speculating from the link register** when the missed TB records no goto_tb successor at all — 17.5 % of misses, and r14 is where a `bx lr` / `pop {pc}` TB is about to go (2026-09-16) | **−7.6 % of wall, 3/3, with no change in miss count** (fixed guest work, el71).  `arm_w64_ret_hint` + one extra root successor | The walk it enables is not free: it runs a `probe_access_full_mmu` and a `tb_htable_lookup` on every one of those misses, which previously returned immediately — the cost the `w64_explored` pruning exists to avoid.  And the root can never be marked explored, because the hint is a *register read*, not a property of the TB, so the re-probe repeats forever.  A dynamic hint cannot use machinery built for static edges.  The static half of the same idea is 0092 and is worth 0.3 % |
| **Shrinking the backend's ~70 declared locals** so the baseline tier stops zeroing them at every TB entry (2026-09-16, priced with `W64_LOCALPAD` and `tools/locals-probe.mjs`) | **Under 1 % in-app.**  The synthetic cost is real and large — +38.9 ns on a 49.9 ns baseline-tier call, free in the optimizing tier — but only ~3.6 % of TB entries run baseline code, and the in-app slope is superlinear (0/69/200 extra locals → 0 / +1.05 % / +6.8 %), so the derivative at 70 is the small end of the curve | Building it means interleaving the i32/i64 register locals so trailing declaration runs can be patched to zero-count at finalize (the body must stay a fixed size — `qemu_ld/st` retaddrs are offsets into it) **and** renumbering `TCG_REG_TMP` off R28, or the first TB that touches the scratch register declares 58 locals anyway.  Not worth it for <1 %; revisit only if the baseline-tier share rises |  **Revised by 0114b**: a pad's slope is only valid near the N it was measured at — re-priced at `W64_LOCALPAD=192` the slope is 8.09 µs/Mi per declared local (~6 % of wall at 69), and halving the register file (`TCG_TARGET_NB_REGS` 32 → 16) landed **+2.05 %**
| **Emitted-byte count as a lever on compile time** (2026-09-16 — the fourth time, and the first with a number) | **Capped at 2.2 % of wall.**  `W64_BYTEPAD` 0/40/120 inflates modules to 5.1/7.7/14.5 KB and compile to 96/110/125 µs: **~80 µs fixed + 3.2 µs/KB**, so at the shipping size bytes are 17 % of the module cost.  The inline TLB probe, at 37 % of emitted bytes, is worth ~0.8 % | The three earlier "flat" readings (prologue cleanup, 0055's `local.tee`, the `$tlb` hoist) were −2.6 % to −3.7 % byte cuts, which predict 0.4 % against meters that resolve 3 % — they were never evidence of no effect, only of no *measurable* effect.  Now it is bounded from above instead: **module count is the only lever on the 12.5 % pipeline.**  Also ruled out the same round: the live-module count is not a factor (`tools/modgrow.mjs`, 500 → 6000 instances flat at ~50 µs, unchanged after dropping all) |
| **Merging a batch's members into one `br_table` function so it tiers up sooner** (the tiering budget was assumed to drain by function *size* per call, which would make N merged members tier up ~N² sooner) (2026-09-16, closed by probe before building) | **The premise is false.** `tools/tierup-probe.mjs` puts tier-up at **~1–2.4 × 10⁴ calls across an 85× range of body sizes** — 329 B, 2849 B and 28051 B all land in the same decade, and the calls × size product spans 47×.  The budget drains **per call** | Merging N members therefore buys N, not N² — and a batch holds 4.9 members, not 128, so it is 5× against a `br_table` on every one of ~12.8 M TB entries a second.  The number is still worth having: a TB needs ~15k entries to leave the baseline tier and the average live TB sees ~250 a second, which is why only genuinely hot TBs get there and ~3.6 % of entries stay baseline.  Compaction resets a member's budget when it re-instantiates it, but does so about once per TB and within ~1024 translations of its creation, so it costs almost nothing.  **Two ways to mis-measure it, both paid for once**: a warm-then-measure ladder cannot work (the measuring calls drain the budget, so measuring causes the transition), and the body must be *live* — a dead one is DCE'd by the optimizing tier and reads as already-tiered, a dependent add/xor chain compiles the same in both tiers and reads as never-tiered |
| **The TB-module → main-module helper-call boundary** as an explanation for `helper_lookup_tb_ptr_lc`'s 102 ns (2026-09-16) | **2.1–2.4 ns** in the optimizing tier and 3.6–4.4 ns in the baseline one, the same whether the helper is imported as an export, taken from `wasmTable.get()` the way `wasm64.c` resolves it, or reached by `call_indirect` (`tools/import-probe.mjs`) | `wasmTable.get()` hands back a genuine exported-function object, so V8 wires it as a direct cross-instance wasm call with no JS frame.  The helper's 102 ns is all body.  Useful in the other direction: at 2 ns, **moving work out of emitted code into a C helper is cheap**, and the helper then runs in the main module's optimized code instead of a TB module's baseline code |
| **The AOT module cache** (persist translated-and-compile output — `WebAssembly.Module` or its bytes — keyed by flash hash, so second boots skip the pipeline; ceiling priced at ~19.5 % of boot) (2026-09-16, probed before building) | **Dead on the platform side, both engines.** (1) Neither V8 nor SpiderMonkey will store a `WebAssembly.Module` in IndexedDB at all — `DataCloneError` on `put` in both (in-memory `structuredClone` works, 1.5/0.9 µs, but that is not persistence). (2) The bytes fallback was measured at real module size (2.47 KB × 2000, `tools/wasmclone-probe.mjs`): restore = getAll + `new Module(bytes)` + instantiate costs **56 µs/mod against 30–34 µs/mod to just compile fresh in the same isolate — 0.56–0.60× in V8 across two runs**, and **0.90–0.91× in SpiderMonkey** (179–183 vs 164 µs). (3) Writing at every batch close (one IndexedDB transaction per module) costs **0.13 ms/put (V8), 0.39 ms (FF) — ×34k modules = 4.4–13.3 s per boot, more than the whole 2.82 s compile prize**; even one bulk transaction is ~0.5–0.9 s of first-boot write. (4) The escape route — Chromium's HTTP wasm code cache via `compileStreaming` from the Cache API — gives **no code-cache hit for synthetic responses** and the streaming path itself is 12× slower than plain compile in V8 (418 vs 34 µs; `tools/wasmcache-probe.mjs`) | The browsers refuse to persist compiled modules, and byte-persistence costs more than the recompile it avoids: the read alone (~18 µs/mod at ~150 MB/s) is half a cold compile. Even the most AOT-favourable framing (83 µs cold saved vs ~30 µs restored) buys under ~1.5 s of a 25 s boot, minus the first-boot write, for a correctness surface the gates do not cover (qht/chain restore, flash-change invalidation). **The interpreter tier is the only remaining route into the module pipeline.** Side finding worth keeping: SpiderMonkey compiles the same 2.5 KB module ~7× slower than V8 (150 vs 20 µs) — the 83 µs/module economy is V8's; on Firefox the pipeline share of boot has never been measured |
| **A cached import namespace for generated modules** (one persistent `imports.e` object plus a `Map` memoising `wasmTable.get(BigInt(fptr))`, replacing a fresh object, a `'f'+i` concatenation, a BigInt and a table lookup per import per module) (2026-09-16) | **0.7 % of the thing it optimises.** The four-way split of `MOD_NS` puts building the import object at **0.026 s of 3.66 s** over a 25 s EL71 boot, against 2.82 s in `new WebAssembly.Module`. Reverted unbuilt-upon | The reasoning was sound and the premise was wrong: a close module has **2.1 imports** (`modUimp` 74 461 / 34 722 modules), not the twenty the `W64_UMAX_IMPORTS`-sized machinery suggests. **Measure the phase before optimising the loop inside it** — the split cost twenty lines and settled it, and the same split is what found the 83 us. Nothing here is worth retrying unless imports per module rise by an order of magnitude |
| **Observed goto_ptr edges as speculation successors** (`helper_lookup_tb_ptr_lc` knows the calling TB — its `slot` is `&tb->w64_lc` — so record the target it actually resolved into a `w64_isucc[2]` on that TB and let `w64_speculate` walk it; aimed at the 18.8 % of misses whose TB has no static successor at all) (2026-09-16) | **2 225 628 edges recorded, 474 TBs translated by following one.** `specMiss` went the wrong way, 34 547 -> 35 032 (+1.4 %), and `tbGen` +1.5 % for it | **An observed edge is evidence about the past.** It is recorded only after the guest took it, by which point the target is translated — so it can only ever predict a TB that already exists, and is useful solely after a `tb_flush` (which a boot does not do: `tbFlush` = 0). This is the third attempt to lower `specMiss` by giving the walk more edges, after call-return points and the `ldr pc` trampoline. **Stop adding edges.** Module count is miss count, and a miss is the guest reaching code no predecessor has ever named; only a scheme that runs cold code *without* a module can move it |
| **`arm_rebuild_hflags` as an 11 % target** (the profile's single largest vCPU entry on an idle CX70, apparently contradicting round fifteen's rejection of the `cpsr_write` hflags skip) (2026-09-15) | Not a target and never was: an unconditional entry counter (`hflagsCalls`, index 85) puts the call rate at **11,606/s**, so 11.0 % of a 30 s profile would be **9.5 us per call** for a function priced at ~76 ns.  A 10,000-iteration volatile spin placed in it took the board 113 MIPS -> **0.7 MIPS**, confirming both the rate and that the knob reaches the code | **The profiler names the wrong function.**  Profiling the spin build -- where all the work provably sits in `arm_rebuild_hflags` and calls nothing -- reported `rebuild_hflags_a32` **67.3 %**, `arm_rebuild_hflags` 20.3 %, `arm_security_space` 9.5 %, `cpsr_write` 1.0 %.  A name in a wprof2 profile identifies a neighbourhood, not a function.  Round fifteen's A/B was right and its profile was not.  Price a function from a counter times a per-call cost, or by a volatile-spin probe -- never from self-time; and see doc/lessons.md for the two ways a cost probe silently measures nothing |
| **Speculate along call return points** (after the goto_tb walk, translate each walked TB's fall-through `pc + size` on a budget of its own; that address is the return point of a `bl` and of an indirect `blx rN`, neither of which the frontend records as a successor) (2026-09-15) | EL71 boot window (100M-1500M, fixed guest work, 4 interleaved pairs): **+0.8 %, 2/4 wins** -- a tie -- for **+15 % more TBs translated** (160.4k -> 184.6k) and **no change in module count at all** (34669 -> 34436, within run-to-run noise).  It does work on an interactive path: on the EL71's second key press it cut modules 456 -> 339 (-26 %), and keylag's `madePerMiss` rose 0.33 -> 0.43 | **Module count is miss count.**  A batch is opened by a lookup miss and closed the moment that miss's TB executes, so on the EL71 boot window `close` (34922) equals `specMiss` (34922) exactly, with `temp` = 0.  Speculating *more* therefore cannot reduce modules; only speculating the TBs the guest misses on *next* can, and fall-throughs are that only on interactive paths, not during boot -- where the wall time is.  The boot already gets 5.3 TBs per module from the goto_tb graph alone.  Retry only with a predictor that lowers `specMiss`, and measure that counter, not `tbGen`.  Note also that the first attempt read `specRet=0` on every press because it copied the `CF_PCREL` guard from the trampoline heuristic beside it -- see the lessons entry on counting the fast path |
| **A second way for the per-TB inline lookup cache** (2026-09-15) | **Built, measured, reverted: the mechanism works and pays for itself exactly.** `W64_LC2`, a software ceiling probe that simulates a second way in the helper, said 42.3 % of el71's misses and 34.2 % of cx70's would hit it — against a ~100 ns helper call, a predicted +3.3 %. Built for real (`w64_lc[2]`, an LRU-of-two fill, a second compare chain in `gen_goto_ptr`, behind `W64_LC_WAYS`): `lcCall` fell **14 718 -> 8 947 per Mi, -39 %**, almost exactly what the probe promised. Wall time, A/B'd *within one binary* by flipping the knob: **el71 0.0 % (2/3), cx70 -0.2 % (2/3)** | The saved calls and the added cost cancel. Way 1 is only reached after way 0 misses — 856k/s — and each such miss now runs a second 5-7 op compare chain before the helper it was going to call anyway; emitted code grew **+20.6 %** on every goto_ptr exit. **The lesson is about the probe, not the cache**: a ceiling probe that simulates only the *hit rate* measures the benefit and is silent on the cost added to the path that still misses. Worth retrying only with a way-1 test that is cheaper than the helper call by a wide margin, or emitted only at sites known to be megamorphic |
| **Raising `W64_SPEC_N` above its default 32** (the speculative successor budget; 64 looked like a free win) (2026-09-15) | **A tie on the meter that counts.** An insns-at-fixed-wall sweep read a clean inverted-U peaking at 64 — el71 boot 753M -> 799M insns (+3-6 %), modules down, pipeline share down — and `workbench.mjs` then read **27.88 vs 27.95 MIPS over 4 interleaved pairs, 2/4 wins each**. Cross-board was already mixed (cx70 +0.7 %, s75 +1.0 %, **ke800 -3.5 %**) | The mechanism works and cancels: at 64 the modules fall 4.8 % (33 846 -> 32 213) and the TBs translated rise 6.5 % (162 726 -> 173 295), which is **module count is miss count** seen from the other side — you buy compile time with translate time at roughly par. Past 64 it inverts outright (at 512, translate 12.50 % vs compile 10.01 %). Two lessons: the knob is already at a flat optimum, and **insns-at-fixed-wall found a shape that the fixed-guest-work meter refused to confirm** — use the first to explore, never to decide |  **Superseded by the tier (0102)**: a miss no longer forces a module and speculation is default-off — the trade priced here no longer exists
| **`W64_NOGENBUMP` — the inline cache's global generation** (every `tcg_flush_jmp_cache` bumps one global `tb_key_gen`, retiring *every* `w64_lc` slot at once; at 1920 bumps/s an epoch is 0.5 ms, so the hypothesis was that slots die before they are reused) (2026-09-15) | **17 %, and no time in it.** The ceiling probe (skip the bump entirely — unsound, stale targets survive) moved `lcCall` only 14 644 -> 12 112 per Mi on an EL71 boot, with MIPS unchanged (28.7 vs 28.5) | So ~83 % of inline-cache misses are genuine: the target really does differ, exactly the megamorphic return sites 0047's note predicted. 420 k helper calls/s at any believable per-call cost is ~1 % of wall, so a sound per-page or per-ASID generation scheme would buy a fraction of that. **The probe is worth keeping** (`W64_NOGENBUMP=1`, clearly marked unsound) — it prices a perfect inline cache in one run. Retry only with a way to make *megamorphic* sites cheap, which a generation scheme is not |
| **The `ldr pc, [pc, #-4]` trampoline heuristic** (a TB ending in that insn jumps to the literal immediately after it — an edge `goto_tb` cannot record, since it is an indirect branch; read the literal through the speculation walk's non-faulting probe and queue it as an extra successor) (2026-09-15) | **The pattern is not there.** With the guard lifted and each queued TB's guest pc carried alongside the walk, the tail probe succeeds on **141 nodes per Mi** (EL71) — i.e. on essentially every node walked — and of those the pattern matches **0.004 per Mi**: about one node in 35,000, against 6.5–17.6 lookup misses per Mi. Four boards, same answer (`specTramp` per Mi: el71 0.004, ke800 0.02, cx70 0.00, s75 0.00) | It had **never once run**: it was guarded on `!CF_PCREL`, which `arm_cpu_realizefn` sets on every system-mode ARM TB, and both the code and the guard arrived in the same commit (2ad6330fdf). Two rounds read it as a live optimization. The ~35,000:1 gap means no timing A/B was needed or run — a mechanism that fires four times in a boot cannot move a wall clock. **Deleted rather than shipped behind a knob** (−26 lines): dead code that looks live costs more than it saves. Note the measurement order that made this cheap — point the counter at the *probe* first, so "the pattern is rare" is distinguishable from "the probe never ran"; the two look identical from a zero |
| **`cpsr_write` hflags skip** (rebuild only when a bit hflags actually reads changed, not merely when the instruction's field mask names one) (2026-09-15) | CX70 fixed-work **+0.6 %, 2/6 pairwise** — a tie — although it removes **93.7 %** of the rebuilds `cpsr_write` asks for (74.8M of 79.8M on a CX70 boot; 90 % of all 82.6M hflags rebuilds) and 52 % on an S75 | The mechanism is real and the change is sound — a `CPSR_HFLAGS_SKIP_VERIFY` build (take the skip, rebuild anyway, compare) found **zero** disagreements over 74.8M skips — but the time is not there to recover. The post-0071 fast path is already close to free, so `arm_rebuild_hflags`'s 3.3 % profile self-time on a CX70 is not 3.3 % of recoverable work: treat a self-time share for a small leaf function as an upper bound, not a budget. Retry only with a profile showing where that 3.3 % actually goes, and note it costs an invariant (`CPSR_HF_BITS` must stay a superset of every CPSR bit any hflags path reads) |
| **`dacr_write` value guard** (skip the full TLB flush when DACR is rewritten with the value it already holds, the guard `fcse_write`/`contextidr_write` beside it already have) (2026-09-15) | **No effect at all**: over an identical 5.1G-instruction CX70 window, `tlbFlush` 15636 → 15635 and `jcFlush` 13793 → 13795 | This firmware does not write DACR idempotently, so the flushes come from somewhere else — most likely an explicit `TLBIALL` per context switch, which QEMU must honour. The guard is still correct and costs one compare, but nothing here pays for it. If the jump-cache flushes are attacked again, **find the caller first** (they are boot-time only: `jcFlush/s` is 0 at idle) rather than guessing at candidates |
| **wasm32 runtime-JIT TCG backend (0005, ktock port fully rebased)** (2026-09-09) | v-window 2→7: JIT 18.7–20.1 s vs TCI 24.8–28.3 quiet / 45–46 loaded — **~1.3–2.3x ceiling**, and the boot deterministically hangs at v≈6 (BROM USART-RIS poll data divergence → watchdog reset → recovery loop forever; LG/no-icount boot fully dead) | per-TB dispatch protocol (instance return → C dispatcher → indirect instance call per chained TB) + per-new-TB JS `WebAssembly.Module` compile eat the codegen gains on this 3–4 insn/TB branchy firmware; ~4200-line surface; discarded |
| **tci.c interpreter stack as a parameter** (split `tcg_qemu_tb_exec` into a core + wrapper taking `uint64_t *call_stack`) | TCI v-window 25→45 s (**−60%**, 4/4 interleaved runs) | the pointer-select makes the interpreter stack alias every local array in LLVM's analysis; the TCI stack is per-TB scratch anyway — keep a single function with a local array |
| **MMIO dispatch fast path** (memory.c: direct `ops->read/write` call for exact-size aligned accesses, skipping valid-check + access_with_adjusted_size + accessor layers; reentrancy guard replicated; `__EMSCRIPTEN__`-gated) | window 24.9–25.2 → 25.1–25.3 s (**consistently 0.1–0.7 s WORSE on a quiet host**, 4/4 pairs); finalV ±noise; insns@110 s +0.1–5.8 % inconsistent; a late-window A/B (LO=30 HI=60) was flat too | the pre-dispatch condition chain (accepts/align/size/trace/ioeventfd checks) costs as much as the ~3 non-inlined calls it saves at ~90k dispatches/s; V8 already keeps the dispatch path hot. Reverted; don't retry a *runtime* cache without cross-TU inlining (LTO). **NOT the same as the current workstream's fill-time precompute** (store `(fn, opaque, attrs)` in the iotlb entry when it is filled — zero added per-access checks): that one is the plan in [performance-handoff.md](performance-handoff.md) slice 1 |
| **TLB table-base caching in the TCI interpreter** (cache `(fast->table, fast->mask)` per mmu_idx across ops, dropped after helper calls and ldst fallbacks — the only paths that can resize/flush the tlb on this single-cpu machine) | window 25.9/25.2/25.2/25.2 → 24.5/25.3/25.1/25.1 (flat, ±0.1); late-window LO=30 HI=60: 19.7/20.3 → 19.6/20.0 (flat); finalInsns won 4/4 (+1…5.7 %) but finalV-at-200 s varies ±45 v run-to-run — no reproducible win | the two saved loads are L1-hot; the memory-op path is at its practical floor for micro-tweaks (0011+0012 already removed the real work). Reverted; only a big lever (64-bit TCI encoding, wasm32 JIT) can move the interpreter now |
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
| **A per-memop-site TLB entry cache** (each `qemu_ld/st` site gets its own two-word slot — page key tagged with a global generation, host addend — checked in two loads before the inline probe; the probe stays as the miss arm) (2026-09-16, `W64_SITECACHE`, built end to end and reverted) | **4.4–5.0 % SLOWER.**  Fixed guest work, EL71, knob flipped inside one binary: 26.62 s cache-off vs 27.83 s cache-on.  `W64_SITEPOOL` 512 / 8192 / unlimited read +8.4 / +5.0 / +5.0 %, so it is **not** slot locality — the unlimited pool loses exactly as much as an 8192-entry one | Everything that priced it was right and the conclusion still did not follow.  The probe really is 5.07 % of wall (`W64_TLBDUP`), the two-load check really is 2.33 % (`W64_TLBCHEAP`), and sites really do stay on one page 94.7 % of the time (`W64_TLBHIT`: 1 656 776 205 hits / 91 863 184 misses).  What those three numbers cannot see is the branch structure: the cache adds an `if/else` that every memop executes, and the hit arm must **duplicate the fast load/store** (hence `w64_ld_fast`/`w64_st_fast`), so the emitted memop grows a test, a taken branch and a second copy of the access to save a probe that was already predicted-taken and out of the dependency chain.  **Generalizes to every "check before the check" idea on this backend**: a duplicate-probe instrument emits the code *straight-line, outside any branch*, so it prices the work and not the branch it would really live behind — +5.07 % is an **upper bound** on deleting the probe, not a budget to spend.  Retry only with a scheme that *replaces* the probe rather than fronting it |
| **Emitted byte count as a lever on execution** (distinct from the compile-time lever above: the i-cache/tier-up cost of a bigger TB body, tested by padding every TB with dead-but-live filler) (2026-09-16, `W64_BYTEPAD` 0/1/10/30/60/120) | **Flat to +420 bytes per TB — about double the module size.**  27.22–28.03 s against a 27.2–27.6 s baseline across N = 0, 1, 10, 30, 60; no monotone trend.  The +17.6 % cliff at N = 120 is a **`tb_flush` artifact**, not the i-cache: `tbFlush` goes 0 → 1, `tbGen` 159 k → 204 k and `mods` 33.6 k → 40.8 k, i.e. the padded code overflows the code buffer and the whole translation is redone | Check `tbFlush`, `tbGen` and `mods` before reading any wall number from a knob that changes code size — a code-buffer overflow looks exactly like a cache cliff and is 10× larger.  Second finding, awkward and recorded rather than resolved: **`modMs` per module is flat from N = 0 to N = 60** (≈100–109 µs) across roughly a doubling of module size, which does *not* fit the ~80 µs + 3.2 µs/KB compile model from 0086's close-vs-compaction solve.  Either the marginal byte term is far smaller than that fit says or it is swamped by the per-call cold-cache term; do not plan against the 3.2 µs/KB slope until someone re-derives it |
| **Dispatch locality — making `return_call_indirect` cheaper by shrinking the live function set** (2026-09-16, `tools/dispsize-probe.mjs`) | **At most ~2 % of wall, with no mechanism to collect it.**  The probe sweeps distinct call targets under a random draw: 8 → 6.03 ns, 64 → 6.06, 512 → 7.21, 4096 → 8.24, 32768 → 14.19, 131072 → 22.67 — a clean cache-size curve with a hard floor at ~6 ns.  The emulator's 7.7 ns sits between 512 and 4096, i.e. **already near the floor**, so even collapsing the working set to eight functions is worth 1.7 ns of a 7.7 ns dispatch ≈ 2 % of wall | Third and last visit to this idea, after the two compaction-granularity sweeps above.  The indirect call is not slow because of where its targets live; ~6 ns is what a `return_call_indirect` costs on this engine even with eight of them.  **The floor, not the curve, is the number to remember.**  Anything that wants the dispatch back has to execute fewer dispatches, not cheaper ones |
| **`return_call_ref` / typed funcref tables instead of `return_call_indirect`** (drop the runtime type check by carrying a typed reference, or by declaring the shared chain table with a concrete `(ref $tbfn)` type) (2026-09-16, `tools/callref-probe.mjs`) | **`return_call_ref` is 45 % worse**: 11.68 ns against 8.04 ns for the plain indirect call.  A **typed non-nullable table** is 7.52 ns, **−6.5 %** — real, but 6.5 % of a 9 % line item is ~0.6 % of wall | Kept as a live micro-item rather than a rejection: the typed table needs the GC/typed-funcref proposal in every shipping target and touches `w64_batch_*`'s element segments, for 0.6 %.  `return_call_ref` is rejected outright — passing a reference costs more than the type check it removes, which is the opposite of the usual intuition and the reason to have measured it |
| **memory64's bounds checks as a per-memop tax** (a 2 GB `memory64` cannot use the 4 GB guard-page trick a `memory32` gets, so every guest access was assumed to carry an explicit compare) (2026-09-16, `tools/mem64-probe.mjs`) | **Free.**  0.241 (m32) / 0.253 (m64) / 0.258 (m64, index forced dynamic) ns per load at a 2 GB memory — a 5–7 % spread on a load that is already the cheapest thing in the emitted code | Closes a standing suspicion about the backend's choice of `memory64` at its root, and with it any thought of splitting the heap into `memory32` windows.  The guest-memop cost is the **TLB probe** (5.07 %), not the wasm bounds check |
| **Neighbour / jump-table speculation** (translate pc ± k around a miss: 18.0 % of misses are within ±4 words of an earlier miss and 36.4 % within ±12, which looks like dense jump tables and short forward branches) (2026-09-16, offline replay of a 32 394-pc EL71 miss trace) | **Below break-even unfiltered, negligible filtered.**  Speculating every neighbour hits **10.0 %** against a **12.5 % break-even** (~12 µs a speculative translation vs ~96 µs a module).  Filtering on the guest instruction at the target being an ARM `B`/`BL` lifts the hit rate to **23.6 %** — comfortably profitable per attempt — but only **10.1 %** of missed pcs sit at a branch at all and **2.9 %** inside a run of ≥3 consecutive branch words, so the filtered scheme prevents **1.1 %** of misses | Fourth scheme aimed at `specMiss` and the first priced *before* any code was written, by replaying a recorded miss trace instead of building a predictor.  **Replay the trace; the arithmetic is the experiment.**  The ±4 clustering is real and is still not predictive: it is mostly the guest walking *forward* through code the walk would have reached anyway, which is why raw proximity converts at 10 % while the branch-filtered subset converts at 24 % and is almost empty.  Consistent with the standing rule — the miss stream is edge-limited, and only running cold code *without* a module can move it |
| **TPU event RAM as its own MemoryRegion** (2026-09-15; `memory_region_add_subregion` at TPU_RAM0, one page, page-aligned, with its own tiny `ram_ops` so `full->io_write_fn` points straight at the RAM handler instead of `tpu_io_write`'s ~40-case switch; plus `disable_reentrancy_guard` on both TPU regions, which drops the `io_guard` load and the two `engaged_in_io` stores from every access) | S75 idle **−2.3 % MIPS and v/wall, 1/4 pairwise wins** vs the same tree without it. Not a dispatch regression: `ioStFast/ioSt` stayed 98.8 % on both legs, so the fast path still resolved to a leaf | the switch was not what the RAM write was paying for — 1.7M writes/s reach it through a range compare clang puts early — and the extra flatview section costs more than that compare. Same shape as the rejected **MMIO dispatch fast path** row above: the per-access work removed was smaller than the structure added. The `disable_reentrancy_guard` half was never measured alone; it is ~3 memory ops on 3.3M accesses/s ≈ 0.3 %, under this meter's ~2–3 % floor, so it needs a profile, not a wall A/B |

## Remaining reference: the measured cost model and closed levers (the ranked plan lives in performance-handoff.md)

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
   reference.  (Declared *locals* are a different axis and a real one:
   0114b re-priced the slope at `W64_LOCALPAD=192` — 8.09 µs/Mi per
   declared local — and halving the register file landed **+2.05 %**;
   a pad's slope is only valid near the N it was measured at, which is
   why the § REJECTED locals row first read "under 1 %".)
   Per TCG opcode (temporary histogram in `tcg_gen_code`, first 1.5 M
   ops): `qemu_ld` 83.9 B/op and `qemu_st` 86.9 B/op = 37 % of all
   emitted bytes (the inline TLB probe), `add` 12.0 B × 4.2/TB,
   `goto_tb` 57 B, `goto_ptr` 65 B, `mov` 5.0 B × 6.3/TB, `brcond` 18.9 B.

0c. **Where the boot's time actually goes (counters, rounds 17–19).**
   This replaces a 2026-09-13 wprof2 self-time table that stood here for
   five rounds and was wrong in both directions — round sixteen showed a
   profiler name identifies a neighbourhood rather than a function, and
   rounds 17–19 re-derived the same quantities from counters, where the
   run-to-run spread is 0.04 % instead of tens of percent.

   The translate-and-compile pipeline is **19.5 %** of an EL71 boot, so
   the boot is *not* compile-bound and the other ~80 % is guest code plus
   the device/lookup paths. Inside the pipeline, per 25 s EL71 boot:

   | phase | s | note |
   |---|---|---|
   | `new WebAssembly.Module` | 2.82 | 77 % of `modNs` |
   | `new WebAssembly.Instance` | 0.31 | |
   | `addFunction` | 0.10 | |
   | building the import object | 0.026 | 2.1 imports per module, not 20 |
   | `tcg_gen_code` (translate) | ~2.2 | ~13 µs × ~170k TBs, ~8.5 % of wall |

   **A module costs ~83 µs to create and the size term is invisible**
   (~80 µs fixed + ~1.4 ns/byte; `W64_SPEC_N` 8/32/128 reads 83.6/82.7/
   83.3 µs across a 1.5× byte range). Compile time is therefore
   `83 µs × module count`, and **module count is speculation-miss count**
   (0080): a batch opens on a lookup miss and closes when its first
   member runs, so `close` == `specMiss` exactly.

   **Four fifths of that 83 µs is not compiling.** `W64_MODBENCH=1`
   compiles one real module's own bytes 200× back-to-back inside the
   vCPU worker's own isolate: 12–31 µs. Size, the 69 locals per TB
   function, control-flow density, the GC nudge, machine load and live-
   module count were each eliminated separately. The remainder is cold
   cache — the compiler's working set evicted by ~700 µs of guest code
   between calls.

   Consequences, all of which are now REJECTED rows: halving compiled
   bytes buys nothing (compaction is 0.13 s of 2.98 s); `W64_SPEC_N`=64
   is a tie because 83 µs/module against ~13 µs/TB is par; and adding
   instructions to a hot path costs *module count*, which is why the
   `W64_LDSTPAD` calibration confounds itself at n=12 (+8 556 modules).

   **Post-tier caveat (0101–0105):** with the interpreter tier a miss
   no longer forces a module — batches fill toward `W64_BATCH_N` and
   close on promotion, so `close == specMiss` no longer holds and the
   fixed-close-cost dominance above inverted (see 0f).

0d1. **What a TB boundary costs, on the video workload (round 41).**
   Two same-binary legs, `W64_INLINE` 4 against 0, counters on in both:
   100 080 boundaries/Mi at 3.505 ms/Mi against 168 145 at 4.124, i.e.
   68 065 boundaries for 0.619 ms — **9.09 ns each**, and the census's own
   counter bump is inside that, so the shipped figure is ~8 ns.  At
   88 316 /Mi after round 41 the row is **22 % of wall** and it is the
   only large one left.  Round 23's 33 ns below is EL71 at 9.35 ms/Mi and
   does not transfer; its other half — *changing an exit's kind is worth
   nothing, only removing it pays* — does.  A TB-lengthening change then
   beats its own census, because the entry costs it divides (locals
   zeroed by Liftoff, globals synced and reloaded across the hand-off) are
   not counted as boundaries: round 41's two mechanisms remove 11.8 % of
   the boundaries and measure **+6.3 %**.

0d. **Where the other ~80 % goes, and what a TB transition costs
   (counters, round 23).**  Same method, applied to execution instead of
   the pipeline.  EL71 at ~49 Mi/s, i.e. **20.4 ns per guest
   instruction**:

   | line item | share of wall | how it was obtained |
   |---|---|---|
   | emitted TB body | ~48.6 % | remainder after everything below |
   | TB → TB transition | **9.1 %** | 240.6 k transitions per Mi × 7.7 ns |
   | module pipeline | ~10 % | 83 µs × module count (0c) |
   | `helper_lookup_tb_ptr_lc` | ~4.9 % | call count × 102 ns |
   | *of the TB body:* the inline TLB probe | **5.07 %** | `W64_TLBDUP`, measured directly |
   | translation (`tcg_gen_code`) | ~2.5 % | 13 µs × tbGen |
   | memop slow path | ~1.9 % | |
   | cpsr / hflags / exceptions | ~2.7 % | |
   | devices | ~1.6 % | |

   Exit mix and what each exit costs: see 0h — the round-23 census that
   stood here predates the TB-shape work (0108–0113) that more than
   halved exits per Mi.

   (The 0098 commit message says "~12 %" for the transition line; that
   was an arithmetic slip over its own inputs — 11.8 M transitions/s ×
   7.7 ns is 9.1 %, which is the figure above.)

0e. **How long a translated TB lives (counters, round 23).**  `W64_TBHIST=1`;
   EL71, 2528 Mi, `tbFlush` 0.  173 583 TBs translated, 586 M entries.

   | entries in this TB's life | TBs | share |
   |---|---|---|
   | never entered | 47 251 | **27.2 % of translated** |
   | exactly 1 | 45 406 | 35.9 % of entered |
   | ≤ 3 | 63 689 | 50.4 % |
   | ≤ 31 | 93 568 | 74.0 % |
   | ≥ 2²⁰ | 107 | 0.08 %, and **half of all entries** |

   Bimodal with an enormous gap: a TB that will be hot is hot
   immediately.  S75 is the same (36.5 % / 72.7 %), so it is guest code,
   not a board.  Two things follow.  **Any scheme that treats cold and
   hot TBs differently gets a clean separation almost free** — promoting
   at 32 entries leaves 74 % of entered TBs cold for 0.25 % of all
   entries.  And **a quarter of what the backend translates is never
   run at all**, which is speculation's over-reach priced from the other
   side: 47 251 TBs × ~12 µs = ~0.57 s of an EL71 boot, unavoidable
   without a predictor the miss-stream work has already closed.

0f. **What a wasm module costs, as a law (counters, round 24).**  The
   figure quoted since round 19 — "~80 µs fixed + 3.2 µs/KB" — was
   fitted by *inflating* one population with `W64_BYTEPAD`, over a 2.8×
   range of bytes at a fixed 4.9 members.  Round 24 fits it over a
   **48× range of members** instead, by moving the close policy, and
   every point is a real batch of real emitted code:

   | knob | members/close | closes | modNs | µs/close |
   |---|---|---|---|---|
   | `W64_SPEC_N=4` | 2.64 | 54 784 | 5.514 s | 100.6 |
   | `W64_BATCH_N=16` | 4.41 | 39 345 | 4.025 s | 102.3 |
   | `W64_BATCH_N=32` | 4.81 | 35 996 | 3.720 s | 103.3 |
   | shipping | 4.85 | 35 708 | 3.543 s | 99.2 |
   | `W64_SPEC_N=64` | 5.39 | 34 393 | 3.519 s | 102.3 |
   | `W64_NOCLOSEEXEC=1` | **128.1** | **1 352** | **0.600 s** | 443.8 |

   Two points 26× apart give **~86 µs per close + ~2.8 µs per member**,
   and the four in between sit on that line.  At the shipping 4.85
   members the per-member term is 13.6 µs against 86 — so **96 % of the
   boot's 3.5 s of module time is the fixed cost of closing too often**,
   and neither bytes nor members nor batch size is the lever.  Only the
   close count is.

   Decomposed by sub-timer (shipping, 36 083 modules, 106.4 µs each):
   `new WebAssembly.Module` **83.8 µs (79 %)**, Instance 9.0, pre 5.2,
   addFunction 2.8, import object 1.2, GC nudge 0.45.  There is no
   second thing to attack.

   And `new WebAssembly.Module` has **no cheap corner**
   (`tools/modshape-probe.mjs`, synthetic modules in Chromium): cost is
   linear in function count with a per-call intercept, across 1 to 256
   functions and 23 B to 236 KB, with no threshold anywhere; 64 imports
   cost 0.09 µs each and exports are free.  The only lever the API
   offers is fewer calls.

   **Correction to round 19.**  That round concluded "four fifths of the
   80 µs is not compiling — the same bytes compile in 12–31 µs
   back-to-back".  *The same bytes* is the flaw: V8 keeps a
   compiled-module cache keyed on wire bytes, so a repeat compile is a
   cache hit.  Measured with one immediate byte perturbed per call
   (`modshape-probe` case G, 1 KB/function):

   | functions | identical bytes | distinct bytes | ratio |
   |---|---|---|---|
   | 1 | 7.3 µs | 27.9 µs | 3.8× |
   | 5 | 14.6 | 40.5 | 2.8× |
   | 32 | 46.8 | 125.7 | 2.7× |
   | 128 | 149.4 | 305.8 | 2.0× |

   So most of that "cold cache" gap was a cache *hit*, not cache
   coldness, and `W64_MODBENCH`'s number is not a floor the emulator
   could approach by being warmer.  The emulator never compiles the same
   bytes twice.  **Generalises: a repeat-the-same-input microbenchmark
   of a compiler measures its cache.**

   **Post-tier correction (0101–0105):** the law above was fitted by
   moving the close policy at ~5 members per close.  With the tier,
   batches fill (~284 members at the 1024 cap) and every close is a
   promotion, so module time is dominated by the per-member term and
   the close count is retired as a lever.  The no-cheap-corner and
   wire-byte-cache findings stand.

0h. **The exit census after 0108–0113, and which guest instruction asks
   for each one (counters, round 28).**  EL71, per Mi at matched
   instruction counts, wall 9.35 ms/Mi:

   | exit | per Mi | share |
   |---|---|---|
   | `goto_ptr` | 72 003 | **66.7 %** |
   | `goto_tb` which = 0 | 16 409 | 15.2 % |
   | `goto_tb` which = 1 (fall-through) | 18 920 | 17.5 % |
   | self-chaining `goto_tb` | 628 | 0.6 % |
   | **total** | **107 960** | at ~33 ns each = **38 % of wall** |

   `W64_XWHY=1` splits the `goto_ptr` two thirds by the instruction that
   asked for it (EL71, 2049 Mi):

   | reason | per Mi | share of `goto_ptr` |
   |---|---|---|
   | `xwOther` — a **direct** branch refused a `goto_tb` | 25 126 | 41.5 % |
   | `xwBx` — `bx`/`blx` register, i.e. returns | 23 087 | 38.1 % |
   | `xwDefer` — a deferred taken path with no slot left | 5 950 | 9.8 % |
   | `xwPsr` — `msr cpsr` | 4 078 | 6.7 % |
   | `xwPcst` — a store to r15 (`pop {pc}`, `ldr pc`) | 1 279 | 2.1 % |
   | `xwRfe` — `rfe`, `ldm` with SPSR restore | 1 018 | 1.7 % |

   **`xwOther` is calls and `xwBx` is their returns, and they balance
   (25 126 ≈ 23 087) as they must.**  A `bl` is a direct branch with a
   static target, but `translator_use_goto_tb` refuses it unless the
   target is on the TB's own page — and this CPU is an ARMv5, so
   `arm_cpu_realizefn` picks **`pagebits = 10`, a 1 KB page**, which most
   calls clear.  Together the pair is **45 % of all exits ≈ 17 % of
   wall**: the largest single removable block left, and the only one
   whose removal means inlining a callee into its caller's TB.

   Three things this closes or bounds:

   - **Changing an exit's *kind* is worth nothing; only removing it
     pays.**  A boundary is ~33 ns whatever kind it is, because the cost
     is the tail call plus the prologue and the global sync, not the
     lookup.  Chaining the cross-page direct branches soundly (a
     `tb_key_gen`-guarded chain, exactly the inline cache's own soundness
     argument) would save the pc compare the static target makes
     redundant — 1 load and 1 branch, **≈ 0.3 % of wall**.  Likewise a
     third and fourth `goto_tb` slot for `xwDefer`.
   - **`msr cpsr` is not what the comment in `gen_set_psr` says.**  It
     calls the firmware's critical sections "the most frequent TB exit of
     the boot"; measured, it is 6.7 % of indirect exits and **1.2 % of
     wall**.  Letting the TB continue past it under a runtime hflags
     check is buildable on the deferred-path machinery and is worth that
     and no more.
   - **A perfect next-TB cache is worth 5.2 %** (§ the lookup helper,
     round 28), which is the ceiling on every inline-cache idea.

0i. **Where a *running J2ME game* spends its time (profile + counters,
   round 30).**  Everything above 0h was measured on a boot or an idle
   menu.  A J2ME MIDlet is a different workload — a bytecode interpreter
   inside the guest, driving a full-screen blit every frame — and it is
   the one the user actually waits on.  `tools/j2mebench.mjs` boots
   CX70_games.bin, navigates Centre → 3 → 1 → Centre, plays, and reports
   `MIPS/cpu`; `tools/perf/prof.sh` holds the *played* game on screen and
   attaches `wprof2` to the vCPU worker, so this is the game's steady
   state and not an idle canvas.

   Game 1, 60.8 s of vCPU samples at ~96 % busy, 11.30 ms/Mi:

   | bucket | share of vCPU | what it is |
   |---|---|---|
   | JIT'd TB modules (`wasm://wasm/…` URLs) | **64.4 %** | emitted guest code |
   | main module C | 32.8 % | helpers, devices, dispatch |
   | `emscripten_futex_wait` | 2.2 % | genuinely idle |
   | JS glue | 0.5 % | |

   The C third, grouped (share of vCPU; × 11.30 ms/Mi gives ms/Mi):

   | group | share | per-event price |
   |---|---|---|
   | TB dispatch + lookup | **10.7 %** | `helper_lookup_tb_ptr_lc` **28.5 ns** × 15 839/Mi |
   | ARM exception round trip | ~6 % | see the discrepancy below |
   | display chain (`dif_*`/`lcd_*` only — see the fifth bullet) | 4.3 % | **28.0 ns/word** in the DIF, **9.6 ns/px** in the LCD |
   | softmmu slow paths | 2.5 % | |
   | BQL / mutex | 2.6 % | |
   | SMC / dirty | 1.5 % | `tb_invalidate_phys_range_fast` **286 ns** × 434/Mi |
   | `arm_rebuild_hflags` | 0.9 % | **54 ns** × 1 874/Mi |
   | module pipeline | **0.15 %** | — |

   Four things this says that the boot profiles do not:

   - **The module pipeline is gone.**  It is 10–20 % of a boot (0c, 0f)
     and **0.15 %** of a running game: `tbGen/Mi` is 4.2 against the
     boot's hundreds.  Every conclusion in 0c/0f/0d about compile time
     is a *boot* conclusion and must not be carried into J2ME work.
   - **The exit mix is more indirect than any boot's** (`W64_XCOUNT=1`,
     game 1, 1980 Mi; the counters are in the generated code so the
     per-Mi rates are exact and that run's wall is not comparable):

     | exit | per Mi | share |
     |---|---|---|
     | `goto_ptr` | 80 781 | **67.8 %** |
     | `goto_tb` which = 1 (fall-through) | 22 371 | 18.8 % |
     | `goto_tb` which = 0 | 16 010 | 13.4 % |
     | self-chaining `goto_tb` | 16 | 0.01 % |
     | **total** | **119 161** | 8.4 guest insns per TB entry |

     Of the 80 781 `goto_ptr` exits the inline cache answers 64 942
     (**80.4 %**) inside emitted code and only 15 839 reach the helper.
     So two thirds of all boundaries are an indirect call whose target
     the *hardware* cannot predict either — which is the quantity the
     row below is about.

   - **A TB boundary is much more expensive here than on the boot.**  A
     four-point `w64_ft_max()` sweep on this game fits
     `ns/insn = 9.83 + 27.87 × exits/insn` to within 1.2 %, i.e.
     **27.9 ns per boundary** against 0h's ~33 ns for EL71 — but at
     ~108 k boundaries/Mi and 11.30 ms/Mi that is **27 % of wall**, and
     `tests/wasm/dispatchbench.mjs` says the transition instruction
     itself is the reason: an *unpredictable* `return_call_indirect` is
     ~27 ns on this engine, the same call made from a `loop` is
     ~12.7 ns, and the gap vanishes once the target is predictable.
     That reopens the dispatch-locality row in § REJECTED, which
     measured ~6 ns — it measured a **predictable** target.  See
     `W64_CHAINLOOP` in `tcg/wasm64/wasm64.h`.
     (Settled by the round-32 dispatchbench sweep, § REJECTED: a real
     chain is per-site *predictable* — the strided regime, where every
     mechanism ties at 16–17 ns — and `W64_CHAINLOOP` itself measured
     −0.1 %; the 27.9 ns fit was a bundle price, not a mechanism.)
   - **The inline cache is not the lookup lever — in C.**  The pc-cache
     already catches 14 568 of 15 839 misses = **92.0 %**, so a second way
     *in C* is duplicating it.  What costs is the 28.5 ns call, not the
     miss.  The corollary is not "drop the second way", it is "put it
     where the call isn't": a second way in *emitted* code answers the
     same 92 % without the call at all, which is what `W64_NOPCCIN`
     (mechanism K, `gen_goto_ptr_pcc`) A/Bs.  Two levels, not one — way 1
     is the per-TB slot at ~5 ops and 80.4 % of exits, and pulling it out
     in favour of a single pc-keyed way costs more than it saves, because
     the pc-keyed compare is five times longer.
   - **The DIF now costs 3× the pixels it feeds.**  After the burst work
     (0104–0107) the DIF's own per-word TX packing is 28.0 ns/word
     against `lcd_transfer_run`'s 9.6 ns/px, and the two cancel: the DIF
     packs 16-bit words MSB-first into a byte buffer that `lcd_run_rows`
     immediately reassembles with `tx[2i] << 8 | tx[2i+1]`.  37.6 ns/px
     combined against a ~2–3 ns floor = **4.1 % of wall**.
   - **A profile bucket drawn by symbol family undercounts a
     cross-cutting path — here by 3.5×.**  The three display mechanisms
     of round 31 (`W64_NOLCDROW`, `W64_DMACOAL=1`, `W64_NORXTAIL`,
     A/B'd together as one bundle, 8-leg palindrome, games 1 and 2) are
     worth **+17.5 % of `MIPS/cpu` = 1.83 of 12.25 ms/Mi = 15 % of
     wall**, with every "on" leg above every "off" leg in *both* games
     (g1 94.15/112.33/109.63/96.22 vs 87.78/89.35/91.58/82.47; g2
     85.69/86.64/97.62/85.63 vs 73.98/73.69/79.78/74.69) and the two
     halves agreeing to 1.8 pp.  The table above predicts 4.3 %.  It is
     not wrong, it is *narrow*: it counts only symbols named
     `dif_*`/`lcd_*`, while a display word also pays DMAC scheduling,
     `memory_region_dispatch_write`, the BQL round trip and a
     `timer_mod`/`icount_get` re-arm — which the same table books under
     "softmmu slow paths", "BQL / mutex" and nothing at all.  **Group a
     profile by the path an event takes, not by the prefix its symbols
     share**, or the biggest lever on the board reads as the fourth
     biggest.  `W64_DISPNS=1` splits the bundle by stage and the
     per-knob palindromes say which of the three earned it.

   **Settled by 0116's counters:** ~90 % of ARM exceptions are guest
   `SVC`s (`excSwi` 4 947 895 against `excIrq` 537 242 over a 40 s S75
   window, every other kind zero), exceptions are 77 % of dispatcher
   re-entries (`armIrq` 1.85 M against `execIter` 2.41 M in 20 s), and
   the path never unwinds — `execLjmp` is 34 per boot, so the ~15 µs
   JS-exception unwind is priced on a call rate that does not exist.
   **Unsettled:** the exception round trip prices at ~1 030 ns per SWI
   from the profile (683 `excSwi`/Mi) but ~174 ns from the round-28 C
   timer.  A factor of six is not a measurement error on one side; run
   `W64_EXCNS=1` before believing either.  **Round thirty-nine did, on
   the video workload: neither.**  `arm_cpu_do_interrupt` is 52.3 ns net
   and the BQL pair around it is under the instrument's 75.1 ns floor —
   but removing the *other* BQL round trip, the one `cpu_handle_interrupt`
   was making to clear `CPU_INTERRUPT_EXITTB` after every exception and
   which no instrument was bracketing, bought **4.9 %**.  When two
   instruments disagree about a path, suspect that neither is watching
   all of it.

0j. **Where a *decoding video clip* spends its time (counters, round 39).**
   `tools/videobench.mjs`, SL65v49 TIM, `Berlin.3gp`, 12 virtual s
   uncapped, 4.12 ms/Mi.  Read it next to 0i: same engine, opposite
   workload.

   | per Mi | video (SL65) | J2ME game 1 (CX70) | |
   |---|---|---|---|
   | `excSwi` | **2 360** | 444–1 109 | one guest syscall per 424 insns |
   | `hflagsCalls` | 5 936 | 1 205–2 936 | 2.51 per exception, the same constant ratio |
   | `lookup` (helper) | **2 683** | 15 839 | 6× *fewer* — this guest chains well |
   | `tbGen` | 0.5 | 4.2 | nothing to translate; the module pipeline is not visible at all |
   | `duty` / `halt` | 1.000 / 0 | 1.000 / 0 | neither workload ever idles |

   So the levers rank in the opposite order.  Dispatch — 10.7 % of a
   J2ME game and the target of most of rounds 26–32 — is a sixth of the
   rate here; the exception path, ~1 % on a game, is where this
   workload's fixed costs live.  **Pick the workload the complaint names
   before picking the lever**: a patch ranked on J2ME can be worth
   nothing on video and the other way round.

   What this does *not* say is that the engine is close to enough.  At
   `duty` = 1.0 the guest wants a whole 125 MHz SL65 continuously, this
   desktop delivers `rt` = 2.04, and a phone runs ~5× slower per
   instruction — so real time on the phone needs about **2.5×**, which
   no item in the C third can reach.  Beyond it lies the emitted code
   (70 % of the vCPU here, by module URL, the one attribution a wasm
   profile can be trusted for).

0k. **The same clip after round 40 (SVC in the TB, callee inlining, 4 KB
   pages).**  The C third of 0j was mostly the syscall's dispatcher round
   trip — `cpu_exec_loop`, `tcg_qemu_tb_exec`, two `bql_lock` pairs
   guarding empty hook lists, `replay_exception`, `tb_lookup` — and it is
   gone: `execIter` 2 387 → 28 /Mi, C-side `lookup` 2 687 → 328, the main
   module under 10 % of the vCPU.  The boundary census moved from 166 834
   exits/Mi at 6.0 guest instructions per TB entry to **100 080 at 10.0**:
   returns 60 607 → 36 343, direct branches refusing a chain 66 363 →
   7 391 (+ 9 665 `bl` refused for a page or depth rule), `tlbFill` 1.12
   → 0.27.  Three lessons that generalise:

   - **A refund after an observation moves a clock the device already
     saw.**  A mid-TB device access reads virtual time with the whole TB
     prepaid ("one TB ahead", by design); any icount refund emitted after
     it (deferred taken path, join, loop exit, inlined-return miss)
     steps that clock backwards, and a device that keeps `now - last`
     then spins.  `w64_refund` refunds only while `can_do_io` is clear.
     The hazard existed before inlining and never fired because a device
     access and a refund rarely shared a 6-instruction TB.
   - **A capture that drops lines looks like a compiler that drops ops.**
     The console forwarder loses lines under a burst; the op dump of a
     TB read that way was missing eight `goto_ptr`s that a walk of
     `tcg_ctx->ops` in C found present.  Count in C before believing a
     listing.
   - **The instruction-per-TB cap is a page rule in disguise.**  A32
     bounds a TB to the instructions left on its *entry* page; anything
     that moves the stream (absorb, inlining) has to re-bound from where
     the stream is, or the cap ends TBs for no reason the exit counters
     name (`inlEndMany` = 153 of 276 before the re-bound).

Closed (do not reopen without new ideas): exception longjmps (0013/0014
— SVC inline exit + io barriers; the generic wasm-EH longjmp stays
blocked by asyncify); TCI interpreter dispatch (0007–0016 took it to its
micro-optimization floor; the wasm64 backend supersedes it, TCI remains
the reference/fallback tier); flash romd topology churn (0016); V8
warm-up (no in-window effect on this host); main-loop busy-wait (0009);
register-file expansion (measured worse); icount2 thread-local batching
(flat — the per-TB atomics are cheap on wasm; and the account is now
inline on wasm64 anyway).  Also closed since: the early-boot module
economy (the interpreter tier 0101–0105 — a miss no longer forces a
module, speculation is default-off under the tier, batches fill to
the cap; the AOT cache stays a REJECTED row); main-loop wake storms
(0049 GPTU, 0062 TPU, 0067 empty-timerlist notify — the main loop
parks 99.4 % of the time); the TB-lookup helper tail (0046's per-TB
inline cache and 0118's `w64_pcc` table landed; jump-cache resizing
is closed — 8k and 32k both measured worse, 14 bits is the peak);
the display-DMA per-word chain (0048–0054 the per-word overhead,
round 31's display bundle, 0118's `write_run`/`transfer_run` bursts
— what remains of the display path is the DIF/LCD packing item in
§ 0i); the ke800 LG-logo stall (0049).

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
- **build-qemu.sh resets the submodule checkout to the pin** whenever
  HEAD differs from `QEMU_PMB887X_REV` (the submodule init/checkout is
  inlined there), so commit *and pin* before a full rebuild
  (`ninja-fast.sh` never touches the tree).
- **wasm64 batching invariant**: every translated TB must be staged in
  an open batch (`w64_batch_begin_tb` at TB start, 0053).  A TB that
  runs from a per-TB temp module works in Chrome and silently eats
  Firefox's ~16 k-module budget.  The counters that showed the surplus
  (`ffboot.mjs` `temp=`, `diagall.mjs` MOD_COUNT − CLOSE_N − COMPACT_N)
  went with the 2026-09-22 review.  A regression now shows only as its
  effect: the `firefox` gate's errors or stalled guest.
- **The TCI TB layout (`/dist`)**: `tb->tc.ptr` points at the TCI stream;
  every TB starts with `tci_tbhdr` (icount) — chain jumps and
  `lookup_tb_ptr` targets all pass through it.  Anything that jumps
  into a TB must land on the header.

## The browser boot gate: why four boards, and why not just the native suite

`scripts/gate.sh` runs this; the reasoning is why it is in every tier.

Why the native suite is not enough, and why each board earns its place
(it was three boards when this was written in 2026-09-12; CX70 joined
with the SGOLD work in round fifteen):

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

Generally: **if the page has a knob, the benchmark must be able to set
it.**  A hardcoded query parameter in a measurement tool is a permanent
blind spot, not a default.

## The shipping boot is virtual-time-bound after t0.75G (2026-09-12)

Interleaved, same invocation, `rt=off` against the shipping cap:

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

## The real-time cap ships as `budget:30:500`

`banked` is the right mode *during* a boot and the wrong one after it:
the credit that lets a compute-bound boot catch up as fast as it can is
the same credit that lets a later stall — a backgrounded tab, a host
hiccup — be repaid by sprinting the phone's clock and animations.  The
first second phase tried, `strict`, was also wrong: after a stall it
keeps the clock behind wall *forever*, while plain `banked` repays
*everything* — a 12×-throttled boot released at v=4.2 s sprinted v to
38.0 s in four seconds of wall (v/wall ≈ 8×), freezing the LCD while
the clock skipped half a minute.  The shipping default is therefore
**`budget:30:500`**: banked until the guest has run 30 seconds of its
own clock, then a forgive branch that keeps
`allowed = vtarget + 500 ms` instead of `= vtarget` — a stall is
repaid, but never by more than half a second of sprinted clock, so the
phone stays close behind wall instead of either drifting or skipping.
Plain `banked` and `strict` stay pinned, so every historical A/B keeps
its meaning.

Two design points worth keeping:

- **The window is guest time, not wall time.**  The boot costs ~42 s of
  virtual time on every host, but 39 s of wall on the reference machine
  and minutes on a phone.  A wall window would therefore expire mid-boot
  on exactly the slow machines banked exists to protect, forfeiting a
  large unspent bank.  A guest window also costs nothing to implement —
  `icount_rtcap_excess_ns` is already handed a virtual-time value, so
  the test is one compare against a constant with no extra clock read —
  and it is not consumed by a pause.
- **The switch needs no re-anchor.**  The paced branch only fires when
  `vtarget < allowed - SLACK`, and the budget's `allowed` is never
  greater than banked's, so flipping can only shorten a sleep, never
  lengthen one.  On the reference host the switch is the no-op case:
  the guest is already pinned at the cap by v=30 s, having spent its
  bank through the display-DMA warp stretch, and afterwards v/wall
  settles at 1.00.

Verified three ways:

- A host-side mirror of the branch (3 s stall, then 2× emulation):
  strict repays 3 ms, `budget:500` 502 ms, `budget:2000` 2.002 s,
  banked the full 3 s.
- In vivo, through a temporary `wasm_rtcap_debug` export of
  `icount_rtcap_excess_ns` (a 12×-throttled S75v40lg1 boot): strict
  holds `excess(v) = −2 ms` and a permanent 28.2 s lag; `budget:0:500`
  holds `excess(v) ≥ −502 ms` for the whole run — the invariant — and
  was caught repaying ~0.5 s of a fresh 0.8 s stall (lag 24.77 → 25.57
  → 25.15); banked holds −25.8 s and sprints it all on release.
- The windowed default boots `banked` and flips to `budget` at v=30 s,
  mode 3 in `window.__ui.rtcap` and the diagnostics.

The page side: the status pill's `slow` warning is suppressed while
the cap is banking, because v/wall is below 1 there *by construction* —
the guest is behind and allowed to catch up, so the warning fired on
every boot and meant nothing (the HUD strip keeps its real colours).
The HUD's `lag` re-anchors at the switch: the paced phase *forgives*
the debt instead of paying it back, so carrying the boot's 16 s of lag
past the switch would show an amber token for a debt that no longer
exists.

Two measurement traps worth recording: **CPU-throttling a halted guest
accrues no lag** (the cap paces warps to wall, so the guest is never
behind however slow the host — only compute-bound time lags), and
**SIGSTOP-freezing the renderer freezes the module's clock with it**
(emscripten's `CLOCK_MONOTONIC` is performance.now-based, so `r` pauses
along with `v` and the module never sees a stall; a repayment test must
throttle through a compute-bound stretch instead).

## Two gates that are not in gate.sh

- **precise-clocks smoke** (any change near timers/halt/rr):
  `cd tools && PORT=8080 DIST=dist-jit MATCH=WATCH EXTRA_Q=icount=precise-clocks=on node conlog.mjs 40`
  must show v advancing to ≈45 by 40 s (a stall reads as a frozen
  `v=`/`insns=` — 0024's first build froze at v=7.2). Not in a tier
  because it only means anything for a change in that area.
- **gzip sidecar warm-up** before any *benchmark*:
  `curl -s -o /dev/null -H 'Accept-Encoding: gzip' http://localhost:8080/<dist>/qemu-system-arm.wasm`
  for every dist in the run (serve.mjs regenerates the sidecar on the
  first request after a deploy — ~1.3 s inside `tModule`, i.e. on every
  milestone of the fresh candidate). `gate.sh` does this for its own
  dist; a benchmark invocation must do it for each leg.

## Session checklist

1. `git log` here and `git -C qemu log origin/master..` (the series);
   read **performance-handoff.md down to the end of § Open items** — that
   is the live state, and the round log below it is history.
2. `bash scripts/ninja-fast.sh` **first** (an inherited mid-state build
   dir has faked a baseline before), then `cp -a site/dist-jit
   site/dist-jit-base`.
3. Pick ONE target from § Open items. **Check § REJECTED here first** —
   it is dozens of experiments deep and several ideas have been
   retried twice.
4. Patch → rung 2 (fixed guest work) → confirm the mechanism with
   counters → keep/revert → `bash scripts/gate.sh keep` → commit on the
   qemu branch with the measured numbers, push, bump the pin in
   `versions.env`.  To re-check that a landed patch is still
   load-bearing: `git -C qemu revert <commit>` → `ninja-fast.sh` →
   the ladder.
5. `bash scripts/gate.sh close` before the session's last commit —
   Firefox included, because Chrome hides module-budget bugs.
6. Update § REJECTED and § Remaining here, § Open items in the
   hand-off, and lessons.md when something was learned the hard way
   — a landed patch's numbers live in its commit message (rule 2).
