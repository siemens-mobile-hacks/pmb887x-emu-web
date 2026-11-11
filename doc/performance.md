# Performance

Where the speed work stands, how to measure and validate a change, and what
has already been tried. Read this before doing performance work on the
emulator.

- **State described:** fork `f77b282b9f`, on smh/master `9e5a6bbfd6`
  (2026-11-10).
- **Related:** [wasm-fast-paths.md](wasm-fast-paths.md) lists every fork change
  that exists only for speed, and how to remove one.
  [diagnostics.md](diagnostics.md) lists the page parameters and tools.
  [lessons.md](lessons.md) has the platform facts (emscripten, wasm, V8)
  and the measuring traps behind the method here.
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
  hides env-addressing effects, so re-test those ideas with it. On a phone
  the checks cost 19 % (2026-11-10), and V8's arm64 code has other costs
  that x64 does not show at all: measure ARM ideas on a phone ("On a
  phone" below).
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
   if it gives a significant boost and stays isolated. Since 2026-11-10 a
   speed change may touch upstream's files when it is clearly reversible
   later or upstreamable, as long as the fork does not deviate too much
   (the owner, on the levers that were waiting for a decision). The bus
   deferral (D12) went in under this.
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

### Working rules

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
- **Emscripten traps.** wasm-EH longjmp composes with Asyncify only while no
  function on the Asyncify onlylist calls setjmp, `poll()` never sleeps,
  condvar waits are whole milliseconds, and proxied syscalls take ~1 ms.
  See [lessons.md](lessons.md), Emscripten runtime.
- **Build both legs of an A/B the same way**, from the same build directory
  and source state apart from the change. Never compare against a dist of
  unknown origin or yesterday's number.

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
  `SCENEBENCH_BROWSER=firefox` (`tools/perf/swab.sh` pairs it too), with
  `SCENEBENCH_FF_PREFS='{"pref": value}'` for user prefs. Headless Firefox
  needs PulseAudio. It ran towerblox at x0.96–1.12 against Chromium's x1.72
  with bounds checks until the rebinder (History, 2026-11-10; lessons.md has
  the SpiderMonkey facts), and reaches x1.3 with it once its tiers settle,
  which takes about a minute: measure Firefox over 80 s, not 20.

### On a phone

The container has no USB, so the phone hangs off the Docker host's adb
server, and the container talks to that server (set up 2026-11-10).

- **Phone:** Developer options, USB debugging on; Chrome open and in the
  foreground (Android freezes it in the background and DevTools stops
  answering).
- **Host:** `adb devices` must list it, then
  `socat TCP-LISTEN:5037,bind=172.17.0.1,fork,reuseaddr TCP:127.0.0.1:5037`
  (the bridge address only, so the LAN cannot reach the phone through it).
- **Container:**

```bash
export ADB_SERVER_SOCKET=tcp:172.17.0.1:5037
adb=build/android-emu/sdk/platform-tools/adb     # any adb 1.0.41
$adb shell svc power stayon usb                   # undo: svc power stayon false
node tools/perf/adbtun.mjs raw "reverse:forward:tcp:8080;tcp:$(hostname -i):8080"
node tools/perf/adbtun.mjs listen 9222 localabstract:chrome_devtools_remote &
SCENEBENCH_CDP=http://127.0.0.1:9222 node tools/scenebench.mjs stopwatch dist-jit \
  --runs 1 --measure 30 --keyscale 3
```

`127.0.0.1:8080` on the phone is a secure context, so the page is
cross-origin isolated without TLS. scenebench opens a tab of its own, hands
the flash to the page through DevTools and closes the tab; `cpu` reads 0.
The walk waits in guest time there (an idle guest keeps real time, a busy
one gets what it needs), so a towerblox run is ~5 minutes on a phone that
emulates at a third of real time. The tunnel also serves `PROF_ATTACH=9222`
(`tools/wprof2.mjs`) and `tools/perf/wasmtrace.mjs` (V8's wasm compile
events: counts, durations and threads per tier).

**A/B on the phone:** alternate the two dists, one run each, Chrome
restarted in between; a guest behind real time is in free-run by itself, so
the ordinary dists do. An x64 host cannot see what V8's arm64 code costs at
all (lessons.md). V8 flags work through the debug-app command line
(lessons.md).

- **A new dist starts cold.** Chrome caches the main module's optimized
  code by URL, so the first run of a dist that was just built reads ~3 %
  low and the second ~1 % (one build on 2026-11-11: x0.318, x0.331, then
  x0.334–0.341 over five more runs; three other builds the same). Give a
  new dist two throwaway runs, or rotate the dists three times and drop
  the first round. The first phone A/Bs (A11, `59a4bd78f9`) did not, with
  the candidate cold and the baseline warm: they understate.
- **What it resolves.** Warm runs of one dist vary by about ±1 % on
  towerblox and bobby (2026-11-11, an overnight series; three consecutive
  runs agreed within 0.5 % once). A 1 % effect takes three rounds or
  more; bobby shows a DSP change about 1.5x larger than towerblox.
  Stopwatch spreads from x0.41 to x0.45 for one build: its first six
  pairs read −3.8 to +1.1 % for a change that was +0.3 % over ten.
- Start a batch in the background and chain the next one behind it: a
  towerblox run is ~5 minutes, a pair more than a command's timeout.

| Phone | Scene (date, fork) | Result |
|---|---|---|
| Motorola One 5G Ace (Snapdragon 750G: 2 × A77 2.2 GHz + 6 × A55, 3.5 GB, Android 11, Chrome 156) | paced, `472c44c938` (2026-11-10) | towerblox x0.29 (40 MIPS, 52 fps; S75 idle after 60 s), stopwatch x0.40 (55 MIPS), bobby x0.64 |
| the same | paced, `0dcee227d0` (A11) | towerblox x0.327 (+12.8 %, S75 idle after 55 s), stopwatch x0.428 (+6.2 %), bobby x0.65 (+1.6 %, fps +13 %) |
| the same | paced, `59a4bd78f9` (2026-11-11), against `f77b282b9f` in alternating runs | towerblox x0.325 (+4.7 %), bobby x0.745 (+7.3 %), stopwatch x0.445 (+4.3 %) |
| the same | paced, `cc1c25a551` (2026-11-11), against `59a4bd78f9`, both warm | towerblox x0.338 (+0.7 %, 4 pairs; `59a4bd78f9` warm x0.336), bobby x0.759 (+2.6 %, 2 pairs), stopwatch x0.439 (+0.3 %, 10 pairs) |
| the same, towerblox with V8 flags, `472c44c938` | `--wasm-tiering-budget=1300000` | x0.297 (+4 %) |
| | `--no-wasm-bounds-checks` | x0.338 (+19 %) |

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
- **Outlier pairs:** one leg sometimes ran 10–15 % slow (seen on pair 3's
  and 4's A side), and a round's se then read 3–4 % against ~0.7 %
  otherwise. Up to `4903acdf72` this was a whole-cache `tb_flush` in the
  middle of the burst: the DSP flushed whenever its block was the one to
  cross the first 16 MiB code region (~16.7 MB, ~8.5 s), in about one boot
  in five to eight. A flushed boot is ~1.5 s late at the 15 s mark.
  `42bb89c091` fixed it (History). A dist built before that still has it.
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

### Native micro-benchmarks

A fork-owned C kernel can be timed natively in seconds, where a browser
A/B takes minutes and resolves ~1 %: add a temporary `g_test` to
`hw/arm/pmb887x/dsp/tests/tcg.c` that sets the unit test's core to the real
operating point (take it from a census) and times a few million iterations
with `g_get_monotonic_time()`, then
`ninja -C build/qemu-native-build test-pmb887x-dsp-tcg` and run it with
`-p <test path>` on one pinned core. Knocking out a part (results invalid,
timing only) prices it. The 2026-11-09 35BE work went 64 -> 32 ns this way
before its first browser run, and the browser confirmed it (History). Check
that the benchmark takes the path it means to time: with the unit test's
`stepi` of 0, r2 walked into Y space and half the iterations fell back to
the per-instruction runner.

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
- **The fold counts instructions at TB entry.** The wasm64 prologue adds
  the whole TB, and an unwind (io_recompile rewind, SMC restart, fault)
  hands back what did not run (`w64_acct_unwind`). Before `4fc6ac6dc7` it
  did not, each rewind left the count ahead, and the `LS_QARGS` run diverged
  wherever rewinds were frequent, which is what A5's barriers prevented.

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
- **Checking a kernel change in the browser:** the tree has no runtime
  switch for the fast loops. Build a per-call differential as a temporary
  patch: run the kernel and the translator on copies and memcmp the state
  and data (`a2fc4f3414` did this for 35BE). The replay checker that
  `git -C qemu show fefdb61f9d:hw/arm/pmb887x/dsp/tcg.c` still has
  (`tcg_fast_check`, `tcg_verify_level_free`) re-ran every fast run through
  the translator, and was too slow to reach SL65 MIDI playback.

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
path ([lessons.md](lessons.md), Measuring).

## Where the time goes

Every share below is as of its date, and later work moved some of them.

| Scene (date) | Profile |
|---|---|
| Stopwatch, free-run + bounds checks (2026-11-02) | TB code 62 %, DSP kernels ~10 %, SVC/eret/mode-switch path ~2.5 % (upstream target/arm), BQL futex waits ~1.2 %, `lcd_handle_cd` lock 0.3 %, JS clock reads ~2.4 % (a free-run artifact: the raw-clock cache applies only when behind real time) |
| Stopwatch, V8 `--prof` (2026-11-01) | TB TurboFan 46 %, main module 26 %, TB Liftoff 6.4 % + `WasmLiftoffFrameSetup` 2.4 %, libc 16 % (`ATOMICS_WAIT`, i.e. idle) |
| Towerblox, V8 `--prof`, free-run + bounds checks (2026-11-04, `92f6a90e56`) | TB TurboFan 59 %, main module 31–33 %, TB Liftoff 4–5 % + `WasmLiftoffFrameSetup` 1.5 %. TB code by owner: ARM 40 %, DSP 23 %. Top C: `tcg_fast_run_35be` 4.2–4.7, `dsp_bus_advance` 3.1 (callers: data reads 1.1, the `dsp_sync` timer 1.0, data writes 0.8, `dsp_runtime_advance_cycles` 0.6), chain helper 2.1–2.3, `helper_w64_fill` 1.9–2.1, `dsp_sync` 1.5–1.7, kernels 643f/64a9/6489 ~1.2/1.1/0.7. Nothing else above 0.8 %; from entry 26 down, each is ≤ 0.3 %. The hottest ARM TB (2 %) is the fill loop's own superblock |
| Towerblox, V8 `--prof`, free-run + bounds checks, TBs named by guest pc (2026-11-10, `8fcac1b334`) | Main module 33.9 %; ARM TBs of the firmware in flash 32.4 % (1.7 of it Liftoff); ARM TBs in RAM, the game's own compiled code, 7.4 % (3.0 Liftoff); DSP blocks 22.4 %; `WasmLiftoffFrameSetup` 0.7 %. DSP-side C is ~19 % (`dsp_bus_advance` 3.6, chain helper 2.8, the four kernels 5.6, `dsp_sync` 1.5, a long tail), so the DSP is ~41 % of the scene and ARM ~45 %. 3799 TB functions have ticks; the top one is 1.4 % (a DSP block). ARM TB code comes to ~1.3 ns per guest instruction: a hot 8-instruction TB is ~70 x64 instructions, of which the entry accounting ~12, a guest access 13–16 and the exit ~6 |
| Bobby (2026-10-31) | Worker busy time: DSP 61 %, ARM 19 %, display 13 % |
| Video (2026-11-01/02) | Busy 11.8 s of 20 s = ARM JIT 5.0 s, DSP 4.4 s, ARM-side C 2.1 s. GSM search kernels (35be+643f+6489+64a9) ~30 % of free-run ticks (midi 12 %, bobby 9 %) |
| MIDI (2026-10-30/11-01) | DSP ~62 % of the vCPU, ~48M DSP cycles/s. Hot blocks: f4ec 27 % of chained cycles, e20d 16 %, f4b8 10 %. DSP-bound: only faster DSP execution helps |
| Music AAC (2026-10-30) | 10 s of vCPU: DSP 4.7 s (JIT code 2.4, chain helper 0.6, 35BE kernel 0.44, bus/sync 0.35), ARM 1.4 s, idle 3 s |
| S75 boot, vt + bank (2026-10-29) | Busy ~15 s = ARM 8.4 s (interpreter tier 2.0, TB code 4.7, helpers 0.75), DSP 3.3 s, translation 1.7 s, loop overhead 0.9 s |
| EL71 boot, `434be28741`, Chrome trace and V8 `--prof` (2026-11-05) | ~900 batch modules and ~43k lazy compiles per boot. A lazy compile takes 43 µs on the vCPU thread: Liftoff ~19 ns per wasm byte plus ~13 µs fixed, of which ~11 µs is publishing (AddCompiledCode, PublishCode, two icache flushes); the mean TB body is 1.5 KB. Module decode, validation and instantiation are ~0.5 ms per module. TurboFan takes 1.6 ms per TB on the background threads, 45 % of it register allocation. Busy window, guest ~7–16 s: main-module wasm 35 %, TB Liftoff 19.6 %, TB TurboFan 17 %, Chrome C++ (the Liftoff compiler) 15 %, builtins 5 % (`WasmLiftoffFrameSetup` 3.3 %, which runs on every Liftoff entry while wasm inlining is on; `CallIndirectIC` 1.1 %, on every Liftoff `call_indirect` including the chains' tail calls). Top C: `tcg_gen_code` 6.3 % self (the register allocator and the inlined wasm64 emitters), `liveness_pass_1` 3.1 %, `helper_lookup_tb_ptr_lc` 1.2 % |
| TB bytes by TCG op, EL71 boot census (2026-11-05) | `qemu_ld`/`qemu_st` ~44 % of the body bytes at ~100 bytes each, ~42 of them the slow arm (helper call and the `$tmask`/`$ttab` reload, which a helper's TLB resize forces). Moving the arm out of line would save ~1.5 % of the burst at most; the reload has to stay in the TB |
| `tcg_gen_code` phases, EL71 boot to 73.7k TBs, `emscripten_get_now` timers (2026-11-06, `42bb89c091`) | 2.63 s in all: `liveness_pass_1` 0.54 s, register allocation and emission 1.10 s, the rest (`tcg_optimize`, the smaller passes, the batch modules' assembly) ~1.0 s. Per TB: 115 ops and 76 temps, 24 of them globals; ~26 block ends, branches and call-clobbering ops at which liveness reset or crossed every temp, and the allocator walked every temp at each block end. After A9 (wasm-fast-paths.md): 2.30 s, liveness 0.38 s, allocation and emission 0.95 s. The constant temps' `GHashTable`, emptied by `tcg_func_start` for every TB, was ~1 % of the burst in the 2026-11-05 profile (`tcg_constant_i32` 1.0 % inclusive; inserts, lookups and resizes 0.4–0.7 % each), 2–3M lookups per boot; A10 replaced it |
| EL71 idle (2026-10-29) | ~18.5 % of a core; DSP 1.09 s per 10 s |

**Rates.** A per-event cost must pay for itself at these rates (free-run
unless noted).

| Event | Rate |
|---|---|
| ARM TB entries | 16.5–19M/s; ~50 % indirect (goto_ptr): the per-TB slot answers 83 % of those, the pc cache 17 % (2026-11-02) |
| ARM ns per guest insn | stopwatch ~1.7, towerblox ~3.5 (its fill loop ~0.75) |
| Thumb fill rows (towerblox, 2026-11-05, 60 s real time plus boot) | 36.8M rows finish inside the helper. 98.1 % go straight into the next row; 1.5 % end the rectangle, 0.4 % meet the cycle budget, and ~50 were in TBs still interpreted. A row costs two TB entries (a0a04cc2 head, the b absorbed; a0a04cc6 loop and tail). Done as a C transition per row, it cost ~23 ns, as much as the TB code it replaced |
| SVC / eret / mode MSR / IRQ (stopwatch) | ~240k / ~245k / ~250k / ~1.9k per s |
| ARM MMIO accesses | ~50k/s, no polling; `mmu_lookup1` ~18k/s in steady state |
| ARM guest accesses (towerblox, census 2026-11-10) | 1965M inline probes over the boot and 34 s of the game. 27 % of them were the second to last word of an LDM/STM (3.7 words each), which R8 now serves with one probe; all probes together are a few percent of the vCPU |
| New ARM TBs in steady state | stopwatch ≈ 0; towerblox ~135–300/s (JIT-compiled Java at fresh addresses, no invalidation churn) |
| DSP (bobby) | 59M cycles/s, 5.4M blocks/s, 2.86M chain links/s, 109k C-dispatcher entries/s |
| DSP chain calls | towerblox ~1.7M/s, stopwatch ~191k/s; ~20.6 cycles per block |
| DSP program bank switches (S75) | ~34k/s |
| DSP config changes (sat, modi, ...) | ~40k/s |
| `dsp_sync` / `dsp_bus_advance` | ~15k/s / 145k/s (video) to ~600k/s (towerblox) |
| Chain helper | ~22 ns per link (2026-10-31, before `3488724de2`); ~150 x64 instructions on the hit path |
| Cross-instance wasm call | ~2.7 ns microbenchmark, 5–7 ns in situ |
| DSP kernels | 643f 3.7, 6489 3.6, 64a9 3.4 ns/cycle on the per-instruction runner; calls run 600–2000 cycles (2026-11-02). 35BE whole iterations ~0.8 ns/cycle natively since `6b8a64baa5`. JIT ~5.3 ns/cycle (2026-11-01) |
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
  minimum memory size (memory is 32768 pages, min = max), and the index
  has to be a constant when V8 builds its graph: an `i32.const`, not
  `i32.wrap_i64` of a local that holds one, which it folds only later.
  env is addressed as constants when the TB's env is fixed (`w64_tb_env`,
  `w64_abs_base`), and so is anything behind a register a movi loaded
  (`w64_const_base`). What stays dynamic is inherent: TLB entries, guest
  RAM, the DSP's data pages.

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
| Plain (non-sata) 35BE mode | 643f −1 %, 64a9 worse | 2026-11-01 |
| Per-iteration exit check; inlining `walk_reads` | Neutral | 2026-11-01 |
| Generic "plain" block-repeat iterations with one exit check per iteration | Mixed (643f −10 %, 6489 −7 %, 64a9 +4 %) | 2026-11-02 |
| `teak_update_modulo_steps` (upstream) | 0.6 % on midi, left | 2026-11-01 |
| Envelope state-machine kernel (midi F6BC / bobby ED2A loop) | Too big (~10 new instruction types) | 2026-11-01 |
| EE49 C kernel (S75 MAC loop: 27 % of chained cycles, 3.1 % of the vCPU) | Parked, ~1.5 % on Bobby, S75 only | 2026-11-02 |
| Biquad routine 0xDDDE (~11 % of towerblox chains) | ~1 % reachable, parked | 2026-11-02 |
| Lazy DSP flags. Upper bound: `fz fm fn fv fe fc0` dead at every block exit and at the chain helper (inexact, `tcg_remove_dead_flag_stores`) | towerblox −0.6 % ± 0.65 (4 pairs × 30 s). midi −38 %: the DSP reads those flags across blocks, so the inexact build changed its work, and it bounds nothing there. DSP TB code is ~23 % of towerblox, so even cutting a fifth of it is ~4–5 %, before materializing the flags read across blocks | 2026-11-05 |
| The exit and interrupt request checks after a data-writing DSP instruction only on its slow (helper) arm | Priced, not built: two constant-address loads and two predicted branches per such instruction, under 0.5 % of the scene, and exact only with a translation-time record of the helper calls since the last check | 2026-11-10 |
| The chain test's tail after `59a4bd78f9`. (a) Each link's arm reads the link's `instruction_count` and `code` through `tcg_constant_ptr`: behind the `linked` label the `link` temp is a variable again, so those two loads keep their bounds checks (hot DSP block functions 24.4 → 17.9 checks with it). (b) One generation word for both invalidations: the DSP's cache generation becomes a low word that a batch eviction bumps as well, and the links' eviction epoch and its compare go | Motorola One 5G Ace, bobby, three builds rotated four times, all warm: (a) −4.1 % (x0.716 against x0.747; each of its six runs below every baseline run, cause not found), (a) + (b) +0.5 % (x0.751). (b) alone before that: bobby +1.1 / +2.0 %, towerblox −2.4 / +1.5 %. Desktop x64 with forced checks, 4 pairs a round: (a) bobby +3.3 / −1.4 %, towerblox +1.1 / −2.5 %; (b) over (a) bobby +3.1 / +0.8 %, towerblox 0.0 / +1.0 %, midi +0.8 %. Two checks fewer per transition were expected to give ~1.5 % on bobby and did not; nothing here pays for a change in upstream's file. `build/experiments/dsp-chain-link-generation-early-reads.diff` (applies to `cc1c25a551`) | 2026-11-11 |

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
| No bus synchronisation in front of the interrupt-controller registers (DE00–DE1F; inexact bound, a two-line return in `tcg_synchronize_data_access`). They are 47 % of the DSP's register accesses on towerblox | towerblox +0.1 % over 6 pairs (−2.5 to +4.7): nothing. The helper call is not the cost; the device walk behind it is | 2026-11-10 |
| Exact bus deferral, measured on towerblox at last | Shipped as D12 (`58cb97caff`): bobby +2.2 %, towerblox +1.2 %, midi +0.6 %. Less than the +3.1 % of the batching bound, because half of `dsp_bus_advance` was the I2S frames themselves: towerblox runs an I2S port in both directions, a frame every ~16 advances and a receive interrupt every 2.4 frames | 2026-11-10 |
| Going further with the deferral: no flush for I2S reads, or for writes of RXINTADDR / TXINTADDR (253k accesses per 4M advances on towerblox, each a walk now and a second one at the next advance) | Not built. It would take the walks from 18 % of the calls to ~8 %, for ~0.3–0.5 %, and needs per-register knowledge in the bus. Recomputing the horizon lazily after a flush instead of walking would delay `i2s_tx_configure` past the next advance, which the codec model could see | 2026-11-10 |
| 35BE's 26 multiplies with wasm SIMD | Not built: the kernel is 1.5 % of towerblox since the flat iteration (`6b8a64baa5`), the multiplies a third of it | 2026-11-10 |

### ARM translator and wasm64 backend

| Idea | Result | Date |
|---|---|---|
| Removing the wasm64 superblock code under vt (`3bd45ab9d0`) | Reverted by `2ff4e374c3`: superblocks with exact CF_COUNT_CYCLES accounting took stopwatch vratio 0.58 → 0.87 (parbench, under contention) | 2026-10-30, 11-01 |
| ARM self-loop back-edge via `translator_loop_begin/back`, separate from superblocks | Correct, but loop passes were 4.7 % of video insns; neutral everywhere | 2026-10-31 |
| `W64_INTERP_THRESH` 16 / 32 / 256 | Neutral in steady state and at the EL71 boot | 2026-10-31, 11-05 |
| `W64_FT_MAX` 12, absorb limit 512 | No better than `W64_FT_MAX` 6 (`3132d80df8`) | 2026-11-01 |
| `W64_INL_DEPTH` 8 | Neutral / −1 % on Bobby | 2026-11-01 |
| Anything in front of the inline TLB probe: a per-TB page memo in locals (59 % of memops served, flat; later −0.7 / −4.2 %), a per-site entry cache (4.4–5.0 % slower at a 94.7 % hit rate), `env + fast_ofs` hoisted into a local (+3–10 % slower) | The probe's loads hit L1 and run in parallel with the address arithmetic. A check before it adds a dependent branch to every memop. Only a scheme that replaces the probe could collect its ~5 % | 2026-09-13 – 10-31 |
| TLB page cache in locals (reuse a probe for a same-page ld/st) | towerblox −3 to −7 % with bounds checks. `build/experiments/w64-tlb-pagec.diff` | 2026-11-03 |
| `movcond` as `select` (M1) | +1.4 / 0 % | 2026-10-31 |
| Typed funcref chain table; `return_call_ref` | A typed non-nullable table is −6.5 % of the indirect call itself (~0.6 % of wall, September probe) and needs typed funcrefs in every browser; the patch no longer decodes against the batch encoder. `return_call_ref` is 45 % slower than `return_call_indirect`. The table was done again on 2026-11-11 and shipped as `cc1c25a551` (History): the exnref floor already includes typed funcrefs, and on arm64 the signature test is 5 of the call's 21 instructions | 2026-09-16, 10-31, 11-11 |
| A chain table of fixed size (min = max), on top of the typed one | Not built: V8 then takes the table's length as a constant, one load of the 16 instructions left. It needs the table's final size up front or a flush when it is full | 2026-11-11 |
| Lazy global sync at `qemu_ld/st` (`TCG_TARGET_LDST_SLOW_SYNC`) | The correct version is neutral: V8 env stores are cheap, and exit-time stores remain. The first version leaked register mappings past labels (lockstep diverged at 16M) | 2026-11-01 |
| Dropping the TB-start exit-request check under CF_COUNT_CYCLES | The guest never runs: exits are needed beyond IRQs | 2026-11-01 |
| Removing or moving the per-TB `wasm_guest_insns` RMW | Removing it breaks scenebench's progress detection. The counter costs ≤ ~2 %, and deriving it from cycle_count was neutral. Env-relative accounting won only with bounds checks (`305999f747`) | 2026-11-01 – 11-02 |
| Folding literal-pool loads (`ldr Rt,[pc,#imm]`, 3.2 % of stopwatch insns) to constants | Noise: TB code is not load-latency bound | 2026-11-02 |
| TB code size: a 1 KB cold pad per TB; one shared `return_call_indirect` tail per TB | Only inline *unhinted* cold code costs, and hot TBs already hint their cold paths. The shared tail was neutral | 2026-11-02 |
| Same-batch direct `return_call` for goto_tb chains | +0.2–0.65 %: noise. `return_call_indirect` cost is not a lever | 2026-11-02 |
| Backend known-constant registers (`i32.const` addresses) | Noise on x64 with the trap handler: TurboFan folds `wrap(local const)`. It folds it after it has decided about the bounds check, so with explicit checks this is a lever: shipped as `59a4bd78f9` (History, 2026-11-11) | 2026-11-02, 11-11 |
| Constant `w64_tb_tp` for the return-address store before helper calls | Neutral / −1 % | 2026-11-02 |
| Inline ARM chain linking across wasm instances | Too large a change for ~1–2 % (a cross-instance call is ~5–7 ns) | 2026-11-02 |
| TB lookup path | After `5c8cf5bc65`/`1cffcb62a0`: per-TB slot 83 %, inline hash 17 %, helper ~0. Not a lever | 2026-11-02 |
| Code-page gate on the key-generation bump in `tb_jmp_cache_clear_page` | Neutral at the boot and in steady state | 2026-11-02 – 03 |
| Upstream goto_ptr exits at the EL71 boot (no slot, no probe: the ceiling of any out-of-line exit), against `d4380167b9` | Burst −2.1 % (se 1.2) / −2.4 % (se 1.0), but audioMs +6.2 / +5.0 %: the slot's hits matter where the sound plays | 2026-11-05 |
| No TB-side pc-cache probe: the lookup helpers probe it instead (free-run, 4 pairs each, against `d4380167b9`) | Video −5.0 % (se 0.6) / −3.0 % (se 2.2), towerblox +0.3 / −3.3 %, midi −2.0 / +0.8 %, stopwatch +1.9 %, bobby +0.7 %. Behind a helper call a hit saves nothing over the jump cache. The module's probe function (A2) keeps both the boot and the steady state | 2026-11-05 |
| Selective batch landing (interpret ≥ 16 times before a module) | +2 % slower | 2026-11-02 |
| Cold landing (`W64_INTERP_LANDED` 4: a batch member with fewer than 4 interpreted entries keeps fidx 0 when its batch lands, and is pointed at the thunk later), three attempts | EL71 boot: burst −1.4 to −2.1 %, audioMs −2 %, lagMax −3 to −4 %. Free-run: bobby negative in all six readings (−0.2 to −2.4 %), also in a placement-free A/B with the threshold in a global, and video −0.9 / −0.3 %. Fails the no-loss rule. Census: 82 % of members are still cold when their batch lands and 31 % of those wake later; an interpreted entry costs ~1.5 µs. Neither the interpretation (0.12 % of bobby) nor the extra dispatcher entries (~1 %) explains the loss; the cause was not found. `build/experiments/w64-cold-landing-42bb.diff`, `w64-cold-landing-census.diff` (apply to `42bb89c091`) | 2026-11-05 – 06 |
| A9 extended to the globals: walk only the globals an op touched since their last reset, at side-effect ops too | Exact (the checker passed on boot and the five scenes), but nothing over A9: EL71 boot timers to 73.7k TBs, liveness 373 / 392 ms against A9's 377 / 383, `tcg_gen_code` 2.31 / 2.40 s against 2.30 / 2.34. A TB has only 24 globals. `build/experiments/w64-la-touched-globals.diff` (applies to `42bb89c091`) | 2026-11-06 |
| Precise large-page TLB flush: a page flush inside `large_page_addr/mask` drops only the entries whose own block (`lg_page_size`) holds the page, scanning the indices of the aligned largest block, instead of flushing the whole mmu_idx | Census, EL71 boot: ~11k `tlbimva` (each over 22 mmu_idx) and nearly every one forced a full flush, because the range spans `a0000000`–`afffffff` (flash sections). The full flushes threw away 140k live entries, where only 128 belonged to a block holding the page, and their refills were 64 % of the boot's 219k fills. The full dirty-reset walk (all 22 modes, 1775 of 1806 calls) read 11.7M entries. Exact (a checker that rescans the whole TLB after each precise flush passed 21.5k flushes on the boot and 23.5k on stopwatch; the other four scenes never reach the path). Fills 219k → 42k, but EL71 boot, 2 × 4 pairs: burst −0.5 % (se 0.7) / +0.5 % (se 0.8), audioMs −0.3 / +2.0 %. V8 profile, 6–14 s, HEAD / candidate: `tlb_set_page_full` 0.26 / 0.07 %, `tlb_reset_dirty_range_all` 0.44 / 0.29 %, but `tlb_flush_page_by_mmuidx_async_0` 0.32 / 0.49 % (the 256-entry scans, 5.6M entry checks), `mmu_lookup1` 0.07 / 0.20 %, `victim_tlb_hit` 0.07 / 0.12 % and `do_ld4_mmu` 0.47 / 0.76 % (not explained). TLB maintenance comes to ~1.8 % in both. Without full flushes C5 grows the tables to 4096–8192 entries. A bitmap of the blocks present and skipping clean modes could leave ≤ 0.5 %, which bootab does not resolve. `build/experiments/w64-tlb-large-flush.diff` (applies to `af7a5a4bf6`) | 2026-11-06 |
| Inline return through `pop {..., pc}`, as `w64_inline_return` does for `bx lr` | Census, towerblox: of 53.9M executed pc-loading LDMs only 16.0M (30 %) ran inside an inlined callee with the guard's conditions met; 70 % were at depth 0, the TB having started inside the function. Against ~17M TB entries a second that is under 2 % of them (the `bx lr` form already returns inline 33M times of 69M). Not built | 2026-11-10 |
| hflags kept in place on AArch32 mode changes (`8203411abf`) | Committed on 2026-11-01, returned to upstream in `b12dea95f2` (neutral) | 2026-11-02 |

### V8 and toolchain

| Idea | Result | Date |
|---|---|---|
| `--no-liftoff` (−10 % ns/insn on video) | A page cannot set V8 flags | 2026-10-31 |
| Wasm compilation hints | Behind a flag in Chrome 153–155, no origin trial. Even with the flag there was no TurboFan | 2026-11-01 – 02 |
| Forcing Liftoff tier-up by padding TBs | Tier-up budget is charged by machine-code offset at returns and tail calls, so it would take tens of KB per TB. Ceiling: `--wasm-tiering-budget=1300000` gives +3.7 % on towerblox. Closed for good | 2026-11-02 |
| `--wasm-tiering-budget=300000` at the EL71 boot (ceiling) | Burst −8.2 %, stretchedMs −25 %, gaps unchanged; TB Liftoff ticks 22.5 → 4.1 %. All of it is TB tier-up: main-module Liftoff is ~1 %. V8's default budget is 13M. A page cannot set it | 2026-11-05 |
| Tier-up spin: a loop in TB code that charges the tiering budget | A back-edge charges ~0.93 × the function's Liftoff size (~2.5 × its wasm body bytes) per iteration, under 1 ns each. A per-TB countdown with overshoot matched the flag's tier-ups, but the loop wrapper alone cost +3–9 %: net burst +0.5 % (se 0.9), gaps worse. A full charge on every TB floods TurboFan: +19.6 %. Closed | 2026-11-05 |
| Tier-up by calls from outside: the exit-request arm of a TB returns at the end of the function, so a call with the request flag set charges the whole Liftoff size and runs no guest code | Priced, not built. The budget of 13M needs ~3500 such calls for a mean TB (Liftoff ~3.75 KB), ~35 µs on the vCPU thread, about one lazy compile; a TB that would tier up by itself gains at most the same, and one that never would repays it only after thousands of runs. Off the vCPU thread it is the tier-up helper worker (Remaining levers), whose instance has its own budgets | 2026-11-10 |
| Masking indexes so V8 drops bounds checks | Impossible: V8 drops them only for constant indexes, and the memory size is a hoisted load | 2026-11-03 |
| wasm SIMD build; extra Binaryen passes | Neutral | 2026-11-01 |
| Binaryen one-caller inline limit (N=200, or 1000 globally) | 200 is worse (splits `dsp_i2s_advance` out); 1000 is noise | 2026-11-02 |
| ThinLTO main module | Noise. The wasm grew 12.3 → 16.2 MB, and ~30 Asyncify onlylist names went missing | 2026-11-03 |
| Fewer declared TB locals (the baseline tier zeroes them at every entry), re-priced now that Liftoff TB code is ~6.6 % of towerblox | A pad of 16 extra i64 locals per TB: +1.0 / +0.1 % (4 pairs in each order), noise. Not a lever | 2026-11-05 |
| Firefox: make TB functions tier up sooner from the page (SpiderMonkey's baseline counts down at every loop header, so N loops without a back-edge around a TB body would multiply the countdown) | Not built. With the rebinder (History, `472c44c938`) the default prefs reach x1.30 on towerblox over 80 s and x1.35 with tier-up at the first call (`javascript.options.wasm_lazy_tiering_level` 9): the gap is the first minute only, and Ion's `emitLoop` adds an interrupt check per loop header to the optimized code. Without the rebinder, levels 6–9 gave nothing at all (x0.98–1.03) | 2026-11-10 |

### Devices, display, timers, clock

| Idea | Result | Date |
|---|---|---|
| Display lazy batching with framebuffer dirty tracking | Judged not exact on 2026-10-31. Done differently in `0c3c3c8c9b`: lazy wakes, catching up on DIF/DMAC access and on stores to source pages through `tlb_set_ram_write_guard` | 2026-10-31, 11-01 |
| Batching dif_v1 words | Not exact: the guest runs ≥ 64 cycles (`CPU_CLOCK_BUDGET_MIN`) between words | 2026-10-31 |
| timer2 O(1) closed form; DMAC+ALB+timer2 combination | Neutral | 2026-10-31 |
| Widening the `cpu_clock_owner_raw` cache | 89 % hits, video neutral: the profiler overstates JS clock reads | 2026-10-31 |
| Skipping `cpu_clock_owner_shorten_budget` while the budget renewal (now `tcg_vcpu_timers_next_budget`) runs timers; 64-bit `muldiv64` fast path in the budget | Safe, but no gain / ~0.2 % | 2026-10-31 |
| LCD writer-thread wake thresholds 16K/32K, a 4 ms poll | No better than the 1 ms poll of `43c24bb03d` | 2026-11-01 |
| Inline LCD drain at the CD edge (0.40 %) | Needs the LCD commands on the writer thread | 2026-11-01 |
| DIF bus bytes (~7 MB/s on stopwatch, ~3 ns per byte) | Left alone | 2026-11-01 |
| BQL waits in `cpu_exec_loop` (~1 %), QOM casts (~0.1 %), slow-path ld/st (~1 %, the direct MMIO path) | Real work, not levers | 2026-11-01 |
| Syscall proxying to the main thread | A few `fd_pwrite`s per minute, no vCPU stalls | 2026-11-02 |

### September 2026, under icount (before the DSP LLE and vcpu-timers)

Measured on boot milestones and J2ME windows of that build, with knobs and
counters that the 2026-09-22 review removed. Each row still concerns code
that exists.

| Idea | Result |
|---|---|
| Branch hints on the cold labels besides the TLB probe's (exit request, inline-return and `msr` misses, unlinked `goto_tb`/`goto_ptr`) | −1.35 % ± 1.89 on video: not resolvable. Those arms end in a plain return with almost nothing live, so only block layout changes |
| Memoising `arm_rebuild_hflags` (16 entries by CPSR mode; and across the SVC round trip) | Hit 100 % of 5.9k calls/Mi, verified exact, and did not move the meter. The pre-v6 short path (R5) is 12.3 ± 1.6 ns a call, ≤ 2.6 % of video |
| Guessing an indirect branch's target from `env` at translation time | 9.4 % hit rate: hot code outlives the phase that translated it. Coverage capped it at ~2 % anyway |
| A 64 KB guest page | Boot regression: the code granule (`code_mask`) scales with the page and each page's TB list grows 16x. 8 and 16 KB were inconclusive |
| One helper call for a whole ldm/stm | −11.7 %, then −6.3 % with the obvious fix. A helper call inside a TB costs ~14.5 ns (spilled locals, globals reloaded) and saves 3.6 probes of ~1.2 ns |
| Cheaper TB-boundary mechanisms: a module's TBs merged into one `br_table` function, a driver loop instead of the tail call, same-instance tail calls | All tie, and the merge is a regression: TB chaining is predictable per site, where every mechanism costs the same (lessons.md, wasm and V8) |
| Shrinking the set of live dispatch targets (dispatch locality) | ≤ ~2 % with no mechanism to collect it: `return_call_indirect` has a ~6 ns floor even with 8 targets |
| Turning off TCG's optimizer for wasm64 | No effect over an 8-leg sweep |
| A second way for the per-TB lookup slot (`w64_lc`) | Helper calls −39 % as predicted, wall 0.0 / −0.2 %: the second compare chain on every remaining miss and 20 % more exit code cost what the calls saved |
| Lookup cache keyed on an hflags generation; comparing every key word inline | hflags change 88k times a second, so the generation retired every slot. A dozen loads and six branches inline were +2–4 % slower than the helper. What landed compares 2–3 words and stamps the rest statically |
| Widening the TB jump-cache entry so a hit never dereferences the TB | Flat on pristine builds of both revisions: the hot TB set stays resident |
| A dense arena for `goto_tb` chain slots | A wash over six pairs. The slot address is a compile-time constant, so the load is not on the critical path |
| An inlinable fast path for `bql_lock_mmio()` | ~1 ns a call, ≈ 0.06 % of wall; not built |
| MMIO dispatch fast path at access time in `memory.c` | 0.1–0.7 s worse per boot window: the condition chain costs what it saves. The fill-time resolution (C1) landed instead |
| TPU event RAM as its own MemoryRegion | S75 idle −2.3 %: the extra flatview section costs more than the range compare it removes |
| `dacr_write` value guard (skip the TLB flush on an unchanged value) | No effect: this firmware does not rewrite DACR with the same value |
| Lazy flash romd restore (back to array mode on the first array read) | 7.4x fewer topology flips but 32 % slower in the flash-heavy window: array reads and fetches become MMIO dispatches meanwhile |
| A cheap corner in `new WebAssembly.Module` (size threshold, imports, exports) | None: cost is linear in function count plus a per-call intercept; 64 imports add 0.09 µs each, exports are free. Only fewer modules pay |
| Persisting compiled TB modules across boots (AOT cache) | Dead on the platform: neither V8 nor SpiderMonkey stores a `WebAssembly.Module` in IndexedDB, restoring bytes costs more than compiling them fresh, and synthetic responses get no code-cache hit |

## Known open issues and remaining levers

**Issues:**

- **EL71 display freeze:** the display freezes (framebuffer stops, guest
  idle) after leaving a running stopwatch with the red key. It also happens
  under icount. It is upstream's issue; wait for upstream.
- **wasm64 `extract`/`sextract`/`deposit` are all but off:**
  `TCG_TARGET_{extract,sextract,deposit}_valid` in
  `tcg/wasm64/tcg-target-has.h` test `ofs + len <= type * 8` with the
  `TCGType` enum (I32 = 0, I64 = 1), so only 64-bit fields within the low
  byte reach `tgen_extract`/`tgen_sextract`/`tgen_deposit`; everything else
  is lowered to shifts and masks by `tcg-op.c`. The emitters read correct
  for every width. Making the test `1` (as TCI does) changes every TB's
  code, so it needs the gate, lockstep and a whole-candidate A/B; dropping
  the emitters needs the same. Left as found 2026-11-10.
- **An evicted batch has only been exercised with a lowered cap:**
  `W64_LIVE_MAX` 48 boots S75 (2026-11-10), slowly, and at 256 a wasm
  lockstep of 1e9 instructions is clean (`bed67ff185`, which fixed an
  abort in the DSP at the first eviction in the middle of a slice).
  Nothing in the gate reaches eviction; Tower Bloxx would after about half
  an hour (two or three batches a second against a cap of 6144), unless
  the code buffer fills and flushes first. Nobody has played that long
  under a counter.
- **S75 OFFLINE/PTEST startup:** the Siemens board includes of bsp `de47d4b`
  define only `[startup.ONLINE]` (x75, elka, r65, sirius). The
  lookup in `hw/arm/pmb887x/board/startup.c` is required, so qemu exits at
  t=0 and the page looks hung. Not fixed.
- **SL65 native lockstep is nondeterministic** (see Lockstep).
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
- **MIDI underrun (2026-10-30, not re-checked):** one ~120 ms underrun per
  60 s window on a normal host, unrelated to speed. Cause not found.
- **Pixel numbers** have not been re-measured since 2026-11-01 (the owner's
  figure for towerblox before `8fcac1b334` is ~x0.67). The phone that is
  measured is the Motorola in "On a phone".
- **What V8's arm64 TB code still pays over x64, after A11** (2026-11-10,
  read from the code an arm64 Node prints; nothing here is priced on a
  phone yet): the `movz` + `movk` pairs that are left, ~6 % of the
  instructions, are `goto_tb` slots and the DSP's chain-link fields, whose
  addresses are per TB or per block; one `movz` for `can_do_io`, a byte
  above 4095; the explicit bounds checks, 19 % of towerblox there, a `cmp`
  + `b.hs` per TLB word and per guest access; V8's own stack check, frame
  and memory-base reloads. The first thing priced after that list was not
  on it: bounds checks on constant addresses in the DSP's chain test
  (`59a4bd78f9`, +4.7 %).
- **A DSP block transition on a phone** (2026-11-11). Towerblox makes
  ~11M of them per guest second (the chain helper's 1.7M are 15 %),
  against ~17M ARM TB entries, and each was ~160 arm64 instructions
  before `59a4bd78f9`: the chain test's gates and link compares ~100,
  V8's indirect tail call 21 (seven loads, since the code-pointer table)
  and the next block's frame and stack check ~10. Taking nine bounds
  checks (27 instructions) out of it was worth 4.7 % of the scene there;
  the five instructions of the tail call's signature test (`cc1c25a551`,
  on ARM transitions as well) +0.7 %, inside the noise, and +2.6 % on
  bobby; two more checks and the epoch compare nothing (Closed ideas,
  DSP execution). What is left of the transition is not a lever at the
  phone's resolution short of fewer transitions (DSP chain tail, below).
- **The DSP's share on the phone** (towerblox, the profile of 2026-11-10
  split by the C call chain above each sample): DSP blocks 22.8 % of the
  vCPU thread and the C code under the DSP's slice functions 13.3 %, so
  36 % in all; ARM TBs 48.7 % and the rest of the C module 15.1 %. A DSP
  thread that never waited would bound at 1/(1 − 0.36) = 1.56x there
  (rule 1; the exact design of 2026-11-02 was measured on a desktop that
  already ran at real time).

**Remaining levers** (not done; prices as of their dates):

- **Teak state in TCG globals.** This is the only way to cut the DSP JIT's
  semantic cost. It is a large, upstream-divergent rewrite.
- **Direct DSP block linking** (≤ 3 %).
- **Kernels:** EE49 (~1.5 % on Bobby, S75 only) and DDDE (~1 % on towerblox).
- **EL71 boot window:** what is left of `tcg_gen_code` is per op (Where the
  time goes). ~1.35k TB invalidations per boot each bump a global key, which
  is cheap: ~36 stale-slot lookups per bump (census, 2026-11-05). The
  goto_ptr exit code has a small ceiling: with upstream's
  `lookup_and_goto_ptr` (no slot, no probe) the burst was only −2.1 / −2.4 %
  faster and audioMs got worse (Closed ideas). The module-probe trick, a
  function the batch module defines instead of an import, suits any per-TB
  code that TurboFan should inline but Liftoff should not have to compile at
  every site.

From the 2026-11-05 brainstorm (towerblox profile `92f6a90e56`; priced only
where noted):

- **Exact DSP bus deferral on towerblox:** done as D12 (2026-11-10), for
  +1.2 % there and +2.2 % on bobby. Census of the DSP's peripheral accesses
  on towerblox (2026-11-10, by register and pc, stable over three
  4M-access windows): 47 % are one routine at P:040B–0416, the interrupt
  dispatcher, reading the six interrupt-controller registers
  DE00/01/04/05/08/09 two cycles apart; 16 % are writes of DEA3 and 12 % a
  read and a write of DEA8 (the DSP block, from P:00D0/00D8). The rest is
  mostly the I2S interrupt handler reading and rewriting DEE8 / DEEA
  (RXINTADDR, TXINTADDR) and the baseband's DE81. Of 4M advances, 3.44M
  now return after the add, 246k reach the horizon (I2S frames), and 306k
  walk because an access to the I2S flushed just before.
- **Tier-up helper worker.** Liftoff TB code plus `WasmLiftoffFrameSetup` and
  `CallIndirectIC` are ~7 % of towerblox ticks; 61 % of the Liftoff ticks are
  in code older than 60 s. A second worker sharing the NativeModule could
  call hot TBs until TurboFan publishes them. Ceiling ~4.5 % (the closed
  tiering-budget row gives +3.7 %). It needs a second 2 GB memory and a new
  worker: the owner's call.
- **Display refresh off the BQL.** `gui_update` holds the BQL on the main
  loop (0.26 % on the dev host). It matters with a slow main-loop core.
- **DSP chain tail.** Every DSP block ends with 55–76 TCG ops of gates and
  link checks; four gates are constant per block. Census (2026-11-10, tail
  executions by the block's instruction count): towerblox 4.7 instructions
  per block, 45 % of the blocks two instructions or fewer and 78 % five or
  fewer; midi 4.5, 56 % and 92 % within eight. A `rep` and a batched loop
  body count as one short block but run many cycles. The chain helper takes
  15 % of the transitions on towerblox and 10 % on midi. The hot tail is
  ~22 loads, 12 compare-branches and 3 stores before the indirect tail
  call, perhaps 4 % of towerblox. Superblocks across fallthroughs would
  save part of that for a large change to upstream's translator: not
  started.
- **One check per TLB probe:** done as C8 (2026-11-10), with three hooks.

From the 2026-11-10 round (towerblox profile with named TBs, above):

- **Probes are not what a hot TB's listing suggests.** The hottest ARM TBs
  of towerblox do about one guest access per instruction (35 instructions,
  31 probes), yet removing a quarter of all executed probes (R8) is worth
  ~2 %. Sharing a probe between neighbouring instructions on one base
  register would need decode look-ahead or a TCG pass for under 1 %.
- **The scene is two flat halves.** ARM code runs at ~1.3 ns per guest
  instruction and the DSP at several times that per cycle, on ~41 % of the
  vCPU. Nothing generic is left on the ARM side; the DSP side is the
  levers already listed (Teak state in globals, the bus deferral, the
  chain tail).

From the 2026-11-09 round (hot TB modules by `tools/perf/wasmgrab.mjs` on
free-run scenes, `6b8a64baa5`; DevTools shares, which overstate):

- **The other three kernels are not the 35BE case.** 643F + 64A9 + 6489
  are 12 % of video and ~4–6 % elsewhere, on the per-instruction runner
  (~2.8 ns per cycle natively, where 35BE's iterations take ~0.8). A
  hand-written 643F iteration (six direct reads, two stores, only the last
  add's flags and the sticky ones; a unit test of 13 modes against the
  translator, every observable mutant caught) measured video −0.4 %
  (se 0.3), midi −0.2 % (se 1.0), stopwatch +1.3 % (se 1.4), 4 pairs each:
  nothing. The runner's unrolled, constant-folded instructions already are
  such an iteration; 35BE paid because it dropped walks and copies, which
  these loops do not have. Validating the accesses up front and leaving
  the rest to the compiler was slower natively (25.4 → 28.5 ns).
  `build/experiments/dsp-643f-flat.diff` (applies to `6b8a64baa5`).
- **Time is concentrated in a few guest loops.** One DSP block function is
  7.1 % of midi's vCPU and another 4.4 % (seven are ~20 %); one is 6.1 % of
  bobby; one ARM TB was 6.8 % of stopwatch and the same routine ~2.4 % of
  towerblox: the firmware's colour-keyed 16-bit blit, since `dcb799b05c`
  a C kernel (R7). Towerblox also spends 1.5 % in a DSP
  `rep` of one `mov a0l, (rN)+` (P:E9E8, 160 passes), each pass reloading
  the accumulator and redoing the page lookup.
- **The C side is a long tail** (V8 `--prof`, free-run, 2026-11-10):
  main-module C is 31–42 % of the vCPU and no function is above 5 %.
  `dsp_bus_advance` was 3–5 % on S75 scenes before D12: ~0.5 M calls per
  guest second on bobby, 70 % from cycle-sensitive register accesses with
  the I2S and timer 2 active, each asking eleven devices whether they are
  active (`baseband_is_active` reads the virtual clock). On towerblox the
  only active devices are one I2S port and timer 2 (the baseband on 0.05 % of the
  calls), 48 % of the advances are for two cycles or less, and upstream's
  own horizon (`dsp_bus_get_cycles_until_event`: AFE and I2S receive
  interrupts) is far away on 96 % of them. The four correlator kernels are
  7–11 %; the 26-tap loop of 35BE is a third of its iteration and would
  vectorise by hand (wasm SIMD is not enabled in the build; as a global
  flag it measured neutral).
- **Idle.** An idle EL71 keeps the vCPU busy 14 % of the time at 3.9 MIPS
  (0.20 cores for the whole page, 0.17 the vCPU worker). Of the busy ticks
  ~29 % were the four correlator kernels (35BE 15 %, before `6b8a64baa5`),
  25 % TB code, 15 % Chrome C++.
- **What the TB code looked like** (read as WAT, towerblox and stopwatch):
  every guest register and the four flag words go through env at each
  sync point, a `cmp` stores all four flags even when a branch follows, a
  literal-pool `ldr` takes a full TLB probe every pass, and each TB entry
  and back-edge pays the instruction counter, the exit check and the
  budget. All of it is TCG's design or closed above; nothing cheap is left
  there.

## History

Every qemu commit is on `wasm-browser-port`. Parent commits are listed where
they exist. Numbers
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
| 2026-11-05 | — (parent `8e0322a`) | `-parallel none` among the page's qemu arguments. Without it qemu backs the default parallel port with a hidden `vc` text console, whose cursor timer redraws 80x24 glyphs every 250 ms on the main loop under the BQL (`cursor_timer_cb` 0.50 % of ticks; the vCPU's BQL futex waits were 0.85 %). Dev host +0.2 % over 8 pairs (noise); the hold grows with a slow main-loop core |
| 2026-11-05 | — (parent `54be137`) | Main-module code cache: `startEngine()` compiles the fetched response itself and counts bytes on a clone. It used to compile a `new Response(tee)`, which has no URL, so Chrome never cached the code. The profile's wasm code cache holds ~7.8 MB after one boot (72 bytes before). Free-run S75 boot, warm vs cold: +17 % guest insns in the first 3 s, ~+20M insns by 20 s |
| 2026-11-05 | `d4380167b9` (`172f58552d`) | Shorter pc-cache probe at goto_ptr exits (own 3-op hash, no `cpu_index` compare on one CPU). EL71 boot (bootab.sh, 2 × 4 pairs): burst −1.5 % (se 0.9) / −4.7 % (se 3.4), median −1.7 %, audioMs −3.3 / −9.8 %. Free-run: towerblox +0.9 %, bobby +1.2 %, video +0.8 % (8 pairs), stopwatch +1.0 %, midi +0.4 % (4 pairs) |
| 2026-11-05 | `434be28741` (`d4380167b9`) | The lookup helpers probe the pc cache; the inline probe is emitted only at goto_ptr exits whose pc-cache hits in C reach 65535 (the TB is retranslated). EL71 boot (bootab.sh, 2 × 4 pairs) vs `d4380167b9`: burst −7.0 % (se 0.9) / −5.4 % (se 0.8), audioMs −10.7 / −9.0 %, lagMax −13.7 / −10.6 %. Free-run, 4 pairs each: video −1.6 / −1.4 %, towerblox −0.7 / −1.3 %, bobby −1.4 %, midi −0.8 %, stopwatch −0.3 %, taken by the owner's one-time exception (rule 5). Census, paced video: ~35k slot misses/s and ~11k second-exit lookups/s answered in C, ~0.4 promotions/s, which at tens of ns each does not explain the ~1 % |
| 2026-11-05 | `36e3b3cc4c` (`434be28741`) | The goto_ptr exits call `w64_pcc_probe`, a function each batch module carries, in place of the helper import: TurboFan inlines it into hot TBs, a cold TB's exit stays a 5-byte call, and a miss calls the helper. Promotion, its counters and `helper_lookup_tb_ptr_cnt` are gone. EL71 boot (bootab.sh, 4 pairs) vs `d4380167b9`: burst −6.5 % (se 0.7), audioMs −10.2 % (se 1.6), lagMax −10.3 % (se 1.4); vs `434be28741`, 3 × 4 pairs: +6.6 % (se 4.1, two outlier pairs) / −0.1 % / −0.7 %. Free-run vs `d4380167b9`, 4 pairs each: video +2.3 / −0.1 %, towerblox −0.4 / +1.0 %, bobby +0.2 %, midi +0.2 %, stopwatch −0.4 %, which recovers the steady state that `434be28741` gave up |
| 2026-11-05 | `c5f522fbfa` (`36e3b3cc4c`) | `-sSUPPORT_LONGJMP=wasm` in configure's wasm64 `CPU_CFLAGS`, as standard exnref instructions (wasm-fast-paths.md A8; Firefox deprecates the legacy `try`, lessons.md): the 15 JS `invoke_*` trampolines are gone (`cpu_exec` once per entry, `setjmp_gen_code` three times per TB). EL71 boot (bootab.sh, 2 × 4 pairs): burst −4.4 % (se 2.6) / −7.6 % (se 2.7), audioMs −8.8 / −14.6 %, lagMax −9.8 / −13.6 %. Free-run, 4 pairs each: towerblox +4.9 % (se 1.1), video +3.6 % (se 0.9), bobby +1.2 %, midi +1.2 % (se 0.6), stopwatch −0.4 % (se 1.8), and in the swapped order the candidate led 4 of 4 pairs (+1.1 to +3.2 %, one +21 % outlier). Measured with the legacy instructions; the exnref build against it: boot burst +2.2 % (se 2.8) and +0.8 % (se 5.2) in the swapped order; free-run towerblox −0.1 %, video −0.8 %, bobby −0.8 % and +0.8 % swapped, midi −0.1 %, stopwatch +0.9 %: a tie. Raises the browser floor to Chrome 137, Firefox 131, Safari 18.4. A build dir made before it must be removed (both build scripts refuse it) |
| 2026-11-05 | `4903acdf72` (`c5f522fbfa`) | One `run(env, sp, tp, tidx)` thunk for every batch module, built once in its own module and kept across flushes, in place of a thunk each module exported: no `addFunction`/`removeFunction` pair, lazy compile and Liftoff phase per module, and one target for the dispatcher's indirect call. EL71 boot (bootab.sh, 2 × 4 pairs) vs `c5f522fbfa`: burst −7.2 % (se 2.9, two slow baseline boots) / +0.1 % (se 0.4), the candidate faster in 6 of 8 pairs; audioMs −20.4 % (se 8.0) / +0.2 % (se 1.8). Free-run, 4 pairs each: bobby +3.2 % (se 0.5), stopwatch +2.9 % (se 1.3), video +2.2 % (se 0.3), towerblox +0.8 % (se 0.3), midi +0.5 % (se 0.6) |
| 2026-11-06 | `42bb89c091` (`4903acdf72`) | The DSP took `tcg_gen_code`'s −1 (past the current region's highwater) for a full buffer and queued a `tb_flush`; `tb_gen_code` moves on to the next region instead. Whenever a DSP block was the one to cross the first 16 MiB region (~16.7 MB, ~8.5 s into an EL71 boot, the DSP's compile burst at the chime) every TB and module was dropped: 2 of 11 logged boots (44.4k TBs, 623 modules), ~1.5 s late at the 15 s mark. It now gives up the rest of the region and allocates again. The interpreter tier's entry counts survived the flush, so TBs on recycled indices skipped it; reset at flush (forced flush at 16.7 MB, 3 boots each: 15 s mark 16.64 → 16.23 s, lagMax 3.16 → 2.78 s; no flush 15.12 s, 1.70 s). EL71 boot (bootab.sh) vs `4903acdf72`: 3 of 24 baseline legs 10–12 % slow, none of the candidate's; without them neutral (+0.4, +1.0, −0.6, +0.3 %). The two slow baseline boots of `4903acdf72`'s −7.2 % round were likely the same. Free-run, 4 pairs, host load 8–12: stopwatch +1.1 % over 4 rounds (se 1.5), midi +0.5 %, bobby −0.3 % over 2, towerblox +0.5 %, video 0.0 %; a first version (the `tb_gen_code` retry) read stopwatch −1.2 % (se 0.4, 10 rounds) with neither leg flushing or retrying there, and a control with its function order and no behaviour change +2.9 / +0.5 %: placement |
| 2026-11-06 | `328087aa34` (`42bb89c091`) | Liveness and the register allocator's block-end walk visit only the globals, the TEMP_TB temps and the EBB/const temps touched since the last reset (wasm-fast-paths.md A9). EL71 boot to 73.7k TBs: `liveness_pass_1` −30 %, register allocation and emission −14 %, `tcg_gen_code` 2.63 → 2.30 s. EL71 boot (bootab.sh, 2 × 4 pairs): burst −1.5 % (se 1.2) / −1.5 % (se 1.1), audioMs −2.1 / −2.8 %, lagMax −2.9 / −4.9 %. Free-run, 4 pairs each: stopwatch +5.9 % (se 0.9, 4/4), midi −0.1 %, bobby +0.3 %, towerblox −0.4 % (one −4.2 % pair) and +2.8 % swapped (4/4), video −0.3 % over 12 pairs (median −0.1 %) |
| 2026-11-06 | `af7a5a4bf6` (`328087aa34`) | A TB's constant temps in a per-thread open-addressed table per type, emptied by a generation bump, in place of the `GHashTable` that `tcg_func_start` emptied for every TB (wasm-fast-paths.md A10). EL71 boot (bootab.sh, 2 × 4 pairs): burst −1.0 % (se 1.2) / −2.1 % (se 0.5, 4/4), audioMs −0.9 / −5.3 %, lagMax −2.8 / −4.5 %. Free-run: stopwatch +1.3 %, towerblox +1.1 % (4 pairs each), midi −0.1 % (8), bobby 0.0 % (12), video −0.2 % (16, median −0.2 %; per-pair sd 2–5 % that hour) |
| 2026-11-09 | `d7fab9092f`, `3486f1e2b7` (`af7a5a4bf6`) | smh/master `9e5a6bbfd6`: debug channels, the CFI flash's own writeback (flash-blk gone), core Fifo, `hw/dma` sink cache, chips moved out of `hw/arm/pmb887x`, audio through audio lines and PCMOut; bsp `de47d4b`. The merge alone lost, free-run, 4 pairs: towerblox −4.2 % (se 1.5), stopwatch −2.5 %, bobby −2.2 %, midi −1.4 % (se 0.3, 4/4), video −0.1 %. Paired V8 profiles: `audio_line_write` looks the sink's interface class up by name per sample frame (`object_class_dynamic_cast` + `g_hash_table_lookup`, ~0.3 % of towerblox, ~0.6 % of midi), and the new chain AFE/I2S → router → line → speaker → PCMOut is ~0.5 % of towerblox where the old direct sink was 0.09 %. With D11 (wasm-fast-paths.md), 8 pairs: towerblox 0.0 % (se 1.1), midi 0.0 % (se 0.4), stopwatch −0.3 % (se 1.1), bobby +0.6 % (se 0.7), video −0.1 % (se 0.2). EL71 boot (bootab.sh, 4 pairs): burst −1.1 % (se 0.3), audioMs −1.8 %, lagMax −2.6 %. The legs need a page server each (`PORT_A`/`PORT_B`): the page always loads `dist/boards.tar`, and the two qemus read different bsp boards. Under `--prof` the merge leg read 5 % slow with identical time shares: boot-time writeback leaves six more idle pool threads, and the sampler signals every thread; per-thread CPU without the profiler was equal |
| 2026-11-09 | `6b8a64baa5` (`3486f1e2b7`) | 35BE iterations on guest memory itself (`tcg_fast_iterate_35be_flat`, wasm-fast-paths.md P1). Census on EL71: sata 1, product shift 0, r4 in a 26-word ring, r2 back on the same 13 coefficients every iteration, ~36 iterations a call. Native micro-benchmark of that point (a temporary g_test timing the unit test's kernel, 3 s a run): 64 ns per iteration, of which the 26 multiplies 14 ns, the operand copies 11 ns and the walks, pointer lookups and bookkeeping the rest; reading memory directly 48 ns; with every Y read finding its own ring word, in place of a stepped index that chains the multiplies, and a loop of its own for shift 0, 32 ns. Free-run, 4 pairs: stopwatch +6.3 % (se 0.9), midi +6.0 % (se 0.7), bobby +4.3 % (se 1.2), towerblox +3.8 % (se 1.7), video mips +2.1 % (se 0.1); 19 of 20 pairs positive. Native lockstep old binary against new, EL71 and S75 to 1e9: identical. After it (V8 `--prof`, free-run): 643F + 64A9 + 6489, still on the per-instruction runner at ~3.5 ns per cycle, are 12 % of video, 5.7 % of midi, ~4 % of stopwatch and bobby, 2.8 % of towerblox; 35BE is 5.5 % of video plus 2.1 % in `tcg_fast_step_35be` (the slice ends). A hand-written 643F iteration then measured nothing (Remaining levers) |
| 2026-11-10 | `dcb799b05c` (`6b8a64baa5`) | The firmware's colour-keyed blit loop in C at its back-edge (`HELPER(w64_blit)`, wasm-fast-paths.md R7): stopwatch +7.0 % over 7 pairs (all positive), towerblox +1.0 % over 6 (se 1.8). Stopwatch rows are ~96 pixels, towerblox's ~20. With the host loaded from outside the container, four pairs at once halved every leg and buried the effect; two pairs at a time showed it |
| 2026-11-10 | `455f756d82`, `9e7d3d4ce5` (`462123cd8d`) | DSP block chaining. The chain helper enters repeat-headed and over-budget blocks itself (P11): towerblox +1.2 %, video +2.5 %, midi +0.9 %. The inline chain test with merged loads (P12): midi +0.8 %, video +0.9 %, bobby +1.0 %. Measured on the way: with no inline links midi loses 11 %, with the helper alone and no inline test 5.4 %, so the inline test is a visible share of DSP time; selecting link slots by the full key lost 0.9 % (eviction churn) and four slots 2.2 % (code size) |
| 2026-11-10 | `db5ec3b899` (`9e7d3d4ce5`) | Review of everything that differs from smh/master, no fast path removed (the 2026-11-04 round measured those). Bugs of ours fixed: the lockstep and guest instruction counts were not handed back when a TB was unwound mid-way (`w64_acct_unwind`; this was the "divergence" that A5 hid, so A5 is speed only now: a 60M leg takes 16 s without it, 3 s with); `mulu2`/`muluh` and the `qemu_ld`/`qemu_st` address read a 32-bit operand raw from a 64-bit local, so `movs r0, r0, lsl r1; cmp; umull` returned a wrong high word (`w64_get_u32`; two new op-suite cases fail on `9e7d3d4ce5`); an evicted batch left its DSP blocks in the DSP block cache and the next entry aborted ("evicted TB is not known": reproduced with `W64_LIVE_MAX` 48 at 61M instructions on S75, boots with the fix) — a session that outlives 6144 live modules would have hit it; `memory_region_set_readonly(false)` on a region born read-only kept the stale view; the fused MMIO load skipped the read cycles under `PMB887X_MEMORY_TIMING` (1.44M loads / 34M cycles in a 25 s S75 boot); GPTU configuration writes now sync the elided ticks first; the emscripten timed cond wait dropped its last millisecond. Closer to upstream: `arm_rebuild_hflags` after eret back off wasm64, the `tcg_func_start` const-table hunk down to one statement, two DSP call sites and a comment hunk restored, asyncify-only list 196 → 122 names (wasm byte-identical). Whole candidate against `9e7d3d4ce5`, free-run: stopwatch +4.0 % (6 pairs, +2.7 to +5.4), midi +0.1 % (4), video +0.8 % (4), towerblox +1.0 % (4, −2.2 to +3.4); which commit gives stopwatch its gain was not bisected |
| 2026-11-10 | `33855e074b`, `8fcac1b334` (`db5ec3b899`) | Two bounds-checked loads per guest access where there were three (C8: the comparator and the addend in one 64-bit word), and one probe for all the words of an LDM/STM (R8). Free-run, two pairs at a time, host load 4–10. C8: stopwatch +2.4 % (6 pairs), towerblox +1.1 % (14, se 1.0). R8 over C8: towerblox +2.0 % (6), stopwatch +3.6 % (4). Both: towerblox +3.1 % (16 pairs; the last ten +4.2 %, −2.5 to +9.4), stopwatch +4.1 % (6, +0.4 to +7.2), bobby +1.5 %, midi +1.2 %, video mips +0.5 % (4 each, one video pair −1.0 %). Lockstep with `LS_QARGS` clean on S75 and EL71; the op suite gained page-boundary and base-in-list LDM/STM cases (1312 cases, identical on native JIT, TCI and wasm) |
| 2026-11-10 | `58cb97caff` (`8fcac1b334`) | The DSP peripheral bus adds cycles up until a device has something to do (D12), under the owner's rule of that day for changes in upstream's files. Free-run, two pairs at a time: bobby +2.2 % (6 pairs), towerblox +1.2 % (12, −4.4 to +7.2), midi +0.6 % (6, all positive), stopwatch +0.1 % (8), video mips −0.3 % (6). V8 `--prof` on towerblox: `dsp_bus_advance` 3.05 % → 2.4 % with its callees. A digest of every bus event with its cycle count (`tools/perf/busdigest.py`) is identical to the undeferred bus over 35M events of the S75 and EL71 boots, and both it and the new unit test catch a horizon late by 50 cycles; upstream's own unit tests did not. The rest of the round priced what is left and found nothing above 1 %: see Closed ideas (DSP scheduling) and Remaining levers (DSP chain tail) |
| 2026-11-10 | `bed67ff185`, `472c44c938` (`58cb97caff`) | Firefox. SpiderMonkey never re-points a table slot when a function tiers up, so every chained TB was entered through its baseline code; each Firefox batch now carries a rebinder (`table.init` from a passive segment) that the dispatcher runs once a second for the live batches, 2–3 ms a pass. Free-run in Firefox 155, two pairs each: towerblox +11.9 %, stopwatch +11.6 %, bobby +7.7 %, midi +6.4 %, video +24.7 %; towerblox x0.96 → x1.30 over an 80 s window (the ceiling with tier-up at the first call is x1.35, Chromium with bounds checks x1.72). Chrome modules are unchanged (+2.0 %, se 1.6). Closed on the way: tiering up sooner from the page by wrapping TB bodies in loops (the gap between x1.15 at 20 s and x1.30 is warm-up only, and Ion emits an interrupt check at every loop header). Testing eviction with rebinders found an abort of older date: a batch landing in the middle of a DSP slice evicted a block the slice then ran (`bed67ff185`, lessons.md) |
| 2026-11-10 | `0dcee227d0` (`472c44c938`) | The first measurements on a phone, and the first lever only an ARM host shows (A11). A phone's profile has the desktop's shape with TB code ~1.3x slower relative to the C module; tiering, thread placement and compile backlog were ruled out (lessons.md). V8's arm64 code builds every constant address above 64 KiB with `movz` + `movk`, 19–22 % of all TB instructions, so the CPU object, the DSP runtime and two counters moved below 16 KiB of linear memory, where the address is the load's immediate (`CPUTLB.d` became a pointer to make room in front of env). Motorola One 5G Ace, alternating runs: towerblox +12.8 % (x0.320, x0.334 against x0.289, x0.291), stopwatch +6.2 %, bobby +1.6 % (fps +13 %), S75 boot −8 %. Desktop x64: stopwatch +0.9 %, bobby +1.1 %, towerblox +0.6 % (2 pairs each, noise). Tools: `tools/perf/adbtun.mjs`, `SCENEBENCH_CDP`, `tools/perf/wasmtrace.mjs`. On top, `f77b282b9f`: an access at env + offset is one constant address, because V8's arm64 backend adds a memarg offset to the memory base before a store at a constant address; towerblox +1.1 % on the phone (x0.314, x0.326 against x0.313, x0.320) |
| 2026-11-11 | `59a4bd78f9` (`f77b282b9f`) | A constant address for every access through a register a movi loaded. V8 decides about a bounds check while it builds its graph, where `wrap(local)` is not a constant yet even if the local holds one, so the DSP chain test's eight to ten link fields each kept a `sub`, `cmp` and branch on Android. Found by weighting the arm64 instruction mix of the hot TB functions by their self time (`tools/perf/a64code.sh`, an arm64 Node with Chrome 156's V8). Hot DSP block functions: 41.3 → 24.4 bounds checks, 827 → 750 instructions. Motorola One 5G Ace, alternating runs, two pairs each: towerblox +4.7 %, bobby +7.3 %, stopwatch +4.3 %. Desktop x64 with forced checks, 4 pairs each: towerblox +2.0 %, bobby +1.7 %, video +1.7 %, stopwatch +0.4 %, midi +0.4 % |
| 2026-11-11 | `cc1c25a551` (`59a4bd78f9`) | The chain table holds `(ref $tb)`, non-null references to the TB signature, defined by the thunk's module (JS cannot create a typed table); a slot no TB owns holds a function that traps. V8's `return_call_indirect` drops the signature compare, which was also its null test: 21 → 16 arm64 instructions per chained transition, ARM and DSP. Motorola One 5G Ace, alternating runs, both builds warm: bobby +2.9 % and +2.4 %, towerblox +0.7 % over 4 pairs (−1.2 to +3.0), stopwatch +0.3 % over 10 pairs (single runs of either build x0.41–0.45; the first six pairs alone read −1.5 %). Desktop x64 with forced checks: towerblox +2.6 % (4 pairs), bobby +1.0 % (16), stopwatch +0.8 % (16), midi +0.6 % (4). Eviction with the trap function in the slots: lockstep to 1e9 with `W64_LIVE_MAX` 256. Found on the way: a dist the phone has not run reads ~3 % slow, so the phone A/Bs before this one understate (On a phone) |

## 2026-11-04 deviation cleanup

The owner asked to return every fork deviation that neither speed nor
correctness needs, without losing anything on any scene (rule 5). The base
was merge `6cd424cdb5`. What went back to upstream is listed in
[wasm-fast-paths.md](wasm-fast-paths.md) under "Returned to upstream"; the
rows there give the cost of removing each path that was tried and kept.

Whole-candidate free-run A/Bs against the base, 4 pairs × 20 s per run, in
percent, negative meaning slower than before the cleanup. An A/A gave
+0.3 / +0.1 %.

| Candidate | stopwatch | towerblox | bobby | midi | video (mips) |
|---|---|---|---|---|---|
| all groups removed (each was near neutral alone) | −5.7 | −2.6 | −3.3 | −2.9, −3.5 | −0.3 |
| cand2: the groups the A/Bs and profiles blamed put back | +0.7, −3.4 | −1.7, −0.5 | −4.4, +0.4 | −1.3, 0.0 | −0.4, +0.6 |
| cand3: + D2's shift mux, D4's clock cache, R2's rebuild drop | −1.2, −0.9 | +0.5, +0.6 | +1.5, −0.2 | −0.5, −0.1 | +2.0, +0.5 |
| cand4: + R4 | −0.2 over 20 pairs (see below) | +2.2 | +1.4 | −1.2 | +0.2 |
| cand5 (final): + D9's plain casts | — | — | — | −0.1, −0.3 | — |

- **Groups that were each near neutral summed to −5.7 %** on stopwatch,
  which is why rule 5 asks for a whole-candidate A/B.
- **cand4's stopwatch rounds** ran under outside load (+0.15, −1.30, +3.79,
  −4.40, +0.81 %); its paired V8 profiles against the base matched within
  0.3 % per function.
- **Validation of cand5:** `gate.sh keep` green; lockstep-wasm with
  `LS_QARGS` clean on S75 to 2.5G insns and on EL71 to 1.5G; DSP unit tests
  pass.

The wasm io-barrier single-instruction TBs (A5 in
[wasm-fast-paths.md](wasm-fast-paths.md)) stay: without them, lockstep-wasm
with `LS_QARGS` diverges at 16.7M insns on S75 and EL71 (wasm internal SRAM
lags native). That was not a rewind divergence: the lockstep fold's
instruction count ran ahead by the instructions each rewind left unrun
(fixed 2026-11-10, `4fc6ac6dc7`; History). The gate's own lockstep runs one
instruction per TB, where nothing unwinds mid-TB, so it never saw this.

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
