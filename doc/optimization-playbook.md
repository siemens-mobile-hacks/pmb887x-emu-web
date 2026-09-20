# WASM performance optimization playbook

The working method of the optimization sessions since 2026-09-07:
**profile → hypothesize → small patch → measure → keep or revert →
document**, tuned for the shortest loop that can still reject a bad
change.  Read with [performance-handoff.md](performance-handoff.md)
(current targets/plan) and [tests/tcgbench/README.md](../tests/tcgbench/README.md)
(tool ladder).  The conclusions behind these rules — timing model,
io-recompile accounting, emscripten traps, measurement traps — are in
[lessons.md](lessons.md).

**Workstream history**: TCI patches 0007–0016 (~4× guest throughput) →
wasm64 TCG backend 0017 (compute 7.4× TCI; boot early phase still ~27 %
behind TCI, see § Remaining) → qemu-core device path (0018: MMIO
dispatch at native parity) → wasm64 module economy 0019 (compile-once
batching + compaction: tIdle −15 %, Firefox OOM fixed) → halt path
0023–0029 (idle warp on the vCPU thread, virtual-clock device
completions, goto_ptr for indirect jumps and CPSR writes, budget-aware
timer kicks, no icount2 accounting under stock icount: dist-jit
tIdle 50.1→43.9 s, dist 63.4→57.0 s in one interleaved `--runs 2`) →
Asyncify onlylist + real-time cap 0031/0032 (instrument only the
coroutine-switch stack, not everything the invoke_* wrappers reach:
dist-jit 45→28 MB, tIdle 40.3→33.2 s / −18 %, wasm64-only; and a
sleep=off real-time cap so the idle clock/animations stop running ahead
of wall) → RTC seed layout 0033 (the too-fast clock and the 2091 date
were one bug, not a rate issue) → EL71/KE800 on the wasm builds
0034–0038 (every board now boots on the wasm64 backend, which became
the page default for all of them) → display path + fill-time TLB growth
0039–0041 (stopwatch vratio 0.19 → 0.33) → TB lookup / hflags /
range-flush 0042–0045 (−2..−4 % on the milestones; the counters that
showed the shipping boot is virtual-time-bound after t0.75G and that
197 MB of wasm is compiled per boot) → 2026-09-13 (no perf change
landed: four candidates measured flat or worse; the batcher
SOURCE-CORRUPT root-caused and fixed; a wprof2 profile that **replaced
the cost model this workstream was ranked on** — translation is 3–4 %
of the vCPU, not ~20 %, and emitted code volume is closed as a lever;
and the **phantom-win** baseline trap in § Measuring, which is the
session's most reusable result) → 0046 inline next-TB lookup cache
(2026-09-13: ~80 % of `helper_lookup_tb_ptr` calls gone, J2ME stopwatch
0.33 → 0.35 (+7..+9 %), boot milestones flat; and the discovery that
0044's devirtualisation had never been compiled in) → 0047–0051 the
display-DMA per-word chain (stopwatch 0.33 → ~0.58) → 0052 the per-TB
dispatch loop (+3.5 %) → 0053 the Firefox module-budget fix (a
regression nine commits old that no gate was watching for; Firefox boot
is now rung 7) → 0054 the per-word MMIO dispatch decision (~2 points of
non-guest work; both wall-clock meters flat) → 0055 the emitter
peephole (−3.7 % emitted bytes/TB, flat on all three speed meters) →
**open now**: the J2ME throughput target (§ Remaining 0, now ~0.58×),
the interpreter tier now that the AOT cache is probed out (§ Remaining
5), and — the honest
read after 0054/0055 — **both cheap directions are now exhausted**.
The device chain is a long tail of ~1–3 % items with no single
removable piece (re-checked against a fresh profile in § Remaining 7,
three candidates sized and rejected without building), and the guest's
49 % is not reachable by codegen volume: it is smeared over thousands
of TBs (§ Remaining 0b) and four independent measurements now say
emitted bytes and op count are not what it is bound by.  So the next
*structural* win has to be a **design** change — § Remaining 5 (the
interpreter tier, ~5.7 %: halving module count, needs the TCG op
stream kept alongside the wasm) or collapsing the per-word DMA
request/acknowledge dance (§ Remaining 7, changes what the guest could
observe between words) — not another peephole.  Round nine's real
product is arguably the negative results and the two new meters in
§ Measurement methodology, not the 0055 commit.

→ 0056/0057 round ten (the other two phones: the KE800's io-barrier
thrash was a 20× and the EL71's subpage MMIO dispatch a 10 %, neither
visible to any S75 meter) → **0058–0066 round eleven, the device access
path**: the profile said one device register read cost ~170 ns while a
guest instruction cost ~7 cycles, and that the MMIO path was ~66 % of
the S75's vCPU against ~24 % for the guest's own code.  Nine patches
took it apart — the redundant icount seqlock write per access (0058),
the six-frame load and store dispatch fused into one (0059/0061), a
cache line of its own for `qemu_icount` (0060), the TPU's 1.45 M
`timer_mod` calls a second (0062), the ~22-call BQL pair (0063), a
frame off the clock read (0064) and the duplicate clock notify per
idle round (0065) and the TPU's double advance per register write
(0066).  Two things generalise: **a store to a
line another thread touches costs 24× more than one to an uncontended
line**, and **the wasm tax is per *call*, so the win is in frames
removed, not instructions removed** — which is also why LTO looked
right and is not (it cannot inline the `noinline` coroutine-TLS
accessors, and function merging would break the `ASYNCIFY_ONLY` list).
What is left is now two things, both sized in the handoff: the main
loop being woken ~12 k times a second to do nothing (~21 % of the vCPU
at idle), and `icount_get` still costing ~50 ns/call.

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
| 0 build | `scripts/ninja-fast.sh` (**wasm64 → site/dist-jit by default**; `TCI=1` for the interpreter → site/dist) | ~8 s wasm64, ~70 s TCI | compile errors | — |
| 1 knob A/B | `idlebench "dist-jit@env=K=V,dist-jit"` — same wasm both legs | ~2 min | whether the mechanism is worth building at all | anything without a knob |
| 2 fixed work | `node tools/workbench.mjs --board <b> --to <Mi>` | ~30 s/leg | **the default keep/revert meter**: wall time over identical guest work | steady state, boot phases |
| 3 op-suite | `scripts/run-tcg-isa.sh` | ~3 s | any TCG/memory/exec value divergence; every built backend byte-identical against the native JIT | perf (the wasm64 leg was a known hole 2026-09-13→16, fixed by 0090) |
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
  in the optimized function.  Counters beat profiles: ≥1 % leaf
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

## What landed (with numbers)

| Patch | Mechanism | Measured effect |
|---|---|---|
| 0118 the J2ME round, three mechanisms: `memory/pmb887x: let a device take a DMA burst in one call` (`b76f6112`), `ssi: let a peripheral take a run of bytes in one call` (`0b248e44`), `accel/tcg: cache the next TB by PC, ahead of the jump cache` (`dc08b972`) | **A** — the display DMA dispatched one 16-bit word per `memory_region_dispatch_write()`, 12 888 times per Mi, paying the whole MMIO preamble (RCU lock, `adjust_endianness`, `access_with_adjusted_size`, reentrancy guard, trace check, indirect call) per pixel.  New optional `MemoryRegionOps::write_run` offers the device the whole run; strictly declinable (no hook, a subpage, or a live `memory_region_ops_write` trace point sends the caller back to its per-word loop).  **B** — the same burst one level down, where every word was still two `ssi_transfer()` calls; `SSIPeripheralClass::transfer_run` takes the whole byte run, refused unless the bus is the shape the hook can reason about (one child, default `transfer_raw`, CS asserted) and the panel is in the plain RAM-write state.  **C** — `HELPER(lookup_tb_ptr)` ran 15 459×/Mi in a settled J2ME window and the CPU jump cache answered 14 930 of them, still paying `cpu_get_tb_cpu_state()` + hashed probe + 4-field compare to return what the same branch returned last time; `w64_pcc` is a direct-mapped PC-keyed table in front of it, sound on `cpu->neg.tb_key_gen` (which already exists for the inline cache and ticks only 1.2–1.5/Mi).  All three carry off switches (`W64_NODMARUN`, `W64_NOSSIRUN`, `W64_NOPCC`) | **+50.6 % on a J2ME game, measured as `MIPS/cpu`** — guest Mi over the CPU seconds the vCPU thread itself burned, read from `/proc/<pid>/task/<tid>/stat` at the window's own two ends, which is the only throughput number that survives a host at load 45.  Four-config palindromic A/B **inside one binary** (`tools/j2meab.sh`, `none a ab abc abc ab a none`): **51.49 → 64.85 (+25.9 %) → 72.61 (+12.0 %) → 77.53 (+6.8 %)**, `busy` 0.957–0.966 on every leg.  `ms/Mi` 20.148 → 16.014 → 14.263 → 13.471 agrees to 0.3 pp.  Per-event prices, all in the cost model this workstream has been paying elsewhere: **A = 321 ns per display word**, **B = 137 ns/word = 68 ns/byte**, **C = 55.8 ns per absorbed helper call**.  C's effect is visible in counters **independent of its own**: `lookupJc` 14 930 → 740/Mi while `lookupQht` (523 → 507) and `lookupConfl` (374 → 363) do not move — the misses are identical, only the jump-cache hits vanish.  Soundness of C proven, not argued: `W64_PCC_VERIFY=1` re-runs the full `tb_lookup` behind every hit — **~68 M verified hits over 45 virtual s, `pccBad` 0** (note verify mode suppresses the per-TB inline-cache refill, so its `lookup/Mi` is not comparable with a normal run's).  Replicated at a different host load: 77.53 @ load 43.7, 75.30 @ load 54.1.  gate `keep` 10/11 — `key-ke800` RED, and **not from these commits**: it passes 3/3 and 12/12 standalone and fails only under the gate's own concurrency (see the freeze row below) |
| 0117 util: publish the main-loop wake after the work it advertises (`42874496`) + `site/app.js` §6b, the page notices a dead guest | **Not a perf patch — the bug that made KE800 unbootable on a phone.**  The wasm main loop sleeps in `emscripten_futex_wait` on `ml_futex_seq`, snapshotted before the timeout is computed.  Two lost-edge defects in that protocol: `qemu_main_loop_wake()` incremented the sequence word with a **non-atomic read-modify-write** (wakers run concurrently as a matter of course — `qemu_notify_event` issues one itself and a second through `aio_notify`, and the vCPU notifies on every `timer_mod`), and `aio_notify()` issued its wake **at the top, before the `smp_wmb()`/`qatomic_set(&ctx->notified, true)` that publish the work** — the loop can wake, look, find nothing and sleep again on that same edge.  With **icount off the main loop is the only thing that runs `QEMU_CLOCK_VIRTUAL` deadlines**, so on the LG boards a lost edge is not a delay, it is a stop | **Mechanism proven deterministically, on an idle machine.**  A race that hits once every few boots cannot be A/B'd: the first attempt (14 boots/arm under CPU contention) read **2/14 frozen → 0/14**, which is directional and proves nothing.  What proved it was `W64_AIOLAG=<n>`, a probe that reinstates the wrong order **and widens its window**: `0` (wake after publish) boots at **44–108 MIPS**; `20` is **frozen at 977 M insns, 0.00 MIPS, 0 halt/s, vratio 1.00**; `200` frozen at 912 M — the phone's exact HUD signature, including the occasional 0.12 MIPS sliver, with no load at all.  Host speed only decides how often the natural window is hit.  During a natural freeze **every** diag counter is still, `execIter` and `mlWake` included — vCPU and main loop both parked, not a timer storm.  gate `close` **GREEN 15/15**.  The page half is the other half of the bug: it said "Running · 0:21" over a corpse, so §6b calls a stall when insns, halts and display reads are frozen *together* for 15 s and the overlay carries the last line qemu printed — a phone has no console, and the only report you get is the one the page makes by itself |
| 0116 wasm-diag: the dispatcher's and the CPU's own rates (`d78977e8`) — `execIter`, `execSjmp`, `execLjmp`, `armIrq` + a seven-slot exception histogram | instrumentation, cold by construction (the hottest is `armIrq` at ~93 k/s against the 4 M/s the `WASM_DIAG_HOT` counters run at).  The dispatcher's profile share could not be turned into ns without knowing how often `cpu_exec_loop` goes round, how often `cpu_exec` is re-entered, how often a `cpu_loop_exit` longjmp is actually taken, and how often the CPU takes an ARM exception -- and once you have the last one, *which kind* decides whether a device is firing too often or the guest is making that many syscalls | Three results, all of which redirect the next round.  (1) **90 % of ARM exceptions are guest `SVC`s**: `excSwi` 4 947 895 against `excIrq` 537 242 over a 40 s S75 window, with `excUdef`/`excPabt`/`excDabt`/`excOther` all **zero** — so there is no device storm here of the 0049/0062/0068 kind, and the exception *rate* is not reducible.  (2) **Exceptions are 77 % of all dispatcher re-entries** (`armIrq` 1.85 M against `execIter` 2.41 M in 20 s), against 0098's "the dispatcher is re-entered once per 173 transitions" — i.e. a chain essentially only ever unwinds because the guest took an exception.  (3) **`execLjmp` = 34 per boot**: the exception path does *not* use `cpu_loop_exit`, it leaves through a normal TB exit and `cpu_handle_exception` picks `exception_index` up on the next pass.  That matters because a longjmp here is the emscripten JS-exception unwind, priced at **~15 µs** by the `HELPER(wfi)` comment that removed the last hot one; at 93 k/s it would have been the whole program.  Keep the counter as the regression guard for that design |
| 0115 hw/pmb887x: the TPU event-RAM scan window is one event, not the rest of the list (`764aa9eb`) | 0068 skips `tpu_update_state()` for a write outside `[ceap, eapt)`, "the part of the current frame's list still to be scanned".  But that is **one event, not the rest of the list**: `tpu_run_events()` breaks at the first event the counter has not reached, leaving `p->ceap` on it, and `p->next` is that event's time — it read words `ceap..ceap+2` and nothing beyond.  A later event cannot move the deadline, because the list executes in order and nothing reaches it before `p->next` anyway, at which point the timer fires and the list is rescanned from RAM.  `W64_TPUSCAN=0` restores the wide window | **The prize was proven with a counter before the code was written**: of 8.7 M event-RAM writes in 25 s, 1.97 M passed the old test and **every one of them landed past `ceap+3`**.  After: `tpuRamSkip` **8 893 135 of 8 893 141 (99.99993 %, from 77.5 %)** and `tpuRearm` **−14 %** (681 155 → 587 308 per 25 s), with `tpuTimer` unchanged at 378.7 k / 382.4 k — the deadline itself does not move, which is the claim.  Wall effect is below this meter's floor at host load 4–5 and is **not claimed**; `halt` reads 70 267 / 70 255 / 70 272 across legs, so it does not shift virtual-clock pacing either.  gate `keep` GREEN 11/11.  One false alarm worth the row: `tpuTimer` appeared to *halve* (702 k → 382 k) against an earlier run — that was cross-run drift (TPU traffic varies ~2× with the guest's phase), and a same-binary knob comparison showed it flat.  **Compare legs, never runs** |
| 0114b tcg/wasm64: halve the register file, because a local is not free (`fa470233`) | Every TCG register costs **two** declared wasm locals in every TB function (an i32 and an i64), and the baseline tier zeroes all of a function's locals on entry.  32 registers with 28 allocatable was mostly locals TCG never used: `tcgSpill` reads **0 over a whole boot at 13 allocatable** and 29 over 64 631 TBs at 10.  `TCG_TARGET_NB_REGS` 32 → 16 (13 allocatable, TMP/env/sp reserved) is 33 fewer locals per TB function, verified by disassembling a `W64_DUMPTB` module with `wasm-dis`: 37 declared locals, down from 70 | **+2.05 % median** (two dists, five palindrome rounds, insns at a fixed 20 s wall; 9/10 pairs positive, +1.66 % with the high and low pair dropped).  Emitted bytes per TB unchanged at 772, so it is not paid for in code size.  **This revises 0093's "removing the ~60 spare locals buys under 1 %"**: re-priced with `W64_LOCALPAD=192` the slope is **8.09 µs/Mi per declared local** (−14.5 % of insns, 5/5 rounds), which makes 69 locals ≈ 6 % of wall and predicts +2.8 % for this change.  0093 read the derivative at the *bottom* of a superlinear curve and generalized it upward; the honest reading is that a pad's slope is only valid near the N it was measured at |
| 0114 accel/tcg: the C-side callers get the probe the generated code has (`b4559d83`) | The generated code carries an inline TLB probe (`w64_tlb_setup`/`w64_tlb_probe`) and the C entry points into the memop slow path carry none — so the wasm64 interpreter tier, which reaches the guest only through `helper_*_mmu`, took a full `mmu_lookup` for every access.  A counter said **76 % of those lookups found a matching entry with no flag set at all** (`slowClean`): no MMIO, no watchpoint, no notdirty, aligned, not crossing a page — a round trip that bought nothing.  `do_ram_1p()` is that same one-compare test written once in C, wired into all eight one-page entry points beside `do_ld_mmio_1p`/`do_st_mmio_1p`; `MO_BSWAP` and the atomicity classes the backend refuses are refused here too, so a fast-path access is exactly the one the JIT would have done inline.  `W64_RAM1P=0` is the knob A/B | **+0.81 %** robust, and the mechanism is the result: `slowClean` **5.69 M → 0** with `ram1p` picking up the same 5.7 M per 20 s.  Gate `keep` GREEN 11/11.  One trap worth the row: **`TARGET_PAGE_MASK \| a_mask` silently truncates to 32 bits** in `cputlb.c` — it is not a `COMPILING_PER_TARGET` TU, so `TARGET_PAGE_TYPE` is `int`, `int \| unsigned` is `unsigned int`, and the result zero-extends into a `vaddr`.  Hoist it as `(uint64_t)(int64_t)(int)TARGET_PAGE_MASK \| a_mask`, which is what the backend already does at `tcg-target.c.inc:1949` |
| 0113 target/arm: a third deferred taken path per TB (`e58e2625`) | `w64_ft_max()`'s default 2 -> 3, the same one character as 0112.  A run of conditional branches folds into one TB until the slots run out, and 0111's join frees a slot whenever the fall-through reaches the branch's own target, so slots are spent and refilled rather than merely allocated | **The clock cannot resolve this one and the counter can.**  Two independent five-round palindromes (EL71, 20 s, two legs per side per round, one binary) read **+1.4 % (3/5)** and **+1.1 % (3/5)** -- both positive, neither outside a meter whose round spread is ±8 %.  Exits per Mi at *matched instruction counts* (`tools/exitrate.sh`, three rounds each, 0.8 % spread): **110 380 -> 107 253 at 600 Mi (-2.83 %)** and **113 647 -> 110 704 at 800 Mi (-2.59 %)**, moving exactly where the mechanism says -- `xGototb` 20 193 -> 16 081 against `xGototb1` 16 103 -> 18 797, i.e. branches that left through a `goto_tb` slot now leave as a fall-through the TB carried on into.  Instructions per TB 6.436 -> 6.723 (+4.5 %), `tbGen` -0.75 %.  At the standing "1 % fewer exits ≈ 0.3 % of wall" that predicts **+0.8 %**, which is what both clock runs read: mechanism, magnitude and sign agree and only the clock alone is short of its floor.  An earlier *mismatched* pair read -12.3 % for this same change -- see the window trap in § Measurement methodology |
| 0112 target/arm: two deferred taken paths per TB, now that a join frees the slot (`c5f3ad24`) | One character: `w64_ft_max()`'s default 1 -> 2.  The same knob was measured **flat** before 0111 (see the REJECTED table) and the reason is in that row -- a second deferral used to occupy a slot until the end of the TB and pay a `goto_ptr` lookup.  0111 hands the slot back the moment the fall-through reaches the target, so the second deferral is now usually *free*: it either joins too, or it costs what the first one did | EL71, 20 s windows, five interleaved rounds x 2 legs/side vs `W64_FTMAX=1`: **2229.6 vs 2130.3 Mi, +4.7 %**, 3/5 rounds (+10.2 / +13.1 / -4.8 / -1.5 / +7.1 %).  `tbGen` 105.0 k -> 102.1 k and `tbIcount` 610.7 k -> 658.0 k, i.e. **6.44 guest insns per TB against 5.81** -- the TB got longer *and* rarer.  `halt` unchanged at 70.27 k.  Gate `keep`: GREEN 11/11 |
| 0111 target/arm: a deferred taken path the TB reaches anyway is a label, not an exit (`e33ab826`) | 0108's deferred taken path is still an exit.  But the fall-through usually arrives at the branch's own target a few instructions later -- that is what an `if (cond) { ... }` *is* -- so `arm_tr_insn_start` checks the pending deferred paths against the address about to be translated and, on a match, places the label there.  The branch then costs no exit at all.  The skipped instructions were prepaid by `gen_tb_start`, so the join hands them back through the same `w64_refund` the end-of-TB paths use.  Joining inside an IT block is refused: branching into one is architecturally unpredictable | EL71, 20 s windows, five interleaved rounds x 2 legs/side vs `W64_JOIN=0` in the same binary: **2245.1 vs 2118.2 Mi, +6.0 %**, 4/5 rounds (+11.9 / +9.2 / -5.1 / +3.3 / +12.3 %).  Exits per Mi **117 215 -> 105 972, -9.6 %**, and `xGotoptr` falls with them (73 876 -> 67 376) because a TB that keeps going reaches its indirect exit after more guest work.  It fires on only 2 614 translations; the effect is far larger than that because freeing the slot lets a *run* of conditional branches fold into one TB |
| 0110 target/arm: a forward branch to a nearby address does not end the TB (`e3dd86d4`) | An unconditional direct branch ends the TB and the exit costs a tail call through a table of thousands of TB functions.  When the target is forward, on the same page and within `W64_ABSORB` bytes (default 256), `gen_jmp_tb` just moves `pc_next` there and lets `translator_loop` carry on: nothing is emitted for the branch.  The skipped bytes join the TB's guest range, so a write to them invalidates a TB that does not contain them -- conservative, and the reason for the bound.  ARM bounds a TB to the instructions left on its page and the count *is* the byte offset there, so a skip spends that budget too (`max_insns -= skip / 4`); Thumb re-checks the page per instruction and needs nothing | **2133.3 vs 2044.0 Mi, +4.37 %** (20 s windows, seven interleaved rounds of two legs per side against `W64_ABSORB=0` in the same binary; 5/7 rounds, +4.9 / +3.2 / -0.9 / -1.7 / +12.0 / +11.6 / +2.0 %).  Exits per Mi **132 458 -> 117 215, -11.5 %**, all of it in the two direct kinds (xGototb 32 386 -> 23 560, xGototb1 24 462 -> 19 334).  TBs carry 6.4 % more guest instructions each and 3.3 % fewer are generated; `halt` unchanged at 70.26 k.  Distance is exhausted at 256: 512, 1024 and 4096 all read within 0.7 % of it.  **Two guards are correctness, not tuning**: `trans_BLX_i` switches instruction set (it flips `w64_thumb`), and M-profile's `trans_WLS`/`trans_LE` emit their own control flow around `gen_jmp` -- without them `tbAbsorb` reads 7065 against 4861, so **31 % of an unguarded version's absorbs are wrong** |
| 0109 target/arm + tcg/wasm64: a guest loop whose body is one TB stays in it (`0e7305d8`) | One TB exit in five was a TB tail-calling itself (`xSelf` 26.3 M of 154.6 M) -- a guest loop whose body is a single TB.  `arm_tr_tb_start` names the TB's first instruction with a label and a `goto_tb` back to `pc_first` becomes a branch to it, repeating what `gen_tb_start` does on entry (another `num_insns` off `icount_decr.u32`, out through `exitreq_label`, the survivor stored to `u16.low`) so the loop stays interruptible and still spends its budget.  The backend half is what makes it pay: a backward branch used to drop the whole TB out of nested-label mode into the `$bp` dispatch loop where every *forward* branch is O(n_labels), so `w64_scan_labels` now separates the one backward target target/arm emits (`W.selfloop`) and keeps nested mode, opening the wasm `loop` exactly at label 1 -- past the icount check -- with only the last label's block outside it | **2061.3 vs 1914.8 Mi, +7.65 %** (20 s windows, six interleaved legs per side against `W64_LOOP=0`; 3/3 rounds, +7.6 / +8.4 / +7.0 %).  `xSelf` **26 334 665 -> 410 789** and exits per Mi **163 116 -> 130 032, -20.3 %**, which solves for **~22.4 ns per boundary** on this mechanism; `tbGen` unchanged at ~109.7 k and `modCount` 423 -> 313.  **Two traps, both recorded in the handoff**: a first version that only did the frontend half measured **9 % slower** with perfect counters (the nested-mode fallback), and a version whose `loop` opened *before* the icount prologue measured **+36 %** that was pure artefact -- double-charging icount runs the guest's virtual clock fast, it spends less time halted, and a fixed-wall instruction meter reads work that is not there.  `halt` is the tell and must match between legs |
| 0108 target/arm: merge a conditional branch's fall-through into its own TB (`02aaf4c4`) | A conditional branch ended the TB: `arm_skip_unless` emits the brcond, the taken path exits through `goto_tb` slot 0, and `arm_tr_tb_stop`'s `if (dc->condjmp)` tail emits the fall-through as slot 1 -- two TBs of ~4 guest instructions for one branch.  Invert it: the taken path becomes a forward `br` to a label emitted at the end of the TB (`w64_ft[]`, `w64_emit_deferred_taken`), and translation carries straight on into the fall-through.  The inversion owes an icount refund -- `gen_tb_start` prepays the whole `num_insns`, so a taken exit hands back what it skipped -- and `w64_slots` tracks which `goto_tb` slots the TB already spent so the deferred path takes one that is left, else `goto_ptr`.  Off for anything that reads `tb->icount` as a per-entry statistic (`w64_tb_icount_exact()`: tbhist, tbstats, icount2), for an IT block, ECI, single-step | **1771/1714 -> 2140/2069 Mi, +20.8 %** (20 s palindrome legs, interleaved).  Translations **126 125 -> 109 963** and modules 446 -> 423, so it is not paid for by duplicate translation -- the failure mode the handoff warned about.  Dynamic exit counters (`W64_XCOUNT=1`): exits per Mi **231 300 -> 172 650, -25.4 %** against 87.1 -> 105.2 Minsn/s, which solves `t = c + e·b` for **b ≈ 34 ns per TB boundary** and `c ≈ 3.68 ns` per instruction -- boundaries were **68 % of wall before and 61 % after**.  `W64_FTMAX` > 1 is measured-neutral (ins/tb 5.35/5.77/6.13/6.23 at N=1/2/4/8 against 412/427/412/424 Mi), so the default stays 1 and the array stays for a future measurement.  The lockstep fold is deliberately *not* in the exclusion set: a 250 Mi merged lockstep returns a byte-identical verdict to the unmerged gate leg (249 561 088 insns both sides, 29 SRAM digests + serial identical, 20 SDRAM identical, 14 epochs of regs identical, 233 SOFT timing-race diffs on both), so excluding it would only have meant the gate never ran the shipping control flow |
| 0107 tcg/wasm64: reset the emitter state by its counters, not by its size (`50d753b1`) | `tcg_out_tb_start` opened every translation with `memset(&W, 0, sizeof W)` -- 11.6 KB (`label_idx[1024]`, `fixup[1024]`, `blk[128]`, the type and import tables) against the ~10 label slots a 4-instruction TB uses; `w64_ir_reset` did the same to 2 KB of `IR.lbl`.  Only the counters and the live prefix of `label_idx` carry state across TBs, so zero the counters by name and the two arrays only up to `s->nb_labels` | **A tie: 1795.3 Mi both legs** (four 20 s samples each, ABBA-interleaved: 1805/1796/1774/1806 against 1804/1806/1779/1792).  That is the honest result for 13 KB of memset against ~126 k translations in 20 s -- ~1.6 GB of stores over the window, and still invisible.  It lands because it is strictly less work and because it now says in the code which fields carry state |
| 0106 tcg/wasm64: `W64_CALLPAD` and `W64_DUMPTB` (`643f7a87`) | Instrumentation, both off by default.  `W64_CALLPAD=N` emits N calls to an empty `()->()` import in every TB prologue, so an A/B divides straight into ns per wasm->wasm import call (`padSink` counts them exactly); the existing `W64_LOCALPAD`/`W64_LDSTPAD` price a wasm *instruction*, this one prices the call a helper costs before the helper does anything.  `W64_DUMPTB=<n>` writes the nth translated TB's module bytes out for `wasm-dis`, driven by `tools/tbdump.mjs` | Enabling work.  What reading a TB bought: the exit is a `return_call_indirect` through a table of thousands of TB functions, and **the register globals are not cached in wasm locals across a boundary** -- env memory is the storage -- so there is no "global sync" to remove at an exit, only fewer exits.  An import call is ~14.5 ns |
| 0105 tcg/wasm64: `W64_BATCH_N` 256 -> 1024 (`5cd641eb`) | At a cap of 256 the average module held 174 members, so the cap was cutting batches short of the promotion close that was coming anyway.  Raising it to the array maximum makes it stop binding -- batches then average 284 and every close is a promotion | **674.2 vs 657.5 Mi, +2.5 %** (12 s windows, six interleaved rounds, 5/6 pairwise).  `modCount` 612 -> 375 with `closeBytes` unchanged at 56.9 MB -- the same bytes in fewer modules -- and `modNs` 244 -> 189 ms.  Nothing else binds: the union import table holds 7 entries per module against the 167 that would close a batch, which is what 0103's commit message wrongly blamed for the ~200-member ceiling.  Raising the promotion threshold instead does not help -- at the 1024 cap `W64_INTERP` 64/256/1024 measures 636.7/637.0/651.7 Mi while `interpEnt` goes 377 k/625 k/1130 k: the modules a higher threshold saves are paid back by the entries it leaves interpreted |
| 0104 tcg/wasm64: compact only under live-module pressure (`a76e52e1`) | Compaction merges live "small" batch modules into one so the live count stays low.  Its trigger was the accumulation of smalls -- 256 batches or 1024 members -- which was right when a batch held 4.85 members.  The tier made a batch hold ~150, so the same bound merged 7 batches to free 6 slots for the same ~530 KB, firing every ~7 closes.  Gate the trigger on live-module pressure instead (`W64_COMPACT_LIVE`, default 3/4 of `W64_LIVE_MAX` = 4608) and bound the merge by members inside `w64_compact()` | **608.3 vs 572.5 Mi, +6.3 %** (12 s windows, four interleaved rounds, 4/4 pairwise) -- and **+14.8 %** when the host was loaded (load 10 vs load 3.3), because what it removes is the browser's background compilation competing with the vCPU worker.  `modCount` 609 vs 715 and `modCount == closeN`, so the mechanism is confirmed by a counter: zero compactions.  On an EL71 12 s window the old trigger was 94 compactions and **56 MB of re-compiled module bytes, half of everything handed to `WebAssembly.Module`**, for slots nothing wants -- with compaction off the live count plateaus at 760 by t=30 s and is still 760 at t=90 s against a cap of 6144, with no eviction.  `modNs` 236 vs 353 ms accounts for only ~1 % of the win |
| 0103 tcg/wasm64: `W64_BATCH_N` default 128 -> 256 | one constant.  The cap never mattered before the tier -- the close fired on the first member that had to run, so modules averaged 4.85 and 128 was never approached.  With batches filling, the cap binds for the first time.  `W64_BATCH_N_MAX` 256 -> 1024 so the knob can still express more; the max lives in one static array in the open batch (`w64_bsrc` holds a pointer), not per landed module | **575.0 -> 595.0 Mi, +3.5 %** (four interleaved rounds, no overlap between legs: 576/578/572/574 against 592/598/598/592).  Modules 1092 -> 700, module time 415 -> 338 ms.  **It pays once**: 256 -> 512 is a tie on throughput (608 vs 600 Mi) though modules keep falling to 528.  What stops a batch filling is *promotion*, not the union import/type tables -- raising `W64_UMAX_IMPORTS` 192 -> 1024 and `W64_UMAX_TYPES` 64 -> 256 left `modCount` unchanged at every cap (527 vs 528 at 512), and a temporary close-reason counter reads `closeExec` 326 == `itryHot` 326 with `itryNorec` 0.  At a 512 cap, T = 64/1024/8192 gives 527/348/319 modules against 353 k/944 k/1.96 M interpreted entries, and throughput is flat -- the two ends cancel |
| 0102 tcg/wasm64: speculative translation defaults off under the tier | `w64_speculate`'s budget becomes 0 when `w64_interp_gate` is set, and stays 32 when it is not, so `W64_INTERP=0` remains an honest pre-tier baseline.  `w64_interp_init` moves to `tcg_target_init` and becomes idempotent, because accel/tcg latches the budget on the **first lookup miss**, which is earlier than the first TB execution -- getting this wrong cost a measurement round in which speculation silently stayed on.  The gate flag moves to `exec/translation-block.h` (outside `struct TranslationBlock`), where the other constants accel/tcg needs from this backend live | **364.3 -> 584.3 Mi, +60.4 %** against `W64_INTERP=0` (the tier alone was +29.7 %).  Modules **19 358 -> 1 093**, module time 1.92 -> 0.39 s; translations are essentially unchanged (106 323 -> 105 751) -- it is the module count that collapses, not the translation count.  The sweep is **monotone** -- 593/571/540/514 Mi at a budget of 0/2/8/32 -- so there is no interior optimum.  Round 22 priced speculation correctly for its time: ~12 us per translation against ~96 us for the module a miss forces, break-even 12.5 %, conversion 66 %.  The tier kills the numerator -- a miss no longer forces a module, and the module it eventually joins is amortized over ~100 members instead of ~5 -- so break-even moves to ~100 % and the 34 % that never execute become translation bought for nothing.  Round 23's "27.2 % of translated TBs are never entered" was measuring exactly this |
| 0101 tcg/wasm64: the interpreter tier | the backend records every emitter's already-register-allocated operands a second time into a flat `uint32_t` op stream (`tcg/wasm64/w64-interp.h`), so the record and the wasm are the same program by construction; a C interpreter in the main module (`w64-interp.c`, helper calls via the shared `tcg/call-direct.c.inc`) runs a TB **before its module exists**, and the dispatcher consults it before the descriptor's `fidx`.  Anything the recorder cannot encode marks the TB un-interpretable and it takes the old path.  A record is freed when its TB lands in a module (52 MB live -> 48 KB).  `W64_INTERP=T` (default 64), `W64_INTERP=0` off, `W64_INTERP_ALL=1` interpret everything, `W64_INTERP_RANGE=lo:hi` bisects a divergence to one TB | **EL71 400.7 -> 519.7 Mi in a 12 s window, +29.7 %** (three interleaved rounds, off 391/404/407, on 528/514/517).  Modules 20 380 -> 1 362, module time 1.95 -> 0.50 s, **members per module 5.4 -> 105.7** against a cap of 128 -- the batch fills, which was the mechanism's whole claim.  210 k entries run interpreted, ~0.02 s.  Threshold flat 32..512 (517-529 Mi).  `W64_BATCH_N=256` halves the module count again (1362 -> 827) for a further ~4 %.  Two fixes outside the backend were required and are the reason the first three attempts wedged: **32-bit signed compares** were evaluated at 64 bits on zero-extended operands, so `gen_tb_start`'s `count - n < 0` never fired and the icount budget was never charged; and **`tb_add_jump` must refuse to link** when the target has no module yet -- a compiled `goto_tb` tail-calls the target's shared-table entry, and `tb_set_jmp_target`'s own comment relies on "tb_add_jump is immediately followed by executing the target", which the tier is precisely the thing that breaks.  The guard goes before the `cmpxchg` that claims `jmp_dest[n]`, or the pair could never link later.  **Module time is now dominated by its per-member term rather than its fixed one, inverting round 24's law and retiring the close count as a lever.**  Gates: `keep` GREEN with the tier default-on -- bootcheck 4/4, earlykey 4/4, op-suite, native, wasm lockstep 250 Mi clean (the boot gates are what cover `goto_tb` and multi-insn TBs; the lockstep gate runs `one-insn-per-tb`, hence `CF_NO_GOTO_TB`) |
| 0091 tcg/wasm64: dispatch on the table index, not the target's descriptor | every TB entry is a `return_call_indirect` through the shared chain table (~11 M/s on an EL71 boot) and **both** exits — `goto_tb`'s slot and `goto_ptr`'s inline cache — followed a pointer into the *target TB's* descriptor to read `fidx` and `tidx`: one cache line per TB in ~20 MB the execution path never otherwise reads, on the dependency chain of an indirect branch.  `helper_lookup_tb_ptr`, `helper_lookup_tb_ptr_lc` and `tb_set_jmp_target` now carry `W64_TIDX_TAG \| tidx` directly; a wasm64 heap pointer is below 2 GB so the high half separates a table index from NULL and from an uncompiled descriptor with no test of its own.  Batch eviction gained the matching unlink (`tcg_tb_lookup` + `tb_w64_unlink_incoming`) and a `tb_key_gen` bump | priced before it was built: `tools/dispatch-probe.mjs` says the mechanism is cheap (predictable indirect tail call 2.4 ns; 128-per-module vs one module is 8–13 % of the dispatch) and the *cost is locality* (5.5 ns at a 1-function working set → 46 ns at 4096), with the descriptor load specifically **+2.1 ns over 256 TBs, +8.2 at 1024, +9.1 at 4096**.  Fixed-guest-work A/B, 3 interleaved pairs per board: **el71 −5.4 %, s75 −4.5 %, cx70 −7.0 %, ke800 −10.8 %, 3/3 each**.  Halves measured apart: goto_ptr alone −1.6 % on el71.  gate keep 11/11 |
| 0092 target/arm: record the call-return address on the Thumb-1 and register call paths | a lookup miss costs a wasm module (`closeN` == `specMiss`), the pipeline is **12.5 % of an EL71 boot**, and speculation is starved of *edges* not budget — `W64_SPEC_N` 8 and 128 give the same miss count, and the walk makes 3.5 TBs per miss against a budget of 32 because `w64_succ` holds only goto_tb destinations and dies at the first indirect exit.  The call-return address is the one statically-known indirect edge; `trans_BL`/`trans_BLX_i` already noted it, `BL_suffix`, `BLX_suffix` and `blx <reg>` did not — and this core is an ARM926EJ-S, so the split Thumb-1 BL **is** every Thumb call.  `W64_NORETSPEC=1` A/Bs it in one binary | **misses −2.6 %, 3/3** on fixed guest work (33 730/33 626/33 266 vs 34 361/34 319/34 604), modules the same.  At 103 µs a module that is ~0.3 % of wall — the counter is the result, the clock reads −2.7 % 2/3 and cannot resolve it.  Free at run time.  0080 had closed this class on "module count == miss count", which is the reason it *helps*; what is now closed is that the class is **small**.  gate keep 11/11 |
| 0093 tcg/wasm64: `W64_LOCALPAD`, the knob that prices the declared locals | instrumentation.  N extra never-referenced i64 locals per TB function.  wasm zeroes locals at entry and the baseline tier has no liveness analysis to drop them; every TB function declares ~70 for a 3–4 insn TB | `tools/locals-probe.mjs`: **+38.9 ns on a 49.9 ns call in the baseline tier, free (25 ns flat) in the optimizing one**.  In-app (`W64_LOCALPAD` 0/69/200) +1.05 % / +6.8 % of wall — superlinear, so the derivative at 70 is the small end and removing the ~60 spare locals buys under 1 %.  **Priced, not built.**  The tier itself is the finding: `--liftoff-only` +63 %, `--no-liftoff` +119 %, `--wasm-tiering-budget=1000` **−3.1 % 3/3**, so ~3.6 % of TB entries run baseline code at 2× cost.  `tools/import-probe.mjs` prices the TB-module→main-module call at **2.1–2.4 ns**, so moving work *into* a C helper is the cheap direction, not the expensive one |
| 0094 tcg/wasm64: `W64_BYTEPAD`, the knob that prices emitted bytes against compile | instrumentation.  N never-executed i64 add/store pairs per TB body behind a test of `$scr32` (still 0 there), so emitted bytes move and execution cost does not.  Three earlier rounds called emitted-byte count "not the lever" on −2.6 % and −3.7 % byte cuts read as flat — but at a 10 % compile share those predict 0.4 %, under every meter used | 0/40/120 → 5.1/7.7/14.5 KB per module → 96/110/125 µs: **~80 µs fixed + 3.2 µs/KB in the app**.  At the shipping size bytes are 17 % of module cost, so **emitted bytes are worth at most 2.2 % of wall driven to zero** (the inline TLB probe, 37 % of bytes, ~0.8 %).  Companion floors: `new WebAssembly.Module` alone is ~8 µs + 7–12 µs/KB (`locals-probe --split`), large modules compile on background threads (do not fit a line through the 2.3 KB close and 404 KB compaction populations — different experiments), and the live-module count is **flat** from 500 to 6000 instances (`tools/modgrow.mjs`).  **Module count is the only lever on the 12.5 %, and module count is miss count** |
| 0098 tcg/wasm64: `W64_XCOUNT`, `W64_TLBDUP`/`TLBCHEAP`/`TLBSIMD`/`TLBHIT`, `dispCall`/`dispIter` | instrumentation, all off by default (+4 618 bytes in the shipping wasm, nothing on a hot path).  `W64_XCOUNT` counts TB exits in the generated code by kind, including the self-chaining subset; `dispCall`/`dispIter` count the C dispatcher's entries and loop iterations.  `W64_TLBDUP=N` emits N extra *real* inline probes per memop against mmu index ^ 1 — no load CSE'd with the genuine one — each result stored to **its own** per-site slot, so the N=1→N=2 slope is one whole probe.  `TLBCHEAP`/`TLBSIMD` are the same instrument over a two-load generation-tagged site cache and a one-load `v128` form of it; `TLBHIT` runs the site cache for real and counts hits | **The inline TLB probe is 5.07 % of EL71 wall** (+4.8…+5.5 % across runs, `mods`/`tbGen`/`modMs` identical between legs), against 2.33 % for the two-load check and 4.09 % for the one-load `v128` one — **its cost is not its load count**, and SIMD lane extraction is expensive.  Site page-stability is **94.7 %** (1 656 776 205 / 91 863 184).  Dispatch: 240.6 k transitions per Mi at ~7.7 ns = **9.1 % of wall**, 4.16 guest insns per TB entry, dispatcher re-entered once per 173 transitions, inline cache serving 83.9 % of `goto_ptr` exits (§ 0d).  **The sink must be a plain per-site store**: folding duplicates into one global serializes every memop through store-to-load forwarding and prices latency, which inflated the probe ~2× and reordered all three variants.  Everything built on these numbers was then rejected by its own A/B — see § REJECTED, the per-site TLB entry cache |
| 0099 tcg/wasm64: `W64_TBHIST`, the per-TB entry counter | instrumentation, off by default.  The TB prologue bumps `w64_tbhist[tidx]` — one i32 load/add/store at a **translation-time-constant** address, the cheapest per-TB-entry counter the backend can emit — and `wasm_tbhist()` buckets the result by log2.  This is the measurement the interpreter tier is gated on: what fraction of translated TBs never run often enough to be worth a wasm module.  `tools/tbhist.mjs` prints the distribution and the promotion-threshold decision curve | **The distribution is bimodal and the gap is enormous.**  EL71, 2528 Mi, tbFlush 0: 173 583 TBs translated, of which **47 251 (27.2 %) are never entered at all**; of the 126 358 that are, **35.9 % run exactly once**, 50.4 % run ≤ 3 times, **74.0 % run ≤ 31 times** — and **0.08 % of TBs take half of all 586 M entries**.  Promoting at 32 entries leaves 74 % of entered TBs interpreted forever for **0.25 % of all TB entries** ever interpreted.  S75 is the same shape (36.5 % / 72.7 % / 0.27 %), so this is guest code, not one board.  Combined with `tools/interp-probe.c` (an interpreter loop compiles to wasm at **native speed**, 7.26–7.42 ns/op against 7.30–7.43, while emitted TB code runs 2.7× slower than native) the interpreter tier prices at **+1.8 s of a ~27 s EL71 boot, ~6 %** — see the hand-off's open item 1 for the range and the one assumption no probe can settle |
| 0100 tcg/wasm64: `closePreEnt`/`closePreTb`, and `tools/modshape-probe.mjs` | instrumentation, off by default (the accounting is inside `if (w64_tbhist)`, and `w64_tbhist` is NULL unless `W64_TBHIST=1`).  At each batch close, sum what the members have already executed.  Combined with `W64_NOCLOSEEXEC=1` — which defers the close so batches fill to `W64_BATCH_N` — that is the interpreter tier's cost term measured rather than assumed.  `modshape-probe.mjs` maps `new WebAssembly.Module` over synthetic modules: function count, size, imports, exports, identical-vs-distinct wire bytes | **The module cost law, fitted over a 48× range of members** (§ 0f): ~86 µs per close + ~2.8 µs per member, so **96 % of the boot's 3.5 s of module time is the fixed cost of closing too often** and only the close count is a lever.  `new WebAssembly.Module` is 79 % of a module and has **no cheap corner** — linear in function count from 1 to 256, no threshold, imports 0.09 µs each.  **Round 19's "four fifths is not compiling" is withdrawn**: it recompiled *identical* bytes, which V8 serves from a wire-byte-keyed module cache; distinct bytes cost 2.0–3.8× more.  Interpreter tier re-priced with its cost measured (§ 0g): 1 353 closes, 0.548 s of module time, **7.00 M entries (1.45 %) run before their batch closes** — **net +2.2 s of a ~27 s EL71 boot**.  gate keep 11/11 |
| 0007 TCI TB chaining | restore `goto_tb` chaining; per-TB icount2 accounting moved into the interpreter via a `tci_tbhdr` header op executed at every TB entry; the old 0004-era session io accounting collapses to a deadline-sync | +84–113 % insns at fixed wall time; `cpu_exec_loop` 9.3 %→0.8 % of vCPU; boot to idle ~260 s |
| 0008 TCI immediate forms | `tci_add/and/or/xor/andc_ri`, `tci_setcond32_ri` + constraint letters + `tcg_target_const_match` + outop `out_rri`/`out_ri` wiring — constants stop materializing through `tci_movi` (18.9 %→12.8 % of ops; `add` 7.4 %→1.0 %) | window 46.7→42.9–43.7 s (+8 %); idle screen ~235 s |
| 0009 futex main-loop wait | emscripten `poll()` cannot sleep (it ignores the timeout — the browser main thread must not block), so the main loop busy-spun ~23k iterations/s through a proxied syscall, 2 BQL handoffs each, and the aio eventfd wake never worked at all.  Replaced with a worker-local ns-precision futex wait woken by `qemu_notify_event`/`aio_notify`; main-loop wait no longer times out on virtual deadlines (the vCPU runs those) | window 43.7→40.1–40.4 s (+8 %); +22 % boot progress @110 s; idle screen ~195 s |
| 0012 tci size-specialized ldst | eight appended opcodes (tci_qemu_ld8..st32) for the exact mop family MO_ALIGN\|MO_ATOM_NONE\|size\|sign — every plain pmb887x data access: the generic probe reduces to `(addr & (page_mask\|size-1)) == tlb_addr`, baked in as constants, no mask math/atom branch/size switch, mmu_idx-only stream word; tci_qemu_ld/st dead re-probe removed (0 hits in >1M calls); cold-path diag counters (wasm-diag.h + tools/memstat.mjs) | window wins all 4 interleaved pairs (34.1/33.9/34.0/34.0 vs 40.6/34.4/34.9/34.5; −1.4…−16 %, bigger under host load); boot progress @110 s v 91–102 → 114–121 (+18–25 %); native suite PASS ×4 |
| 0013 wasm: SVC inline exception exit | ARM frontend stores exception_index/syndrome/target_el + `exit_tb(0)` instead of the `helper_exception_with_syndrome` call (its `cpu_loop_exit` longjmp = ~15 µs JS-exception unwind × ~9.4k SWIs/s); new early-return in `cpu_handle_interrupt` delivers a pending exception_index before running/chaining any other TB — exactly the longjmp outcome, incl. IRQ-vs-exception ordering. Gated `__EMSCRIPTEN__` + !EL2/EL3/!M/!AA64 (target_el fixed 1, no TGE redirect); ss_active keeps the helper | window 34→25 s (−26 % quiet, −39 % loaded; 3/3 interleaved pairs); finalV@110 s +30…77 % (92–126 → 164); insns@110 s +6–10 %; `__emscripten_throw_longjmp` 18.5 %→2.6 % of vCPU; idle screen v=245 in ~185 s; native suite PASS ×4 |
| 0014 wasm: io barriers | recurring ROM-device io_recompile (0010 kept the stock rewind for flash-command accesses; the unsplit cached TB re-paid the ~17 µs unwind on every status-poll iteration, 1.67k/s) — on rewind, record the faulting insn pc (64-entry direct-mapped set) + `tb_phys_invalidate` the TB; the translator keeps barrier insns in single-insn TBs (stop before mid-TB / after at TB start), so `can_do_io` is true and the access completes with stock 1-insn-clock precision — no further unwinding | ioRewind 1.67k/s → ~0; window wins 3/3 pairs (25.2–24.8 vs 25.3–27.5); insns@110 s +3–5 % on all pairs; soak v=373 @330 s, keypad works; native suite PASS ×4 |
| 0016 memory: romd FlatView variants + range-scoped tlb flush | romd toggle per flash command = full FlatView re-render of every root (~200 µs, 16k radix page inserts over the flash) + full tlb_flush + ~33-entry refill storm, ~18k flips per boot — (a) FlatViews tagged (topo_gen, romd_sig), romd-only commits adopt the recycled variant from a 16-slot stash (roots whose tag already matches are skipped); (b) tcg listener records region_add/del phys ranges, flush drops only entries translating into them (evicted-variant latch falls back to full flush; entries never dereference a dead view) | topo-commit time 3857→421 ms (−89 %), 30894 variant reuses; v-window 25.1–28.3 → 22.5–25.1 s (8/8 interleaved pairs, every candidate run beats every baseline); insns@110 s +4–9 %; idle screen ~160 s; run-to-run variance collapsed; native suite PASS ×4 |
| 0017 wasm64 TCG backend | full backend: per-TB wasm modules → chaining → batching (128/B module) → inline TLB probe → inline TB accounting; `tcg/wasm64/` + small hooks | compute 7.4× TCI on tcgbench; boot: early phase (first 0.75 G insns) ~27 % SLOWER than TCI, last 0.55 G 2.7× faster — tIdle equal by cancellation only (562 vs 53 MIPS; per-phase 7–18×); all gates green incl. full 2.5e9 lockstep — numbers and history in the backend design record (removed 2026-09-16) |
| 0019 wasm64: speculative successor translation + compile-once batching + compaction | goto_tb destinations recorded per TB; on a lookup miss the successors are translated breadth-first into the open batch (non-faulting probes before any lookup — the faulting `get_page_addr_code` delivered a spurious prefetch abort for a blx Thumb target); the batch is compiled when its first member runs (no per-TB temp module); landed batches keep re-assemblable records, live FIFO cap + on-demand re-ensure, and every 256 small batches are compacted into one module; a 32 MB throwaway allocation per 256 instantiations keeps Firefox's worker GC collecting dropped modules (Firefox: ~16.3k live modules max, code memory is not GC pressure) | idlebench `--runs 2` interleaved: tIdle 76.2/71.5 → 65.0/64.9 s (−15 %), window 30.4/28.7 → 26.0/25.7, t0.25G −13 %, t0.5G −14 %, t1.3G −15 %, RSS −4..−12 %; vCPU `Module` self-time 21 % → ~3 % early boot; Firefox boots to idle (was OOM at 10 s); op-suite 1156/1156 ×4, lockstep 20e6+250e6 clean, native suite 4/4 |
| 0020 wasm64: call-return + `ldr pc,[pc,#-4]` trampoline successors, W64_SPEC_N 32 | ARM `bl`/`blx` record the return address via `translator_note_succ`; a TB ending in the firmware's `ldr pc,[pc,#-4]` thunk contributes its literal | batches 29.5k → 11.3k per 25 s, 3.1 → 12.7 members, misses −60 %; idlebench `--quick` vs 0019, both orders: t0.5G −8 %/−5 %, window −5 %/−5 %; gates green (op-suite, lockstep 250e6, Firefox idle, native 4/4) |
| 0021 wasm: untimed cond waits + atomic event notifiers | `qemu_cond_wait_impl` passed 0 ms to `emscripten_futex_wait` = immediate "timeout" → every untimed wait (vCPU halt, RCU, io-dump threads) was a BQL lock/unlock spin; `event_notifier_set/test_and_clear` did proxied eventfd `write`/`read` (~1 ms sync round trip to the main thread, per icount deadline via `qemu_clock_notify`) → atomic flag | idlebench both orders: dist-jit tIdle 66→62.6 / 68→58.9 s, dist 76→73 / 73.5→64.7 s; gain from t0.75G on (the display-DMA stretch); op-suite ×4, lockstep 250e6, Firefox idle |
| 0022 wasm64: goto_ptr handoff slot offset | `tcg_out_goto_ptr` stores the next TB at `[sp-8]` = frame+8; the dispatcher read frame+0 (always 0) → every indirect jump was a "miss" that unwound to `cpu_exec_loop` (exit-kind counters: 14.9M misses, 0 hits of 16.8M exits in 30 s) | idlebench `--quick` vs 0021 both orders: window −10 %/−8 %, t0.5G −4 %/−4 %, t1.3G −5 %/−2 %; op-suite, lockstep 250e6, Firefox idle |
| 0023 icount rr: idle warp on the vCPU thread | stock icount routes every idle virtual deadline through the main loop (notify → `icount_start_warp_timer` → `async_run_on_cpu(do_nothing)` kick → `icount_handle_deadline` on the vCPU): two cross-thread hops per deadline; `rr_idle_advance` does the warp + `QEMU_CLOCK_VIRTUAL` timer run on the vCPU thread under the BQL (≤64 iterations, BQL released between them) before the cond wait | counters: ~50k halts/boot, ~5 deadlines per halt, the halt cond wait is never reached; alone: dist-jit t0.75G..t1.3G −5 %, dist −2 %; stack 0023–0027 (`--runs 2`): dist-jit tIdle 51.9→46.2 s (−11 %), t1.3G 50.7→44.3 (−13 %); dist tIdle 62.2→58.2 (−6 %), t1.3G 60.1→55.8 (−7 %) |
| 0024 pmb887x: dmac/dif/ssc completion timers on QEMU_CLOCK_VIRTUAL | the display-DMA word completed from a REALTIME "now" timer on the main loop; on the virtual clock the vCPU runs it at the next TB boundary or in the first 0023 warp — deterministic and hop-free (the same change was neutral before 0023: REJECTED row superseded) | on top of 0023: display stretch (0.5G→0.75G) dist 15.2→12.5 s, dist-jit 11.1→9.1 s; t1.2G dist −4 %, t1.3G dist-jit −2 % |
| 0025 wasm: halt-path costs | `icount_get_limit` read the REALTIME deadline (a ~3 µs JS clock import) twice per vCPU loop round — 8 % of the vCPU in the halt-dense stretch (dropped on wasm: the main-loop worker paces its own wait); `icount_start_warp_timer`'s VIRTUAL_RT read moved into the sleep=on branch; `helper_wfi` returns instead of `cpu_loop_exit` (WFI ends its TB, the 0013 early return delivers EXCP_HLT) — no ~15 µs JS unwind per halt | with 0026 on 0023+0024: dist-jit t0.75G −7 %, t1.3G 47.9→43.8 (−9 %) |
| 0026 wasm64: goto_ptr in-wasm tail call | `tcg_out_goto_ptr` return_call_indirect's an instantiated target through the chain table (same fidx / chain-stop guards as goto_tb) instead of returning to the C dispatcher; handoff slot kept as the fallback | goto_ptr dispatcher exits 14.9M/30 s → 17k per boot (true misses); measured only in the stack above |
| 0027 target/arm: CPSR writes / exception returns via goto_ptr | exit_tb(0) was the most frequent exit (~190k/s, 4.2M in 33 s from 230 TBs): `msr CPSR_*` in the firmware's critical sections and `ldm {..pc}^`; a plain exit only buys `cpu_handle_interrupt`, so the helpers set `icount_decr.u16.high` when `interrupt_request` is pending (the next TB start unwinds exactly as before) and the TB ends with `DISAS_JUMP` | on top of 0023–0026, `--quick`: window −7 %, t0.25G −7 %, t0.5G −4 %, t1.3G 46.8→42.2 (−11 %); op-suite ×4 identical, native 4/4, lockstep 250e6 |
| 0028 icount: timer re-arms beyond the running budget don't kick the vCPU | `qemu_timer_notify_cb` did `cpu_exit` on every vCPU-thread `timer_mod` (37k/s: device callbacks + the idle warp's own re-arms); only 1.2 % moved the deadline inside the remaining budget (`icount_decr.u16.low + icount_extra`); each needless kick = an empty `cpu_exec` round + a `TB_EXIT_REQUESTED` unwind | `TB_EXIT_REQUESTED` exits 554k → 75k per boot; inside noise on its own (t1.3G 42.8 vs the 0023–0027 stack's 42.2–43.8) |
| 0029 wasm64: no icount2 accounting in TB prologues under stock icount | the prologue mirrored `icount2_advance` per TB entry: atomic i64 load+store of `icount2_ticks` + atomic load/compare of the deadline — ~5M TB entries/s for a clock that is opt-in (`?icount=precise-clocks`, decided at command-line parse); emitted only when `icount2_enabled()` | `--quick` one pair on top of 0023–0028: t0.25G −7 %, t0.5G 32.1→30.4 (−5 %), t1.3G 42.8→40.5 (−5 %); session base 48.4→40.5 (−16 %) |
| 0030 wasm64: speculation explored flag | the BFS through already-translated TBs re-probed and re-looked-up every edge of a fully translated neighbourhood on each miss inside it; `tb->w64_explored` marks a node whose expansion found every successor present | host-time counters: speculation walk overhead 0.87 → 0.29 s per boot (translations unchanged); stack 0023–0030 `--quick`: t1.3G 48.4→40.3 (−17 %) |
| 0018 cputlb: fill-time MMIO dispatch + victim-TLB masked compare | (a) `tlb_set_page_full` resolves `(callback, opaque, size-mask, swap, align, re-entrancy guard)` per iotlb entry — the MMIO access path becomes one mask test + indirect call instead of dispatch_read→access_valid→adjusted_size→accessor; (b) `victim_tlb_hit` compared `cmp == page` unmasked, but every MMIO entry carries TLB_FORCE_SLOW in addr_idx → the victim TLB *never hit for MMIO*, so two MMIO pages aliasing on one TLB index (sysctl 0x10000000 + VIC 0x10140000, both index 0 under ARMv5 1K target pages) re-walked the guest page tables on **every access** | tcgbench mirrors: mmiopoll **534→202 ns** (dist-jit), 606→252 (dist), mmiow 305→227; native parity (223).  bootbench finalV/insns@110 s up on every pair (windows noisy under host load); op-suite 1156/1156 byte-identical ×3, native suite 4/4 on the branch binary, lockstep 20e6+250e6 clean (sessions doc, 2026-09-11 device-path) |
| 0031 wasm64: Asyncify instrumentation allowlist (`-sASYNCIFY_ONLY`) | the emscripten fiber backend unwinds the whole C stack at a switch, so the old `-sASYNCIFY_REMOVE=tcg_qemu_tb_exec` instrumented ~everything the `invoke_*` longjmp wrappers reach (~21k fns / 17 MB / ~25 % of early-boot vCPU).  The wasm64 backend runs guest code as JIT'd modules, not `tcg_qemu_tb_exec`, so instrument ONLY the functions seen on a real switch stack (`configs/meson/asyncify-only.txt`, captured with `QEMU_COSTACK=1` over boot/rw-flash/shutdown + name families).  Prereqs: flash `blk_pwrite` deferred to a main-loop BH (a vCPU-thread block coroutine can't unwind a JIT frame); vCPU thread marked `qemu_coroutine_forbid_current_thread` (abort, not derail).  **wasm64-only** (`build-qemu-wasm64.sh` overrides the shared cross file): the TCI dist's hot path IS the interpreter, onlylist **regressed dist +26 %** | dist-jit wasm **45.1→27.8 MB**; idlebench `--runs 2`: **tIdle 40.3→33.2 s (−18 %)**, t0.5G 29.6→24.0 (−19 %), t0.1G 5.4→3.3 (−39 %); op-suite native JIT+TCI 1156/1156 identical, lockstep 250e6 serial+regs identical, Chromium idle |
| 0032 icount: real-time cap for sleep=off (`QEMU_ICOUNT_RTCAP`, wasm default banked) | sleep=off warps the virtual clock straight to the next deadline (0023, on the vCPU), so a halted guest advances virtual time as fast as the host runs deadlines → the idle clock/animations run ahead of wall (~3.7× at t≈45 s; a regression vs native's RT-paced warp).  The vCPU sleeps (kick-interruptible, sub-ms `qemu_cond_timedwait_ns`) before a warp / after a budget round until wall reaches the virtual target.  "banked" measures allowed time from VM start, so the compute-bound boot (virtual *behind* wall) is never throttled and only idle overrun is paced; "strict" re-anchors on lag (paces the boot too — not the default).  Virtual time stays instruction-deterministic (lockstep/op-suite unaffected) | at t=45 s: virtual v=166 s (off) → **44.8 s (banked) ≈ wall**; boot-to-idle unchanged (insns@30 s 1.13 G banked vs 1.19 G off); default off on non-emscripten.  **Residual:** the phone's displayed digital clock still advances too fast per virtual second — an RTC/timer decode issue separate from the virtual-time rate, resolved by 0033 |
| 0077 icount: the real-time cap switches banked -> strict after `<n>` guest seconds (`QEMU_ICOUNT_RTCAP=banked:<n>`, wasm default `banked:30`) | `banked` lets a boot that fell behind catch up as fast as it can - and lets any *later* stall (a backgrounded tab, a host hiccup) be repaid the same way, by sprinting the phone's clock and animations.  So bank only for the boot: `banked` until the guest has run `<n>` seconds of its own clock, then re-anchor on lag forever.  Guest time, not wall time - the boot costs ~42 s of virtual time on every host but 39 s to minutes of wall, so a wall window would expire mid-boot on exactly the slow machines banked protects; it is also one compare against a constant on a path already handed a virtual-time value (no clock read) and is not consumed by a pause.  No re-anchor at the switch: `excess_strict <= excess_banked` always, so the flip can only shorten a sleep.  Plain `banked`/`strict` stay pinned, so the ladder above and every historical A/B keep their meaning; `RT=ship` is the new idlebench leg that takes the page's own default.  Page side: the pill's `slow` warning is suppressed while banking (v/wall is below 1 there by construction), and the HUD's `lag` re-anchors at the switch because strict forgives the debt rather than paying it back | switch lands at wall ~30.7 s with v=30.2 s, i.e. the guest is already pinned at the cap (it spent its bank through the display-DMA warp stretch: v 4.2 -> 30.2 in ten seconds, v/wall 2.58), so the flip is the no-op case and tIdle is unmoved; v/wall settles at 1.00 after it.  The boot no longer reads "Booting - slow" |
| 0090 wasm: versatilepb machine-init path in the Asyncify onlylist | the wasm64 op-suite leg (`-M versatilepb` + semihosting) had been a KNOWN HOLE since 2026-09-13 — "null function" in an Asyncify rewind on the pthread's onmessage after an unsupported `__syscall_mprotect`, i.e. a rewind into a frame the pass never instrumented (the faulting `dynCall_jj` *is* listed; the null callee is the frame above it).  A no-onlylist build ran the suite green, `QEMU_COSTACK=1` on the suite target (tools/costack-suite.mjs) captured 7 switch stacks, and the audit found 20 missing names — all on the versatilepb machine-init / legacy-SCSI / board-reset path no pmb887x boot reaches: `versatile_init vpb_init lsi53c8xx_handle_legacy_cmdline scsi_* sd_* sdbus_* blkconf_blocksizes qemu_devices_reset do_legacy_reset bus_reset_child_foreach resettable_* pl181_reset`.  Added as the minimal explicit set (no wildcards); the KNOWN-HOLE special case in scripts/run-tcg-isa.sh deleted so the leg gates unconditionally again | wasm 27804606 → 27817238 bytes (+12.6 KB); el71 boot A/B (workbench 100–1400 Mi, 3 interleaved pairs) a tie — medians 29.45 s both legs (base 29.46/29.45/29.25, new 29.45/31.07/29.05; the +1.6 s leg is host noise), guest counters identical.  `WASM64_SUITE=1 scripts/run-tcg-isa.sh`: native JIT 1156/1156, TCI 1156/1156, **wasm64 page leg 1156/1156, serial byte-identical to native JIT**; gate keep green 11/11 |
| 0089 icount: the post-window cap is a budget, not strict (`QEMU_ICOUNT_RTCAP=budget[:<win>[:<ms>]]`, wasm default `budget:30:500`) | strict (0077's post-window phase) forgives *all* lag, so after a stall the phone's clock silently stays behind wall forever - and `banked` repays *all* of it, sprinting v 4.2 -> 38 s in 4 s of wall once a throttled host recovers (measured below), freezing every countdown while it skips.  The middle: keep a bounded bank.  `budget` windows the boot exactly like `banked:<n>`, then the forgive branch re-anchors `allowed = vtarget + <ms>` instead of `= vtarget`, so the guest may sit at most `<ms>` (+slack) behind allowed: a stall is repaid, but never by more than 500 ms of sprinted clock.  `budget:0:<ms>` is capped from the first insn; bare `budget` = the 30 s / 500 ms default; `banked:<n>` and every pinned mode keep their meaning.  `icount_rtcap_mode()` gains 3 = budget so the pill/diagnostics can name the phase; `wasm_rtcap()` unchanged otherwise | a 12x-throttled S75v40lg1 boot, internals probed via a temporary `wasm_rtcap_debug` export of `icount_rtcap_excess_ns`: strict holds `excess(v) = -2 ms` and a permanent 28.2 s lag; budget:0:500 holds `excess(v) >= -502 ms` for the whole run (the invariant), repaying ~0.5 s of a fresh 0.8 s stall (lag 24.77 -> 25.57 -> 25.15); banked banks all 25.8 s then sprints v 4.19 -> 38.02 in 4 s on release.  A host-side mirror of the branch (stall 3 s, then 2x emulation) repays 0.003 s (strict) / 0.502 s (budget:500) / 2.002 s (budget:2000) / 3.000 s (banked) |
| 0033 pmb887x: RTC `CNT` seed layout per board (`cnt-format`) | the pinned rev seeds `CNT` as a packed calendar (sec/min/hour/yday fields, 964/4/40 reloads); LG firmware reads those fields, Siemens firmware treats `CNT` as one linear Unix-seconds counter (+ its own time-zone setting), so the packed value decoded to "Wed 02 May 2091" and each minute wrap (0x3FF → 0x7C4 = +965) jumped the shown clock +16 min.  Not wasm- or warp-related: identical on the pristine native build.  Board config `[rtc] format` (default unix; the LG configs set calendar — landed in bsp master as `e8d490e`, ex-PR#6 `e6e73d1`); both honour `-rtc base=` | native S75 "Пт 11 Сен 21:22" / C81 "11.09.2026 20:22" / KE800 unchanged "17:20 11/9"; wasm dist-jit 21:23 → 21:24 over 60 s, dist 21:26 → 21:27 over 40 s (was 15:39 → 15:55 over 40 s); no perf change |
| 0039 pmb887x: display path per-word costs | a redrawing J2ME app (the stopwatch, ~57 fps) pushes every LCD word through DIF FIFO → DMAC request → VIC; that chain was 44 % of the vCPU: `vic_update_state` scanned all 170 lines on every level change (now an asserted bitmap + unchanged-level no-op), the DIF re-drove 6 GPIO pins per FIFO word and 8 DMAC request lines per event (level caches; every consumer is level-idempotent), `dif_mux` was a 32-iteration bit loop per word (byte-lane tables), DMAC read a memory source word by word (burst read once), `srb_set_isr` tested 32 bits.  Plus `-Dqom_cast_debug=false` for the wasm64 build (`OBJECT_CHECK` asserted per FIFO word) | `tools/stopwatch.mjs` vratio **0.19 → 0.33** (25 → 41 MIPS); QOM casts off: boot −3..−5 % every milestone, both orders; op-suite 1156/1156, native 4/4, bootcheck s75/el71/ke800, lockstep 250e6 |
| 0040 cputlb: fill-time TLB growth | QEMU's dynamic TLB resizes only at flush time; a phase with no flushes (the JVM: ARMv5 1 KB pages, ~6.2k-page working set) sat at 256 entries at 83k fills/s.  `tlb_set_page_full` doubles the table when fills since the last flush exceed 2× its size (cap 2^14); trap: index `f[]` through `cpu_tlb_fast()` (mmuidx_to_fast_index), not by mmu_idx | fills 83k/s → 35/s, table → 16384; boot (both orders, with 0039): t0.1G −18..−20 %, t0.5G −2..−3 %, t1.3G −1..−3 % |
| 0041 wasm diag: lookup / fill / flush / halt counters | cold counters behind `wasm_memstat`: tb_lookup calls, jump-cache/qht hits, jump-cache flushes, table clears, fill classification, halts — read by `tools/memstat.mjs` / `tools/stopwatch.mjs` | zero hot-path cost; decided 0039/0040 (78 M lookups per boot at 92 % jc hits; 83k fills/s with 0 flushes; halts/s = 0 in the stopwatch) |
| 0042 wasm diag: warp / module-economy / range-flush counters + compaction knobs | cold counters for the idle warp (ns + 7 size buckets), bytes handed to `WebAssembly.Module` split by assemble source (first close / compaction / re-ensure), emitted TB body bytes, and `tlb_flush_phys_ranges` calls/entries/drops; `W64_COMPACT_BATCHES`/`W64_COMPACT_MEMBERS` promoted from `#define` to env knobs | zero hot-path cost; decided 0043 and produced the module-economy and virtual-time numbers below |
| 0043 cputlb: physical-address summary for the range flush | 0016's topology-commit flush finds its victims by walking every entry of every mmu_idx; 0040 grew the table 256 → 16384, so each romd flip streamed 512 KB of table.  Per mmu_idx keep a 64-bit mask of the 32 MB physical blocks its entries translate into, one per 64-entry group plus an OR over groups and the victim table; a commit ANDs the requested blocks against it and skips whole tables and groups.  Masks are conservative (added on fill and victim promotion) and rewritten exactly by any commit that walks the group, so staleness self-heals.  Block size must divide the reported ranges — 64 MB blocks lumped the two 32 MB flash banks together and only got 280M → 107M | entries walked per boot **280,759,680 → 1,179,712 (237×)**, 1.16 groups walked per commit, entries dropped **22,007 → 22,007 (identical)**; boot effect on its own **FLAT** (t1.3G 29.7 vs 29.8, both orders) — the walk is a predictable streaming scan at ~0.3 ns/entry.  Kept for the scaling property and as part of the 0043–0045 stack |
| 0044 accel/tcg: devirtualise the TB-lookup helper on wasm | `helper_lookup_tb_ptr` runs per indirect jump (78 M/boot, 2.9 M/s, ~10 % of the vCPU) and reached `get_tb_cpu_state` through `cpu->cc->tcg_ops` — a wasm `call_indirect` — and `curr_cflags()` through a cross-TU call whose four debug-only conditions cannot be true in a browser build.  Both folded away under `__EMSCRIPTEN__`.  NOT the rejected per-TB inline cache: the key is still computed once, in the helper.  **Correction (2026-09-13, 0046): the `get_tb_cpu_state` half was guarded by `CONFIG_TARGET_ARM`, a macro no build defines, so it was never compiled in; measured on its own once switched on it is flat (−1..+2 %).  The numbers in the next column belong to the 0043–0045 stack, i.e. to `curr_cflags_fast` and 0045** | stack 0043–0045, interleaved `--runs 4`: window 14.2 → 13.7 s (−4 %), t0.5G 21.8 → 21.4 (−2 %), t0.75G 27.1 → 26.4 (−3 %), t1G −2 %, t1.3G −1 %; −2 % on t0.5G in both orders of two `--quick` pairs; helper self time 7.3 % → 6.5 % |
| 0045 target/arm: hflags rebuild on a CPSR write only when it can change them | upstream rebuilds unconditionally with a TODO saying not all cpsr bits matter; they do not, and 0027 made `msr CPSR_*` the boot's most frequent TB exit — those writes set I/F and the condition flags.  Every CPSR field hflags reads (mode → EL/mmu_idx/sctlr, E, IL, PAN) lives in `uncached_cpsr`; everything in `CACHED_CPSR_BITS` lives in dedicated env fields and is not an hflags input, so an unchanged `uncached_cpsr` means unchanged hflags | verified with a temporary build that recomputed and compared on every skip: **2,125,612 skips, 0 mismatches** over a full boot; ~2.1 M rebuilds saved (~0.2–0.4 s); measured as part of the 0043–0045 stack |

| 2026-09-13 prologue cleanup (`58bb2742`) | the shipped TB prologue carried two RMWs of the `wasm_tb_stats` diagnostic counters and a lockstep-armed test per TB entry (~5 M/s) plus a `w64_chain_stop` load per chained jump — ~70 of ~560 bytes per TB module.  Under icount `wasm_insns()` now derives the count from the icount state (exact), the counters are emitted only on non-icount boards or with `W64_TBSTATS=1`, and the lockstep probes only in a `W64_LOCKSTEP` process; `W64_NOACCTINLINE` is gone | **flat**: quick pairs −6 %/−1 % window, −7 %/−2 % t0.5G; full `--runs 2` pair +0 % tIdle, +3 % window, +3 % t0.5G, +1 % t1.3G; rt=banked quick −3 %/0 %.  Landed as a simplification (W-19), not as a win — the per-TB counters were cheaper than their byte count suggested |
| 2026-09-13 W-12 BLX speculation fix (`58f6f9c5`) | `trans_BLX_i`'s `gen_jmp` recorded the mode-switching target as a speculation successor; the wasm64 backend translated it with the caller's flags and the ARM translator emitted a PC-alignment-abort TB that a chained jump then ran → EL71 `Prefetch_Abort` in ~45 % of second-page boots.  `translator_unnote_succ()` withdraws the hint | correctness: 8/8 reproducer passes with the abort dump armed (`QEMU_LOG_PABT=1`) vs 5/11 failures before; no perf change expected (fewer dead speculated TBs) |
| 2026-09-13 batcher SOURCE-CORRUPT fix (`bf0b67d4`) | § Remaining 4, root-caused from the forensic dump: `encode_search()` overflowing the region highwater does `goto buffer_overflow` **without advancing `code_gen_ptr`**, after `tcg_gen_code()` already staged the module body in the open batch, so the next `tcg_tb_alloc()` carves `TranslationBlock`s out of the staged bytes (the dump showed seven, at the 192-byte `sizeof(TranslationBlock)` stride).  `w64_batch_unstage()` withdraws the member; the staged-source check is now shared with `w64_batch_ensure()`, which re-assembled evicted batches with no validation at all | positive control (`-accel tcg,tb-size=8` forces region overflows): **5 dropped batches per 60 s → 0**, same guest progress.  Stock rate was 1–2 per 60 s boot, not the "once in 285 s" the hand-off recorded.  Correctness only; no perf claim |
| 0046 wasm64: inline next-TB lookup cache on goto_ptr exits (+ 0044 actually switched on) | every `bx lr` / `pop {pc}` / `ldr pc` / `msr CPSR` ends in `helper_lookup_tb_ptr` (~130 M per boot, 2.75 M/s in the J2ME stopwatch).  The ARM translator now gives each TB's goto_ptr exit a slot in the TB (`w64_lc`: pc, generation, hflags/thumb/condexec words, target descriptor) and emits a test of only the words that can differ at that exit: pc, `cpu->neg.tb_key_gen` and thumb after a `gen_bx` — hflags cannot change without ending the TB, so they and condexec are **stamped statically by the translator** and checked once at fill time by `helper_lookup_tb_ptr_lc`; only an exit after a CPSR write compares all three.  The generation moves on every jump-cache invalidation (flush, page clear, TB invalidate) and on the rare key inputs nobody compares (hflags.flags2, FPSCR.Len/Stride, FPEXC.EN).  `W64_LC_VERIFY=1` routes every exit through the helper and cross-checks each would-be hit against the real lookup; `W64_NOLC=1` is the knob A/B.  **Found on the way**: 0044's `#if defined(CONFIG_TARGET_ARM)` guarded a macro no build defines (accel/tcg is target-independent, `TARGET_ARM` is poisoned there) — the devirtualised lookup was never compiled in until this patch keyed it on `CONFIG_TCG_WASM64` | verify: **101.3 M would-hits of 124.1 M helper calls (82 %), 0 mismatches** over a 40 s boot; normal: helper calls 26.1 M of ~126 M lookups, `keyGen` 1458 (= the jump-cache flushes).  **J2ME stopwatch vratio 0.328/0.329 → 0.350/0.358 (+7..+9 %, 40.9/41.1 → 43.7/44.7 MIPS), 4 alternating samples**, helper lookups 2.75 M/s → 0.43 M/s.  **Boot milestones flat**: `--quick --runs 2` both orders, the second-listed leg reads +3..+5 % slower whichever build it is (pair A jit second: t0.5G +5, t1.3G +4; pair B base second: every milestone −5 % for jit); three-leg runs with the `W64_NOLC=1` leg say the same, and the devirtualisation on its own is −1..+2 % (flat).  Emitted TB bytes 106.5 → 101.5 MB.  Gates: op-suite 1156/1156 ×2 identical, native 4/4, lockstep 250e6, bootcheck s75/el71/ke800 |
| 0047 pmb887x: DIF v2 lazy mux tables, DMAC in-callback re-arm, one-bit DMA acks | the J2ME stopwatch profile after 0046 (`tools/wprof2.mjs` attached to `stopwatch.mjs --devtools`): devices 46 % of the vCPU, guest code 30 %, top symbol `dif_update_mux` **12.7 %** — the DIF v2 rebuilt its byte-lane mux tables (0039's, 2 × 4 × 256 evaluations of the 32-bit mux) on every BMREG/BCSEL/BCREG/INVERT_BIT write, and the firmware writes those per LCD command.  Now a write that changes the register only marks the tables dirty, `dif_mux()` rebuilds on the next word (370 rebuilds/s), and the builder walks the 32 output bits once.  Same path, per word (the display DMA is one 4-byte word per request, ~500 k/s): `dmac_schedule` re-armed the DMAC timer from inside its own callback on every acknowledgement (`timer_mod` → deadline → `icount_get`, ~3 %) — a request raised while the loop runs now only sets the flag; the DIF's DMA-clear handler cleared all four request bits per ack and each already-clear bit re-ran the event handler — only the raised bits are cleared; `srb_set_icr` walks set bits like `set_isr` | `tools/stopwatch.mjs` alternating: vratio **0.360/0.333 → 0.482/0.533 (+34..+60 %)**, 45/41.6 → 60/66.6 MIPS; boot flat (`--quick --runs 2` both orders: one order −1..−4 %, the other +4..+8 % with one outlier run; the four t1.3G readings overlap the baseline's); op-suite 1156/1156, native 4/4, lockstep 250e6 clean against the *pre-change* native oracle, bootcheck s75/el71/ke800 |
| 0048 pmb887x: DMAC translation windows, VIC parent-line cache, `memory_region_topology_gen()` | after 0047 the stopwatch profile read guest 39 %, devices 33 %, memory API 10 %, top symbol `dmac_transfer_memory` — the display DMA is one 4-byte word per request (~475 k/s) and each word walked the flatview twice (`address_space_read` of its RAM source word, `address_space_write` to the FIFO).  Each channel now keeps a translated window for source and destination, keyed on a new memory-core counter that bumps on every committed transaction that installed flatviews (romd-only ones included); a RAM window is read through the host pointer, an MMIO window dispatches with the same `memory_access_size`/`prepare_mmio_access`/`memory_region_dispatch_write` step the API takes, RAM destinations keep the API for dirty tracking.  The window is the flat range (`memory_region_find`), not one access: the firmware walks the DIF's 16 KB FIFO window with an incrementing destination, and the first cut refilled on every word (`dmacXlatFill` = burst rate).  Second item: the DIF's TX request line is masked at the VIC but toggled twice per word, and every toggle re-drove the CPU line — `arm_cpu_set_irq` → `cpu_interrupt` forces the TB loop out per call; the VIC now drives the CPU lines only on a level change (0027's `cpsr_write_check_irq` re-checks on unmask, so nothing relied on the repeats).  Plus the DIF pin table's dead `name[32]` | `tools/stopwatch.mjs`, two alternating pairs: **0.503/0.514 & 0.489/0.498 vs 0.497/0.457 & 0.453/0.424** (≈ +9 %, host load moving between runs); `dmacXlatFill` 0/s in steady state (306 per boot).  Boot: **flat within a loaded host** — two both-order `--quick --runs 2` pairs under load 6–13 from other sessions (19 GB swapped) disagree in sign (+2..+9 % slower, then −4..−5 % faster / +2..+4 % slower), while 40 s counter samples show the new build warping 13 % more virtual time and moving 6 % more DMA words in the same wall time with identical per-work ratios.  Gates: op-suite 1156/1156 native JIT + TCI identical, native 4/4, lockstep 250e6 clean vs the pre-0047 oracle, bootcheck s75/el71 PASS (ke800: the pre-existing first-page stall, § Remaining 8) |

| 0049 pmb887x: GPTU T0/T1 QEMU timer armed for observable overflows only | the ke800 first-page "stall" (§ Remaining 8): the LG firmware chains GPTU T1A..T1D into one 32-bit timer clocked at 26 MHz (T1A bypass, B/C/D concatenated, reload from the top byte, SR10 on the T1D overflow) and the model armed its QEMU timer at every **8-bit overflow of the free-running byte** — ~100 k main-loop callbacks per second on wall time (no icount), each ~10 µs of `emscripten_get_now` and friends in wasm and each under the BQL.  Profile of the stalled page: main-loop worker 100 % busy (`_emscripten_get_now` 37 %, `futex_wake` 9 %, `gptu_t2_sync_timer`, `gptu_t01_add_ticks`, `timer_mod_ns`), vCPU worker 94 % `futex_wait`, guest ~40 k insns/s.  Now `gptu_sync_timer` walks the carry tree of each free-running timer (`gptu_t01_ticks_to_boundary`): the sync steps to each overflow that *reloads other timers* (the interval after it counts from the reloaded values — everything else `gptu_t01_add_ticks` reproduces exactly from an overflow count, output toggles included, by parity) and the QEMU timer is armed only for the next overflow somebody can *observe* — a service request, or a T2 trigger that T2 is actually listening to (reload/capture mode or a masked RLCP event).  Counter `gptuTimer` (QEMU-timer callbacks, T01 + T2) | **ke800 booted alone: idle screen at tIdle 64–77 s** (cold page, host load 2–8; native 31 s), insns@idle 1.8–2.0 G, where 0048 crawled: `idlebench --board ke800 dist-jit-0048` NOIDLE at 420 s, t1G 255.6 s / t1.5G 377.5 s (0049: 44.5 / 64.4 s), and the plain bootcheck page sat at 590 M for 300 s.  Native ke800 timeline unchanged (logo 18 s, idle 31 s).  **S75 boot −4..−5 % in both orders** (`--quick --runs 2`: pair A t0.5G 22.5→21.7, t1.3G 29.6→28.3; pair B 0049 listed first, t1.3G 33→31.3, every milestone in the same direction) — the storm taxed the icount boot too.  Gates: native 4/4, op-suite 1156/1156 JIT + TCI identical, lockstep 250e6 clean vs the 0049 native oracle, bootcheck s75 1717 M / el71 1608 M / ke800 1945 M (≥ 1.5 G) |

| 0050 pmb887x: no 16 KB zero-fill per DMA word, no checked casts per LCD byte | the J2ME stopwatch profile on 0049 (`prof-stopwatch-0049`, 20 s): guest code 46 %, devices 34 %, other 8 %, lookup 4 %, memory 3.5 %; top device symbol `dmac_transfer_memory` **7.5 % self time for moving one 4-byte word** — QEMU's meson adds `-ftrivial-auto-var-init=zero` and the function's `uint8_t buffer[16 * 1024]` was cleared on every call (`memory.fill 16384` in the wasm asm, ~480 k × 16 KB per second, ~150 ns per word on this host).  `QEMU_UNINITIALIZED` on the buffer (every path writes the bytes it reads).  Second: `object_dynamic_cast_assert` 1.7 % — `SSI_PERIPHERAL()` in `ssi_transfer` and `PMB887X_LCD()` in `lcd_transfer` run per LCD byte and still call the assert for its trace point with `qom_cast_debug=false`; both are plain casts now (the bus type and the class guarantee the type) | `tools/stopwatch.mjs`, four pairs both orders: **0.542/0.545/0.541/0.547 vs 0.483/0.533/0.509/0.458** (new build ahead in every pair, +2..+19 %, means 0.544 vs 0.496 = **+10 %**; the profile share predicted ~+7 %; note the old build's spread is 5× wider — a 16 KB memset per word is sensitive to whatever else the host runs, which is also why this meter drifted with load in earlier rounds).  **Boot flat**: `--quick --runs 2` both orders read the *second-listed* leg 2–4 % faster whichever build it is (pair A 0049 first: t1.3G 29.5 → 28.3; pair B 0050 first: 29.6 vs 28.3) — the boot moves few display words, so nothing was expected.  Gates: native 4/4, lockstep 250e6 clean vs the 0050 native oracle, bootcheck s75 1718 M / el71 1608 M / ke800 1988 M.  **The phone question, answered on the desktop** (no `/dev/kvm` in the container, so no Android emulator): the running app is one busy thread (vCPU worker 98 %, page thread 3.5 %, main-loop worker 2.3 %; the S75 boot reaches idle at 40–41 s whether Chrome has 32 cores or is pinned to one), so a Pixel's single big core is the whole budget; V8's tier is not the gap (`--no-liftoff` = TurboFan only: stopwatch +3 %, boot 75 s instead of 40; `--liftoff-only` = baseline only: boot 54 s, +35 %, and the keypad navigation then drops presses — `--no-wasm-tier-up` is a no-op in Chrome 153); `?hud=1` puts MIPS / v/wall / lag on the page so the device can report its own number |
| 0051 pmb887x: DIF pin rebuild skipped on unchanged inputs, FIFO index without modulo, no checked bus cast per SSI transfer | the stopwatch profile of 0050 (`prof-stopwatch-0050`): guest 48 %, devices 32 %, other 7 %; the checked casts were not all gone — `BUS()` in `ssi_transfer` still called `object_dynamic_cast_assert` once per LCD byte (119 ms/20 s, attributed to `dif_tx_from_fifo` by the profiler); `dif_update_gpio_state` runs twice per word (tx_csreg active/inactive) and rebuilt six pin levels from unchanged inputs (235 ms); `pmb887x_fifo_base_push/pop` took a modulo per index step.  Plain cast, an input key that skips the pin pass, compare-and-wrap.  **Tried and dropped**: the same key on `dif_trigger_dma` — it blanked the Siemens displays (the function re-enters itself through the DMAC's CLR handler; the outer pass finished with stale levels after the nested pass had stored the fresh key — the native suite caught it) and, once guarded, the profile showed it never hits (self 299 → 462 ms: the inputs differ on every call of a word's raise/acknowledge/release sequence) | profile candidate vs 0050: **"other" 1416 → 1056 ms** of 20.3 s, `dif_update_gpio_state` 235 → 142, the cast gone, cpu-loop+devices flat (6435 → 6391).  `tools/stopwatch.mjs`: loaded host three candidate legs 0.547/0.554/0.540 vs 0050 0.486/0.530 (two 0050 legs failed at app navigation under load — a flake, the same snapshot then ran); quiet pair after the gates **0.584 vs 0.562 (+4 %)**.  The meter's ±5 % drift cannot resolve a change this size; the profile deltas are the evidence.  Gates: native 4/4, lockstep 250e6 clean vs the 0051 native oracle, bootcheck s75 1717 M / el71 1608 M / ke800 2030 M |
| 0052 tcg/wasm64: labels as nested blocks instead of the dispatch loop | the per-TB structure, sized first: the stopwatch does ~17 M TB entries/s (4.24 insns/TB with `EXTRA_Q="env=W64_TBSTATS=1"`, 73.6 MIPS), i.e. ~28 ns per TB entry of which the guest's four instructions are only part; a native `-d op_opt` dump of 25 s of S75 boot: 132 k TBs, 4.0 insns / 26 ops / 1.5 labels per TB, 200 k `brcond`, **0 backward branches**, max 54 labels in one TB.  Every TB body was a `loop` around sibling `if (bp <= k)` regions (a branch set `$bp` and re-entered the loop; each label cost a compare on fall-through; V8 adds a loop stack check and loop phis for every live local — the likely reason the `$tlb` hoist regressed).  Now `w64_scan_labels` numbers the labels at TB start and, when no branch is backward, opens them as nested blocks (last label outermost); `set_label` closes the innermost, `br`/`brcond` become `br`/`br_if depth`.  A backward branch keeps the loop scheme.  `W64_MAX_BLK` 32 → 128 | `tools/stopwatch.mjs` quiet host: **0.603 / 0.628 / 0.605 / 0.592 vs 0051 0.584 / 0.589 / 0.582 (+3.5 %)**, every new leg above every old one (a 0051 leg under a load spike read 0.523).  Profile 20 s: jit-guest 50.9 → 49.5 %, cpu-loop+devices 31.4 → 31.6 % (flat), tb-lookup 4.5 → 4.8.  Boot: bootcheck s75 1718 M / el71 1608 M / ke800 2242 M (0051: 1717 / 1608 / 2030); idlebench `--runs 2` both orders tIdle 28.2/29.8 (−5 %) with the new build second, 29.1/29.9 (+3 %) with it first — the usual order bias, boot flat.  Gates: lockstep 250e6 identical vs the native oracle, op-suite 1156/1156.  wasm +1.6 KB.  **Not gated on Firefox — see 0053** |
| 0053 tcg/wasm64: open the batch at TB start (Firefox module budget) | Firefox on the Pixel stalled at the Siemens logo (0.76 G insns, MIPS 0); local Playwright Firefox reproduced it on every snapshot back to 0046 ("failed to allocate executable memory for module", the vCPU worker dies at ~450 M insns) while 0022 booted.  Six bisect builds (the first two were invalid — pre-AFE, the Siemens boot never reaches the phase) pinned it to the prologue cleanup `58bb2742` (2026-09-13 review session, "measured flat").  Mechanism: the open batch is created lazily inside `w64_union_type`; until the cleanup every prologue registered a lockstep import type, which opened a batch as a side effect.  After it, a TB translated right after a batch close — no helper call, so no type registration — was never staged and ran from a throwaway per-TB module: Firefox counters at the crash read modules 27.6 k vs closes + compactions 21.8 k (5.9 k temp modules, ~20 % of TBs), the good build 27.4 k vs 27.4 k.  Temp modules are never evicted, so Firefox's ~16 k-module budget runs out; Chrome has no such budget and never showed it.  Fix: `w64_batch_begin_tb()` at `tcg_out_tb_start` opens the batch explicitly; `ffboot.mjs` now prints `temp=` so the invariant is visible | Firefox: boots to idle again (v 58.9 at 60 s, 1.62 G insns, `temp=0`, errors 0).  Chrome: lockstep 250e6 identical, op-suite 1156/1156, bootcheck s75 1718 M / el71 1608 M / ke800 2408 M.  Stopwatch 0.605 vs 0052 0.596 (flat).  idlebench `--runs 2` both orders: tIdle **28.6 vs 29.6 (−3 %) with the fix listed second, 28.7 vs 29.5 (−3 %) listed first** — faster in both orders, against the order bias: a temp module is a `Module` compile per TB |
| 0054 memory/pmb887x: MMIO write dispatch decision cached per DMAC window | after 0053 the stopwatch profile read guest 47.2 %, devices 33.8 %, memory 4.2 %, other 5.8 %.  The display DMA is one 4-byte word per request (~570 k/s) and 0048's translation window already keeps it off the flatview, but every word still paid `memory_region_dispatch_write`'s own per-access work for a window that had not changed: alias resolution, `memory_region_access_valid`, the endianness-swap test, the ioeventfd match, and `access_with_adjusted_size`'s split loop with its MAX/MIN/mask/shift arithmetic (`access_with_adjusted_size` 270 ms + `memory_access_size` 92 ms of 20.3 s).  Whether all of it can be skipped depends only on the region and the width, so `memory_region_write_direct_ok()` decides it once per window and `memory_region_dispatch_write_direct()` runs the tail — reentrancy guard, trace point and the device's write callback all kept, since all three are observable.  The DMAC caches the predicate in `pmb887x_dmac_xlat_t` (cleared on refill) and checks only the per-access alignment; whatever the predicate rejects falls through to the unchanged path.  **Closed by inspection on the way** (§ Remaining 7): a same-batch direct `return_call` for chained TBs is not possible as written — the chain slot is patched by `tb_add_jump` at runtime, long after the module is compiled, so the target is unknown at emission; and the per-exit `fidx` load is not removable, because `w64_batch_evict_oldest()` makes eviction real even though a boot shows `ensureN 0` | profile: `access_with_adjusted_size` and `memory_access_size` **gone from the profile entirely**, memory 4.2 → 3.5 %, other 5.8 → 4.1 %, the freed share moving to guest code (47.2 → 49.0 %) — ~2.1 points of non-guest work.  **Both end-to-end meters read flat**, as in 0051: stopwatch 10 alternating samples, candidate mean 0.601 (0.618/0.563/0.604/0.608/0.612) vs 0.593 (0.635/0.603/0.578/0.536/0.612) inside a baseline spread of 0.536–0.635; idlebench `--runs 2` both orders puts the *second-listed* leg 4–6 % slower whichever build it is (the order bias), so the boot is flat.  Gates: op-suite 1156/1156 three backends identical, native 4/4 displays PASS, lockstep 250e6 identical, bootcheck s75 1718 M / el71 1608 M / ke800 2198 M, Firefox boot `temp=0` errors=0 |
| 0055 tcg/wasm64: `local.tee` for set+get pairs, no scratch local in the TLB probe | picked from the 0054 profile by asking where the *uniform* cost is rather than the biggest symbol: `tools/profjit.mjs` says guest time is smeared (25 % of jit time in the top 21 functions, 50 % in 272, 90 % needs 2389, top function 1.5 % of total), so there is no hot TB to hand-tune and only per-op overhead is worth touching.  The emitter wrote `local.set $x; local.get $x` in eight places — that is what `local.tee` is for — and the inline probe additionally round-tripped `tlb_addr` through `$scr1` although nothing reads it after the compare.  The probe runs on **every** guest memory access (`qemu_ld/st` = 37 % of emitted bytes) and drops from seven local ops to three; `tcg_out_goto_tb` and `tcg_out_goto_ptr` lose one each at ~17 M TB entries/s.  Net −3 lines | **mechanism proven, speed flat.**  `diagall` 45 s boot, 2 runs per dist, run-to-run spread **0.04 %**: emitted bytes per TB 530.6 → 511.0 (**−3.7 %**), `modBytes` 194.2 → 189.1 MB (−2.6 %).  Speed: idlebench `--quick` **contradicts itself** in the two orders (the same wasm read 12.5 s then 14.3 s, +14 %); stopwatch 10 ABBA legs 0.545 vs 0.535 with per-pair ratios +9.2/+1.3/+22/−16.7/−6.7 %; insns at a fixed 45 s wall time, 5 runs each, 2550 vs 2524 M (+1.0 %) inside a ±7.5 % spread on both sides (an n=2 read of +3.5 % did not survive n=5 — the samples are bimodal at ~2440 and ~2600 for *both* dists).  Landed as a simplification on the byte evidence, not as a speed win.  Gates: op-suite 1156/1156 three backends byte-identical, native 4/4 displays PASS, lockstep 250e6 serial + 29 SRAM digests + 20 SDRAM + 20 epoch reg sets identical, Firefox idle `temp=0` errors=0 |
| 0056 accel/tcg: io-barrier set no longer thrashes | the LG boards run `icount=none`, so **every** mid-TB MMIO access takes the stock `cpu_io_recompile()`: JS-exception unwind + `tb_phys_invalidate` (a full jump-cache flush — the TB is CF_PCREL) + retranslation + a fresh `WebAssembly.Module`.  The io-barrier set (0014) exists to make that once-per-insn, but it was 64 slots, direct-mapped on `(pc >> 2)` — two hot MMIO insns in one slot evict each other every pass, so neither is ever kept out of the middle of a TB and the recompile repeats forever.  The KE800 sat at ~800 recompiles/s at a standing idle screen with the same ~800 retranslations, jump-cache flushes and modules per second, which capped it at ~1 MIPS whenever it had work.  Now indexed by `(pc >> 1)` (Thumb insns are 2 bytes apart; `>> 2` aliased every adjacent pair), 4096 slots × 2 ways; `W64_IO_BARRIERS=<n>` caps the usable slots for a same-wasm A/B.  New counters `ioRecomp` / `ioBarrierEvict` / `ioBarrierSplit` — the existing `ioRewind` counted only the ROM-device branch, so this whole path was invisible | `uibench --board ke800 --state menu`, two interleaved pairs vs 0055: **MIPS 42.6 / 25.1 vs 1.3 / 1.8, fps 9.8 / 4.9 vs 0.0 / 0.0**, `tbGen/s` 56 / 505 vs 836 / 750, `mod/s` 22 / 85 vs 816 / 697, `jcFlush/s` 1 vs ~800.  fps 0 is not a slow UI — on 0055 the menu key does nothing at all.  `ioRecomp` 1/s after, `barrierEvict` 0/s.  The idle screen is ~1 MIPS on both (an idle LG guest is halted; that number was never the churn).  Gates: op-suite 1156/1156 JIT+TCI identical, native 4/4, lockstep 250e6 identical, bootcheck s75/el71/ke800 PASS, Firefox `temp=0` errors=0 |
| 0057 accel/tcg + memory: subpage MMIO dispatch resolved at TLB fill | a page shared by several regions is represented by a *subpage container*, and the TLB fills with the container (its translate passes `resolve_subpage = false`).  The container re-enters the flatview per access (`subpage_read` → `address_space_read` → translate + validity walk + dispatch) **and** its `valid.accepts` callback stops `tlb_resolve_io_dispatch()` from installing any direct call — two translations and two dispatches per access.  Every pmb887x device under the 1 KB page is one: STM `0x30`, GPTU `0x100`, SCU `0x200`, VIC `0x2d8`.  The EL71 polls the STM and spent ~22 % of its vCPU there (`subpage_read`, `subpage_accepts`, `flatview_read`, `flatview_read_continue_step`, `flatview_translate`, `flatview_access_valid`, `address_space_translate_internal`, `memory_region_dispatch_read`, `memory_region_access_valid`, `access_with_adjusted_size`, both read accessors) — none of which the S75 profile shows, because its hot register is in the TPU (`0x2000`, whole pages).  `memory_region_subpage_leaf()` resolves one level and reports the run of offsets that share the leaf; `tlb_set_page_full()` resolves the leaf's direct dispatch for the faulting offset and records the run plus an offset delta, and the access path adds the delta and range-checks (a leaf entry gets `io_lo = 0`, `io_len = UINT32_MAX`, delta 0, so the check always passes).  Anything outside the run keeps the container's stock path | `uibench --state menu`, two interleaved pairs per board vs 0055 (shared host, external load 8–11): **EL71 v/wall 7.29 / 7.14 vs 6.51 / 6.59 (+10 %)**, MIPS +10/+12 %; **S75 MIPS 29.1 / 30.8 vs 24.6 / 24.4 (+22 %)**; S75 J2ME stopwatch vratio 0.363 / 0.479 vs 0.332 / 0.355 (+9 / +35 %, noisy under that load).  Mechanism: every symbol listed opposite is **gone** from the EL71 vCPU profile, `int_ld_mmio_beN` grows 1.8 → 4.1 % (it now does the dispatch) and `stm_io_read` is unchanged at 1.5 %.  Gates: as 0056 |
| 0058 accel/tcg + system: the icount seqlock is no longer paid twice per MMIO access | a guest that polls a device register reaches `io_prepare()` with `can_do_io` false on every access, and the stock-icount branch committed the running slice with `icount_update()` before dispatching.  That commit is redundant — `icount_get_raw_locked()` calls `icount_update_locked()` itself on every virtual-clock read, so a callback that reads the clock gets the identical value either way — and it is the expensive half, because `icount_update()` publishes under the vm_clock seqlock *write* lock: a spinlock acquire plus the write-side barriers, on a line every other thread reads.  Keep `can_do_io` (without it `icount_get_raw_locked()` aborts with "Bad icount read"), drop the commit.  Also calls the virtual-clock hooks directly in `cpus_get_virtual_clock()` instead of through `cpus_accel` | EL71 busy state (driven menu, 700 ms key period): `io_prepare` **7.1 % → 0.9 %** of the vCPU worker, `cpus_get_virtual_clock` 1.4 % → 0.7 %, v/wall 3.93 / 4.04 → 4.30.  Flat on the *free-running* menu state, which is not MMIO-bound — this is why the busy state is the one to measure |
| 0059 accel/tcg: fused single-piece MMIO **load** dispatch | the route from a guest load to a device callback is six frames that re-derive from each other (`do_ldN_mmu` → `mmu_lookup`/`mmu_lookup1` → `do_ld_N` → `do_ld_mmio_beN` → `io_prepare` → `int_ld_mmio_beN`), taken 1.2 M/s on the EL71 and 4.0 M/s on the S75.  Every one of those accesses has the same shape: TLB hit on an I/O entry whose dispatch `tlb_set_page_full()` already resolved (0054/0057), naturally aligned, one page, `TLB_MMIO` as its only slow flag.  `do_ld_mmio_1p()` does that shape in one frame; anything else returns false and takes the generic path unchanged.  `io_prepare()`'s rare `!can_do_io` half is split out (`io_open_clock_window`) and must stay ahead of the BQL guard, because `cpu_io_recompile()` longjmps and would leak the lock | new counter `ioLdFast` says the fused path takes **99.1 %** of MMIO loads.  EL71 busy, interleaved vs 0058, two pairs: MIPS 49.1 / 50.1 vs 45.7 / 47.1 (**+6.9 %**), fps 6.4 / 5.6 vs 4.2 / 4.3 (**+41 %**), v/wall +3.6 % — and it wins carrying two counter increments the baseline does not have |
| 0060 cpu-timers: `timers_state.qemu_icount` on its own cache line | `icount_get_raw_locked()` commits the running slice on every virtual-clock read, so a polling guest writes that field 1.5 M/s (EL71) to 4.5 M/s (S75), and every other `TimersState` field is read by other threads — the seqlock and spin lock above all, since that is how any thread reads a clock.  An emscripten microbenchmark of the exact shape: **2.2 ns/iter alone, 52 ns/iter with one reader on another core, 0.5 ns/iter read-only** — which is the ~50 ns/call the profiler attributes to `icount_get`.  56 bytes of padding, no semantic change | S75 driven menu (the highest clock-read rate, 4.5 M/s), three interleaved pairs: MIPS 53.2 / 54.2 / 55.2 vs 50.6 / 52.3 / 51.2 (**+5.5 %, 3/3**), ioLd/s +8.6 % 3/3.  On the EL71 (1.5 M/s) the same change is +5.7 % and −0.2 %, i.e. inside that board's noise — settled on the S75 |
| 0061 accel/tcg: fused single-piece MMIO **store** dispatch | the mirror of 0059.  The S75 leans on this side hardest: at idle it issues ~815 k MMIO stores/s against ~500 k loads (the TPU event RAM), so fusing only loads left half of that board's device traffic on the generic route.  The value is byte-swapped to little-endian at the call site exactly as `do_st_N()` does | `ioStFast` covers **98.8 %** of the S75's idle stores and 98.7 % of its menu stores |
| 0062 hw/pmb887x: the TPU no longer re-arms its QEMU timer on every register write | `tpu_io_write()` ends in `tpu_update_state()` for *every* TPU register including the event RAM, and that called `tpu_update_timer()` **twice** — the first arm overwritten by the second before the guest could observe it.  New counters said the S75 at a standing idle screen was making **1,449,833 `timer_mod` calls a second** against 26,674 actual TPU timer callbacks: the same "deadline = next hardware tick" storm 0049 found in the GPTU, driven by writes instead of by the timer.  Split `tpu_advance()` (counter, frame, interrupts, events) out of `tpu_update_timer()` (advance + arm), have the leading call only advance, and skip `timer_mod()` when the deadline has not moved and the timer is still pending | `tpuRearm/s` **1,449,833 → 82,882** (−94 %) idle, 524,357 → 18,491 (−96 %) menu.  Interleaved vs 0061: S75 idle MIPS 24.0 / 23.7 vs 21.0 / 22.0 (**+11 %, 2/2**), ioSt/s +12 % 2/2; EL71 menu v/wall 2.97 / 2.61 vs 2.29 / 2.34 (**+21 %, 2/2**).  Native suite 4/4 is the gate that matters here — the TPU drives GSM frame timing |
| 0063 system/cpus + accel/tcg: a lean BQL pair for the MMIO path | `BQL_LOCK_GUARD()` is ~22 calls no compiler may inline: `bql_locked()` and its coroutine-TLS accessor are `noinline` **by design** (`QEMU_DEFINE_STATIC_CO_TLS` puts an asm barrier in it), three `g_assert`s call them again, `bql_lock_impl()` reaches pthread through the lock-profiling function pointer, and `qemu_mutex_post_lock()` calls `mutex_is_bql()` and `bql_update_status()` — which calls the accessor twice more.  ~41 ns per lock/unlock pair, a quarter of a device register read.  `bql_lock_mmio()`/`bql_unlock_mmio()` read the flag once, take the mutex directly, write the flag once; they give up the three mutex trace points, the `-enable-sync-profile` hook and `CONFIG_DEBUG_MUTEX` bookkeeping **on this path only**.  Also forces `io_fast_bswap` inline — a four-line switch the size heuristic had left out of line as its own 0.5 % symbol | back-to-back profiles of the same S75 idle state (the host was at external load ~35 and the wall meters could not resolve it): BQL symbols **4.6 % → 2.4 %** of the vCPU.  The same symbols were 15.8 % in the driven-menu state, where MMIO is 4 M accesses/s |
| 0073 system/cpus: do not give the BQL back after every device access | `bql_lock_mmio()`/`bql_unlock_mmio()` were already the lean pair (0063), but an idle S75 runs them **3M times a second** and an uncontended musl mutex is still a locked compare-exchange plus a locked exchange — while the main loop, since 0067, is parked 99.4 % of the time and wakes ~90 times a second.  `bql_unlock_mmio()` on a vCPU thread now leaves the thread-local flag set and keeps the mutex; the next `bql_lock_mmio()` finds it set and does nothing at all.  Ended by: an explicit `bql_lock()` on this thread (adopts it), `bql_lock_impl()` counting itself into `bql_wanted` before blocking with `cpu_exec_loop()` releasing on that count, and `bql_lock_mmio()` handing over directly.  Safe rather than merely fast because the rr loop unlocks the BQL for real before every `tcg_cpu_exec()`: a missed release is bounded by one icount slice, not a deadlock | `__pthread_mutex_lock` 1.5 %→0.6 %, `__pthread_mutex_unlock` 1.7 %→0.7 % (back-to-back profiles; the wall meter was wrecked by orphaned browsers at load 8–19).  S75 idle MIPS 45.8→47.6 (+4.0 %, 2/3 pairs); the profile pair's own MIPS 49.0→51.7.  KE800 boot (icount=none, main loop owns its timers — the board at risk) tIdle 52.4→47.2 s, −10 %.  All gates green |
| 0072 wasm: four fixed costs on the per-access and per-TB paths | (a) `io_open_clock_window()` under stock icount is just "set can_do_io", but was a noinline call on every mid-TB device access, 3M/s — decide `QEMU_IO_REWIND` and the icount mode once, precompute the region's `rom_device` bit in `CPUTLBEntryFull`, inline the rest; (b) `tpu_ram_write()` wrote the word byte by byte, read it back, masked it and wrote all four bytes again — fourteen byte accesses per 32-bit store, 1.5M/s — which for the word-aligned 2/4-byte case reduces exactly to one masked half plus a zeroed half; (c) `cpu_exec_loop()` still reached `get_tb_cpu_state` through `cpu->cc->tcg_ops`; (d) `cpu_handle_interrupt()` cleared the kick flag with `qatomic_set_mb()` every pass — a seq_cst store plus a full fence — whether or not there was anything to clear | measured together: S75 idle MIPS and v/wall **+1.2 %**, 3/4 pairs.  Profile: `io_open_clock_window` 0.9 %→0.4 %.  (d) turned out to be nearly free — the barrier was not the cost |
| 0071 target/arm: a short hflags rebuild for a pre-v6 A-profile CPU | a counter said an idle S75 rebuilds AArch32 hflags **814k times a second**, one per 57 guest instructions (EL71: 1.0M).  On a CPU with none of M / AARCH64 / EL2 / EL3 / PMSA / V6 every question `rebuild_hflags_a32()` asks is constant or a two-load one, and five of the calls it makes cannot be inlined by the backend — `arm_sctlr`, `arm_mmu_idx_el`, `fp_exception_el`, `arm_singlestep_active`, `access_secure_reg`.  One test of `env->features` picks a path that computes the same flags from `sctlr_el[1]` and four CPSR bits (CPSR.PAN checked, not assumed).  **Verified, not argued**: `-DHFLAGS_FAST_VERIFY` takes the short path, computes the generic answer anyway, counts disagreements and returns the generic one | S75 idle MIPS **+3.9 %**, v/wall +4.1 %, 4/4 pairs.  Profile cluster (`rebuild_hflags_a32` + `arm_rebuild_hflags` + `arm_mmu_idx_el` + `fp_exception_el` + `arm_fgt_active` + …) 4.3 %→1.5 %.  Verification: 3 boards × idle and menu, ~59M rebuilds, **hflagsBad=0** in all six windows |
| 0070 accel/tcg/icount: read the virtual clock without the wasm fence pair | `icount_get()` was the top symbol at 4.3 % for ~1.2M reads/s, and almost none of it was arithmetic: two `atomic.fence` (the seqlock's `smp_rmb()` pair), one `i64.atomic.store` (publishing `qemu_icount`), four atomic loads.  wasm has no relaxed atomics and no acquire fence, so every `qatomic_set` is seq_cst and every `__atomic_thread_fence` is a locked operation.  A local seqlock pair whose barrier is a compiler `barrier()` — justified *for this section only*, because every shared location it touches is reached through `qatomic_*` and is therefore already seq_cst — plus a plain publish store (single writer, `QEMU_ALIGNED(64)`, readers already tolerate staleness) and an early return when nothing has executed | ceiling probed first (all atomics stripped: **+5.0 %**, 3/3); the patch gets **+5.2 %** MIPS and v/wall, 4/4 pairs, i.e. all of it.  `icount_get` 4.3 %→0.6 %.  The fences-only first cut was +1.8 % — the locked *store* was more than half the cost |
| 0079 pmb887x: run DIF v1 transfers inline instead of from a timer | every word went through `timer_mod(transfer_timer, 0)` and its callback — an instant deadline bought only a list removal, a sorted insert and a dispatch, ~84k/s on a CX70; worse, the DIF's `breq` then reached the DMAC from outside its run loop so the DMAC's `in_run` guard never applied and it armed *its* timer per burst (`dmacSchedTimer` 10.87M vs 10.86M bursts, against an S75's 99/s vs 11660/s). Run the queued words behind a re-entrancy guard, as `dif_v2.c` always has (v2 never calls `timer_mod`); the loop still stops on a raised request, so the resume points — next FIFO write, RX read, event handler on a cleared request, and `CON` read for a CPU spinning on BSY — carry the held word | CX70 fixed-work +7.3 % (4/4 interleaved pairs, host load 2.8–5.8); screenshot at a fixed instruction count byte-identical; menu navigation renders correctly |
| 0080 wasm-diag: counters that price speculation, the jump cache and hflags | instrumentation only, all of it under `CONFIG_TCG_WASM64` / `__EMSCRIPTEN__` so native builds are untouched.  `SPEC_MISS/NOSUCC/EXISTS/NOTRAM/MADE` (80-84) price the speculative successor walk; `HFLAGS_CALLS` (85) prices `arm_rebuild_hflags`; `LOOKUP_CONFL` (86) splits jump-cache misses into capacity vs flush | they exist because this round found the wasm profile's per-function self-time is wrong by ~100x (see § REJECTED, `arm_rebuild_hflags` as an 11 % target).  Immediate results: **module count == miss count** (`closeN` 34922 == `specMiss` 34922 on an EL71 boot window, `temp` 0), which killed return-address speculation; `arm_rebuild_hflags` is called 11,606/s, not 11 % of the vCPU; and every idle-CX70 jump-cache miss is capacity, not a flush.  Gates: native op-suite 1156/1156 both backends serial-identical, native lockstep 3/3 clean at 2.5 G (the browser gate and native `boot-init` were unrunnable — host at 23 GB swap — and fail identically on the pre-change revision) |
| 0081 ui/wasm: a key event before the display exists must not trap the module | `wasm_send_key()` is exported at instantiation; `wasm_display_init()` creates the bottom half it schedules much later; the page's keypad is live from its first render.  `qemu_bh_schedule(NULL)` does not fault where the mistake is -- the atomic on `bh->flags` lands on address 40, a valid wasm address, and succeeds -- so `bh->ctx` reads address 0 and the list insert at ctx+184 leaves the 2 GB memory.  Publish a readiness flag with a release store, take it with an acquire, drop events before it; and stop the page sending a release for a key that was never pressed | **CX70 bootcheck 203M insns (trap) -> 13442M with 2443 fb updates**, its best boot here; bootcheck 4/4 after failing 4/4 on every dist.  Regression test `tools/earlykey.mjs`: PASS on all four boards, FAIL on the build before.  Not a perf patch -- but it was failing the gate that every perf patch is measured through, and it masqueraded as host memory pressure for an afternoon |
| 0082 wasm-diag: phase timers, and delete a heuristic that never ran | three things, all instrumentation or removal. (1) The `ldr pc, [pc, #-4]` trampoline block in `w64_speculate` is **deleted** — see § REJECTED; it had been guarded on `!CF_PCREL` since birth and had never executed. (2) Phase timers: `MOD_NS` around `w64_batch_instantiate` (always on, ~1k/s), `TB_GEN_NS` and `FILL_NS` behind a new `WASM_DIAG_TIME_PHASES`, plus `TB_ICOUNT` for mean TB length. Charged in **C**, because the EM_JS body's own `__w64t*` globals live in a vCPU worker that never yields and a page-side `evaluate()` on it hangs. (3) `W64_NOGENBUMP`, an unsound ceiling probe for the inline cache | no throughput change is claimed or intended; the value is what the timers said. The translate+compile pipeline is **19.5 % of EL71 boot wall at its densest, 8 % late** — so *the early boot is not compile-bound*, which this document had asserted since round nine, and tiering's whole prize is capped at the ~10 % compile slice. MMIO, `hflags`, TLB fills, TB length and the inline-cache generation were each measured and closed (§ REJECTED and the hand-off). Gates: browser bootcheck 4/4 + earlykey 4/4; native op-suite, lockstep and suite as below |
| 0083 memory: a readonly flip is a view *variant*, not a topology change | `memory_region_set_readonly()` set `memory_region_update_pending`, so every flip bumped `topo_gen`, re-rendered every flat view, re-dispatched it to every listener **and dropped the whole romd variant stash**.  But `readonly` changes the rendered `FlatRange` (it is in `flatrange_equal`), not the region tree — exactly what the romd stash already exists to cache.  So: track the readonly set in `ro_on_mrs`, fold it into `romd_signature()` behind its own separator, and take `romd_update_pending` instead.  The pmb887x EBU opens the NOR flash chip-select for a CFI command and closes it again, so the toggle is A-B-A and hits the stash every time | found by pricing the device write callback directly (`DEV_W_NS`), which said MMIO **stores** cost 330 ns against a read's 3.6 ns, then by histogramming the slow ones on `full->phys_addr` — 68 % landed on the EBU, and a per-attribute counter showed **100 % of the remaps were readonly** (size/base/enable moved 14/10/14 times in a whole boot).  EL71 EBU write 8278 ns -> 260 ns, `topoReused` 412/s -> 1330/s.  Fixed-guest-work A/B over the boot window, guest work identical: **el71 +55.6 %** (29.4 -> 45.8 MIPS, 3/3), **cx70 +31.5 %**, **s75 +15.1 %**, ke800 -2.1 % (no EBU toggling there; noise).  Warm window is a tie, as it must be — the toggling is a boot-phase behaviour.  Gates: browser bootcheck 4/4 + earlykey 4/4; native op-suite, lockstep and suite as below |
| 0084 accel/tcg: size the jump cache for the wasm64 lookup path | `TB_JMP_CACHE_BITS` 12 -> 14.  The wasm64 backend reaches `tb_jmp_cache` through `helper_lookup_tb_ptr_lc` on every inline-cache miss (~15k/Mi), and at 4096 entries 11.5 % of those fell through to the qht — with `LOOKUP_CONFL` saying **95 % of the fall-throughs were conflict misses**, i.e. a sizing problem, not cold pcs | qht lookups per Mi -62 % (el71 1718 -> 649) and -55 % (cx70 1814 -> 816).  Warm-window fixed-guest-work A/B: **cx70 +3.5 % (3/3), el71 +1.6 % (2/3)**.  **16 bits is worse than 14 on both boards** (el71 -0.3 % 1/3, cx70 +2.4 %), so 14 is a peak, not a floor.  Affordable only because 0083 took `tcg_flush_jmp_cache` from 1135/s to ~0/s — the flush is what a bigger table costs.  256 KB for the one vCPU.  Gates: browser 4/4 + 4/4; native op-suite, lockstep, suite |
| 0085 target/arm: rebuild hflags only when a CPSR write moves one | `cpsr_write()` set `rebuild_hflags` from the write *mask* alone, and `msr cpsr_c` — how firmware masks interrupts — has mask 0xFF, which covers `CPSR_M`.  Every critical section in the guest therefore rebuilt hflags for a mode that had not changed.  Require a bit to actually move; M/E/IL are the only CPSR-derived hflags inputs (thumb and condexec are read straight out of env by `arm_get_tb_cpu_state`) | `arm_rebuild_hflags` **873k/s -> 317k/s, -64 %** (15008 -> 5307 per Mi).  Warm-window A/B: **cx70 +1.0 % (3/3), el71 a tie**.  Smaller than the phase timer's 3.8 % — the 1 ms clock over-attributes short functions even after `CAL_NS`.  Verified with a `--enable-debug-tcg` native build, whose `assert_hflags_rebuild_correctly()` re-derives hflags on every `arm_get_tb_cpu_state`: clean over full el71/s75/cx70 boots.  **That check was necessary**: lockstep runs JIT against TCI and both share this code, so a stale hflags would not diverge |
| 0086 wasm-diag: split the topology commit, decompose a module compile | Instrumentation only, all wasm-gated.  (1) `TOPO_FULL`/`TOPO_VAR` split `TOPO_COMMIT`, which counted both commit paths together and stopped meaning anything once 0083 gave the cheap one the traffic; `TOPO_R_*` attributes the expensive one via a reason bit per setter of `memory_region_update_pending`.  (2) `MOD_NS` split four ways — the EM_JS body had timed these into `__w64tR/M/I/A` since 0019 and those globals live in a vCPU worker that never yields, so nothing had ever read them — plus `MOD_CLOSE_CNS`/`MOD_COMPACT_CNS` splitting compile by assemble source.  (3) `W64_MODBENCH=<n>`: compile one real module's own bytes 200x back to back inside the vCPU worker.  (4) `W64_LDSTPAD=N`: N fold-proof ALU units on every memop, so wall against N prices a wasm instruction against a *known* cost instead of round eighteen's empty interval | **The hand-off's open item 2 closes negative**: `topoFull` 170 per 25 s EL71 boot against `topoVar` 16872, and 122 of the 170 are startup `add_subregion` — 0083 left ~7 full commits/s where there were 1135.  **And `MOD_NS` is not compilation.** Of 3.66 s: `Module` 2.82, `Instance` 0.31, `addFunction` 0.10, import object **0.026** (2.1 imports per module).  Close (33 969 modules / 88.2 MB / 2.849 s) against compaction (191 / 84.3 MB / 0.132 s) solves to **~80 us fixed per call, ~1.4 ns/byte marginal**; `W64_SPEC_N` 8/32/128 agrees independently at **83.6/82.7/83.3 us** across 1880→2903 bytes per module.  `W64_MODBENCH` then reads **12–31 us** for the same bytes back to back, against 83 us once in the normal flow: **four fifths of "compile" is cold cache**, paid per compile event, which is why it tracks count and ignores bytes.  This retro-explains three REJECTED rows — compaction-off is flat because compaction is 0.13 s of 2.98 s, and `W64_SPEC_N`=64 is a tie because 83 us per module against ~13 us per translated TB is par.  `W64_LDSTPAD` has a working range: at N=4 it is clean (+1.55 s of a 28.70 s el71 window for 18 instructions per memop, 2.51 ns/memop — so the whole inline TLB probe is ~5 % of wall), at N=12 the pad grows the code enough to add **8556 modules** and 3 `tb_flush`es and the slope is meaningless.  Gates: bootcheck 4/4, earlykey 4/4, ffboot clean, op-suite 1156/1156 both backends serial-identical, lockstep 3/3 at 2.5 G, native 4/4 |
| 0087 tcg/wasm64: the module-GC nudge only where it is needed | 0019 allocates 32 MB of garbage every 256 instantiations so SpiderMonkey's GC sees pressure from dropped modules — module code is not GC pressure there and the vCPU worker never yields, so they accumulate against Firefox's ~16k executable-memory budget.  At the EL71 boot's ~1360 modules/s that is **~170 MB/s manufactured on purpose**, and V8 has no such budget.  Decided from `navigator.userAgent` (WorkerNavigator's is the page's — verified in a Playwright Firefox worker); `W64_GCNUDGE=0/1` forces either leg inside one wasm binary | Chromium: `modNs` per module **119.3 → 111.6 us**, 0.27 s per 25 s EL71 boot, **~1.1 % of wall**.  It is only ever its own allocation — the first hypothesis for the 83 us module was that it inflated compile, and with it off compile came back **2.8754 s against 2.8761 s**.  Firefox unchanged by construction; ffboot 1.625 G insns, `temp=0`, `errors=0`.  **The gate can no longer reproduce the OOM it was written for**: since 0053 `temp` is 0 and module creation plateaus at ~37k once the guest idles, and a 202 s Firefox run with `W64_GCNUDGE=0` reached 2.73 G insns and 40 152 modules created with `errors=0`.  Whether desktop Firefox still needs the nudge is therefore untested — but the original report was mobile Firefox on a Pixel, so it stays until someone retests there on a workload that keeps generating modules |
| 0088 tcg/wasm64: stop rebuilding heap views and copying the module twice | 0086's four-way split of `MOD_NS` left ~14.5 us a module outside every timer; `MOD_PRE_NS`/`MOD_POST_NS` close the accounting and put **9.8 us a module in the prologue** of `w64_batch_instantiate`.  It was rebuilding a `DataView` and (0086's own) `Float64Array` over the 2 GB shared buffer on every call and copying the module bytes twice — `HEAPU8.slice()` already returns a `Uint8Array` and the `new Uint8Array()` around it copied again.  Views cached and invalidated on buffer identity, which is the only thing that can change them; wrapper dropped | `modPreNs` **0.341 -> 0.185 s** (9.8 -> 5.3 us a module), stable to +-0.5 ms across four runs in which `modCompileNs` swings 2.62-2.94 s — so the mechanism is clean and compile is untouched, as it must be: nothing here changes a byte of what is compiled.  **0.156 s per 25 s EL71 boot, ~0.62 % of wall.**  Gates: bootcheck 4/4, earlykey 4/4, browser lockstep JIT vs TCI 3/3 clean at 2.5 G with serial identical.  Native unaffected — `tcg/wasm64/` is not in a native build |
| 0078 pmb887x: give DIF v1 the two things v2 already has | `dif_mux()` looped over `p->bits` (16) with two divisions and two modulos per output bit, once per transferred word — v2 resolves the same mapping through a 4×256 byte-lane table rebuilt only when `bmreg`/`bcsel`/`bcreg`/`bits` change; and `dif_trigger_dma()` drove both DMA request lines on every `srb_set_isr`/`set_icr` (~4×/word) although the level almost never changes and `dmac_handle_signal()` drops the repeat one indirect call later, exactly what v2's `dif_set_dmac_req()` filters at source | CX70 fixed-work: mux table +3.1 % (3/3), request filter a further +3.0 %, together +6.2 % (3/3); mux table proved equivalent over 4.6M random configurations across every bits width |
| 0076 wasm-diag: gate the hot-path counters | `wasm_diag_stat[]` began as cold-path diagnostics (its header still said "hot paths deliberately carry no counters") but `IO_LD`, `IO_ST`, both `*_FAST`, `VCLOCK_READ`, `HFLAGS`, `HFLAGS_FAST`, `TPU_RAM_W`, `TPU_RAM_SKIP`, `LC_CALL`, `LC_FILL` had all migrated onto it — ~**14M read-modify-writes a second** on an idle S75, spread over four cache lines. `WASM_DIAG_HOT()` compiles those out unless `WASM_DIAG_HOT_COUNTERS` is defined; cold counters unchanged, so tb/flush/fill/warp diagnostics still work in the shipping build | below this meter's ~3 % floor at host load 4–7, so carried in the round's end-to-end number rather than measured alone. **A `WASM_DIAG_HOT_COUNTERS` build reports real rates and must never be used for a wall-clock A/B** |
| 0075 accel/tcg: fold the MMIO fast path into its callers, one bswap instead of two | `helper_ld*_mmu` already assert the size, so each `do_ld?_mmu` passes it to an `always_inline` `do_ld_mmio_1p()` as a literal: the size-mask test, both alignment tests, `MAKE_64BIT_MASK` and the swap all fold. The swap was the real find — the fast path applied the device's byte order and the caller then applied the op's, and for a LE device read by a LE guest (every hot MMIO register on these boards) those were two real `bswap32`s that cancelled, one through out-of-line `io_fast_bswap()` and its `br_table`. Now the single leftover swap, `((io_swap & 1) != 0) ^ caller_le` | S75 idle **+4.1 % MIPS and +4.1 % v/wall, 3/4 pairwise** vs the round-thirteen tip. *Most of that is 0074's mechanism*: inlining moved the MMIO body into hosts the onlylist did not name, which un-instrumented it. The same patch **with** those hosts added to the onlylist measured **−2.5 %, 0/4** |
| 0074 wasm: trim the Asyncify onlylist to the frames a coroutine switch can reach | `rr_cpu_thread_fn()` calls `qemu_coroutine_forbid_current_thread()` and `qemu_coroutine_switch()` *aborts* on the vCPU thread, because the JIT'd TB frame and the `invoke_*` wrapper under a helper cannot be instrumented at all — so a switch under guest execution is impossible by construction and 18 vCPU-only entries (`cpu_exec*`, `cpu_tb_exec`, `tcg_qemu_tb_exec`, `tcg_cpu_exec`, `rr_cpu_thread_fn`, `do_ld_*`, `do_st_*`, `helper_*_mmu`, `int_ld_*`, `int_st_*`, `io_read/writex`) were paying for an unwind that can never happen. They are the stack of a vCPU flash write — the case `flash-blk.c` had already moved to a main-loop bottom half; the fix deleted the stack, nothing deleted the entries | instrumentation cost measured directly by the inverse experiment: **adding** 7 hot cputlb functions to the list was **−6.6 percentage points** (a +4.1 % patch became −2.5 %, 4/4 pairwise either way). Verified with `QEMU_COSTACK=1` + new `tools/asyncify-audit.mjs`: 67 distinct frames on a 120 s S75 boot, all block-layer/realize/main-loop/monitor, all still covered, none of the 18 present. Build 28.6 KB smaller |
| 0069 target/arm: no double hflags rebuild per CPSR write | `cpsr_write()` rebuilds hflags at its own tail whenever the write is not Raw and the mask covers `CPSR_M/E/IL` — after every bit of `uncached_cpsr` is written.  Both TCG helpers then rebuild *again*: `HELPER(cpsr_write)`'s "did uncached_cpsr change" guard is true precisely when `cpsr_write()` also rebuilt, so it never saves the duplicate, and `HELPER(cpsr_write_eret)` is unguarded (the only thing between the two is masking the low bits of `regs[15]`, and the PC is not an hflags input).  Skip the second pass when the mask covered those bits — the test must be the mask, not "did anything change", because a write that moves PAN alone leaves `cpsr_write()`'s condition false and still needs this rebuild | verified before measured: a build that took the skip but rebuilt anyway and compared against the hflags already in `env` ran all three boards through idle and driven — **51.8M skips, 0 disagreements**.  Back-to-back S75 idle profiles: `rebuild_hflags_a32` **2.4 % → 2.0 %**, `arm_rebuild_hflags` **1.5 % → 1.2 %**, controls unmoved (`icount_get` 4.2/4.2, `do_st_mmio_1p` 3.6/3.6).  ~0.7 % of the vCPU — below the wall-clock meter (three pairs: +2.4/−4.4/+8.1 %), reported as a mechanism result.  Gates: op-suite 1156/1156 (the one that matters here), native 4/4, bootcheck 3/3, wasm lockstep 2/2, Firefox clean |
| 0068 hw/pmb887x: no TPU advance for an event-RAM write that cannot move the deadline | every TPU register write ends in `tpu_update_state()` → `tpu_update_timer()` → `tpu_advance()`, which reads the virtual clock.  A counter said the S75 idle screen does that **1.48M times a second** and that **96 %** of those writes are to the *event RAM* — 84 % of every MMIO store the board makes; caller stacks put **76 % of `icount_get()`** (then the top symbol at 7.7 %) under that one path.  The event RAM is plain memory — `tpu_run_events()` re-reads it every scan and caches nothing — so a word can only change `p->next` while it is inside `[ceap, eapt)`, the part of the current frame's list still to be scanned.  The RF half, consumed entries, entries past `eapt` and everything once the list has finished are read no earlier than the next frame, where `tpu_advance()` runs anyway because the QEMU timer is armed for it.  Nothing else in `tpu_update_state()` reads the RAM | **77 %** of event-RAM writes take the early return; `vclock/s` **2.02M → 1.17M (−42 %)** on the S75, 1.08M → 0.56M on the EL71.  S75 idle MIPS +20/+7/+10 % (3/3); EL71 +8/+3/−0.4 % (its gain is smaller because 0067 left it less MMIO-bound); KE800 neutral by construction (3.4k event-RAM writes/s).  Verification is the story — see § the 1 ns residue.  Gates: op-suite 1156/1156, native 4/4 with every LCD milestone unmoved, bootcheck 3/3 (ke800 fb=186, its best), wasm lockstep 2/2 clean with serial identical, Firefox clean |
| 0067 util/qemu-timer: no virtual-clock notify for an empty timerlist | `qemu_clock_notify()` fans a notify out to every timerlist on the clock, and `qemu_aio_context`'s QEMU_CLOCK_VIRTUAL list is empty for this machine's whole life (every pmb887x device arms on `main_loop_tlg`).  A notify means "recompute your deadline"; an empty list has none — but `aio_timerlist_notify()` still woke the parked main-loop thread through a futex.  No timer can be missed: the thread that arms one calls `timerlist_rearm()` → `timerlist_notify()` itself after the insert, and that is the only other caller, where the list is non-empty by construction.  Gated on icount: without it the *main loop* runs the virtual timers and the notify is the kick that keeps it iterating | main-loop wakes **38,481/s → 66/s**; the main-loop worker goes from 91.2 % to **99.4 % parked**.  S75 idle MIPS **+41/+40/+31 %** (3/3), EL71 **+25/+21/+27 %** (3/3).  The lesson is the magnitude: the futex call is not the cost, the BQL round trip behind it is — see § what a cross-thread wake really costs.  Gates: op-suite 1156/1156, native 4/4, bootcheck 3/3, native lockstep 3/3, wasm lockstep 2/2 clean at the full 2.5G window, Firefox clean |
| 0066 hw/pmb887x: no double TPU advance per register write | `tpu_update_state()` opened with `tpu_advance()` and closed with `tpu_update_timer()`, which advances again — same virtual instant, same frequency, `elapsed_ticks` 0, same numbers recomputed.  `tpu_io_write()` reaches it for *every* TPU register (~815 k/s on the S75 idle screen) and `tpu_advance()` is a virtual-clock read, two `muldiv64`s, the frame loop, the interrupt test and a scan of the event list.  The leading advance only matters when something consumes a counter brought up to date at the *old* rate — a frequency/enable change or the TINI reset — and everything computed before that point (`ftpu`, the GSMCLK K/L reload, `new_freq`, the new enabled state) is a pure function of the registers.  Hoist that above the advance, take the advance only when consumed | back-to-back profiles of the same S75 idle state: `tpu_advance` **5.8 % → 2.9 %**, and `icount_get` **6.4 % → 4.5 %** with it (the TPU advance was a large share of the virtual-clock reads — `vclock/s` per MMIO access 3.5 → 2.1).  Gates: op-suite 1156/1156, native 4/4, browser bootcheck 3/3 |
| 0065 accel/tcg: one clock notify per idle round, not two | `rr_idle_advance()` warps and then runs the deadline, and both halves called `qemu_clock_notify(QEMU_CLOCK_VIRTUAL)` — a cross-thread wake of a parked main loop, thousands of rounds a second.  The first is always redundant *here*: with `sleep=off` the warp moves `qemu_icount_bias` by exactly the `~QEMU_TIMER_ATTR_EXTERNAL` deadline, so that deadline is 0 on return, and `icount_handle_deadline()` tests the `QEMU_TIMER_ATTR_ALL` deadline — over a superset of the timers, therefore never larger — so it is 0 too and it always notifies, on this thread, a few instructions later.  `icount_start_warp_timer_full(false)` suppresses the first; the `sleep=on` branch, which returns before running the deadline, notifies explicitly | `PROF_FN=emscripten_futex_wake` caller stacks, S75 idle, 25 s: the `icount_start_warp_timer` stack (1185 ms) is **gone**, `icount_handle_deadline` 449 → 1260 ms, wake callers in total **4303 → 3127 ms (−27 %)**, and the BQL handoff on the same path fell 2472 → 1525 ms with it.  Gates: op-suite 1156/1156, native 4/4, browser bootcheck 3/3 |
| 0064 util/qemu-timer: the icount clock without the `cpus_accel` frame | `qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL)` reached the clock through `cpus_get_virtual_clock()`, which makes exactly the two tests `tcg_accel_ops_init()` installs hooks for, in the same order, then calls the same function.  One more non-inlinable frame in front of a call a polled device model makes 4 M times a second.  `stubs/icount.c` gains `icount_get()` so tools that enable `CONFIG_TCG` without linking `accel/tcg` still link | `qemu_clock_get_ns` + `cpus_get_virtual_clock` were 1.9 % + 2.0 % of the S75 menu vCPU |

(The 0017 row is a pointer — that patch's own docs are authoritative for
its compute numbers; its boot numbers are idlebench's.)

## Patch-isolation study (2026-09-09, summary)

Every TCI/longjmp patch in 0001–0014 is empirically load-bearing
(removal costs 15–40 % of the window or collapses the boot); 0002's
condvar half is redundant since 0009 but cannot be split out without
rebasing 0004/0007/0009.  Method today: `git -C qemu revert` of the
commit, then `ninja-fast.sh` and the ladder.

## What was tried and REJECTED (do not retry without new ideas)

| Experiment | Result | Why |
|---|---|---|
| **Every cheaper TB-boundary *mechanism*: the merged module's boundary half, `W64_CHAINLOOP`, `stail`, and `W64_BATCH`-as-a-locality-knob** (2026-09-17, round 32) | **All of them tie, and the merge is a regression.**  `tests/wasm/dispatchbench.mjs` was swept properly for the first time — over body size (`DB_PAD`), table size (`DB_NFUNC`), module count (`DB_NMOD`) and, the knob that turned out to matter, **target order**.  In the *strided* order every mechanism costs the same **16–17 ns at every module count**; only in the *unpredictable* (LCG) order does a 42 ns spread open up, and there `merged` — the no-crossing variant the whole merge case rested on — reads **51.13 ns against `xtail`'s 35.73** at pad 144.  The emulator's own knob had already settled which order it is in: `W64_CHAINLOOP` swaps the call mechanism and keeps everything else, and it measures **−0.1 %**, falsifying the unpredictable regime's prediction at ~7 sd | The benchmark's header described its LCG target sequence as "what a guest interpreter's dispatch looks like", and a TB chain is not that — a chained successor is **per-site predictable**, which is why round twenty-three's `dispatch-probe.mjs` read 7.7 ns and the LCG read 27.  **A dispatch benchmark has two independent knobs, the mechanism and the target sequence, and the second dominates.**  The 27 ns then propagated: three sections of the handoff sized proposals against it, and the four-point `w64_ft_max()` fit agreeing at 27.9 ns looked like confirmation when it was coincidence — see the lessons file, *A slope fitted across configurations is a bundle price*.  **When a knob in the real system already performs the synthetic's A/B, believe the knob** |
| **Replacing emscripten SjLj with native wasm exception handling on the `cpu_loop_exit` path** (2026-09-17, round 30) | **Right that it is 2.2× cheaper, wrong that it matters: ≈ 0.13 % — rejected on the rate, not the price.**  A standalone microbenchmark (`tests/wasm/sjljbench.c`, `tools/sjljbench.mjs`) put one emscripten-SjLj `longjmp` round trip at **595.7 ns** and the same unwind under `-fwasm-exceptions` at **269.2 ns**, a real 326 ns saving per event.  But 0116 had already counted the events: `execLjmp` is **23 per Mi** in the J2ME window, so the whole lever is 23 × 326 ns = **7.5 µs/Mi against 13 471 µs/Mi** | The ARM exception path — the only thing on this workload that unwinds often — **does not longjmp at all**: it leaves through a normal TB exit and `cpu_handle_exception` picks `exception_index` up on the next pass (0116's third finding).  Price × rate, always in that order; this one was priced first and the rate then closed it |
| **`bql_unlock()` on the ARM exception entry path** (2026-09-17, round 30) | ~~**~0.1 % — priced and dropped without building it.**~~  **WITHDRAWN 2026-09-17 (round 32): it is ~1.33 %, and both halves of the original arithmetic were wrong.**  The `excBqlNs` sampler measures the release at **98.4 ns**, not the ~20 ns assumed below — a factor of 4.9 — and the denominator has since halved, 13 471 → **5 738 µs/Mi**, for another 2.35×.  The sampler's own total is **1.33 % of wall**; 679/Mi × 98.4 ns is 66.8 µs/Mi = 1.16 %, and the balance is the IRQ entries, which take the same path.  `excSwi` is 679/Mi, and the *lock* half really is free: `bql_lock_impl()` adopts the deferred `bql_mmio_lazy` hold at no cost (round 13), so what is left is the `pthread_mutex_unlock` at `cpu-exec.c:1586` | **Two ways to mis-price a lever, in one row.**  The first is the one this table warns about elsewhere and this row did anyway: **the 20 ns was assumed, not measured** — "what an uncontended wasm mutex release costs" is a plausible number with no instrument behind it, and the instrument says five times that.  The second is subtler and applies to every percentage in this file: **a share is a ratio, and the denominator moves.**  Nothing about this cost changed; rounds 0104–0118 removed half the wall around it, and that alone turned 0.1 % into 1.16 %.  Re-price a rejected row against the current wall before trusting its verdict — the rejections that age are exactly the small ones.  Next step is not to build the deferral but to explain the 98.4 ns: an *uncontended* release should not cost that, so either it is waking the main thread (emscripten's `pthread_mutex_unlock` calls `emscripten_futex_wake` when a waiter is registered, which is round 12's expensive half arriving by a different door) or the sampler brackets more than the call.  Settle that first; the fix differs completely between the two |
| **An inlinable fast path for `bql_lock_mmio()`** (`QEMU_DEFINE_STATIC_CO_TLS(bool, bql_locked)` makes `get_bql_locked()` `noinline` with an `asm volatile("")` in it, so the lock/unlock pair around every MMIO access is two calls the backend cannot fold) (2026-09-17, round 28) | **~1 ns a call, ≈ 0.06 % of wall — rejected on the price, never built.**  Priced with a calibration pad, `W64_BQLDUP=N` adding N *sound* extra lock/unlock pairs: at N=32 over a 25 s controlled window the guest reads **−1.5 %**, i.e. ~1 ns per pair, against ~800 k MMIO accesses/s | The profile's `bql_lock_impl` 1.4 % is self-time on a small leaf and is an upper bound, not a budget (§ the `arm_rebuild_hflags` row below).  **The pad at small N is unreadable**: N=8 first read −3.1 % and N=32 read *faster than base* on a 12 s window — extend N until the slope is unambiguous before believing any of it |
| **`W64_NOBQL=1` as a ceiling probe** (skip `bql_lock_mmio()` entirely to price the pair by deletion) (2026-09-17, round 28) | **The guest stalled at 15 M instructions.**  No number came out of it | An unsound ceiling probe has to leave the guest *running* to be read at all, and deleting a lock does not: device state races and the boot dies before the meter's first sample.  Round 13's "ceiling-probe by deletion" works on **redundant work** (a second advance, a duplicate rebuild), not on a mutual exclusion someone relies on.  For a lock, the sound instrument is the other direction — a **calibration pad** that adds more of the same, which is the row above |
| **A fourth and eighth deferred taken path** (`W64_FTMAX` 4 and 8 against the landed 3) (2026-09-17) | **The mechanism fires and the change still loses.** Exits per Mi at matched instruction counts: ft3 107 960, ft4 106 706 (**−1.16 %**), ft8 106 140 (**−1.69 %**), three rounds each — and instructions per TB 6.73 → 7.15.  The clock disagrees: ft8 against ft3, five palindrome rounds, **−1.06 %, only 2/5** (+2.1 / −9.3 / −0.2 / +6.4 / −3.7 %), and ft4 read −1.4 % (2/5) in an earlier run.  **Three slots is the peak** | The exits meter predicted +0.5 % and the clock delivered −1.1 %, so something costs more than the removed exits are worth.  The candidates are both per-TB: each extra deferred path is another label, and 0109 found that label handling is what drops a TB out of the backend's nested-label mode into the `$bp` dispatch loop where every *forward* branch is O(n_labels); and a TB carrying 7.15 instructions emits more bytes, which buys modules.  **The calibration is the point: `tools/exitrate.sh` is a mechanism meter, not a verdict meter.**  It prices the exits a change removes and is silent on what the change adds — the same shape of error as the round-15 hit-rate probe that was silent on the cost added to the path that still missed.  Use it to confirm a mechanism and to *size* it; keep the clock as the verdict |
| **One helper call for a whole ldm/stm** (`W64_LSM=N`: a block move of at least N registers becomes `helper_w64_ldm`/`w64_stm`, which translates the address once with `probe_access` and runs the transfer as optimized C) (2026-09-16, round 27) | **-11.7 %, then -6.3 % after the obvious fix.**  Sizing said it should win: `ldstExec` 331 028 000 against `lsmExec` 111 449 385, i.e. **33.7 % of every executed guest memory op is inside an ldm/stm**, at 3.61 registers each, and collapsing them removes 80.6 M of 331 M inline TLB probes.  Two 4-round interleaved sweeps, 20 s windows, `halt` and `tbIcount` matched to 0.5 % throughout: first build (the transfer loop scanned all 16 bits) off 2132.5 vs lsm2 1882.5 Mi, **-11.7 %, 0/4 rounds**; with the loop reduced to set bits only, off 2028.8 vs lsm2 1900.3 (**-6.3 %, 1/4**) and lsm6 1888.0 (**-6.9 %, 1/4**).  Correctness was never the problem -- `lockstep-wasm --insns 250e6 --env W64_LSM=2` is clean | **It could have been rejected on paper, from a number already in this table.**  0106 priced a wasm->wasm import call placed in a real TB at **~14.5 ns** (`W64_CALLPAD`), and the probes the mechanism deletes are ~1.16 ns each (5.07 % of wall over 331 M of them) -- so it spends 14.5 ns to save 3.61 x 1.16 = 4.2 ns, every time.  `tools/import-probe.mjs` says 2.1-2.4 ns for the same call, and that is the trap: a microbenchmark has nothing live across the call, while a call inside a TB makes the engine spill every live wasm local *and* makes TCG treat all globals as written, so each guest register the rest of the TB touches is reloaded from env.  **Price a helper by what it deletes in nanoseconds, not in operations**; the same arithmetic already sits behind the `$tlb` hoist rejection below.  One real bug worth remembering: `op_addr_block_post()` computes the writeback from the address *the emit loop left behind*, so a helper path that passes the un-advanced base must add `(n-1)*4` itself -- without it the guest corrupts SP on every push, which shows up as the main thread wedging, not as a crash |
| **Merging a module's TBs into one wasm function** (one function per *batch*, bodies behind a `loop { block* br_table }` so a TB hands off with a `br` to a depth instead of a `return_call_indirect` through the shared table) (2026-09-16, round 27) | **Worth ~5 ns of an ~18 ns hand-off, and nothing at all when the target is predictable.**  `tools/merge-probe.mjs`, 1024 members with realistic bodies (66 locals, 20 env load/add/store of live work), hand-off cost over the work floor: `direct-c` **2.60 ns**, `ind-in-c` **4.48 ns**, `ind-in` **13.38 ns** (this calibrates the probe against production's ~22 ns), `merged-c` **4.91 ns**, `merged` **8.18 ns** | 55 % of indirect exits already land in the module they are leaving, so the mechanism *does* apply -- but the price of the transfer was never the problem.  A TB boundary is worth **~44 ns** and the call instruction is only ~6-8 ns of it; the rest is the prologue, the PC store and the inline lookup-cache check, none of which merging removes.  So the ceiling is ~3 % of wall for a module-assembler rewrite (depth fixups, group ids, packed chain words, eviction).  Consistent with round 23's "a cheaper indirect call is worth nothing -- ~6 ns is this engine's floor".  **Price the prize before building the machine**: the probe cost an afternoon, the build would have cost a week |
| **Turning off TCG's optimizer for wasm64** (`W64_NOOPT`: the backend emits a stack machine and V8 optimizes again downstream, so `tcg_optimize` looked like translation time bought twice) (2026-09-16, round 26) | **No effect, and it cost three wrong verdicts on the way.**  Read as -2.3 %, then +1 %, then -14.5 % on successive small samples.  An 8-leg interleaved sweep settled it: **the same configuration read 1830 Mi and then 2122 Mi** -- noise of the same magnitude as every "effect" claimed above it.  The optimizer stays | The lesson is about the meter, not the knob: at 20 s windows this workload's spread between identical legs is ~15 %, so **any single-pair A/B below ~15 % is unreadable**.  Interleave at least an ABBA and read the pairing, never the two numbers.  (`tcg/tcg.c` reverted with `git checkout` -- the knob was never committed.) |
| **Deferring more than one conditional fall-through per TB** (`W64_FTMAX` > 1, on top of 0108) (2026-09-16, round 26) | **Flat.**  ins/tb rises 5.35 / 5.77 / 6.13 / 6.23 at N = 1/2/4/8 while throughput reads 412 / 427 / 412 / 424 Mi | The extra deferrals land in **cold** code -- the first branch in a TB is the hot one -- and every deferral past the two `goto_tb` slots pays a `goto_ptr` lookup instead of a chain.  Also the round's cleanest methodology failure: **static ins/tb is not a proxy for dynamic work.**  It moved 16 % while the clock did not.  The `w64_ft[]` array stays sized 8 so a future attempt starts from a measurement, but the default is 1.  **SUPERSEDED by 0112 (same round, later the same day):** once 0111 lets a deferral end at a join, the slot is usually free again within a few instructions and `N = 2` is worth +4.7 %.  The rejection was correct *for the code it was measured on* -- and that is the warning worth carrying: **a knob rejected against one mechanism has to be re-measured after the next one lands**, because what made it flat was the cost of holding the slot, and 0111 deleted exactly that cost |
| **Serving inline-cache misses from the jump cache** (`w64_lc_jc`, `W64_LC_JC`: on a miss, look the target up in `CPUJumpCache` without recomposing the TB key) (2026-09-16, round 26) | **+0.10 %** -- below the noise floor established above | The inline cache already hits ~82 % of `goto_ptr` exits (`lookup` 13.9 M against 76 M exits), so the helper path it shortens is a sixth of a sixth.  Kept only as a counter (`WASM_DIAG_LC_JC`); the fast path itself was not worth the branch | (a close costs ~86 µs fixed and carries only 4.85 members, so more members per close is the whole prize) (2026-09-16, round 24) | **The budget is not what binds.**  `W64_SPEC_N` 4 / 32 / 64 gives 2.64 / 4.85 / 5.39 members per close and 5.514 / 3.543 / 3.519 s of module time: doubling the budget from the shipping 32 buys **0.5 members and 24 ms**, for 7 % more translations.  `W64_BATCH_N` 16 / 32 / 128 is likewise 4.41 / 4.81 / 4.85 — the cap is reached by ~10 % of closes at 16 and never at 128 | The successor walk exhausts: `w64_explored` prunes a node whose successors all exist, and after a few hops everything does.  The batch closes on the **first execution of a member**, not on fullness, so the close count is pinned to the miss count no matter how the walk is tuned.  **The only way to unpin it is another way to run a TB before its module exists** — which is the interpreter tier, and is now the sole remaining route into the pipeline.  (Also settles the handoff's older "`W64_SPEC_N` 8 == 128" as too strong: 4 is clearly worse, 64 is a tie.) |
| **A cheap corner in `new WebAssembly.Module`** — a function-count or size threshold, or a cost hiding in imports/exports rather than compilation (2026-09-16, round 24, probed before building) | **There is none.**  `tools/modshape-probe.mjs`: cost is linear in function count with a per-call intercept over **1 → 256 functions and 23 B → 236 KB**, no knee anywhere; 64 imports add 0.09 µs each, exports are free; an empty module still costs the intercept.  Sub-timers in the app agree — `Module` is 83.8 µs of a 106.4 µs module, Instance 9.0, addFunction 2.8, the GC nudge 0.45 | The API offers exactly one lever, the number of calls.  **Found on the way and worth more than the negative result**: both this probe's and round 19's "warm" numbers were compiling *identical* wire bytes, which V8 serves from its compiled-module cache — distinct bytes cost 2.0–3.8× more (§ 0f).  Round 19's "four fifths of the 80 µs is cold cache" is withdrawn |
| **Turning off `CF_PCREL`** (set unconditionally on every ARM system-mode TB; it makes every PC materialisation a read of `cpu_R[15]` plus an add instead of a constant, and on ARMv5 every 32-bit literal is an `ldr rX, [pc, #imm]`) (2026-09-16, 0096, `W64_NOPCREL`) | **-0.7 %, 2/3 pairwise — inside noise — and +2 % lookup misses**, which at ~96 µs a module cancels most of it.  `tbGen` does not move (158–160k either way) | The saving is not there because **`cpu_R[15]` is a TCG global, and the wasm64 backend keeps globals in wasm locals for the life of the TB** — the "read" is a `local.get`, not a memory load, so `addi` costs about what the constant would.  Generalises: do not price a TCG global access as a load on this backend.  Same shape as round 21's "a load from a compile-time-constant address is not on the critical path".  The misses rise because TBs key on the virtual pc once PCREL is off and stop being shared between aliases; that `tbGen` is flat says this firmware maps its code once, so CF_PCREL's generality is unused here and still not worth removing |
| **Compaction granularity as a dispatch-locality lever** (`W64_COMPACT_MEMBERS` 256 / 1024 / 4096 — fewer live wasm instances should make a `return_call_indirect` cheaper) (2026-09-16) | **Flat.** Five interleaved pairs over a **4.6× range in compaction events** (compact 602 / 194 / 130): 20.63 / 20.87 / 20.37 ms per Mi, and a follow-up 3 pairs of 1024 vs 4096 read +1.0 % the other way.  A wash | `tools/dispatch-probe.mjs` really does show 1024 functions per module dispatching **38 % cheaper** than 128 over a 32768-function working set (60.3 vs 96.5 ns) — but that is a **uniformly random draw**, which is the worst case and not where the emulator lives.  Real guest execution has a hot set of a few hundred TBs that were translated together and therefore share a module.  **Calibration worth keeping: the probe's `live` knob is a worst case; do not read its absolute ns as the emulator's dispatch cost.**  Also measured there and not pursued: a *direct* `return_call` instead of an indirect one, at identical access patterns, saves only 1.1 ns at 128 functions per module (7.5 ns at 1024) |
| **Speculating the address after an unconditional transfer** (`b`, `bx lr`, `pop {pc}` -- the next basic block, which goto_tb never records because it notes only the branch target and an indirect exit notes nothing) (2026-09-16, 0095, `W64_LINSPEC`) | **Rejected twice over.** Performance: **+89 % speculative translations** (specMade 143k -> 271k) and **no change in the miss count**. Soundness: guessing after an *indirect* exit panics the EL71 firmware in ~4.5 s, deterministically, at a fixed guest pc ("sorry died at A04D103C"); after an unconditional branch it does not, and s75/cx70 survive it -- EL71 is the one board that programs its flash file system while booting | The economics looked inviting and are worth recording: a speculative translation is ~12 us against ~96 us for a module, so an extra edge pays at a **12.5 % hit rate**, and the edges the walk already has convert at **66 %** (`W64_SPEC_N` 0 vs 32 on a fixed-work el71 window: 127k extra translations remove 84k misses, 117881 -> 33621 — solve the two-point system, do not guess). There is headroom; this is not the edge that fills it. **The panic is unexplained and matters more than the experiment**: w64_speculate is documented as a hint that cannot change guest behaviour, and it can. Ruled out, each by experiment: tb_flush (the shipping build survives 11 and 38 flushes forced with `?qargs=-accel tcg,tb-size=24`/`=8` — which also exercises 0091's tidx recycling across a flush for the first time and finds it sound); ISA alignment (filtering the guess on `s->thumb` alignment changes nothing); and a stale TB over reprogrammed flash (adding the missing `tb_invalidate_phys_range` to the pmb887x program/erase paths does not stop it). **Recorded separately**: `hw/arm/pmb887x/flash.c` and `hw/block/pflash_cfi01.c` both write their rom device's backing RAM directly and neither invalidates TBs for the range, which `hw/nvram/nrf51_nvm.c` shows is required. Latent, not currently reachable, and `memory_region_flush_rom_device` cannot be used as-is — it asserts the region is in romd mode, which a CFI part never is while being programmed |
| **Dense `goto_tb` chain-slot arena** (16 B per TB keyed by tidx — four translations to a cache line — instead of `tb->jmp_target_addr[n]` inside a TranslationBlock allocated in the code buffer at ~1 KB stride) (2026-09-16, on top of 0091) | **A wash.** Six interleaved fixed-guest-work pairs across two sessions: −3.2, −1.1, +2.1, −7.2, +4.2, −0.0 % — mean −0.9 %, SE 1.6 %.  Op suite green, so it was correct, just worth nothing | The generalizable half: after 0091 the slot address is a **compile-time constant**, so the load issues early and its latency is hidden.  0091 won by removing a load whose address *depended on another load* — the second hop of an indirect-branch dependency chain.  **Locality only pays on a dependent load.**  That also kills the matching idea for the `w64_lc` inline-cache slots, whose address is likewise a constant the emitter knows |
| **Speculating from the link register** when the missed TB records no goto_tb successor at all — 17.5 % of misses, and r14 is where a `bx lr` / `pop {pc}` TB is about to go (2026-09-16) | **−7.6 % of wall, 3/3, with no change in miss count** (fixed guest work, el71).  `arm_w64_ret_hint` + one extra root successor | The walk it enables is not free: it runs a `probe_access_full_mmu` and a `tb_htable_lookup` on every one of those misses, which previously returned immediately — the cost the `w64_explored` pruning exists to avoid.  And the root can never be marked explored, because the hint is a *register read*, not a property of the TB, so the re-probe repeats forever.  A dynamic hint cannot use machinery built for static edges.  The static half of the same idea is 0092 and is worth 0.3 % |
| **Shrinking the backend's ~70 declared locals** so the baseline tier stops zeroing them at every TB entry (2026-09-16, priced with `W64_LOCALPAD` and `tools/locals-probe.mjs`) | **Under 1 % in-app.**  The synthetic cost is real and large — +38.9 ns on a 49.9 ns baseline-tier call, free in the optimizing tier — but only ~3.6 % of TB entries run baseline code, and the in-app slope is superlinear (0/69/200 extra locals → 0 / +1.05 % / +6.8 %), so the derivative at 70 is the small end of the curve | Building it means interleaving the i32/i64 register locals so trailing declaration runs can be patched to zero-count at finalize (the body must stay a fixed size — `qemu_ld/st` retaddrs are offsets into it) **and** renumbering `TCG_REG_TMP` off R28, or the first TB that touches the scratch register declares 58 locals anyway.  Not worth it for <1 %; revisit only if the baseline-tier share rises |
| **Emitted-byte count as a lever on compile time** (2026-09-16 — the fourth time, and the first with a number) | **Capped at 2.2 % of wall.**  `W64_BYTEPAD` 0/40/120 inflates modules to 5.1/7.7/14.5 KB and compile to 96/110/125 µs: **~80 µs fixed + 3.2 µs/KB**, so at the shipping size bytes are 17 % of the module cost.  The inline TLB probe, at 37 % of emitted bytes, is worth ~0.8 % | The three earlier "flat" readings (prologue cleanup, 0055's `local.tee`, the `$tlb` hoist) were −2.6 % to −3.7 % byte cuts, which predict 0.4 % against meters that resolve 3 % — they were never evidence of no effect, only of no *measurable* effect.  Now it is bounded from above instead: **module count is the only lever on the 12.5 % pipeline.**  Also ruled out the same round: the live-module count is not a factor (`tools/modgrow.mjs`, 500 → 6000 instances flat at ~50 µs, unchanged after dropping all) |
| **Merging a batch's members into one `br_table` function so it tiers up sooner** (the tiering budget was assumed to drain by function *size* per call, which would make N merged members tier up ~N² sooner) (2026-09-16, closed by probe before building) | **The premise is false.** `tools/tierup-probe.mjs` puts tier-up at **~1–2.4 × 10⁴ calls across an 85× range of body sizes** — 329 B, 2849 B and 28051 B all land in the same decade, and the calls × size product spans 47×.  The budget drains **per call** | Merging N members therefore buys N, not N² — and a batch holds 4.9 members, not 128, so it is 5× against a `br_table` on every one of ~12.8 M TB entries a second.  The number is still worth having: a TB needs ~15k entries to leave the baseline tier and the average live TB sees ~250 a second, which is why only genuinely hot TBs get there and ~3.6 % of entries stay baseline.  Compaction resets a member's budget when it re-instantiates it, but does so about once per TB and within ~1024 translations of its creation, so it costs almost nothing.  **Two ways to mis-measure it, both paid for once**: a warm-then-measure ladder cannot work (the measuring calls drain the budget, so measuring causes the transition), and the body must be *live* — a dead one is DCE'd by the optimizing tier and reads as already-tiered, a dependent add/xor chain compiles the same in both tiers and reads as never-tiered |
| **The TB-module → main-module helper-call boundary** as an explanation for `helper_lookup_tb_ptr_lc`'s 102 ns (2026-09-16) | **2.1–2.4 ns** in the optimizing tier and 3.6–4.4 ns in the baseline one, the same whether the helper is imported as an export, taken from `wasmTable.get()` the way `wasm64.c` resolves it, or reached by `call_indirect` (`tools/import-probe.mjs`) | `wasmTable.get()` hands back a genuine exported-function object, so V8 wires it as a direct cross-instance wasm call with no JS frame.  The helper's 102 ns is all body.  Useful in the other direction: at 2 ns, **moving work out of emitted code into a C helper is cheap**, and the helper then runs in the main module's optimized code instead of a TB module's baseline code |
| **The AOT module cache** (persist translated-and-compile output — `WebAssembly.Module` or its bytes — keyed by flash hash, so second boots skip the pipeline; ceiling priced at ~19.5 % of boot) (2026-09-16, probed before building) | **Dead on the platform side, both engines.** (1) Neither V8 nor SpiderMonkey will store a `WebAssembly.Module` in IndexedDB at all — `DataCloneError` on `put` in both (in-memory `structuredClone` works, 1.5/0.9 µs, but that is not persistence). (2) The bytes fallback was measured at real module size (2.47 KB × 2000, `tools/wasmclone-probe.mjs`): restore = getAll + `new Module(bytes)` + instantiate costs **56 µs/mod against 30–34 µs/mod to just compile fresh in the same isolate — 0.56–0.60× in V8 across two runs**, and **0.90–0.91× in SpiderMonkey** (179–183 vs 164 µs). (3) Writing at every batch close (one IndexedDB transaction per module) costs **0.13 ms/put (V8), 0.39 ms (FF) — ×34k modules = 4.4–13.3 s per boot, more than the whole 2.82 s compile prize**; even one bulk transaction is ~0.5–0.9 s of first-boot write. (4) The escape route — Chromium's HTTP wasm code cache via `compileStreaming` from the Cache API — gives **no code-cache hit for synthetic responses** and the streaming path itself is 12× slower than plain compile in V8 (418 vs 34 µs; `tools/wasmcache-probe.mjs`) | The browsers refuse to persist compiled modules, and byte-persistence costs more than the recompile it avoids: the read alone (~18 µs/mod at ~150 MB/s) is half a cold compile. Even the most AOT-favourable framing (83 µs cold saved vs ~30 µs restored) buys under ~1.5 s of a 25 s boot, minus the first-boot write, for a correctness surface the gates do not cover (qht/chain restore, flash-change invalidation). **The interpreter tier is the only remaining route into the module pipeline.** Side finding worth keeping: SpiderMonkey compiles the same 2.5 KB module ~7× slower than V8 (150 vs 20 µs) — the 83 µs/module economy is V8's; on Firefox the pipeline share of boot has never been measured |
| **A cached import namespace for generated modules** (one persistent `imports.e` object plus a `Map` memoising `wasmTable.get(BigInt(fptr))`, replacing a fresh object, a `'f'+i` concatenation, a BigInt and a table lookup per import per module) (2026-09-16) | **0.7 % of the thing it optimises.** The four-way split of `MOD_NS` puts building the import object at **0.026 s of 3.66 s** over a 25 s EL71 boot, against 2.82 s in `new WebAssembly.Module`. Reverted unbuilt-upon | The reasoning was sound and the premise was wrong: a close module has **2.1 imports** (`modUimp` 74 461 / 34 722 modules), not the twenty the `W64_UMAX_IMPORTS`-sized machinery suggests. **Measure the phase before optimising the loop inside it** — the split cost twenty lines and settled it, and the same split is what found the 83 us. Nothing here is worth retrying unless imports per module rise by an order of magnitude |
| **Observed goto_ptr edges as speculation successors** (`helper_lookup_tb_ptr_lc` knows the calling TB — its `slot` is `&tb->w64_lc` — so record the target it actually resolved into a `w64_isucc[2]` on that TB and let `w64_speculate` walk it; aimed at the 18.8 % of misses whose TB has no static successor at all) (2026-09-16) | **2 225 628 edges recorded, 474 TBs translated by following one.** `specMiss` went the wrong way, 34 547 -> 35 032 (+1.4 %), and `tbGen` +1.5 % for it | **An observed edge is evidence about the past.** It is recorded only after the guest took it, by which point the target is translated — so it can only ever predict a TB that already exists, and is useful solely after a `tb_flush` (which a boot does not do: `tbFlush` = 0). This is the third attempt to lower `specMiss` by giving the walk more edges, after call-return points and the `ldr pc` trampoline. **Stop adding edges.** Module count is miss count, and a miss is the guest reaching code no predecessor has ever named; only a scheme that runs cold code *without* a module can move it |
| **`arm_rebuild_hflags` as an 11 % target** (the profile's single largest vCPU entry on an idle CX70, apparently contradicting round fifteen's rejection of the `cpsr_write` hflags skip) (2026-09-15) | Not a target and never was: an unconditional entry counter (`hflagsCalls`, index 85) puts the call rate at **11,606/s**, so 11.0 % of a 30 s profile would be **9.5 us per call** for a function priced at ~76 ns.  A 10,000-iteration volatile spin placed in it took the board 113 MIPS -> **0.7 MIPS**, confirming both the rate and that the knob reaches the code | **The profiler names the wrong function.**  Profiling the spin build -- where all the work provably sits in `arm_rebuild_hflags` and calls nothing -- reported `rebuild_hflags_a32` **67.3 %**, `arm_rebuild_hflags` 20.3 %, `arm_security_space` 9.5 %, `cpsr_write` 1.0 %.  A name in a wprof2 profile identifies a neighbourhood, not a function.  Round fifteen's A/B was right and its profile was not.  Price a function from a counter times a per-call cost, or by a volatile-spin probe -- never from self-time; and see doc/lessons.md for the two ways a cost probe silently measures nothing |
| **Speculate along call return points** (after the goto_tb walk, translate each walked TB's fall-through `pc + size` on a budget of its own; that address is the return point of a `bl` and of an indirect `blx rN`, neither of which the frontend records as a successor) (2026-09-15) | EL71 boot window (100M-1500M, fixed guest work, 4 interleaved pairs): **+0.8 %, 2/4 wins** -- a tie -- for **+15 % more TBs translated** (160.4k -> 184.6k) and **no change in module count at all** (34669 -> 34436, within run-to-run noise).  It does work on an interactive path: on the EL71's second key press it cut modules 456 -> 339 (-26 %), and keylag's `madePerMiss` rose 0.33 -> 0.43 | **Module count is miss count.**  A batch is opened by a lookup miss and closed the moment that miss's TB executes, so on the EL71 boot window `close` (34922) equals `specMiss` (34922) exactly, with `temp` = 0.  Speculating *more* therefore cannot reduce modules; only speculating the TBs the guest misses on *next* can, and fall-throughs are that only on interactive paths, not during boot -- where the wall time is.  The boot already gets 5.3 TBs per module from the goto_tb graph alone.  Retry only with a predictor that lowers `specMiss`, and measure that counter, not `tbGen`.  Note also that the first attempt read `specRet=0` on every press because it copied the `CF_PCREL` guard from the trampoline heuristic beside it -- see the lessons entry on counting the fast path |
| **A second way for the per-TB inline lookup cache** (2026-09-15) | **Built, measured, reverted: the mechanism works and pays for itself exactly.** `W64_LC2`, a software ceiling probe that simulates a second way in the helper, said 42.3 % of el71's misses and 34.2 % of cx70's would hit it — against a ~100 ns helper call, a predicted +3.3 %. Built for real (`w64_lc[2]`, an LRU-of-two fill, a second compare chain in `gen_goto_ptr`, behind `W64_LC_WAYS`): `lcCall` fell **14 718 -> 8 947 per Mi, -39 %**, almost exactly what the probe promised. Wall time, A/B'd *within one binary* by flipping the knob: **el71 0.0 % (2/3), cx70 -0.2 % (2/3)** | The saved calls and the added cost cancel. Way 1 is only reached after way 0 misses — 856k/s — and each such miss now runs a second 5-7 op compare chain before the helper it was going to call anyway; emitted code grew **+20.6 %** on every goto_ptr exit. **The lesson is about the probe, not the cache**: a ceiling probe that simulates only the *hit rate* measures the benefit and is silent on the cost added to the path that still misses. Worth retrying only with a way-1 test that is cheaper than the helper call by a wide margin, or emitted only at sites known to be megamorphic |
| **Raising `W64_SPEC_N` above its default 32** (the speculative successor budget; 64 looked like a free win) (2026-09-15) | **A tie on the meter that counts.** An insns-at-fixed-wall sweep read a clean inverted-U peaking at 64 — el71 boot 753M -> 799M insns (+3-6 %), modules down, pipeline share down — and `workbench.mjs` then read **27.88 vs 27.95 MIPS over 4 interleaved pairs, 2/4 wins each**. Cross-board was already mixed (cx70 +0.7 %, s75 +1.0 %, **ke800 -3.5 %**) | The mechanism works and cancels: at 64 the modules fall 4.8 % (33 846 -> 32 213) and the TBs translated rise 6.5 % (162 726 -> 173 295), which is **module count is miss count** seen from the other side — you buy compile time with translate time at roughly par. Past 64 it inverts outright (at 512, translate 12.50 % vs compile 10.01 %). Two lessons: the knob is already at a flat optimum, and **insns-at-fixed-wall found a shape that the fixed-guest-work meter refused to confirm** — use the first to explore, never to decide |
| **`W64_NOGENBUMP` — the inline cache's global generation** (every `tcg_flush_jmp_cache` bumps one global `tb_key_gen`, retiring *every* `w64_lc` slot at once; at 1920 bumps/s an epoch is 0.5 ms, so the hypothesis was that slots die before they are reused) (2026-09-15) | **17 %, and no time in it.** The ceiling probe (skip the bump entirely — unsound, stale targets survive) moved `lcCall` only 14 644 -> 12 112 per Mi on an EL71 boot, with MIPS unchanged (28.7 vs 28.5) | So ~83 % of inline-cache misses are genuine: the target really does differ, exactly the megamorphic return sites 0047's note predicted. 420 k helper calls/s at any believable per-call cost is ~1 % of wall, so a sound per-page or per-ASID generation scheme would buy a fraction of that. **The probe is worth keeping** (`W64_NOGENBUMP=1`, clearly marked unsound) — it prices a perfect inline cache in one run. Retry only with a way to make *megamorphic* sites cheap, which a generation scheme is not |
| **The `ldr pc, [pc, #-4]` trampoline heuristic** (a TB ending in that insn jumps to the literal immediately after it — an edge `goto_tb` cannot record, since it is an indirect branch; read the literal through the speculation walk's non-faulting probe and queue it as an extra successor) (2026-09-15) | **The pattern is not there.** With the guard lifted and each queued TB's guest pc carried alongside the walk, the tail probe succeeds on **141 nodes per Mi** (EL71) — i.e. on essentially every node walked — and of those the pattern matches **0.004 per Mi**: about one node in 35,000, against 6.5–17.6 lookup misses per Mi. Four boards, same answer (`specTramp` per Mi: el71 0.004, ke800 0.02, cx70 0.00, s75 0.00) | It had **never once run**: it was guarded on `!CF_PCREL`, which `arm_cpu_realizefn` sets on every system-mode ARM TB, and both the code and the guard arrived in the same commit (2ad6330fdf). Two rounds read it as a live optimization. The ~35,000:1 gap means no timing A/B was needed or run — a mechanism that fires four times in a boot cannot move a wall clock. **Deleted rather than shipped behind a knob** (−26 lines): dead code that looks live costs more than it saves. Note the measurement order that made this cheap — point the counter at the *probe* first, so "the pattern is rare" is distinguishable from "the probe never ran"; the two look identical from a zero |
| **`cpsr_write` hflags skip** (rebuild only when a bit hflags actually reads changed, not merely when the instruction's field mask names one) (2026-09-15) | CX70 fixed-work **+0.6 %, 2/6 pairwise** — a tie — although it removes **93.7 %** of the rebuilds `cpsr_write` asks for (74.8M of 79.8M on a CX70 boot; 90 % of all 82.6M hflags rebuilds) and 52 % on an S75 | The mechanism is real and the change is sound — a `CPSR_HFLAGS_SKIP_VERIFY` build (take the skip, rebuild anyway, compare) found **zero** disagreements over 74.8M skips — but the time is not there to recover. The post-0071 fast path is already close to free, so `arm_rebuild_hflags`'s 3.3 % profile self-time on a CX70 is not 3.3 % of recoverable work: treat a self-time share for a small leaf function as an upper bound, not a budget. Retry only with a profile showing where that 3.3 % actually goes, and note it costs an invariant (`CPSR_HF_BITS` must stay a superset of every CPSR bit any hflags path reads) |
| **`dacr_write` value guard** (skip the full TLB flush when DACR is rewritten with the value it already holds, the guard `fcse_write`/`contextidr_write` beside it already have) (2026-09-15) | **No effect at all**: over an identical 5.1G-instruction CX70 window, `tlbFlush` 15636 → 15635 and `jcFlush` 13793 → 13795 | This firmware does not write DACR idempotently, so the flushes come from somewhere else — most likely an explicit `TLBIALL` per context switch, which QEMU must honour. The guard is still correct and costs one compare, but nothing here pays for it. If the jump-cache flushes are attacked again, **find the caller first** (they are boot-time only: `jcFlush/s` is 0 at idle) rather than guessing at candidates |
| **wasm32 runtime-JIT TCG backend (0005, ktock port fully rebased)** (2026-09-09) | v-window 2→7: JIT 18.7–20.1 s vs TCI 24.8–28.3 quiet / 45–46 loaded — **~1.3–2.3x ceiling**, and the boot deterministically hangs at v≈6 (BROM USART-RIS poll data divergence → watchdog reset → recovery loop forever; LG/no-icount boot fully dead) | per-TB dispatch protocol (instance return → C dispatcher → indirect instance call per chained TB) + per-new-TB JS `WebAssembly.Module` compile eat the codegen gains on this 3–4 insn/TB branchy firmware; ~4200-line surface; discarded |
| **tci.c interpreter stack as a parameter** (split `tcg_qemu_tb_exec` into a core + wrapper taking `uint64_t *call_stack`) | TCI v-window 25→45 s (**−60%**, 4/4 interleaved runs) | the pointer-select makes the interpreter stack alias every local array in LLVM's analysis; the TCI stack is per-TB scratch anyway — keep a single function with a local array |
| **MMIO dispatch fast path** (memory.c: direct `ops->read/write` call for exact-size aligned accesses, skipping valid-check + access_with_adjusted_size + accessor layers; reentrancy guard replicated; `__EMSCRIPTEN__`-gated) | window 24.9–25.2 → 25.1–25.3 s (**consistently 0.1–0.7 s WORSE on a quiet host**, 4/4 pairs); finalV ±noise; insns@110 s +0.1–5.8 % inconsistent; a late-window A/B (LO=30 HI=60) was flat too | the pre-dispatch condition chain (accepts/align/size/trace/ioeventfd checks) costs as much as the ~3 non-inlined calls it saves at ~90k dispatches/s; V8 already keeps the dispatch path hot. Reverted; don't retry a *runtime* cache without cross-TU inlining (LTO). **NOT the same as the current workstream's fill-time precompute** (store `(fn, opaque, attrs)` in the iotlb entry when it is filled — zero added per-access checks): that one is the plan in [performance-handoff.md](performance-handoff.md) slice 1 |
| **TLB table-base caching in the TCI interpreter** (cache `(fast->table, fast->mask)` per mmu_idx across ops, dropped after helper calls and ldst fallbacks — the only paths that can resize/flush the tlb on this single-cpu machine) | window 25.9/25.2/25.2/25.2 → 24.5/25.3/25.1/25.1 (flat, ±0.1); late-window LO=30 HI=60: 19.7/20.3 → 19.6/20.0 (flat); finalInsns won 4/4 (+1…5.7 %) but finalV-at-200 s varies ±45 v run-to-run — no reproducible win | the two saved loads are L1-hot; the memory-op path is at its practical floor for micro-tweaks (0011+0012 already removed the real work). Reverted; only a big lever (64-bit TCI encoding, wasm32 JIT) can move the interpreter now |
| **Device completion timers on QEMU_CLOCK_VIRTUAL** (dmac/dif_v1/dif_v2/ssc `timer_new_ns(QEMU_CLOCK_REALTIME, …)` → VIRTUAL, 2026-09-11) — **SUPERSEDED, landed as 0024** | tIdle 66 → 65 (dist-jit) / 70.5 → 71.9 (dist): flat *before 0023* | the hop chain was the same for both clocks then; once the vCPU thread warps and runs VIRTUAL timers itself (0023) the virtual-clock completion is hop-free: display stretch −2..−3 s |
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

## Remaining opportunities (ranked; the plan lives in performance-handoff.md)

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
   reference.
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

   **Exit mix** (`W64_XCOUNT=1`, one 1360 Mi EL71 window; the counters
   are in the generated code, so per-Mi rates are exact and that run's
   wall is not comparable to a shipping one):

   | exit | count | share |
   |---|---|---|
   | `goto_tb` which = 0 (the branch the frontend took) | 135 528 086 | 41.4 % |
   | `goto_tb` which = 1 (the fall-through) | 97 455 274 | 29.8 % |
   | `goto_ptr` | 94 266 923 | 28.8 % |
   | — of the `goto_tb` exits, chaining back to the *same* TB | 15 638 733 | 4.8 % of all |

   That is **4.16 guest instructions per TB entry**, `dispCall`
   1 893 390 — so the C dispatcher is re-entered once per **173**
   transitions and chains essentially never unwind — and `lcCall`
   15 134 439, i.e. the inline cache serves **83.9 %** of `goto_ptr`
   exits without the helper.

   Three consequences, each a ceiling on an idea that sounds bigger
   than it is:

   - **Self-chaining loop-back** (a TB whose `goto_tb` target is itself
     could `br` to a `loop` wrapping its own body instead of tail-calling
     through the table) is 4.8 % of transitions = **≤ 0.43 % of wall**,
     for a change to every TB's code shape.  Closed.
   - **Merging a conditional's fall-through into its predecessor** —
     the largest structural idea left in the dispatch line — is bounded
     by the which = 1 exits: 29.8 % of transitions = **≤ 2.7 % of wall**,
     and only the subset whose fall-through has exactly one predecessor
     and is not itself a branch target is actually mergeable.
   - A cheaper *indirect call* is worth nothing: see the dispatch-
     locality row in § REJECTED, where the floor for
     `return_call_indirect` on this engine is ~6 ns against the
     emulator's 7.7 ns.

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

0g. **What the interpreter tier would have to interpret (counters,
   round 24).**  The saving was always easy to price and the cost never
   was: a TB stays interpreted from its translation until its batch
   closes, and how often it runs in that window depends on an
   interleaving only the real thing produces.  `W64_NOCLOSEEXEC=1` *is*
   that real thing with the close deferred — batches then fill to
   `W64_BATCH_N` — so summing each member's exact `W64_TBHIST` count at
   close time (`closePreEnt`) measures it instead of assuming it.

   EL71, 2113 Mi, batches filling to 128:

   | | |
   |---|---|
   | batch closes | 1 353 (from 35 873) |
   | module time | **0.548 s** (from 3.54 s) |
   | members that had run before their batch closed | 95 702 of 173 297 — **55.2 %** |
   | entries run before their batch closed | **7 001 592** — 1.45 % of all entries |

   At the measured 109 ns penalty per interpreted entry (4.16 guest
   insns; 49 MIPS compiled in-browser against 21.4 MIPS for native TCI,
   which `tools/interp-probe.c` shows transfers to wasm at 1.0×) that
   costs **0.76 s** to save **2.99 s**: **net +2.2 s of a ~27 s boot,
   ~8 %**, and +1.7 s if the interpreter lands 1.5× short of TCI.  The
   other end of the trade curve is the shipping build itself (35 873
   closes, nothing interpreted), so **both ends are now measured** and a
   deadline policy moves along a line between them.

0h. **The exit census after 0108–0113, and which guest instruction asks
   for each one (counters, round 28).**  This supersedes 0d's exit-mix
   table, which was measured before any of the TB-shape work.  EL71, per
   Mi at matched instruction counts, wall 9.35 ms/Mi:

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

   **Unsettled:** the exception round trip prices at ~1 030 ns per SWI
   from the profile (683 `excSwi`/Mi) but ~174 ns from the round-28 C
   timer.  A factor of six is not a measurement error on one side; run
   `W64_EXCNS=1` before believing either.

1. **wasm64 early-boot deficit — REDUCED by 0019, still open.**  Was
   ~27 % behind TCI on the first 0.75 G insns (per-TB module compile =
   21 % of vCPU); 0019 took t0.5G 48.7 → 41.7 s on this host.  What is
   left: batches still average ~3 members (60 % of misses find every
   goto_tb successor already translated; indirect targets are not
   followed), so ~1.2k small modules/s are still compiled (~120 µs each
   in Firefox, ~25 µs in V8) before compaction.  0020 added
   call-return and `ldr pc` trampoline successors (batches 3 → 13
   members, misses −60 %, t0.5G −5..−8 %); still ~450 small modules/s,
   65 % of them single-member (indirect `bx lr`/`ldr pc,[rN]` targets,
   mode switches).  Candidates: cheaper first execution, AOT cache (#4).  Meter: `idlebench --quick` t0.25G/t0.5G + `W64_DEBUG=1` batch
   histogram (`tools/iotrace.mjs`).
3. **Timer storms / main-loop wakeups — OPEN, smaller.**  The vCPU now
   runs virtual timers itself; what is left is the main loop's own
   realtime timers (gui refresh, DSP AFE 1 ms tick, PCM refill) and
   `qemu_notify_event` wakes.  Meter: wprof main-thread self-time +
   idlebench t1.3G.  Exit-kind counters (2026-09-11, after 0027): the
   remaining dispatcher exits are `TB_EXIT_REQUESTED` (~25k/s early —
   icount budget ends at every virtual deadline) and goto_tb first
   links (~3k/s).
5. **AOT cache — CLOSED (2026-09-16, probed and rejected; see the
   REJECTED row).**  Neither engine persists a compiled
   `WebAssembly.Module` (IndexedDB refuses the put in V8 *and*
   SpiderMonkey), byte-persistence measured 0.56× in V8 and 0.91× in
   Firefox at real module size, a put-per-batch-close costs more than
   the entire compile prize, and the Cache API + `compileStreaming`
   code-cache route gives synthetic responses no benefit.  The ~19 %
   ceiling was real but unreachable from the browser; the interpreter
   tier's ~5.7 % (halving module count) is what remains of the module
   pipeline, and its own probe — is an interpreted first execution of
   a ~3.9-insn TB ~100× cheaper than the module it avoids? — is the
   gate before any of it is built.
6. **Backend tail — the TB lookup path: 0046 landed the inline cache
   (2026-09-13).**  It was ~12.6 % of the vCPU mid-boot by profile:
   `helper_lookup_tb_ptr` 7.4 %, `qht_lookup_custom` 3.0 %,
   `arm_get_tb_cpu_state` 1.3 %, `tb_htable_lookup` 0.5 %; 153.4 M
   lookups per boot because every `bx lr` / `pop {pc}` / `ldr pc` and
   (since 0027) every `msr CPSR_*` goes through it.  0046 serves ~80 %
   of them from a per-TB slot without the helper — and the boot
   milestones did not move (the J2ME stopwatch did, +7..+9 %).  Read
   that as: the profile's 12.6 % was not 12.6 % of *boot wall time*
   removable by skipping the helper; the boot's early phase is
   compile-bound and its late phase is short at `rt=off`.  What is left:
   - The hflags-generation idea as written here was **wrong** (hflags
     change 88 k/s — § REJECTED); the version that landed stamps hflags
     statically per exit and compares only pc/gen(/thumb).
   - The remaining helper calls (26 M per boot) are real misses: the
     ~20 % of exits whose target alternates (return sites shared by
     several callers).  A 2-way slot would need a second compare on the
     hit path, which the two rejected designs say is not free — measure
     on the stopwatch, not the boot, if anyone tries.
   - Two `wasm_diag_stat` RMWs still run on every helper lookup (now
     ~52 M per boot, <0.5 %); `LC_CALL` is a third.  Not worth a commit.
   - Resizing the jump cache is closed: 8k and 32k both measured worse
     (§ REJECTED).  The misses are not a capacity problem.
7. **The display DMA per-word chain — OPEN, the stopwatch's top item
   after 0047.**  The firmware programs the display channel as 4095-word
   transfers moved **one 4-byte word per request** (`[4x1] -> [4x1]` in
   the `PMB887X_TRACE_LOG=dmac` trace; ~500 k requests/s at 60 fps), so
   every word runs the whole chain: `dmac_timer_reset` → 8 × channel run
   → `address_space_read` (RAM word) → `address_space_write` → flatview
   → dispatch → `dif_io_write` → FIFO push → `dif_schedule` → `dif_work`
   → `dif_tx_from_fifo` (2 × `dif_update_gpio_state`, mux, 4 ×
   `ssi_transfer` → `lcd_transfer` with three QOM casts each) → ack →
   CLR/BREQ level dance (`srb_set_icr` → event → `dif_schedule` again →
   `dif_tx_fifo_req` → `set_isr` → `dif_trigger_dma` → `qemu_set_irq`
   ×2 → `dmac_handle_signal` ×2).  Do not change what a request moves
   (device semantics); what can move is per-word overhead.  **0048 took
   the first three**: per-channel translation windows keyed on
   `memory_region_topology_gen()` (the memory-API layers were ~10 % of
   the vCPU after 0047; `dmacXlatFill` reads 0/s once the window covers
   the flat range), the VIC driving the CPU lines only on a level change
   (the masked TX request line cost a `cpu_interrupt` per toggle), and
   the pin table's dead `name[32]`.  Still open: the three QOM casts per
   LCD byte (`OBJECT_CHECK` calls `object_dynamic_cast_assert` for its
   trace point even with `qom_cast_debug=false`; ~1.6 %), the no-op
   passes of the level dance (`dif_trigger_dma` ×5 and `dif_schedule`
   ×2 per word), `qemu_set_irq` fan-out, and — the largest — the guest's
   own ~40 %.  Meter: `tools/stopwatch.mjs` (`per-s` line: `difTxWord`,
   `dmacBurst`, `dmacSchedTimer`, `dmacXlatFill`, `difMuxRebuild`).
   **0050 took two more**: the 16 KB zero-fill `-ftrivial-auto-var-init`
   put into `dmac_transfer_memory` per word (7.5 % of the vCPU — the
   function's whole self time) and the two checked casts per LCD byte.
   **0051 took three small ones** (the `BUS()` cast per SSI byte, the
   pin rebuild skipped on unchanged inputs, the FIFO modulo); the input
   cache on `dif_trigger_dma` was tried and dropped — it re-enters
   itself through the DMAC and never hits anyway (lessons.md).
   Still open after 0051 (profile `prof-stopwatch-0051`, per word):
   `dif_tx_from_fifo` 5 % self (1800 lines of wasm asm for the loop —
   a fat body, no single call to remove), `pmb887x_srb_set_event`
   2.5 %, `dmac_write` 2.6 %, `dif_trigger_dma` 2.3 % (four passes per
   word, each necessary in turn), `qemu_set_irq` 2.1 %,
   `dmac_timer_reset` 1.6 %, `lcd_transfer` 1.2 %, `dmac_handle_signal`
   1 %; on the guest side the IRQ entry/exit (`rebuild_hflags_a32` +
   `arm_rebuild_hflags` + `cpsr_write` + `switch_mode` +
   `arm_cpu_do_interrupt`, ~3.5 %) — a per-mode cache of the hflags
   would need every cp15 write to invalidate it, not attempted.
   **0052 took the per-TB dispatch loop** (row 0052, +3.5 %).  What a
   TB entry still pays, at ~17 M entries/s: the icount decrement (load,
   sub, brcond, store — the timing model), the chain jump (three loads,
   two compares, `return_call_indirect` through the shared table with
   V8's signature check), and the guest register loads/stores from
   `env` (TCG's design).  **Both chain-jump ideas are closed by
   inspection (2026-09-14), do not retry them blind**: a direct
   `return_call` for same-batch targets cannot be emitted, because the
   chain slot is patched by `tb_add_jump` at *runtime*, long after the
   module is compiled — the target is simply not known at emission (it
   would take a fixup of the staged member bytes at batch-assembly
   time, a much larger design); and the per-exit `fidx` load cannot be
   dropped in favour of the `reset_addr` compare alone, because
   `w64_batch_evict_oldest()` makes eviction real — a boot reads
   `ensureN 0`, but a long run (the phone's 177 s stopwatch) is exactly
   where the cap bites.
   **0054 took the per-word MMIO dispatch decision** (row 0054): the
   destination write's validity/endianness/ioeventfd/split work is a
   function of the region and the width only, so it is now decided once
   per translation window.  Bigger TBs are not
   available: the firmware branches every four instructions.
   **2026-09-14, re-checked on the 0054 profile and nothing new found
   — three candidates sized and all rejected before building.**
   `dif_tx_from_fifo` is still the largest single non-guest symbol
   (1152 ms of 20.3 s, 5.7 %) but its `while` runs **once per call** in
   the display path (one word per request), so hoisting to the loop
   head buys nothing, and the per-word decodes it inlines are cheap
   ANDs/shifts whose one real candidate (`dif_get_bsconf_word_count`)
   keys on `tx_csreg`, popped from a parallel FIFO *per word* — a cache
   would need a config generation plus a `tx_csreg` compare for maybe
   half of 5.7 %.  `dif_mux` is already 0047's table lookup (four loads
   + ORs).  `dmac_timer_reset`'s "8 channel passes per word" overstates
   it: seven are two bit tests each (`ch->config`/`p->config` ENABLE),
   so most of its 1.9 % is the *active* channel's real work and a
   channel bitmask would buy a fraction of it.  The chain really is a
   tail of 1–3 % items with no single removable piece — the 0051 note
   below said so and a fresh profile agrees.
   Earlier list (profile `prof-stopwatch-0049`, per word):
   `dif_tx_from_fifo` 4 % self, `pmb887x_srb_set_event` 2.3 % (two
   events per word — the TXBREQ set from `dif_tx_fifo_req` and its clear
   from the DMA acknowledgement, each through the `irq_router` and
   `event_handler` indirect calls), `dmac_write` 2.1 %, `qemu_set_irq`
   1.8 % (~8 calls per word), `dif_trigger_dma` 1.7 % (5 passes per
   word), `dmac_timer_reset` 1.4 % (8 channel passes per word),
   `ssi_transfer_raw_default` 1.3 % and `lcd_transfer` 1 % (two indirect
   calls per byte), `access_with_adjusted_size` 1.1 %.  Each is small;
   the sum is the ~30 % that is left of the chain.  A structural cut
   would have to collapse the per-word request/acknowledge dance into
   one pass per burst without changing what the guest can observe
   between words (the request bits in `RIS`, the VIC line, the FIFO
   level) — not attempted.
8. **ke800's LG-logo stall — CLOSED by 0049**, and the precedent for
   the open timer-model question: the GPTU model armed a QEMU timer at
   every 8-bit overflow of a free-running byte — ~100k main-loop
   callbacks/s, each ~10 µs of JS clock imports, each holding the BQL.
   Natively a few percent of one core; in wasm it saturated the
   main-loop worker and the vCPU starved at ~40k insns/s.  0049 steps
   the chain lazily and arms only for the next *observable* overflow
   (`gptuTimer` counter).  **The TPU/CAPCOM/STM models have never been
   audited for the same "deadline = next hardware tick" pattern.**

Landed/closed since the last ranking: MMIO dispatch path (0018 —
mmiopoll 534→202 ns, native parity; re-measure before reopening).

Closed (do not reopen without new ideas): exception longjmps (0013/0014
— SVC inline exit + io barriers; the generic wasm-EH longjmp stays
blocked by asyncify); TCI interpreter dispatch (0007–0016 took it to its
micro-optimization floor; the wasm64 backend supersedes it, TCI remains
the reference/fallback tier); flash romd topology churn (0016); V8
warm-up (no in-window effect on this host); main-loop busy-wait (0009);
register-file expansion (measured worse); icount2 thread-local batching
(flat — the per-TB atomics are cheap on wasm; and the account is now
inline on wasm64 anyway).

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
  Firefox's ~16 k-module budget; `ffboot.mjs` prints the surplus as
  `temp=` and `diagall.mjs` has it as MOD_COUNT − CLOSE_N − COMPACT_N.
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

Measured cost of the cap itself (same wasm, S75v40lg1, quiet host):
tIdle 34.8 → 40.6 s, t0.5G 25.8 → 28.2, every milestone +9…13 %.  That
is not a bug — the cap is what stops the phone's clock and animations
running ahead of wall — but it is a real user-visible price that was
invisible here, and it belongs in any future "boot takes N seconds"
claim.

Generally: **if the page has a knob, the benchmark must be able to set
it.**  A hardcoded query parameter in a measurement tool is a permanent
blind spot, not a default.

## The shipping boot is virtual-time-bound after t0.75G (2026-09-12)

The `RT=banked` price in the section above ("+9…13 % on every milestone")
is stale, and it was stale in a way that matters: it was measured when the
engine was slower.  Interleaved, same invocation, current build:

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

## The cap now has two phases: `banked:30` (2026-09-15)

`banked` is the right mode *during* a boot and the wrong one after it.
The credit that lets a compute-bound boot catch up as fast as it can is
the same credit that lets a later stall — a backgrounded tab, a host
hiccup — be repaid by sprinting the phone's clock and animations.  So the
shipping default became **`banked:30`**: banked until the guest has run
30 seconds of its own clock, then strict for the rest of the run.  Plain
`banked` and `strict` stay pinned, so the ladder above and every
historical A/B keep their meaning.

Two things worth keeping:

- **The window is guest time, not wall time.**  The boot costs ~42 s of
  virtual time on every host, but 39 s of wall on the reference machine
  and minutes on a phone.  A wall window would therefore expire mid-boot
  on exactly the slow machines banked exists to protect, forfeiting a
  large unspent bank.  A guest window also costs nothing to implement —
  `icount_rtcap_excess_ns` is already handed a virtual-time value, so the
  test is one compare against a constant with no extra clock read — and
  it is not consumed by a pause.
- **The switch needs no re-anchor.**  strict's branch only fires when
  `vtarget < allowed - SLACK` and then sets `allowed = vtarget`, so
  strict's `allowed` is never greater than banked's:
  `excess_strict <= excess_banked` in every state.  Flipping can only
  shorten a sleep, never lengthen one.  Either the guest is lagging and
  the branch discards the bank on the same call, or it is inside the
  slack band and the flip is a literal no-op.

Measured on the reference host (`dist-jit`, S75v40lg1): the switch lands
at wall ≈30.7 s with `v = 30.2 s` — the guest is pinned at the cap by
then, having just spent its bank through the display-DMA warp stretch
(`v` 4.2 → 30.2 in ten seconds, v/wall 2.58), so the flip is the no-op
case and `tIdle` is unmoved.  Afterwards v/wall settles at 1.00.

The page side: the status pill's `slow` warning is suppressed while the
cap is banking, because v/wall is below 1 there *by construction* — the
guest is behind and allowed to catch up, so the warning fired on every
boot and meant nothing.  The HUD strip keeps its real colours.  The HUD's
`lag` also re-anchors at the switch: the paced phase *forgives* the debt
instead of paying it back, so carrying the boot's 16 s of lag past the
switch would show an amber token for a debt that no longer exists.

## The post-window phase became a 500 ms budget (2026-09-16)

Strict turned out to be the wrong second phase, and so did plain
banked: after a stall, strict keeps the phone's clock behind wall
*forever* (the user watches the countdown lag real time for the rest of
the run), while banked repays *everything* — measured, a 12×-throttled
boot released at v=4.2 s sprinted v to 38.0 s in four seconds of wall
(v/wall ≈ 8×): the LCD freezes while the phone's clock skips half a
minute.  The shipping default is now **`budget:30:500`**: the boot
window is unchanged, then the forgive branch keeps
`allowed = vtarget + 500 ms` instead of `= vtarget` — a stall is repaid,
but never by more than half a second of sprinted clock, so the phone
stays close behind wall instead of either drifting or skipping.

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
   it is 34 experiments deep and several ideas have been retried twice.
4. Patch → rung 2 (fixed guest work) → confirm the mechanism with
   counters → keep/revert → `bash scripts/gate.sh keep` → commit on the
   qemu branch with the measured numbers, push, bump the pin in
   `versions.env`.
5. `bash scripts/gate.sh close` before the session's last commit —
   Firefox included, because Chrome hides module-budget bugs.
6. Update the tables here (landed/rejected/remaining), § Open items in
   the hand-off, and lessons.md
   when something was learned the hard way.
