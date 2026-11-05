# Performance

Where the speed work stands, how to measure and validate a change, and what
has already been tried. Read this before doing performance work on the
emulator.

- **State described:** fork `92f6a90e56`, merge of smh/master `d9cf65ef40`
  on top of the 2026-11-04 deviation cleanup (`1b51f8e577`). Written
  2026-11-04.
- **Replaces** `doc/performance-handoff.md`, the September 2026 round log of
  the icount era (still in this repo's git history).
  [optimization-playbook.md](optimization-playbook.md) and
  [lessons.md](lessons.md) come from the same period and keep its methods
  and conclusions, with the removed knobs and tools pruned. Their figures
  predate the vcpu-timers model and the DSP LLE.
- **Related:** [wasm-fast-paths.md](wasm-fast-paths.md) lists every fork change
  that exists only for speed, and how to remove one.
  [diagnostics.md](diagnostics.md) lists the page parameters and tools.
- Every number is as of its date. Commit hashes refer to the `qemu/` history
  (fork branch `wasm-browser-port`); "parent" means this repo.

## Goal

- **Target:** real time with smooth sound on an Android phone about 5x slower
  than the development host (the owner's Pixel 8 Pro). On the Pixel, the EL71
  stopwatch ran at x1.00 before the DSP LLE and x0.35 after it (2026-11-01).
  That is raw single-thread speed, and it has not been re-measured since the
  fixes. On the dev host the same scene is back to its pre-LLE CPU use
  (cpu 0.66 vs 0.69, 2026-11-01).
- **Size of the gap:** on 2026-10-31, Bobby needed about 4x less vCPU work for
  the 5x target. On 2026-11-02 the Pixel was estimated to need ~3x raw speed.
  No single remaining lever is that big; progress comes from many 1–10 %
  changes.
- **Android Chrome bounds-checks every wasm memory access.** V8 enables its
  trap handler only for `V8_OS_LINUX && !V8_OS_ANDROID`
  (`src/trap-handler/trap-handler.h`). Simulate this on the host with
  `--js-flags=--wasm-enforce-bounds-checks` (`tools/perf/swab.sh` sets it by
  default). With constant env addresses in place (`4dc162bbf6`), the flag
  still costs ~8 % on towerblox and ~9 % on stopwatch. x86 without the flag
  hides env-addressing effects, so re-test those ideas with it.
- **The work is one thread.** On Bobby the vCPU worker used 0.605 of the
  browser's 0.73 cores; the main thread used 0.02 and GPU/compositor 0.03
  (2026-10-31). JS-side changes cannot win anything. The DSP runs on the vCPU
  thread too.

## Rules from the project owner (binding)

1. **No DSP thread.** It was tried twice (see Closed ideas) and the owner
   would only keep it for a serious win.
2. **No HLE and no cutting of DSP work.** The DSP executes everything the
   firmware gives it. That includes the GSM search over upstream's synthetic
   MSK/FCCH baseband input, which takes ~30 % of video ticks.
3. **Behaviour-preserving changes only.** The guest must see the same
   instructions, values and virtual-time events. Do not change the timing
   model or device semantics for speed, and do not pin clock frequencies to
   "fix" pacing.
4. **New fast paths need a significant win, and must stay isolated and
   marked.** Put the code in its own file and give every hook the
   `WASM PORT FAST PATH (removable)` comment (wasm-fast-paths.md § Marking).
   Small gains that add upstream divergence are unwanted: a 35BE kernel
   rewrite for ~2 % was rejected (2026-10-31). A larger rewrite is acceptable
   if it gives a significant boost and stays isolated.
5. **Stay as close to upstream as possible without losing performance.** When
   removing fork deviations, A/B the whole cleaned-up candidate against the
   pre-cleanup build on every scene, with an A/A to check the method. It must
   not lose on any scene. The old per-change ~1 % threshold is gone: removals
   that were each "within 1 %" summed to −6 % on stopwatch and −3 % on midi
   (2026-11-04), and that was rejected. Use per-group A/Bs only to find
   culprits. One exception (2026-11-05): the owner took the EL71 boot win of
   the pc cache probed in the lookup helpers with its ~1 % steady-state cost
   (History). It was a one-time decision, not a licence to give up towerblox
   or any other scene. The cost is gone since the probe became a function of
   each batch module (History, the next 2026-11-05 row).
6. **Follow smh/master.** If upstream is broken, stay on its last working
   commit. For example, the SIM PPS commit was excluded from 2026-11-02 until
   upstream's SIM rewrite fixed it on 2026-11-04.
7. **Never boot a shared fullflash writable.** `RW=1` in
   `scripts/run-native.sh` lets the firmware rewrite its FFS, and the result
   depends on that state. Check the `fullflash:` line of the run output.
   `rr_ff_el71_stock.bin` was corrupted this way once (2026-11-03) and restored
   from a copy.
8. **The display freeze after leaving a running stopwatch is upstream's.**
   Wait for upstream to fix it; do not work on it.

### Working rules (still true from the September log)

- **Measurements and gates are different activities.** A gate asks whether
  the guest reaches a state, so `scripts/gate.sh` runs its jobs concurrently.
  A measurement reads a clock, so it needs the host to itself. Never measure
  while a gate, a build or another benchmark is running.
- **A counter confirms a mechanism; a clock only prices it.** Count that a
  fast path runs, and why it refuses, before you price it (see Validation).
- **Price the prize before building the machine.** Measure the ceiling first
  (profile share, census, an inexact upper-bound build). Many rows under
  Closed ideas stopped at this step.
- **A name in a wasm profile is a neighbourhood, not a function.** Confirm it
  with a counter or with V8 `--prof` (see Profiling).
- **A hard wasm trap is never host pressure.** A bisect that "fits" can fit
  because the bug predates both revisions.
- **A silent skip is worse than a red gate.** `scripts/run-tcg-isa.sh` skips a
  leg whose dist is missing (`WASM=1` makes it fail instead), so read the leg
  list, not the PASS line.
- **Grep this file before trying an idea.** The i2s divide skip, the
  guest-insn counter RMW and the lazy global sync were each re-tried by
  mistake.
- **Pay at the path's rate.** A per-access condition on a hot path must pay
  for itself at that path's rate (see the rates table under Where the time
  goes). A change in shared qemu code (mark **all** in wasm-fast-paths.md) also
  changes the native lockstep reference.
- **Emscripten traps.** wasm-EH longjmp does not compose with Asyncify,
  `poll()` never sleeps, condvar waits are whole milliseconds, and proxied
  syscalls take ~1 ms. See [lessons.md](lessons.md).

### Landing a change

- Make one mechanism per qemu commit, with the measured numbers in the
  message. Bump `QEMU_PMB887X_REV` in `versions.env` together with the
  submodule pin.
- Run `scripts/gate.sh keep` before each commit, and `close` before the last
  commit of a session.
- If the change did not ship, add a row to Closed ideas. Keep the patch under
  `build/experiments/` if it is worth keeping (local, untracked).
- Do not use `scripts/build-qemu.sh` mid-session. It runs
  `git submodule update --init` and moves `qemu/` to the pin. Use
  `scripts/ninja-fast.sh` instead (incremental build and deploy), or
  `scripts/build-qemu-wasm64.sh`.

## Timing model

The site default (`site/app.js`) is:
`-accel tcg,thread=multi,vcpu-timers=on,vcpu-timers-bank=30,vcpu-timers-idle-lead=2000,cross-page-links=on`.
`?bank=` and `?idlelead=` change the two fork values. A `?qargs=` with its own
`-accel` replaces the whole default. `?icount=<spec>` selects icount instead,
and `?icount=none` selects neither.

| Piece | Origin | What it does |
|---|---|---|
| `vcpu-timers=on` ("vt") | upstream | The virtual clock counts guest CPU cycles at the CGU's CPU clock, and virtual-clock timers run on the vCPU thread. The vCPU runs cycle budgets up to the next deadline, at most `CPU_CLOCK_OWNER_LEAD_NS` (200 µs) ahead of wall time and at least `CPU_CLOCK_BUDGET_MIN` (64 cycles). Lag beyond `CPU_CLOCK_OWNER_LAG_MAX_NS` (100 ms) is dropped, so a slow host slows the guest clock instead of starving firmware timing. Requires one vCPU and no icount |
| `vcpu-timers-bank=N` | fork | For the first N s of guest time, lag is not dropped, so the guest catches up while it idles. S75 boot to idle went from 26.4 to 23.7 s; the floor is the guest's own ~22.9 s boot timeline. The HUD polls `_wasm_clock_banked` |
| `vcpu-timers-idle-lead=µs` | fork | While the guest waits for an interrupt, its timers run in batches up to this far ahead of wall time, with one host sleep per batch. Idle cpu went from 0.239 to 0.228 cores only |
| `cross-page-links=on` | upstream option, site default since 2026-11-03 (parent `de0adbd`) | Chains TBs across guest pages and unlinks them on TLB flushes. EL71 boot window −5.8 %; steady state neutral to +1 % |
| `QEMU_TIMER_ATTR_LAZY` | fork (`util/qemu-timer.c`) | A lazy timer neither caps the budget nor counts as the first deadline. It is used by the dif_v2 TX bus timer, which catches up on any access that could observe it (`0c3c3c8c9b`) |
| DSP sync | upstream | The Teak runs on the vCPU thread. It is caught up every `DSP_SYNC_PERIOD_NS` (100 µs virtual, `hw/arm/pmb887x/dsp.c`) and on every MCU access to DSP state: ~15k syncs/s in video and midi, two thirds from the timer. The period is guest timing, not a tuning knob |
| icount `shift=3,sleep=off` | upstream | Deterministic. Used by lockstep (`tools/lockstep-wasm.mjs` passes it explicitly) and as the default of `scripts/run-native.sh` (`ICOUNT=vt` selects vt there) |

Cost facts:

- **Budget exits are the vt tax.** Each one costs a JS clock read (~1.5 µs)
  and the `cpu_exec` setjmp trampoline (~1 µs) (2026-10-29). A device timer
  that fires 100k times a second is therefore expensive. That was the root
  cause of the stopwatch regression: 213k dif_v2 bus wakes/s, each capping the
  budget, caused 275k JIT exits/s.
- **The vt boot to idle is bounded by the guest's timeline.** A compute saving
  shows up only in the compute-bound early window (the first ~11 s of an S75
  boot, 2026-10-29).
- **`-accel tcg,thread=multi` without vcpu-timers** (wall-clock virtual time)
  is unusable with the DSP LLE: stopwatch reports "guest never went idle"
  (2026-11-02).
- **Removed (do not look for these):**
  - The icount real-time cap (`?rt=`, rtcap, idlebench `RT=ship`).
  - Soft icount timers (`QEMU_TIMER_ATTR_SOFT`).
  - The wasm `main_loop_wait` timeout override in `util/main-loop.c`. It
    re-added virtual deadlines without icount, so the main loop woke on every
    100 µs DSP sync and fought the vCPU for the BQL. Removing it took the vt
    boot from 28.4 to 26.2 s.

  All three went on 2026-10-29.

## Benchmarks

`tools/scenebench.mjs` boots a phone, walks the keypad into an app (checking
every step against an LCD reference in `tools/test_targets/`), and measures a
window. The flashes come from `fullflashes/`, next to or one level above the
repo; `--flash` overrides that. Results go to
`tests/results/scenebench-<scene>-<ts>.json`.

| Scene | Phone (flash) | What runs | Where the time goes | Use it for |
|---|---|---|---|---|
| `stopwatch` | EL71 (`EL71v41lg91.bin`) | Extras → Stopwatch running; full-screen redraw over DIF+DMAC | ARM TB code (~62 % with bounds checks), DSP kernels ~10 %, display | ARM, codegen, display and other C-side changes. The most sensitive scene |
| `music` | EL71 | "This time" AAC in the media player | DSP (~65 % of the vCPU, 2026-10-29) | Audio smoothness (underruns, gap) |
| `idle` | EL71 | The idle screen | Idle cost (~0.22 cores) | Idle-path changes |
| `midi` | SL65 (`SL65v49lg1_TIM.bin`) | Asia.mid, looping | DSP (~62 %); DSP-bound | DSP translator and kernels |
| `bobby` | S75 (`s75_working20060710172101.bin`) | Bobby Carrot (J2ME) with sound, walking | DSP 61 %, ARM 19 %, display 13 % (2026-10-31) | DSP. It hides 1–2 % display wins |
| `towerblox` | S75 | Tower Bloxx Quick Game, a block dropped every 1.5 s | ARM TBs 47 % (fresh JIT-compiled Java, partly Liftoff tier), DSP TBs 19 % | Codegen and bounds-check effects. vratio swings 1.2–2.2 with game state, so use many pairs or paired profiles |
| `video` | SL65 | Berlin.3gp, looping | ARM 44 %, DSP 33 %, devices 16 %; GSM search kernels ~30 % of free-run ticks | dif_v1 display and DSP kernels |

**Metrics:**

- `vratio`: virtual seconds per wall second.
- `mips`.
- `fps`: framebuffer changes the page saw, including half-drawn frames. For a
  true frame rate, count LCD RAMWR (0x2C) commands.
- `cpu`: CPU seconds per wall second of the browser's whole process tree,
  from /proc.
- Audio: `underruns`, `underrunAt`, `gapMs`/`gapPct`, `produced`,
  `cushionMs`, `minFillMs`/`maxFillMs`, `drainedMs`/`cutMs`, `stretchedMs`
  and `peak`.

**Options:**

- `--runs N`, `--measure S`, `--flash <path>`, `--keyscale k` (multiplies the
  key delays, for slow models).
- A dist may be `dir@query` (extra page parameters). Encode commas as `%2C`,
  because dist specs are split on commas.
- `SCENEBENCH_CHROME_ARGS` (split on spaces), `SCENEBENCH_AT_MEASURE` (JS
  evaluated when the window starts), `SCENEBENCH_DEVTOOLS=<port>`,
  `SCENEBENCH_CONSOLE=<substring>`, `SCENEBENCH_SAVEREF=<png>` and
  `SCENEBENCH_BROWSER=firefox`. Headless Firefox needs PulseAudio, and it runs
  ~1.6x less efficiently than Chromium on towerblox.

### Boot A/B (`tools/perf/bootab.sh`)

`tools/bootbench.mjs` follows one boot from the Start click to the idle
screen: guest clock, instruction count and audio ring every 200 ms (its
header lists the outputs). `tools/perf/bootab.sh <phone> <distA> <distB> 4`
boots the two dists side by side on swab.sh's core sets, paced as on the page
(no free-run), and prints B/A per metric:

- `burst`: wall seconds from guest 6 s to 12 s (`SPAN`), the EL71 burst
  around the boot chime. While the guest is behind real time this is raw
  emulator speed.
- `audioMs` = `stretchedMs` + `gapMs`: ring audio replayed to slow the
  sound down, plus underrun silence. The two trade against each other, so
  judge the sound by the sum. `lagMax`: the furthest the guest fell behind.

**Pitfalls:**

- **First-request gzip:** `serve.mjs` compresses a dist's wasm on its first
  request, so a dist built moments before made its legs wait while the other
  side booted: B looked ~2 % (up to 5 %) slower in every A/B before
  2026-11-05. bootab.sh now fetches both wasm files before starting. A/A
  after the fix: +0.4 % (se 0.3).
- **Outlier pairs:** one leg sometimes runs 10–15 % slow (seen on pair 3's
  and 4's A side). A round's se then reads 3–4 % against ~0.7 % otherwise.
  Run two rounds and compare the medians.

### The A/B method: paired free-run

On this host the stopwatch keeps real time, so plain runs pin vratio at 1.0
and only `cpu` moves. Running several browsers at once (`tools/parbench.sh`)
makes the guest fall behind real time and hides costs that matter in the
real-time regime (2026-10-31). The method since 2026-11-01 is therefore:

- `tools/perf/freerun.diff` is a bench-only qemu patch that adds
  `_wasm_free_run`. When it is on, the vt clock's host reading runs at 1000x
  wall speed, so the guest never waits for real time and vratio becomes raw
  emulation speed. Never ship it.
- `tools/perf/swab.sh` runs both legs of every pair at the same time, each on
  two whole physical cores. A and B swap sides between pairs, bounds checks
  are on, and free-run is switched on when the window starts. It prints B/A
  per pair, then the mean, sd and se.

```bash
export PLAYWRIGHT_BROWSERS_PATH=$PWD/tools/chrome
PORT=8080 node serve.mjs &                    # page server, leave it running
git -C qemu apply $PWD/tools/perf/freerun.diff
WEB_DIST=$PWD/site/dist-fa bash scripts/ninja-fast.sh     # leg A (base)
# ... apply the change to qemu/ ...
WEB_DIST=$PWD/site/dist-fb bash scripts/ninja-fast.sh     # leg B
git -C qemu apply -R $PWD/tools/perf/freerun.diff         # never `git checkout` those files
tools/perf/swab.sh stopwatch dist-fa dist-fb 4 20         # scene, A, B, pairs, seconds
```

**Reverting the bench patch:** freerun.diff touches
`system/cpu-timers.c`, `include/system/cpu-timers.h` and `ui/wasm.c`.
`git checkout` on those files wipes any other uncommitted edits in them, so
always revert with `git apply -R`.

**swab.sh environment:**

- `BFLAGS=0` drops the bounds checks.
- `ARGS_A`/`ARGS_B` add per-leg Chrome arguments. Chrome keeps only one
  `--js-flags`, so a leg that passes its own must include
  `--wasm-enforce-bounds-checks` in it, comma-separated.
- `METRIC` (default `vratio`), `OUT` (log dir), `PORT_A`/`PORT_B`.

**Pitfalls and noise:**

- **Pairs:** at most 4 per run. Pairs 1–4 already use cores 0–15 and their
  SMT siblings 16–31; more pairs share cores and give garbage. For 8 pairs,
  run 4 twice. Nothing else may run meanwhile.
- **Noise:** one pair is ±3 %. Below ~2 %, use 8–12 pairs or paired V8
  `--prof` profiles (see Profiling).
- **Position bias:** ~±1.5 %; the later-started leg does better. swab.sh
  alternates the sides. When running by hand, run both orders, and never
  sweep more than two dists at once.
- **Do an A/A first** when the method is in doubt (2026-11-04: +0.3 % and
  +0.1 %).
- **Groups interact.** On 2026-11-04, cleanup groups that were each neutral
  against an intermediate state summed to −5.7 % on stopwatch. Always finish
  with a whole-candidate A/B.
- **Outside load:** the host is shared. On 2026-11-04 it showed load average
  55–61 and 56 % user CPU while this container was idle. Check
  `top -bn2 -d 5` and the absolute vratios (table below) before trusting an
  A/B. `/proc/loadavg` and `free` report the host, and
  `tools/perf/hostmon.sh` samples memory pressure.
- **Under bursty outside load the round is the sample, not the pair.** All
  legs of a swab.sh round run at once, so when outside load comes and goes,
  the four pairs of a round move together: on 2026-11-04 the round means
  of one comparison were +3.8 % and −4.4 %, with a spread inside each round
  under 2.4 %. Compute the se over round means. If they disagree, fall back
  to paired profiles.
- **A slow core set biases the same side every round.** swab.sh alternates
  sides between pairs, not between rounds: pair 3 always runs B on cores
  6–7, and on 2026-11-04 it was the most negative midi pair in every
  round (−3.7, −1.2, −2.5 %). For a close call, run half the rounds with
  the dists swapped.
- **Function placement alone moves a scene by ~1 %.** The `-O3` link
  (binaryen) orders functions by use count, so one new out-of-line function,
  or more call sites for an old one, renumbers thousands of functions whose
  code did not change. The 2026-11-05 fill rectangles moved every hot DSP
  function of bobby up one index, and bobby, which never reaches the fill,
  measured −1.4 % over four rounds (se 0.24). A control with the same shift
  and no new code that runs (a looped function behind 16 never-taken calls in
  the base's fill helper) measured −0.8 %. Before blaming a change for a loss
  on a scene that does not run it, compare the two `.wasm` code sections by
  function (sizes, and the `.js.symbols` index of the scene's hot functions)
  and A/B such a control. It is this host's V8 code placement and says
  nothing about the phone.
- **Upstream timing changes:** compare `mips`/`fps`, not vratio, across them.
  After the 326ab1b4d5 merge, video vratio fell 12–20 % because the SL65
  player draws more frames per virtual second, while mips rose 11 %.
- **Profile shares across builds:** function shares are not comparable,
  because Binaryen inlining shifts (`helper_teak_tcg_chain` read 1.5 % vs
  5.9 % after a peripheral-only change). Use an A/B.
- **Dist names:** the host mount is case-insensitive, so dists whose names
  differ only in case collide. Use unique lowercase names.
- **`WEB_DIST` must be absolute.** A relative path lands in
  `build/qemu-wasm64/site/`.
- **Old dists** can hang silently under the current scenebench (empty logs).
  Rebuild the old commit into a fresh dist instead.
- **Board configs:** `site/dist/boards.tar` is shared by every dist and
  repacked from `build/bsp` on every ninja-fast deploy. A dist that needs
  another BSP must be served from a second site root
  (`WEB_SITE_DIR=<root> PORT=8081 node serve.mjs`, then
  `PORT_B=8081 tools/perf/swab.sh ...`).
- **`tools/videobench.mjs` is broken** on current builds (boot detection, no
  `wasm_rtcap_set`). The `video` scene replaces it.

**Normal absolute values on a quiet host** (free-run, bounds checks,
2026-11-04). Anything far off means the host is busy or the build is wrong.

| Scene | Value |
|---|---|
| stopwatch | vratio ~1.05–1.19 |
| midi | vratio ~2.6–2.7 |
| bobby | vratio ~1.75 |
| towerblox | vratio ~1.0–1.05 (swings with game state) |
| video | mips ~72, fps ~35 |

### Slow-host models (big effects only)

These models are too noisy for effects below ~10 %: the same build ranged
0.43–0.62 vratio.

- **`tools/dutyhost.sh`** stops and resumes the whole process tree
  (`RUN`/`STOP` in ms; `RUN=1 STOP=2` was used). Use it for anything that
  spreads work over threads.
- **`tools/slowhost.sh`** (`CORES=0-3 SPIN=2`) shares the cores with spinners.
  It is pessimistic for threads: woken threads wait behind the spinners, which
  is what made the DSP thread look bad. After a run, check
  `ps aux | grep "while :"` for leaked spinners.

## Profiling

### V8 `--prof` (self time; the precise sampler)

```bash
D=$(mktemp -d)
SCENEBENCH_CHROME_ARGS="--no-sandbox --js-flags=--prof,--logfile=$D/v8.log" \
  node tools/scenebench.mjs stopwatch dist-x --runs 1
tools/perf/v8tick.py $D/isolate-<id>-v8.log site/dist-x/qemu-system-arm.js.symbols 25
```

- **Which log:** the vCPU isolate is the log with the most code-creation
  records. The last argument keeps only the final N seconds.
- **Android-like numbers:** add `--wasm-enforce-bounds-checks` to the same
  comma-separated `--js-flags`.
- **Free-run:** use a freerun dist and set
  `SCENEBENCH_AT_MEASURE="window.__qemu._wasm_free_run(1)"`.
- **v8tick knobs:**
  - `V8T_TBTOP=<n>`: the hottest TB functions.
  - `V8T_MAINTIER=1`: split the main module into Liftoff and TurboFan.
  - `V8T_N`, `V8T_WIN=<from>,<to>`, `V8T_TIMELINE=<s>`, `V8T_CHAIN`,
    `V8T_CXXCALLER` and `V8T_LEAF`.
- **Paired profiles** (A and B under identical conditions) resolve effects
  below the swab noise. Compare the cost per guest second (share / vratio).
- **Use the symbol sidecar of the same build** (`qemu-system-arm.js.symbols`);
  a stale one gives nonsense names.

### DevTools sampling (`tools/wprof2.mjs`)

To profile: start `SCENEBENCH_DEVTOOLS=<port> node tools/scenebench.mjs ...`
and wait for its "measuring" line. Then run
`PROF_ATTACH=<port> PROF_DIST=<dist> PROF_SAVE=<json> node tools/wprof2.mjs <secs>`.
`PROF_WORKER` picks the worker. It is useful for stacks, but:

- DevTools charges builtins and runtime C++ to a wasm caller. In DevTools
  `tcg_qemu_tb_exec` read 4.7 % of stopwatch; under `--prof` it was 0.36 %.
  Its real self time is the inlined w64 interpreter tier (the first
  `W64_INTERP_THRESH` = 64 entries of every TB), not dispatch.
- JIT-compiled DSP code can show up under wrong wasm names (index
  collisions), for example `emscripten_get_now` under `tcg_qemu_tb_exec`.
- Without `PROF_DIST`, wprof2 takes `site/dist-jit`'s symbols.
- Fixed-length windows cover different instruction counts, so compare
  per-subsystem deltas with care.

### Reading what V8 runs

- **TurboFan machine code:**
  1. Run `node tools/perf/wasmgrab.mjs <devtools port> 15 8 <outdir>` on a
     page started with `SCENEBENCH_DEVTOOLS`. It saves the hottest TB modules
     and `hot.json`.
  2. Print a module's TurboFan x64 with
     `node --no-liftoff --no-wasm-lazy-compilation --print-wasm-code ...` (the
     full command is in the script header).
  3. Grab last: the debugger tiers the worker's wasm down, so do not measure
     on that page afterwards.
- **WAT:** use `build/deps/emsdk/upstream/bin/wasm-dis --all-features` (npm
  wabt lacks threads). wasm-dis numbers defined functions after the imports:
  the symbol index minus the number of function imports.
- **Named TBs:** a temporary `#define W64_NAME_TBS 1` in
  `tcg/wasm64/wasm64.c` names each TB function `tb_<pc>_<icount>_<flags>`, so
  profiles show which guest code the time goes to.

### Counters and censuses

- **The port carries no counters or knobs.** A census is a temporary patch:
  `fprintf(stderr, "TAG ...")` on the vCPU thread shows up in the page
  console, and `SCENEBENCH_CONSOLE=TAG` prints it. The filter matches a
  substring, so use a unique tag. Lines are cut at 300 characters.
  `cpu_tb_exec` runs only ~70k times/s (chaining), so periodic prints need
  small periods.
- **Missing tools:** there is no Linux `perf` in the container
  (`perf_event` is blocked), and no Teak disassembler in the repo. Opcode
  names follow the enum order in `hw/arm/pmb887x/dsp/core.h`.

## Validation

### The gate

```bash
export PLAYWRIGHT_BROWSERS_PATH=$PWD/tools/chrome   # without it every browser job is RED in ~60 s
PORT=8080 node serve.mjs &
bash scripts/gate.sh keep --dist dist-x            # before a commit
bash scripts/gate.sh close --dist dist-x           # before the last commit of a session
```

- **References first:** the gate builds the native references
  (`scripts/build-native.sh`, `scripts/build-native-tci.sh`) from `qemu/` as
  checked out, then starts its jobs.
- **`keep`** runs opsuite, boot and early-key checks on S75, EL71, KE800,
  CX70 and KE970, the native boots (`tests/run.mjs`) and `lockstep-wasm`
  (S75, 250e6 insns). `close` adds the ordered boot, native lockstep,
  `lockstep-full` (2.5e9 x3), Firefox, detect, efa-web and the UI check.
  `--list` prints the tiers.
- **Browser jobs boot with the page default** (vt + cross-page-links). The
  native boots and the lockstep jobs use icount `shift=3,sleep=off`
  (`scripts/run-native.sh`, `ICOUNT=vt` for the page's clock).

### Lockstep

| Check | How | Blind to |
|---|---|---|
| Default | `node tools/lockstep-wasm.mjs --port 8080 --dist dist-x --insns 2.5e9` (S75; `--flash el71` for EL71). Both sides run icount, one instruction per TB, pinned RTC | Multi-instruction TBs, superblock accounting, io_recompile rewinds, vt-only paths, framebuffer SDRAM (compared only loosely) |
| Multi-instruction TBs | Prefix `LS_QARGS="-rtc base=2000-01-01T00:00:00,clock=vm"`. This **replaces** the default qargs, so the wasm side runs real TBs and superblocks and does io_recompile rewinds; native stays one instruction per TB. Add `-accel tcg,cross-page-links=on` to cover the page's linking | vt-only paths |
| DSP translator changes | Native old vs new binary: `node tools/lockstep.mjs --a-bin <old>/qemu-system-arm --b-bin <new>/qemu-system-arm --flash el71 --insns 1e9`, then S75. Normal lockstep runs the same DSP translator on both sides, so it cannot see a DSP change | SL65 (see below) |

- **The reference is stamped.** It is `build/qemu-native-build`.
  `scripts/build-native.sh` writes `qemu-source.txt` (HEAD plus a diff hash,
  from `scripts/qemu-source-id.sh`), and every wasm deploy writes the same
  stamp into its dist. `lockstep-wasm.mjs` refuses a mismatch.
  `--a-bin <binary>` picks another reference (the stamp next to it is
  checked), and `--no-ref-check` skips the check for deliberate
  cross-version runs such as a bisect over dists. A freerun dist carries a
  different stamp.
- **Rebuild the reference after upstream merges.** Most of them change guest
  timing (for example the ARM9E fall-through stalls in `c97e554e5d`).
- **Run lengths for perf commits:** S75 2.5e9 and EL71 1.5e9.
- **Keep the default `--meminsns`.** `--meminsns 65536` diverges even for a
  correct dist (TB-boundary sampling).
- **`LS_CONSOLE=1`** saves the page console to `console.log` in the run dir,
  for in-situ checkers.
- **SL65 native lockstep is nondeterministic** even binary against itself: it
  diverges at ~78–86M insns, which is pre-existing. Validate SL65-only paths
  with checkers and unit tests.
- **Fork vs upstream DSP translator diverges in timing only.** Upstream's
  codegen hits compile_error −2 ("TB too big", for example at 0xDDDE) and
  retries at half size, so its block boundaries and ARM sync points differ.
  The DSP state matches at every common slice point (2026-11-03).
- **A5 is load-bearing.** Without it, the `LS_QARGS` run diverges (see
  2026-11-04 deviation cleanup).

### DSP unit tests

```bash
ninja -C build/qemu-native-build test-pmb887x-dsp-tcg && build/qemu-native-build/test-pmb887x-dsp-tcg
```

- **Source:** `hw/arm/pmb887x/dsp/tests/tcg.c`.
- **Fast-loop coverage:** `relocated-fast-loop` covers 643F at a relocated
  site, and `35be-iterations` covers 35BE in ring, bkrep and sata modes. The
  other kernels (6489, 64A9) have no unit test.
- **Gaps:** the tests do not check flags after mov/ALB (mutants pass them).
  A mutant that skips the successor match in the chain cache passes both the
  unit tests and lockstep (2026-11-02). Mutation-check every new test.
- **Removed debug switches, as a recipe:** the 2026-10-30 cleanup
  (`90f3562467`) removed `TEAK_TCG_FAST`, `TEAK_TCG_MAX_BLOCK` and
  `TEAK_TCG_CHECK_LEVEL_FREE`. When you change a kernel, restore
  `tcg_fast_check` and `tcg_verify_level_free` from
  `git -C qemu show fefdb61f9d:hw/arm/pmb887x/dsp/tcg.c`, and pass the
  switches with the page's `?env=NAME=VALUE`:
  - `TEAK_TCG_FAST=2 TEAK_TCG_MAX_BLOCK=1` re-runs every fast run through the
    translator and aborts on a mismatch.
  - `TEAK_TCG_FAST=0` turns the fast loops off.
  - `TEAK_TCG_CHECK_LEVEL_FREE=1` re-decodes every level-free hit.

  The replay is too slow to reach SL65 MIDI playback. `a2fc4f3414` used a
  per-call differential instead: iterate vs `tcg_fast_run` and memcmp the
  state and data.

### In-situ checkers

Use one for every path that lockstep cannot see: vt-only paths, the DSP,
framebuffer data and SL65.

1. A temporary patch predicts the fast path's result (or runs the slow path
   on a copy), lets the real code run, and compares everything observable:
   registers, flags, memory, cycle and instruction accounting, timers and
   clock. It prints `TAG ok N` or `TAG MISMATCH ...` and aborts on a
   mismatch.
2. A mutant build (value ^ 1, a skipped store, a wrong step) must abort.
   Otherwise the checker checks nothing.
3. Run it over the scenes that exercise the path (`SCENEBENCH_CONSOLE=TAG`)
   and under lockstep (`LS_CONSOLE=1`).

Checkers built this way are described in the commit messages:

- dif_v2 fed batch: 12.7M wakes.
- Lazy wakes: a store snapshot plus a trap-all variant, 575k traps.
- Superblock shadow cycle checker (`W64_CYCCHK`).
- TLB watch window: a full-walk verify after every targeted reset.
- hflags in place.
- 35BE kernel.
- Block-repeat iterations.
- Inline mov, ALB and shifts.
- Baseband ranges.
- Thumb fill loop: 24.4M checks. Lockstep is blind to it, because a value
  mutant passes.
- Thumb fill rectangles (2026-11-05), two predictors that restore the state
  and compare at the next helper call:
  - one row transition at a time: 36.15M matched over 60 s of towerblox;
  - the fused loop, 1–4 whole rows with a log of every store: 10.93M
    predictions covering 26.25M rows matched, and again 10.93M over 26.26M
    rows on the committed source (one mismatch).
  The 4 + 3 + 1 mismatches all came with an interrupt handler's 22k–58k
  instructions in between, and the main loop had re-armed the cycle budget.
  The budget margins at prediction were 339–12,211 cycles against a
  ~40-cycle transition. Mutants of the fused loop, 30 s each: storing
  `v ^ 1` at the next row's first element failed all 5.93M predictions on
  memory alone, and one cycle too many at the write-back failed all 5.92M
  on the cycle count alone.
- Literal folding.

None of them is in the repo; rebuild one from its description before relying
on it.

**Count the fast path, or it may never have run.**

- The first version of `a85157e75b` never ran (an IMSC precondition), and
  lockstep was trivially clean.
- The first DMAC translation cache "won" while mostly missing.
- On SL65 the 35BE whole-iteration path refused 1 in 3 iterations
  (`a2fc4f3414`).

Count hits and refusal reasons with a temporary counter before pricing the
path (lessons.md § "Count the fast path, or it may never have run").

## Where the time goes

Every share below is as of its date, and later work moved some of them.

| Scene (date) | Profile |
|---|---|
| Stopwatch, free-run + bounds checks (2026-11-02) | TB code 62 %, DSP kernels ~10 %, SVC/eret/mode-switch path ~2.5 % (upstream target/arm), BQL futex waits ~1.2 %, `lcd_handle_cd` lock 0.3 %, JS clock reads ~2.4 % (a free-run artifact: the raw-clock cache applies only when behind real time) |
| Stopwatch, V8 `--prof` (2026-11-01) | TB TurboFan 46 %, main module 26 %, TB Liftoff 6.4 % + `WasmLiftoffFrameSetup` 2.4 %, libc 16 % (`ATOMICS_WAIT`, i.e. idle) |
| Towerblox (2026-11-02) | ARM TBs 47 %, DSP TBs 19 %, rest 33 %. The fill loop at a0a04cc6 was ~35 % of guest insns in ~6.5 % of the time before `3116fa62be`. Liftoff-tier TB code ~9 % + frame setup 1.5 % |
| Towerblox, V8 `--prof`, free-run + bounds checks (2026-11-04, `92f6a90e56`) | TB TurboFan 59 %, main module 31–33 %, TB Liftoff 4–5 % + `WasmLiftoffFrameSetup` 1.5 %. TB code by owner: ARM 40 %, DSP 23 %. Top C: `tcg_fast_run_35be` 4.2–4.7, `dsp_bus_advance` 3.1 (callers: data reads 1.1, the `dsp_sync` timer 1.0, data writes 0.8, `dsp_runtime_advance_cycles` 0.6), chain helper 2.1–2.3, `helper_w64_fill` 1.9–2.1, `dsp_sync` 1.5–1.7, kernels 643f/64a9/6489 ~1.2/1.1/0.7. Nothing else above 0.8 %; from entry 26 down, each is ≤ 0.3 %. The hottest ARM TB (2 %) is the fill loop's own superblock |
| Towerblox fill, V8 `--prof`, free-run + bounds checks, named TBs (2026-11-05, `a357f7ab05`) | Before rectangles: loop TB a0a04cc6 1.45 %, head TB a0a04cc2 0.44 %, `helper_w64_fill` 1.68 %, 3.57 % in all. Row-at-a-time rectangles: loop TB 0.26 %, `w64_fill_row` 1.75 % + helper 1.67 %, no gain. Fused rectangles: loop TB 0.20 %, helper 1.75 % (every store included), ~2.0 % in all |
| Bobby (2026-10-31) | Worker busy time: DSP 61 %, ARM 19 %, display 13 % |
| Video (2026-11-01/02) | Busy 11.8 s of 20 s = ARM JIT 5.0 s, DSP 4.4 s, ARM-side C 2.1 s. GSM search kernels (35be+643f+6489+64a9) ~30 % of free-run ticks (midi 12 %, bobby 9 %) |
| MIDI (2026-10-30/11-01) | DSP ~62 % of the vCPU, ~48M DSP cycles/s. Hot blocks: f4ec 27 % of chained cycles, e20d 16 %, f4b8 10 %. DSP-bound: only faster DSP execution helps |
| Music AAC (2026-10-30) | 10 s of vCPU: DSP 4.7 s (JIT code 2.4, chain helper 0.6, 35BE kernel 0.44, bus/sync 0.35), ARM 1.4 s, idle 3 s |
| S75 boot, vt + bank (2026-10-29) | Busy ~15 s = ARM 8.4 s (interpreter tier 2.0, TB code 4.7, helpers 0.75), DSP 3.3 s, translation 1.7 s, loop overhead 0.9 s |
| EL71 boot window, guest 7–13.5 s (2026-11-02) | ARM translation 23 %, TB Liftoff 17 %, lazy compile 14 %, TurboFan 11 %; 30k of 73k TBs run once |
| EL71 boot burst, guest 6–12 s, V8 `--prof` (2026-11-05, `172f58552d`) | TB Liftoff 22.5 % of ticks (4.1 % under `--wasm-tiering-budget=300000`), main-module Liftoff ~1 %. The inline pcc probe of every goto_ptr exit: emitting it costs ~8–10 % of the burst (translation and Liftoff compile), its hits save ~3.6 % (Closed ideas, ARM translator). Since `434be28741` it is emitted only at promoted exits, and since `36e3b3cc4c` not at all: TBs call their batch module's probe function |
| EL71 boot, `434be28741`, Chrome trace and V8 `--prof` (2026-11-05) | ~900 batch modules and ~43k lazy compiles per boot. A lazy compile takes 43 µs on the vCPU thread: Liftoff ~19 ns per wasm byte plus ~13 µs fixed, of which ~11 µs is publishing (AddCompiledCode, PublishCode, two icache flushes); the mean TB body is 1.5 KB. Module decode, validation and instantiation are ~0.5 ms per module. TurboFan takes 1.6 ms per TB on the background threads, 45 % of it register allocation. Busy window, guest ~7–16 s: main-module wasm 35 %, TB Liftoff 19.6 %, TB TurboFan 17 %, Chrome C++ (the Liftoff compiler) 15 %, builtins 5 % (`WasmLiftoffFrameSetup` 3.3 %, which runs on every Liftoff entry while wasm inlining is on; `CallIndirectIC` 1.1 %, on every Liftoff `call_indirect` including the chains' tail calls). Top C: `tcg_gen_code` 6.3 % self (the register allocator and the inlined wasm64 emitters), `liveness_pass_1` 3.1 %, `helper_lookup_tb_ptr_lc` 1.2 % |
| TB bytes by TCG op, EL71 boot census (2026-11-05) | `qemu_ld`/`qemu_st` ~44 % of the body bytes at ~100 bytes each, ~42 of them the slow arm (helper call and the `$tmask`/`$ttab` reload, which a helper's TLB resize forces). Moving the arm out of line would save ~1.5 % of the burst at most; the reload has to stay in the TB |
| EL71 idle (2026-10-29) | ~18.5 % of a core; DSP 1.09 s per 10 s |

**Rates.** A per-event cost must pay for itself at these rates (free-run
unless noted).

| Event | Rate |
|---|---|
| ARM TB entries | 16.5–19M/s; ~50 % indirect (goto_ptr): per-TB slot hit 83 %, inline hash 17 % |
| ARM ns per guest insn | stopwatch ~1.7, towerblox ~3.5 (its fill loop ~0.75) |
| Thumb fill helper (towerblox, 2026-11-04) | all 16-bit stores; ~16 passes per call on average, and 3 of 4 calls run fewer than 16 passes, so the per-call cost dominates (23M calls, 373M passes over a 30 s real-time window plus boot) |
| Thumb fill rows (towerblox, 2026-11-05, 60 s real time plus boot) | 36.8M rows finish inside the helper. 98.1 % go straight into the next row; 1.5 % end the rectangle, 0.4 % meet the cycle budget, and ~50 were in TBs still interpreted. A row costs two TB entries (a0a04cc2 head, the b absorbed; a0a04cc6 loop and tail). Done as a C transition per row, it cost ~23 ns, as much as the TB code it replaced |
| SVC / eret / mode MSR / IRQ (stopwatch) | ~240k / ~245k / ~250k / ~1.9k per s |
| ARM MMIO accesses | ~50k/s, no polling; `mmu_lookup1` ~18k/s in steady state |
| New ARM TBs in steady state | stopwatch ≈ 0; towerblox ~135–300/s (JIT-compiled Java at fresh addresses, no invalidation churn) |
| DSP (bobby) | 59M cycles/s, 5.4M blocks/s, 2.86M chain links/s, 109k C-dispatcher entries/s |
| DSP chain calls | towerblox ~1.7M/s, stopwatch ~191k/s; ~20.6 cycles per block |
| DSP program bank switches (S75) | ~34k/s |
| DSP config changes (sat, modi, ...) | ~40k/s |
| `dsp_sync` / `dsp_bus_advance` | ~15k/s / 145k/s (video) to ~600k/s (towerblox) |
| Chain helper | ~22 ns per link (2026-10-31, before `3488724de2`); ~150 x64 instructions on the hit path |
| Cross-instance wasm call | ~2.7 ns microbenchmark, 5–7 ns in situ |
| DSP kernels (2026-11-02, free-run) | 35be 2.6 ns/cycle, 643f 3.7, 6489 3.6, 64a9 3.4; calls run 600–2000 cycles. JIT ~5.3 ns/cycle (2026-11-01) |
| `tlb_reset_dirty` full walk | ~100 µs |

**Facts that bound the levers:**

- **ARM TB time is flat.** On stopwatch, 4136 TB functions have ticks; the
  top one (the blit) is 3.7 % and the top 40 are 24 %. On towerblox the top
  TB is 1.2–1.8 % and the top 40 are ~11 %. Only generic codegen changes move
  it.
- **The TB code itself is lean.** Before every `qemu_ld/st`, flags
  (env+536..548) and registers are synced to env (TCG semantics), and the TLB
  fast path is inline. Nothing cheap is left in the hot TBs.
- **The DSP JIT cost is real semantics.** Teak state lives in env, and
  modulo and flags are computed per instruction: ~22 TCG ops per Teak insn,
  mostly flags and saturation. The opcode mix is flat. Cutting this means
  keeping Teak state in TCG globals, a large upstream-divergent rewrite.
- **DSP blocks are short.** About 12–20 cycles each, so per-block costs
  (chain helper, prologue) matter. Block shapes cannot change, because block
  ends are interrupt points. 93 % of chain calls link through the successor
  cache (towerblox census, 2026-11-02).
- **A C helper beats chained TurboFan TBs only by removing per-event work.**
  The fill's row transition in C (four TLB probes, counter calls into other
  files, a register write-back per row) cost as much as the two TB entries
  and 15 instructions it replaced. It paid only once the rows ran in one
  loop with the state in locals, one probe per page and one write-back.
- **A TranslationBlock has room to grow up to 256 bytes.** `tcg_tb_alloc`
  aligns each TB to `qemu_icache_linesize`, which is the 64-byte fallback on
  emscripten (its libc has no cache-line `sysconf`), so the 232-byte wasm64
  TB takes 256 bytes. A 16-byte field before `jmp_list_head` (2026-11-05)
  measured +0.1 % on bobby and +0.4 % on stopwatch (4 pairs in each order,
  noise).
- **C kernels are not faster per cycle than the JIT** unless they run whole
  iterations. The kernels' remaining cost is semantics: ~480 wasm ops per
  9-instruction 643f iteration, with the state already in locals.
- **The Liftoff tail is V8's.** ~800 rarely-run TB functions stay in Liftoff
  (9–11 % of busy time including frame setup). Tier-up budget is charged by
  machine-code size, and a page cannot change it.
- **Bounds checks:** V8 drops a check only for a constant index within the
  minimum memory size (memory is 32768 pages, min = max). env is already
  addressed as constants when the TB's env is fixed (`w64_tb_env`,
  `w64_abs_base`). What stays dynamic is inherent: frame slots, TLB entries
  and guest RAM.

## Closed ideas (grep here before trying)

"Neutral" means within the A/B noise of its time. Patches in
`build/experiments/` are local and untracked.

### DSP execution (`hw/arm/pmb887x/dsp/tcg.c`)

| Idea | Result | Date |
|---|---|---|
| Teak env fields in wasm i64 locals per DSP TB ("Option A") | Loss in every variant (Bobby 0.78–0.795 → 0.804–0.923 cores). TurboFan already forwards env inside a TB, and DSP TBs are short, so fills and flushes are overhead. A microbenchmark gain (5.5 vs 2.3 ns/insn) did not transfer | 2026-10-31 |
| Branch hints on DSP data-access and early-exit labels | No change | 2026-10-31 |
| Renaming label-crossing pooled temps; splitting pooled TEMP_TB temps into per-definition webs | Neutral (f4ec syncs 80 → 30, midi 0.513 vs 0.510). `tcg_remove_dead_state_stores` and `tcg_demote_label_dead_temps` already cover it | 2026-10-31, 11-01 |
| TCG store-to-load forwarding; a combined exit/interrupt request check | Neutral | 2026-10-31 |
| Cached `dynamic_cycles` flag in the block cache entry, alone | Neutral. The 2026-11-02 version with successor heads and epochs is `3488724de2` | 2026-10-31 |
| Inline high-region data reads; inline Y-RAM read for all spaces | Neutral. The helper's direct path is already cheap; the helper fell 0.75 → 0.3 % but the TB code grew | 2026-10-31, 11-02 |
| Inline `ALB_REGISTER`, alone | Neutral. Together with inline mov writes to accumulator halves (`6a18783ada`) it gained +3–3.8 % on Bobby | 2026-10-31 |
| Inline DSP chain linking (per-TB successor memo) | +1.8 % worse, then neutral at 38 % fast-path hits: the inline checks on misses and the bigger TBs eat the saving. Upstream later added its own inline links; disabling them on wasm was neutral | 2026-10-31, 11-04 |
| Runtime branch for "modulo disabled → plain add" | Neutral. An unconditional plain add breaks the guest (modulo is used) | 2026-11-01 |
| Merging blocks across the library call loop (ED2A / F6BC) | Not done: blocks are assumed address-linear (`tcg_block_overlaps`, invalidation by pc range) | 2026-11-01 |
| Direct DSP block linking for static targets | Parked; ceiling ~3 % | 2026-11-02 |
| Block cache entry with the lookup fields first; chain lookup walk length | No change (walks are 1.02–1.05 entries; the helper's share is not cache misses) | 2026-11-02 |
| Cache-entry pool + out-of-line block for the chain helper's misses | Helper 6.18 → 5.83 %, A/B no win. `build/experiments/dsp-cache-entry-pool.diff` | 2026-11-03 |
| A branch-free one-label page access with a sink, instead of upstream's two-label page branch | midi −2.1 %, towerblox −3.2 %: upstream's 2-label page branch is faster on wasm | 2026-11-04 |
| `tgen_extract` ofs 0 / len 32 without the redundant `i64.and` | Neutral: DSP TBs run in TurboFan, which folds it | 2026-11-02 |
| Forwarding env reloads after a store to the same field (~8 % of DSP env loads) | ≤ 0.5 %, not pursued | 2026-11-02 |
| More register helpers inline (towerblox: ~500k calls/s over codes 8/10/14/15/24/31) | ≤ 0.5 %, left | 2026-11-02 |
| Removing the fast loops (35BE/643F/6489/64A9) | They pay: midi 0.566 vs 0.632 cores, AAC 0.610 vs 0.682 | 2026-10-30 |
| Removing 643F/6489/64A9 again (35BE kept), re-priced after the JIT got mode specialisation and dead flag stores | They still pay: midi −5.4 % (sd 0.18), video −7.7 %; towerblox neutral (+0.3 % over 12 pairs) | 2026-11-05 |
| 35BE kernel rewrite for ~2 % | Rejected by the owner (divergence for a small gain) | 2026-10-31 |
| 35BE MAC chain in registers | Saved 9 of 171–180 ns per iteration; reverted. `8fe212e31d` later did it on locals, with a volatile function pointer against Binaryen inlining (video kernel share 24.4 → 18.9 %) | 2026-10-31 |
| Plain (non-sata) 35BE mode | 643f −1 %, 64a9 worse | 2026-11-01 |
| Per-iteration exit check; inlining `walk_reads` | Neutral | 2026-11-01 |
| 35BE direct span reads instead of x/r4 copies | Share unchanged, or 4.94 → 4.54 % of stopwatch, which is below what can be verified | 2026-11-02 |
| Generic "plain" block-repeat iterations with one exit check per iteration | Mixed (643f −10 %, 6489 −7 %, 64a9 +4 %) | 2026-11-02 |
| `teak_update_modulo_steps` (upstream) | 0.6 % on midi, left | 2026-11-01 |
| Envelope state-machine kernel (midi F6BC / bobby ED2A loop) | Too big (~10 new instruction types) | 2026-11-01 |
| EE49 C kernel (S75 MAC loop: 27 % of chained cycles, 3.1 % of the vCPU) | Parked, ~1.5 % on Bobby, S75 only | 2026-11-02 |
| Biquad routine 0xDDDE (~11 % of towerblox chains) | ~1 % reachable, parked | 2026-11-02 |
| Lazy DSP flags. Upper bound: `fz fm fn fv fe fc0` dead at every block exit and at the chain helper (inexact, `tcg_remove_dead_flag_stores`) | towerblox −0.6 % ± 0.65 (4 pairs × 30 s). midi −38 %: the DSP reads those flags across blocks, so the inexact build changed its work, and it bounds nothing there. DSP TB code is ~23 % of towerblox, so even cutting a fifth of it is ~4–5 %, before materializing the flags read across blocks | 2026-11-05 |

### DSP scheduling and threading

| Idea | Result | Date |
|---|---|---|
| DSP thread, lag model (the MCU reads a snapshot of the previous 100 µs tick) | Breaks the S75 boot handshake: `>>EXIT<< ExitCode 0x000E FILE: ddsphw`. The firmware writes DSP_CLC, then reads COM_STATUS and RAM[0], and expects 0x0801 | 2026-10-31 |
| DSP thread, exact (each MCU read is a synchronous job on the DSP worker) | Deterministic and ~6 % faster natively. On the web there was no gain on a fast host, it used more CPU, and it failed the spinner model. At 20 % duty: video +17 %, midi flat (DSP-bound). Branch `exp/dspthr2`: +4–17 % vratio for +40–70 % CPU, and ~12x slower on one core. Ceiling ~15 %: the MCU does ~12k DSP reads per virtual second, each a cross-thread round trip. The owner said no. `build/experiments/dsp-thread-sync-reads.patch` (applies to `11699de202`/`62b16312dd`), qemu branches `exp/dspthr` and `exp/dspthr2`. It also exposed wasm64 bugs that matter only when a second thread translates: `IR` must be `__thread`, `w64_acct_flags` must be per thread, and TBs translated without a vCPU must not account guest insns | 2026-10-31 – 11-02 |
| Batching small `dsp_bus_advance` calls (inexact upper-bound build) | video +1.8 %, midi +0.5 %: noise | 2026-11-02 |
| DSP bus deferral (`DSP_BUS_DEFER_ADVANCE`: advance the peripherals lazily inside a no-event horizon) | Exact (checker, lockstep clean) but neutral | 2026-11-02 |
| Queued DSP syncs (`dsp_schedule_sync` → `async_run_on_cpu`, each a `cpu_exec` exit and re-entry). Census, real time: towerblox ~4.9k/s, all queued from the vCPU thread (~1.5k/s refused by the in-loop budget renewal, the rest from device accesses mid-TB); bobby ~2.2k/s. Inexact bound: `dsp_sync()` in place when on the vCPU thread | towerblox −1.2 / +0.9 % (4 pairs in each order): the exits are cheap, not a lever | 2026-11-05 |
| The batching bound again, on towerblox (~600k calls/s, 4x video): advances batched to 512 cycles, flushed at every slice end (inexact) | +3.1 % (+4.1 / +2.1 %, 4 pairs in each order). The deferral above was never measured on towerblox; see Remaining levers | 2026-11-05 |
| I2S rate memo, I2S rate cache, skipping the i2s divide | Neutral every time (≤ 0.23 %); re-tried twice by mistake | 2026-10-31, 11-02 |
| `dsp_bus_advance` i2s 64-bit div/mod (~70 ns per call on Bobby) | ~0.3 % reachable, in an upstream file, left | 2026-11-01 |

### ARM translator and wasm64 backend

| Idea | Result | Date |
|---|---|---|
| Removing the wasm64 superblock code under vt (`3bd45ab9d0`) | Reverted by `2ff4e374c3`: superblocks with exact CF_COUNT_CYCLES accounting took stopwatch vratio 0.58 → 0.87 (parbench, under contention) | 2026-10-30, 11-01 |
| ARM self-loop back-edge via `translator_loop_begin/back`, separate from superblocks | Correct, but loop passes were 4.7 % of video insns; neutral everywhere | 2026-10-31 |
| `W64_INTERP_THRESH` 16 / 256 | Neutral | 2026-10-31 |
| `W64_FT_MAX` 12, absorb limit 512 | No better than `W64_FT_MAX` 6 (`3132d80df8`) | 2026-11-01 |
| `W64_INL_DEPTH` 8 | Neutral / −1 % on Bobby | 2026-11-01 |
| TLB memo: one probe per same-page access cluster (F1m) | −0.7 / −4.2 % | 2026-10-31 |
| TLB page cache in locals (reuse a probe for a same-page ld/st) | towerblox −3 to −7 % with bounds checks. `build/experiments/w64-tlb-pagec.diff` | 2026-11-03 |
| `movcond` as `select` (M1) | +1.4 / 0 % | 2026-10-31 |
| Typed chain table (T1) | Not repaired: it no longer decodes against the batch encoder (expected 0.5–0.8 %) | 2026-10-31 |
| Lazy global sync at `qemu_ld/st` (`TCG_TARGET_LDST_SLOW_SYNC`) | The correct version is neutral: V8 env stores are cheap, and exit-time stores remain. The first version leaked register mappings past labels (lockstep diverged at 16M) | 2026-11-01 |
| Dropping the TB-start exit-request check under CF_COUNT_CYCLES | The guest never runs: exits are needed beyond IRQs | 2026-11-01 |
| Removing or moving the per-TB `wasm_guest_insns` RMW | Removing it breaks scenebench's progress detection. The counter costs ≤ ~2 %, and deriving it from cycle_count was neutral. Env-relative accounting won only with bounds checks (`305999f747`) | 2026-11-01 – 11-02 |
| Folding literal-pool loads (`ldr Rt,[pc,#imm]`, 3.2 % of stopwatch insns) to constants | Noise: TB code is not load-latency bound | 2026-11-02 |
| TB code size: a 1 KB cold pad per TB; one shared `return_call_indirect` tail per TB | Only inline *unhinted* cold code costs, and hot TBs already hint their cold paths. The shared tail was neutral | 2026-11-02 |
| Same-batch direct `return_call` for goto_tb chains | +0.2–0.65 %: noise. `return_call_indirect` cost is not a lever | 2026-11-02 |
| Backend known-constant registers (`i32.const` addresses) | Noise: TurboFan folds `wrap(local const)` | 2026-11-02 |
| Constant `w64_tb_tp` for the return-address store before helper calls | Neutral / −1 % | 2026-11-02 |
| Inline ARM chain linking across wasm instances | Too large a change for ~1–2 % (a cross-instance call is ~5–7 ns) | 2026-11-02 |
| TB lookup path | After `5c8cf5bc65`/`1cffcb62a0`: per-TB slot 83 %, inline hash 17 %, helper ~0. Not a lever | 2026-11-02 |
| Code-page gate in `tb_jmp_cache_clear_page` + lean goto_ptr exits (EL71 boot) | Boot window −6 %, but steady towerblox −1.7 % (the inline pcc probe's hits, see the 2026-11-05 rows). `cross-page-links=on` was chosen instead | 2026-11-02 – 03 |
| `W64_INTERP_THRESH` 32 / 256 at the EL71 boot | Neutral: +2.8 / +1.9 % burst, measured before the bootab.sh gzip fix that removed a ~2 % penalty on B | 2026-11-05 |
| No inline pcc probe (EL71 boot, `bootab.sh`, page default `cross-page-links=on`) | Burst −4.3 % (se 0.6) / −7.0 % (se 2.5), audioMs −5 / −10 %, lagMax −8 / −11 %. Emitted but skipped at run time: +3.6 % (se 0.4). Emitting it costs ~8–10 % of the burst, and its hits save ~3.6 %. Steady state loses towerblox (row above) | 2026-11-05 |
| The pc cache probed from the lookup helpers instead of inline (`w64_pcc_get` of `3de1546af5^` restored) | Boot burst −6.6 % (se 0.7) / −11.0 % (se 3.7), audioMs −9.9 / −20.5 %, lagMax −12 / −20 %. Steady towerblox −0.9 % (se 0.7) / −2.7 % (se 0.5), A/A +1.9 % (se 1.9), as with no pcc at all: behind a helper call, a hit on towerblox's dispatch exits saves nothing over the jump cache. The slimmer inline probe (own hash, no `cpu_index` compare) landed instead | 2026-11-05 |
| Upstream goto_ptr exits at the EL71 boot (no slot, no probe: the ceiling of any out-of-line exit), against `d4380167b9` | Burst −2.1 % (se 1.2) / −2.4 % (se 1.0), but audioMs +6.2 / +5.0 %: the slot's hits matter where the sound plays | 2026-11-05 |
| The probe in the helpers only, on every scene (free-run, 4 pairs each, against `d4380167b9`) | Video −5.0 % (se 0.6) / −3.0 % (se 2.2), towerblox +0.3 / −3.3 %, midi −2.0 / +0.8 %, stopwatch +1.9 %, bobby +0.7 %. Exits promoted to the inline probe by their hits landed instead (History) | 2026-11-05 |
| Promotion at 256 or 4096 pc-cache hits in C per TB | Boot burst +2.4 % (se 2.2) / −1.0 % (se 0.5), audioMs +8.9 / +4.2 %: a promotion costs ~3 ms at the boot (retranslation, interpreter tier, a new batch module, a generation bump). 65535 landed | 2026-11-05 |
| Promotion at 1024 hits (free-run, 4 pairs, against `434be28741`) | Video −2.1 %, towerblox −4.2 % (se 0.8): the retranslations themselves cost the steady state. Promotion was replaced by the module's probe function | 2026-11-05 |
| Promotion counting only the slot's exit | Video −2.3 / −2.2 %, towerblox −0.2 %: a TB's second goto_ptr exit (keyed differently from the slot) went through `helper_lookup_tb_ptr`, whose ~280k pc-cache hits/s on video never counted | 2026-11-05 |
| Selective batch landing (interpret ≥ 16 times before a module) | +2 % slower | 2026-11-02 |
| hflags kept in place on AArch32 mode changes (`8203411abf`) | Committed on 2026-11-01, returned to upstream in `b12dea95f2` (neutral) | 2026-11-02 |

### V8 and toolchain

| Idea | Result | Date |
|---|---|---|
| `--no-liftoff` (−10 % ns/insn on video) | A page cannot set V8 flags | 2026-10-31 |
| Wasm compilation hints | Behind a flag in Chrome 153–155, no origin trial. Even with the flag there was no TurboFan | 2026-11-01 – 02 |
| Forcing Liftoff tier-up by padding TBs | Tier-up budget is charged by machine-code offset at returns and tail calls, so it would take tens of KB per TB. Ceiling: `--wasm-tiering-budget=1300000` gives +3.7 % on towerblox. Closed for good | 2026-11-02 |
| `--wasm-tiering-budget=300000` at the EL71 boot (ceiling) | Burst −8.2 %, stretchedMs −25 %, gaps unchanged; TB Liftoff ticks 22.5 → 4.1 %. All of it is TB tier-up: main-module Liftoff is ~1 %. V8's default budget is 13M. A page cannot set it | 2026-11-05 |
| Tier-up spin: a loop in TB code that charges the tiering budget | A back-edge charges ~0.93 × the function's Liftoff size (~2.5 × its wasm body bytes) per iteration, under 1 ns each. A per-TB countdown with overshoot matched the flag's tier-ups, but the loop wrapper alone cost +3–9 %: net burst +0.5 % (se 0.9), gaps worse. A full charge on every TB floods TurboFan: +19.6 %. Closed | 2026-11-05 |
| Masking indexes so V8 drops bounds checks | Impossible: V8 drops them only for constant indexes, and the memory size is a hoisted load | 2026-11-03 |
| wasm SIMD build; extra Binaryen passes | Neutral | 2026-11-01 |
| Binaryen one-caller inline limit (N=200, or 1000 globally) | 200 is worse (splits `dsp_i2s_advance` out); 1000 is noise | 2026-11-02 |
| ThinLTO main module | Noise. The wasm grew 12.3 → 16.2 MB, and ~30 Asyncify onlylist names went missing | 2026-11-03 |
| wasm SjLj instead of the JS invoke trampoline around `cpu_exec` | `invoke_ijj` is ~1 % of midi and 0.2 % of video: not worth the Asyncify risk | 2026-11-01 |
| Main-module code cache. Since the prefetch (`67e2d0e`, 2026-09-20) `startEngine()` compiled a `new Response(tee)`, which has no URL, so Chrome never cached the code, despite `deploy/nginx`'s `no-cache` + ETag set up for it. Fixed: compile the fetched response, count bytes on a clone | Landed. The profile's wasm code cache now holds ~7.8 MB after one boot (72 bytes before). Free-run S75 boot, warm vs cold: +17 % guest insns in the first 3 s, ~+20M insns by 20 s; the committed page was cold on every load. Bigger where tier-up is slow (the phone) | 2026-11-05 |
| Fewer declared TB locals (the baseline tier zeroes them at every entry), re-priced now that Liftoff TB code is ~6.6 % of towerblox | A pad of 16 extra i64 locals per TB: +1.0 / +0.1 % (4 pairs in each order), noise. Not a lever | 2026-11-05 |

### Devices, display, timers, clock

| Idea | Result | Date |
|---|---|---|
| Soft icount timers (`QEMU_TIMER_ATTR_SOFT`, `4d7343564d`) | Helped icount only; reverted with the move to vt (the budget is checked at TB start) | 2026-10-29 |
| Display lazy batching with framebuffer dirty tracking | Judged not exact on 2026-10-31. Done differently in `0c3c3c8c9b`: lazy wakes, catching up on DIF/DMAC access and on stores to source pages through `tlb_set_ram_write_guard` | 2026-10-31, 11-01 |
| Batching dif_v1 words | Not exact: the guest runs ≥ 64 cycles (`CPU_CLOCK_BUDGET_MIN`) between words | 2026-10-31 |
| timer2 O(1) closed form; DMAC+ALB+timer2 combination | Neutral | 2026-10-31 |
| Lazy DIF mux rebuild | Neutral on Bobby; later committed for stopwatch (`6c8f08898c`) | 2026-10-31 |
| Widening the `cpu_clock_owner_raw` cache | 89 % hits, video neutral: the profiler overstates JS clock reads | 2026-10-31 |
| Skipping `cpu_clock_owner_shorten_budget` while the budget renewal (now `tcg_vcpu_timers_next_budget`) runs timers; 64-bit `muldiv64` fast path in the budget | Safe, but no gain / ~0.2 % | 2026-10-31 |
| Stepped indices in `baseband_publish_words` (stopwatch, Bobby) | ~0.1 % there. The video case (3.2 %) was committed as `ce4d3f684a` | 2026-11-01 |
| LCD writer-thread wake thresholds 16K/32K, a 4 ms poll | No better than the 1 ms poll of `43c24bb03d` | 2026-11-01 |
| Inline LCD drain at the CD edge (0.40 %) | Needs the LCD commands on the writer thread | 2026-11-01 |
| DIF bus bytes (~7 MB/s on stopwatch, ~3 ns per byte) | Left alone | 2026-11-01 |
| BQL waits in `cpu_exec_loop` (~1 %), QOM casts (~0.1 %), slow-path ld/st (~1 %, the direct MMIO path) | Real work, not levers. 2026-11-05: part of the BQL hold was the hidden text console below | 2026-11-01 |
| Hidden text console. Without `-parallel none`, qemu backs the default parallel port with a `vc` (`parallel0: filename=vc`), and its cursor timer redraws all 80x24 glyphs every 250 ms on the main loop under the BQL (`cursor_timer_cb` 0.50 % of ticks, ~1.2 ms per redraw on the dev host; the vCPU's BQL futex waits were 0.85 %) | Landed as a page argument. Dev host +0.2 % over 8 pairs (noise); the hold grows with a slow main-loop core | 2026-11-05 |
| Syscall proxying to the main thread | A few `fd_pwrite`s per minute, no vCPU stalls | 2026-11-02 |
| `-accel tcg,thread=multi` without vcpu-timers | Unusable with the DSP LLE | 2026-11-02 |

### Removing fork code (2026-11-02 bundles)

| Removal | Result |
|---|---|
| dif_v2 shift mux / closed-form plan / clock cache, baseband ranges | Cost stopwatch 3–7 %: kept |
| tpu.c word path, dsp/tcg.c shift-by-value and dead state stores | Cost bobby/towerblox ~2 %: kept |
| `gen_set_psr` back to upstream `gen_lookup_tb_after_cpsr_write` (an inline interrupt check per TB-ending CPSR write, ~250k/s) | Loss: kept |
| ssi / s1d13716 checked casts (per-byte S75 LCD path), `fifo.h` `%` | Kept as port code. Returning the casts alone in the 2026-11-04 cleanup showed in profiles (midi `object_dynamic_cast_assert` 0.33 → 0.41 %), so they stay |
| Bundle X (`3de1546af5`), bundle Y (`b12dea95f2`: hflags in place, WFI longjmp, EXITTB fast path, lean BQL pair), icount clock window + mod.c (`092f67eff7`), timer notify + RTC guard (`e227c7e9a3`) | Neutral: removed |

## Known open issues and remaining levers

**Issues:**

- **EL71 display freeze:** the display freezes (framebuffer stops, guest
  idle) after leaving a running stopwatch with the red key. It also happens
  under icount. It is upstream's issue; wait for upstream.
- **S75 OFFLINE/PTEST startup:** the board includes in both bsp `e90ceb3` and
  `a5a992e` define only `[startup.ONLINE]` (x75, elka, r65, sirius). The
  lookup in `hw/arm/pmb887x/board/startup.c` is required, so qemu exits at
  t=0 and the page looks hung. Not fixed.
- **SL65 native lockstep is nondeterministic** (see Lockstep).
- **The wasm io_recompile rewind divergence** that A5 hides (see 2026-11-04
  deviation cleanup). Not fixed.
- **Unaligned-atomic crash, seen once** (2026-11-03, towerblox boot under
  heavy load): `RuntimeError: operation does not support unaligned accesses`.
  The TB backend emits only `atomic.fence`, so the misaligned atomic is in
  the main module. It was not reproduced in 46 more boots. If it recurs,
  capture the stack (log `pageerror` stacks over many boots) before changing
  anything. The translation state is `__thread`, but the global landed
  registry in `wasm64.c` assumes one TCG thread.
- **Zombie processes in the container:** PID 1 is `sleep`, so killed Chrome
  processes stay zombies (~16.5k after 5 days, ~31k after 8; `pids.max`
  134918). They are harmless until near the limit. In `ps` they show
  lifetime %CPU, not load. `python3 tools/perf/reap.py <cmd>` runs a
  benchmark or the gate as a child subreaper, so its orphans are reaped.
- **Shell traps:** never `pkill -f` a pattern that appears in your own
  command line; it kills the shell (exit 144). In zsh, `grep` may be a wrapper
  function that misses matches in binary serial logs (use `command grep -a`),
  and `$VARS` does not word-split.
- **Stale absolute paths:** `scripts/ninja-wasm64.sh` and
  `tools/asyncify-audit.mjs` still use `/workspace/build/...` and
  `/workspace/site/...` from before the repo moved to
  `/workspace/pmb887x-emu-web`. Use `scripts/ninja-fast.sh`, or fix the paths
  first.
- **MIDI underrun (2026-10-30, not re-checked):** one ~120 ms underrun per
  60 s window on a normal host, unrelated to speed. Cause not found.
- **Pixel numbers** have not been re-measured since 2026-11-01.

**Remaining levers** (not done; prices as of their dates):

- **Teak state in TCG globals.** This is the only way to cut the DSP JIT's
  semantic cost. It is a large, upstream-divergent rewrite.
- **Direct DSP block linking** (≤ 3 %).
- **Kernels:** EE49 (~1.5 % on Bobby, S75 only) and DDDE (~1 % on towerblox).
- **EL71 boot window:** TCG liveness/register-allocation temp loops cost ~3 %.
  ~1.35k TB invalidations per boot each bump a global key, which is cheap:
  ~36 stale-slot lookups per bump (census, 2026-11-05). Every goto_ptr exit
  is emitted with its own slot test, helper call and `goto_ptr` tails. The
  pc-cache probe, ~8–10 % of the burst when every exit had it, is one
  function per batch module since the module-probe commit (History). The
  remaining exit code has a small ceiling: with none at all (upstream
  `lookup_and_goto_ptr`), the burst was only −2.1 / −2.4 % faster than
  `d4380167b9` (se 1.2 / 1.0), and audioMs got worse, +6.2 / +5.0 %. The
  same trick, a function the module defines instead of an import, suits any
  per-TB code that TurboFan should inline but Liftoff should not have to
  compile at every site.

From the 2026-11-05 brainstorm (towerblox profile `92f6a90e56`; priced only
where noted):

- **Exact DSP bus deferral on towerblox.** The inexact bound is +3.1 %
  (Closed ideas, DSP scheduling). An exact version needs a no-event horizon
  for every active device, not only AFE and I2S RX
  (`dsp_bus_get_cycles_until_event`), a flush before writes and before reads
  of time-varying registers, and a checker. Expect ~1.5–2 %, in upstream
  files.
- **Tier-up helper worker.** Liftoff TB code plus `WasmLiftoffFrameSetup` and
  `CallIndirectIC` are ~7 % of towerblox ticks; 61 % of the Liftoff ticks are
  in code older than 60 s. A second worker sharing the NativeModule could
  call hot TBs until TurboFan publishes them. Ceiling ~4.5 % (the closed
  tiering-budget row gives +3.7 %). It needs a second 2 GB memory and a new
  worker: the owner's call.
- **Display refresh off the BQL.** `gui_update` holds the BQL on the main
  loop (0.26 % on the dev host). It matters with a slow main-loop core.
- **DSP chain tail.** Every DSP block ends with 55–76 TCG ops of gates and
  link checks; four gates are constant per block. Census first.
- **One check per TLB probe.** A probe does three bounds-checked loads
  (comparator, addend, data). A mirrored `{cmp32, addend32}` word makes it
  two. ~1–1.5 %, ~10 hooks in `cputlb.c`.

## History

Everything through `f45db9a125` is on `wasm-browser-port`; later commits are
on the merge branches. Parent commits are listed where they exist. Numbers
come from the setup of their date (lone scenebench, parbench under
contention, free-run) and do not compare across rows.

| Date | qemu (parent) | What |
|---|---|---|
| 2026-10-29 | `3a2585b297`, `6e821e08b6` (`8cd3981`) | DSP LLE: upstream dsp-lle `393263e08d`. ~1.6x slower per insn from DSP work the old build never did (S75 to 1.3G insns: 9.8 → 17.0 s) |
| 2026-10-29 | `4d7343564d`; `de8311e291`, `05df4d6f98` (`799ddea`, `277d508`) | Soft icount timers + 35BE kernel (17.0 → 14.9 s); then vt as site default by the owner's choice, rtcap removed, `vcpu-timers-bank` |
| 2026-10-30 | `371a3041b0`, `3bd45ab9d0`, `23593204f5`, `ab1b086728` (`3f2e49f`) | EL71 stopwatch vratio 0.58 → 0.975: upstream dsp-lle `7d31a86ca9` (DMA block sinks, LCD GRAM writer thread), in-loop budget renewal, clock reuse, idle lead, level-free Teak blocks |
| 2026-10-30 | `7a1e2d1106`, `4a7b35247c` (`35e3c73`) | Batched DSP loops, inline plain registers, wasm64 tail-call chain: music 0.686 → 0.60 cores |
| 2026-10-30 | `fefdb61f9d`, `90f3562467` (`5365c7f`) | SL65 MIDI: decoded-hit re-cache, relocated fast loops (0.679 → 0.531 cores); debug switches removed |
| 2026-10-31 | `afe23d9974`, `50c3b39c64`, `a85157e75b` (`da6468e`, `687ec12`) | Bobby scene; idle clock read; display TX bursts without the request handshake |
| 2026-10-31 | `4ace13cbc9` … `d5ac642584`, `11699de202`, `8b7c975f81`, `a2fc4f3414` | DSP temps, frame locals, dead state stores, DMAC cache, DIF clock (Bobby −14 %); budget without host reads; dif_v1; 35BE under bkrep. DSP thread rejected |
| 2026-11-01 | `e91e76773d` … `ce4d3f684a` | dif_v2 fed batch (Bobby −11 %), lazy wakes (the stopwatch regression's root cause), superblocks under vt (stopwatch 0.58 → 0.87), TLB watch window, LCD queue, jump-cache hash, kernel series, baseband ranges |
| 2026-11-02 | `3488724de2` … `8f4bc73ab8` (parent through `818935a`) | Chain-helper misses, inline DSP mov/ALB/shifts, towerblox scene, dsp-lle up to `a58f2b61a9` without PPS (`c97e554e5d`), EL71 boot sound, constant env for Android bounds checks (`4dc162bbf6`: towerblox +12.4 %, stopwatch +8 %), first cleanup bundles, Thumb fill loop, wasm-fast-paths.md |
| 2026-11-03 | `d617e13d02`, `f45db9a125` (`de0adbd`, `7807572`) | `cross-page-links=on` default; smh/master `c1db99c3de` with PPS reverted. Towerblox −3 % = upstream's AFE/audio workload change. The EL71 PPS abort depended on the pristine `rr_ff_el71_stock.bin` FFS state and reproduced in pure upstream |
| 2026-11-04 | `6e41e38a16`, `36e4130ef8`, `f8612575ce` | smh/master `326ab1b4d5` + chain caches kept across DSP bank switches: vs `f45db9a125` stopwatch +2.4 %, towerblox +2.1 %, midi +0.7 %, video mips +11 % (free-run) |
| 2026-11-04 | `6cd424cdb5` | smh/master `a05a9df1da`: SIM rewrite (`hw/smartcard`) fixes PPS, revert dropped; needs bsp ≥ `85d4f78` and `-device gsm-sim`. Lockstep references stamped; swab.sh + freerun.diff; deviation cleanup (below) |
| 2026-11-04 | `92f6a90e56` | smh/master `d9cf65ef40`: DSP chain exits with two links (program context and mode checked inline), chain and batch exits only for deliverable interrupts, one running cycle count per slice. Free-run A/B vs `1b51f8e577`, 4 pairs: bobby +4.4 % (4/4), midi +1.4 % (4/4), video mips +0.7 % (4/4), towerblox +3.6 %, stopwatch +1.9 % (3/4 each) |
| 2026-11-05 | `d4380167b9` (`172f58552d`) | Shorter pc-cache probe at goto_ptr exits (own 3-op hash, no `cpu_index` compare on one CPU). EL71 boot (bootab.sh, 2 × 4 pairs): burst −1.5 % (se 0.9) / −4.7 % (se 3.4), median −1.7 %, audioMs −3.3 / −9.8 %. Free-run: towerblox +0.9 %, bobby +1.2 %, video +0.8 % (8 pairs), stopwatch +1.0 %, midi +0.4 % (4 pairs) |
| 2026-11-05 | `434be28741` (`d4380167b9`) | The lookup helpers probe the pc cache; the inline probe is emitted only at goto_ptr exits whose pc-cache hits in C reach 65535 (the TB is retranslated). EL71 boot (bootab.sh, 2 × 4 pairs) vs `d4380167b9`: burst −7.0 % (se 0.9) / −5.4 % (se 0.8), audioMs −10.7 / −9.0 %, lagMax −13.7 / −10.6 %. Free-run, 4 pairs each: video −1.6 / −1.4 %, towerblox −0.7 / −1.3 %, bobby −1.4 %, midi −0.8 %, stopwatch −0.3 %, taken by the owner's one-time exception (rule 5). Census, paced video: ~35k slot misses/s and ~11k second-exit lookups/s answered in C, ~0.4 promotions/s, which at tens of ns each does not explain the ~1 % |
| 2026-11-05 | `36e3b3cc4c` (`434be28741`) | The goto_ptr exits call `w64_pcc_probe`, a function each batch module carries, in place of the helper import: TurboFan inlines it into hot TBs, a cold TB's exit stays a 5-byte call, and a miss calls the helper. Promotion, its counters and `helper_lookup_tb_ptr_cnt` are gone. EL71 boot (bootab.sh, 4 pairs) vs `d4380167b9`: burst −6.5 % (se 0.7), audioMs −10.2 % (se 1.6), lagMax −10.3 % (se 1.4); vs `434be28741`, 3 × 4 pairs: +6.6 % (se 4.1, two outlier pairs) / −0.1 % / −0.7 %. Free-run vs `d4380167b9`, 4 pairs each: video +2.3 / −0.1 %, towerblox −0.4 / +1.0 %, bobby +0.2 %, midi +0.2 %, stopwatch −0.4 %, which recovers the steady state that `434be28741` gave up |

## 2026-11-04 deviation cleanup

The owner asked to return every fork deviation that neither speed nor
correctness needs, and not to lose anything on any scene (rule 5). The base
was merge `6cd424cdb5`, built with `tools/perf/freerun.diff` as `dist-fn1`.
What went back to upstream is listed in
[wasm-fast-paths.md](wasm-fast-paths.md) under "Removed since"; the rest of
the tables is what stayed.

Whole-candidate A/Bs against `dist-fn1`, 4 pairs × 20 s per run, with
negative meaning slower than before the cleanup. An A/A gave +0.3 / +0.1 %.

| Candidate | stopwatch | towerblox | bobby | midi | video (mips) |
|---|---|---|---|---|---|
| all groups removed (each was near neutral alone) | −5.7 | −2.6 | −3.3 | −2.9, −3.5 | −0.3 |
| cand2: the groups the A/Bs and profiles blamed put back | +0.7, −3.4 | −1.7, −0.5 | −4.4, +0.4 | −1.3, 0.0 | −0.4, +0.6 |
| cand3: + D2's shift mux, D4's clock cache, R2's rebuild drop | −1.2, −0.9 | +0.5, +0.6 | +1.5, −0.2 | −0.5, −0.1 | +2.0, +0.5 |
| cand4: + R4 | −0.2 over 20 pairs (see below) | +2.2 | +1.4 | −1.2 | +0.2 |
| cand5 (final): + D9's plain casts | — | — | — | −0.1, −0.3 | — |

- **cand3's stopwatch loss** was 8 of 8 pairs negative. A paired V8
  profile against `dist-fn1` showed one difference: `helper_shr_cc` at
  0.17 % of the ticks, the flag-setting register shift that R4 inlines (each
  call also syncs the TB's globals). The mutex pair, `qemu_ram_block_from_host`
  (C4's fallback, 0.02 %), the load/store helpers and the checked casts
  (+0.05 %) did not stand out.
- **cand4** differs from cand3 only in R4, which removes helper calls from
  TB code. Its paired profiles against `dist-fn1`, on stopwatch and on midi,
  match within sampling noise: no function moved more than 0.3 %. The
  stopwatch A/B ran while outside load came and went (host 3–12 % busy,
  absolute vratio 0.72–0.94 instead of ~1.05). Its round means were +0.15,
  −1.30, +3.79, −4.40 and +0.81 %, so the A/B cannot resolve 1 % here.
- **cand5:** midi leaned negative in all three rounds so far (cand3 −0.47
  and −0.14, cand4 −1.16 %). The only removal that the midi profile showed
  was the checked casts (`object_dynamic_cast_assert` 0.33 → 0.41 %; 0.04
  → 0.09 % on stopwatch), so they came back. cand5 is cand4 plus the casts:
  midi −0.09 / −0.27 % (8 pairs, se ~0.5). The other scenes keep cand4's
  numbers, since the casts can only make them faster.
- **Validation of cand5** (built without freerun.diff): `gate.sh keep`
  green (13/13). lockstep-wasm with `LS_QARGS` clean: S75 to 2.5G insns
  (179 internal-SRAM digests, serial and 20 register epochs identical),
  EL71 to 1.5G (107 digests, 16 epochs). DSP unit tests pass.

The wasm io-barrier single-instruction TBs (A5 in
[wasm-fast-paths.md](wasm-fast-paths.md)) stay: without them, lockstep-wasm
with `LS_QARGS` diverges at 16.7M insns on S75 and EL71 (wasm internal SRAM
lags native), a hidden wasm io_recompile rewind divergence that is not fixed.
The gate's own lockstep does not pin the RTC, so it does not see this.

## 2026-11-05 audio worklet phase vocoder

The slow-down in `site/audio-worklet.js` went from splices to a phase vocoder
(README, Sound). It runs on the audio render thread, where a 128-frame
quantum has 2.7–2.9 ms.

- **Exactness:** every step of the port (plain port, `atan2` only at peaks,
  fused FFT, warm-up) gave output bit-identical to the research prototype:
  7 inputs × 5 producer-speed profiles, through an offline node harness that
  fills a ring and calls `process()`.
- **CPU per quantum** (node, one pinned core, pooled over the stretch
  profiles):

  | Worklet | Mean µs | p99 µs |
  |---|---|---|
  | splices (before) | 7.2 | 23.7 |
  | prototype as ported | 36.1 | 169 |
  | final | 22.9 | 107 |

  The FFT was most of it. Two radix-2 stages per pass with the values kept in
  locals (the same butterflies and IEEE operations, so signed zeros match
  too) made it 2x faster. Keeping the previous frame's spectrum and rotations,
  so `atan2` runs only at peaks, gained a little. The p99 is 4 % of a quantum
  on the dev host. Not measured on the Pixel 8 Pro.
- **V8 cold start.** The first vocoder frames ran interpreted, 5–9 ms each:
  the first entry cost 42–56 ms extra, up to 8–12 ms in one quantum. Warming
  up only the FFT did nothing. Calling the methods directly at full size took
  65 ms and only halved the stall, and at a small size V8 deoptimized the code
  on its first real use anyway:
  - missing type feedback: N = 256 is a power of 4, so the fused FFT's final
    single stage never ran;
  - field constness: fields written once, then reassigned;
  - Smi → Double field representation changes (map deprecation).

  What works: on the first ring message, run two made-up voices (one gets
  back to full speed, one starves) through `process()` itself on scratch
  rings, with 128-frame
  windows, then restore the fields. Every vocoder field is created in
  `configurePv`, so the object keeps one shape. The warm-up costs 30–39 ms
  once per worklet scope (a later processor skips it), and the first entry
  then costs 2–5 ms extra, at most 1.3–3 ms in one quantum.
- **Chrome, towerblox under `dutyhost.sh` `RUN=1 STOP=4`** (vratio ~0.58), the
  two worklets alternated, one 60 s window each:

  | Worklet | Underruns | gapMs | stretchedMs |
  |---|---|---|---|
  | splices | 5, 6 | 3500, 3767 | 23514, 22841 |
  | vocoder | 5, 7 | 3225, 4005 | 21860, 21525 |

  The same within this model's noise; the dropouts are the producer's. The
  vocoder entered ~100 times per window. bobby under `RUN=1 STOP=2` (vratio
  0.86): no underruns, 8.3 s stretched. Chrome cannot time the worklet: its
  scope has no `performance`, `Date` sees the dutyhost stops, and its console
  output does not reach Playwright (stats have to go through the ring
  header).
