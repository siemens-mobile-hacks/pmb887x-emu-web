# Diagnostics toolkit

Everything here lives in `tools/` (playwright-core + the
playwright-downloaded Chromium; `npm i` in that dir once). Most tools
take the test fullflash from `tools/testflash.local.json` (copy the
`.example`) and the server port from `PORT` (default 8080).

## Page URL parameters

| Param | Effect |
|---|---|
| `?dist=<dir>` | build output under `site/` to run: default `dist-jit` (wasm64 TCG backend); any `dist-*` A/B snapshot |
| `?icount=<spec>` | run `-icount <spec>` instead of the default `-accel tcg,thread=multi,vcpu-timers=on,vcpu-timers-bank=30,vcpu-timers-idle-lead=2000,cross-page-links=on` (`shift=3,sleep=off` = the deterministic, unpaced model the lockstep tools use; `none` = plain realtime clock). A `?qargs=` that carries its own `-accel` also drops the default |
| `?bank=<s>` | `vcpu-timers-bank`: for the guest's first `<s>` seconds of its own clock (default 30, the boot) time lost to a slow host is caught up — whenever the guest idles — instead of dropped; `0` = upstream (lag over 100 ms is dropped). The clock never runs ahead of wall time. While banked the pill's `slow` warning stays off (see below) |
| `?idlelead=<us>` | `vcpu-timers-idle-lead`: while the guest waits for an interrupt, its virtual timers run in batches up to `<us>` ahead of wall time, so the vCPU thread sleeps once per batch instead of once per timer (the DSP sync timer fires every 100 us). Default 2000; `0` = the idle clock follows wall time exactly. A build older than the option needs `?qargs=` with its own `-accel` |
| `?trace=<channels>` | `-debug-channels log=<channels>,io=<channels>` (e.g. `trace=dsp,scu`): log lines and register accesses of the matching devices. A channel is a pattern matched against device ids, QOM types and their parents, and subchannels (`dsp.*`); the flash is `cfi-flash`. qemu exits on a pattern that matches nothing (`qemu/qemu-options.hx`) |
| `?tracebuf=1` | buffer raw stderr in `window.__qemulog` (no console flood) |
| `?debug=1` | print every stderr line to console (no dedup) |
| `?qargs=<args>` | append raw qemu arguments (e.g. `qargs=-d exec -D /exec.log`) |
| `?env=NAME=VAL` | extra environment for the build (repeatable) — what qemu still reads is its own section below |
| `?suite=<url>` | boot a bare-metal versatilepb image instead of a phone (`dist/tcgisa.bin`, `dist/tcgbench.bin`); with `?icount=1` the suite runs under `-icount shift=3,sleep=off` (the tcgbench icount-tax leg) |
| `?lockstep=1` (+ `ls-*`) | built-in guest-state fold on the wasm64 backend — the b-side of `tools/lockstep-wasm.mjs`; `ls-*` params (`insns`, `period`, `epoch`, `meminsns`, `mem`, `from`, `to`) set the insn budget and grid |
| `?sound=off` | no audiodev at all (the benchmarks use it, so the audio timer never enters a measurement) |
| `?serialpoll=1` | don't tap the serial log's MEMFS ops — read the file on a 1 Hz timer instead (the page's fallback path; `SERIAL_POLL=1 tools/exitcheck.mjs` takes it through the EXIT checks) |
| `?vp=1` | draw the viewport height budget on the page (it also shows itself on a real overflow; see architecture.md § Page) |

Fullflash, device, IMEI/ESN, SIM, operator, startup and the Siemens key mode
are form controls in the Firmware panel, not params. **Copy diagnostics**
carries the last of those as `siemensMode`, and what it did to this run's
image as `siemensKeys` (`replaced`/`complete` for a recalculation, the
recovered `esn` and whether it came from the cache for a sweep).
The pflash drive is always writable (there
is no longer a "writable flash" checkbox, and `tools/session.mjs` ignores a
`rw=1` token) — the image only lives in this run's MEMFS, and **Export ▸
Flash** in the Run panel hands that copy back. So is the stats HUD:
a two-line strip sampled at 2 Hz. Line 1 is this second's guest: speed
(`1.00×` — virtual seconds per wall second, 1.0 = real time, below it the
guest is compute-bound; green ≥ 0.95, amber ≥ 0.80, red under), `MIPS`
(guest insns/s; under `?icount=shift=3`, 125 = real time), `fps`, the
page's own paint cost in `ms`, `lag` (wall − virtual: time the guest has
lost to a slow host) and `halt/s`. `lag` counts from the run start, or
from the end of the bank (`?bank=`) once that has happened — after the
bank the clock *drops* lag over 100 ms rather than paying it back, so
carrying the boot's lag past that point would show an amber token for a
debt that no longer exists. Line 2 is the machine:
a short user agent (`Android 8 · Chrome 147 · SM-G955U`), cores, memory and
`isolated`. Narrow screens drop whole tokens off the line rather than wrap
or shrink, paint first.

**"Performance HUD"** in the Run panel draws it — under the status pill on
desktop, and at phone widths (where the panel is the settings sheet) as an
overlay on the top edge of the screen box, which waits for a guest rather
than covering the idle panel. It used to be `?hud=1`, then a band across the
top of the page. The choice is remembered; with none stored it starts on at
phone widths, the one place with no debugger to fall back to, and off on
desktop. Either way the pill itself turns amber and gains `· slow` after
three seconds under 0.80× — except while the clock is still banked
(`?bank=` above), where below 1.00× is a guest that is behind and will
catch up, not a slow one. The three-second
hysteresis restarts when the bank ends. The HUD's own `×` and `lag` tokens keep
their colours throughout: the strip is a raw instrument, the pill is a
judgement about whether the user should care.

**"Copy diagnostics"**, beside the toggle, puts the last 60 s of samples,
the 10 s averages, the environment and the full unmodified user agent on the
clipboard as JSON — which is how a phone without a debugger reports its own
number. `window.__hud.diagnostics()` returns the same object.

## Runtime knobs (`?env=NAME=VAL`, repeatable)

The 2026-09-22 review removed every `W64_*` tuning, TB-shape, measurement
and debug knob, and `QEMU_IO_REWIND` and `QEMU_LOG_PABT` with them,
compiling each one's default in. Old handoff rounds and the playbook still
name them because that is how those numbers were taken; an `?env=` of one
of them now does nothing, so an A/B of a mechanism is a build (see
`tools/perf/swab.sh` below). What qemu still reads (`git grep getenv` in
the submodule):

| Variable | Effect |
|---|---|
| `W64_LOCKSTEP`, `W64_LOCKSTEP_*` | the page's built-in guest-state fold; set by `?lockstep=1` + `ls-*` and driven by `tools/lockstep-wasm.mjs`, not set by hand |
| `QEMU_COSTACK=1` | coroutine-stack audit (see the Asyncify work in lessons.md) |
| `PMB887X_BOARD`, `PMB887X_STARTUP`, `PMB887X_FLASH0_OTP0/1`, `PMB887X_FLASH0_EFA_FILE` | set by the page (and `run-native.sh`) from the Firmware panel and the EFA sidecar |
| `PMB887X_MEMORY_TIMING=1`, `PMB887X_WAIT_FOR_SERIAL=1` | upstream board options (`hw/arm/pmb887x/board.c`) |

## Exports on `window.__qemu` (the emscripten module)

`_wasm_fb_ptr/_width/_height/_stride/_take_dirty/_updates`,
`_wasm_vclock` (guest ns), `_wasm_insns` (guest instructions executed),
`_wasm_halts` (vCPU idle entries — the HUD's `halt/s` and the stall
detector), `_wasm_clock_banked()` (1 while the `vcpu-timers-bank` window
is open), `_wasm_audio_ring_ptr()` (the ring `audio-worklet.js` reads),
`_wasm_send_key(lnx, down)`, `_wasm_quit()`, and the runtime's `FS`,
`ENV`, `HEAPU8`, `TTY`, `addFunction`/`removeFunction`.

The `wasm_memstat` counters (`include/qemu/wasm-diag.h`) and the tool-only
probes (`_wasm_tbs`, `_wasm_reg/_pc/_peek`, `_wasm_irq_pending`) went in
the 2026-09-22 review. Tools written against them read 0 where they guard
the call (uibench, stopwatch, keylag, serialwatch, memstat, diagprobe)
and fail outright where they do not (diagall, counters, modcost,
haltprobe, workbench, peekcode, and anything importing
`tools/diagnames.mjs`, which throws on the missing header).
`videobench.mjs` is broken as well (boot detection, the removed real-time
cap); scenebench's `video` scene replaces it.

## When the guest stops dead (`site/app.js` §6b)

The vCPU is a worker thread and the page's state machine never hears
about one that dies or wedges, so a dead guest used to read "Running ·
0:21" behind a frozen splash screen — which is exactly what the round-29
lost-wakeup bug looked like on a phone, where there is no console to read
a log from.

The page now watches three counters and calls a stall when instructions
(`_wasm_insns`), halts (`_wasm_halts`) and display reads
(`_wasm_fb_updates`) are frozen **together** for 15 s. All three,
because a guest asleep in WFI stops retiring instructions while its halt
count keeps moving and the display keeps being read — one counter alone
cannot tell idle from dead. Fifteen seconds because a GC pause, a
compile burst or a merely slow phone must never be called dead, and it
still lands while the user is still looking at the splash.

What you get: the pill goes `· stopped` and turns red, an overlay says
how long it has been still plus either the worker's fatal message or the
last non-blank line qemu printed, and **Copy diagnostics** carries
`stalled`, `fatal` and a 40-line `log` tail (also on `window.__qemutail`).
The fatal message needs its own hook — a pthread that aborts, traps or
fails an allocation surfaces on the main thread as an `error` event and
nowhere else, so without the listener and `onAbort` the vCPU dying is
completely silent. The detector clears itself if any of the three
counters moves again, so a guest that recovers un-stalls.

## Scripts that matter

**Gates** (correctness — parallel-safe, run them through
`scripts/gate.sh`) and **benchmarks** (measurement — one at a time on a
quiet host) are different things, and mixing them is how a session gets
both a slow loop and a wrong number. `scripts/gate.sh quick|keep|close`
builds the native references (`build-native.sh`, `build-native-tci.sh`)
first, then runs the whole gate set concurrently and prints one verdict
table; the benchmarks below are never in it.

Benchmarks — the meters:

| Script | Purpose |
|---|---|
| `tools/perf/swab.sh` | **the A/B meter for a mechanism change**: `swab.sh <scene> <distA> <distB> [pairs 1-4] [measure s]` runs both legs of a scenebench scene at once on pinned physical cores, pairs alternating sides, with V8's explicit bounds checks on (the Android configuration) and the guest clock switched to free-run when the window opens, so a leg's `vratio` is pure compute. Both dists must be built with `tools/perf/freerun.diff` applied (it adds the bench-only `_wasm_free_run`); method and pitfalls in doc/performance.md |
| `uibench.mjs` | per-board steady-state: MIPS, v/wall and fps at the idle screen and while the menu is driven. The only meter that sees a board-specific mechanism — rounds 4–9 measured the S75 only and both round-ten findings were invisible there |
| `idlebench.mjs` | the end-to-end boot benchmark: fresh headless browser per run, S75v40lg1 to the idle screen (LCD bottom-139-rows vs a committed reference), guest-work milestones `t0.1G…t1.3G`, the v=2..7 window, A/B ratios between dists in one invocation, regression verdict vs `tests/results/idlebench-latest.json`; `--quick` (~1 min/dist), `--runs N`, `BANK=<s>` (sets `?bank=`), a dist may be `<dir>@<query>` to add page parameters to one leg; `--board ke800` boots the LG fullflash (+ EFA sidecar) to its idle screen (`tools/test_targets/KE800-v11b_idle.png`, bottom 150 rows) — tIdle is its number, its own `idlebench-ke800-latest.json` baseline; the `-lcd.png` of any run is the canvas at its own resolution, i.e. a reference candidate |
| `tcgbench.mjs` | fast-iteration perf bench on versatilepb (`tests/tcgbench`): per-phase backend A/B + the device/icount-tax mirrors (`mmiopoll`/`rampoll`/`mmiow` ns/access, `ICOUNTS=0,1`, `SUITE=quick`) |
| `keylag.mjs` | key-press response latency per board — the meter for the EL71 key-lag complaint |
| `stopwatch.mjs` | J2ME pacing meter: boots S75v40lg1, walks the keypad to Extras → Stopwatch and prints `vratio` (virtual s per wall s); `--devtools <port> --hold <s>` keeps the running app open for `wprof2.mjs PROF_ATTACH=<port>`; `CHROME_ARGS="--js-flags=--liftoff-only"` passes browser switches (a phone-tier A/B: `--liftoff-only` pins V8's baseline tier, `--no-liftoff` pins TurboFan; `--no-wasm-tier-up` is a no-op in Chrome 153) |
| `scenebench.mjs` | Scenario benchmark, one fresh browser per run, dists interleaved (`dist@query` legs). EL71v41: `stopwatch` (Extras → Stopwatch, a compute-bound full-screen redraw over the DIF/DMAC LCD bus: `vratio`), `music` (My stuff → Sounds → an AAC track in the media player: `underruns` with `underrunAt` [second, audio rendered per second], `gapMs`/`gapPct` silenced by dropouts, `cushionMs` the worklet grew to, `produced` ring seconds per wall second, `minFillMs`/`maxFillMs` the ring delay sampled once a second, `drainedMs`/`cutMs` ring audio skipped to cut the delay (played faster, or cut at the 500 ms cap), `stretchedMs` ring audio replayed to play slower while the guest renders slower than real time, `peak`), `idle` (the idle screen). SL65v49 (TIM): `midi` (My stuff → Sounds → Poly → Asia, a looping MIDI; the same audio numbers), `video` (My stuff → Videos → Berlin.3gp). S75 working: `bobby` (Games → Bobby Carrot 3 Evolution, J2ME, its sound on, Bobby walking through the first level; `vratio`, `fps` and the audio numbers), `towerblox` (Games → Tower Bloxx, J2ME, with its sound). Every scenario reports `cpu`, host cores the browser used. Navigation is checked against `tools/test_targets/<phone>_*.png` and redone on a dropped key. Wrap in `tools/slowhost.sh` for a slow machine. `SCENEBENCH_DEVTOOLS=<port>` opens the browser's CDP port and logs `measuring` when the window starts, for `PROF_ATTACH=<port> node tools/wprof2.mjs` |
| `parbench.sh` | Fast A/B over `scenebench.mjs`: `tools/parbench.sh bobby dist-a,dist-b 4 30` runs every run of every dist as a concurrent single-run scenebench (~2.5 min instead of ~20). The absolute `cpu` reads higher under the contention but the legs share it; noise ~±1 %, so repeat a marginal result with the dists swapped; keep runs × dists ≤ ~8 (more saturates the host and shows as underruns) |
| `loadbench.mjs` | startup-path benchmark (download, compile, instantiate) |
| `ab.mjs` | parallel boot-survival A/B of query variants against the deployed dist (`scripts/iterate.sh` uses it) |
| `slowhost.sh` | run a command on a "phone-sized" slice of this host (pinned cores + same-priority spinners) |

Gates — `scripts/gate.sh quick|keep|close` runs these; the individual
commands are worth knowing only for reproducing one failure:

| Script | Purpose |
|---|---|
| `bootcheck.mjs` | the five-fullflash browser gate: boots s75/el71/ke800/ke970/cx70 on one dist and judges progress in executed instructions; on a firmware `>>EXIT<<` it waits for the panic text and saves the serial tail (`tests/results/bootcheck-<dist>-<board>-serial.txt`); `--query "trace=dsp,scu&tracebuf=1"` adds page parameters to every board and saves the buffered stderr/device trace per board (`…-trace.txt`); `--flash s75,el71` boots the boards in that order as consecutive pages of one browser, which is its own test condition (the second page starts from cache at full speed) |
| `earlykey.mjs` | a key event delivered at the earliest instant the export exists must not take the module down (0081). One board per invocation |
| `tcgisa.mjs` | drives the guest op-suite on one page leg: `node tcgisa.mjs <port> <dist> [out] [ENV=VAL…]`. `scripts/run-tcg-isa.sh` is the gate and runs it once per built dist, comparing each against the native JIT serial log |
| `lockstep.mjs`, `lockstep-wasm.mjs` | cross-backend value-equality drivers — native JIT vs native TCI (plugin) / native JIT vs the wasm page (built-in fold); `scripts/run-lockstep.sh` is the native gate. `lockstep-wasm.mjs` refuses a reference whose `qemu-source.txt` is missing or names other qemu sources than the dist's (`--no-ref-check` skips that, `--a-bin` picks another native build) |
| `ffboot.mjs` | boot a dist in Playwright's Firefox (cross-browser smoke; `BROWSER=chromium` too) — `errors=0` and `progress=ok` (guest clock ≥ 20 s, the screen drew, insns still rising over the last 20 s); the `temp=` module count went with the 2026-09-22 review's counters |
| `tests/run.mjs` | the native suite: five fullflashes (s75/el71/c81/ke800/ke970) booted with `run-native.sh`'s recipe, plus an insncount MIPS benchmark. Blind to every wasm-only path, which is why the browser gates exist |

Profiling:

| Script | Purpose |
|---|---|
| `modfloor.mjs` | synthesizes wasm modules of chosen shapes and times `new WebAssembly.Module` — the page-side floor to compare the emulator's own 83 µs against |
| `modgrow.mjs` | the one variable `modfloor` holds fixed: does module creation slow down as live modules accumulate?  Keeps every instance while building thousands, prints cost per bucket, then drops them all and re-measures.  Answer for the record: **flat** at ~50 µs from 500 to 6000 live, and dropping them changes nothing — the emulator's ~80 µs fixed cost is not the live set |
| `dispatch-probe.mjs` | what one TB→TB dispatch costs.  F functions of the real TB signature spread over a configurable number of module instances, each tail-calling the next index of a pseudo-random sequence; `--stride` adds the dependent descriptor load 0091 removed.  The mechanism is 2.4 ns; **the cost is locality** (5.5 ns at a 1-function working set → 46 ns at 4096) |
| `locals-probe.mjs` | what the backend's ~70 declared locals cost, by tier — wasm zeroes locals at entry and the baseline tier cannot drop the unused ones.  `--liftoff` pins the baseline tier, `JS_FLAGS=` passes any V8 flag.  `--split` also gives the per-module compile floor (~8 µs + 7–12 µs/KB) |
| `abortlog.mjs` | boots `BOARD=` (el71/s75/cx70/ke800) and prints every console line and pageerror verbatim.  The tool for "the run died and the meter only said so three layers up": a firmware panic arrives as a serial line (`sorry died at ...`), and a meter surfaces it as an unhandled Node exception about `wasm_insns` after runtime exit |
| `tierup-probe.mjs` | how many calls a wasm function needs to leave the baseline tier, and whether that depends on its size.  One continuous run per body size in a fresh instance, timed in chunks.  Answer: **~1–2.4 × 10⁴ calls across an 85× size range** — per call, not size-weighted |
| `import-probe.mjs` | what a TB module's helper call costs just for crossing the module boundary, four ways (local / `instance.exports` / `wasmTable.get()` / `call_indirect`).  **2.1–2.4 ns** optimized, 3.6–4.4 ns baseline — it is not where a helper's time goes |
| `wprof2.mjs` | per-worker CDP profiler with `wasm-function[N]` → symbol resolution via the `.symbols` sidecar; `PROF_DELAY=<s>` picks the boot phase, `PROF_FN=<substr>` prints caller stacks, `PROF_ATTACH=` profiles a page another tool drove, `PROF_SAVE=<json>` keeps the raw profile. **Self-time names a neighbourhood, not a function** — confirm with an A/B or a volatile-spin probe before believing a rank |
| `profcat.mjs`, `profjit.mjs` | categorize a saved profile by cost class; distribution of JIT-guest self time over TB functions |
| `threadmap.mjs`, `syscallprobe.mjs` | thread census / syscall CPU attribution |
| `asyncify-audit.mjs` | which frames the Asyncify onlylist still needs (`QEMU_COSTACK=1` is the evidence half) |

Probes and traces:

| Script | Purpose |
|---|---|
| `smoke.mjs`, `verify-boot.mjs`, `wshot.mjs`, `screenshot.mjs` | boot once / verify + insn rate / screenshot after the splash |
| `serialwatch.mjs [s] [query]` | push vclock/serial/fb/insns via console every 10 s — the general-purpose probe |
| `conlog.mjs` | capture qemu console lines matching a prefix (`MATCH=`, `SAVE_FS=` pulls MEMFS files out) |
| `iotrace.mjs`, `tracebuf.mjs`, `tracedump.mjs`, `dsplive.mjs` | `?trace=` (`-debug-channels`) captures (buffered / live-filtered) |
| `execdump.mjs`, `tracediff.mjs`, `iorec.mjs` | `-d exec` log dump / TB-sequence diff between builds / io_recompile frequency |
| `w64walk.mjs` | structural walker over a wasm64 backend module |
| `efa-web.mjs`, `preset-web.mjs` | E2E page tests: LG fullflash + EFA sidecar; preset download → cache → boot |
| `exitcheck.mjs` | the Siemens EXIT path end to end: boots an image that panics (default `fullflashes/BROKEN)S66_no_recalc.bin` as `siemens-s65`, ~3 s to the dump) and checks the page stopped the guest, beeped once, dimmed the canvas and started the 30 s fade, and drew the parsed dump over it — desktop and phone layouts, screenshots in `exitcheck*.png`; `--inject` writes the recorded EL71 (x75-shaped) dump into a healthy guest's log instead, once it has drawn something, which is the leg that watches a lit screen fade |
| `session.mjs` + `ctl.mjs` | persistent headless-browser session and its client |
| `vclock.mjs`, `bootmatrix.mjs` | virtual-clock progression per `?icount=` variant; parallel boot matrix over query variants |

## Native reference runs

```
env PMB887X_BOARD=build/bsp/lib/data/board/siemens-s75.toml \
    PMB887X_STARTUP=ONLINE \
    PMB887X_FLASH0_OTP0=02004AB3C31100000000 PMB887X_FLASH0_OTP1=000094104502237315FF \
  build/qemu-native-build/qemu-system-arm -display none -icount shift=3,sleep=off -machine pmb887x \
    -drive if=pflash,format=raw,file=<fullflash>,readonly=on \
    -device gsm-sim,operator=00101 \
    -debug-channels log=dsp,scu,io=dsp,scu -serial file:serial.log -D trace.log
```

(`scripts/run-native.sh` builds this command line from the fullflash
name; pass `-debug-channels …` after the fullflash, as an extra
argument. `-device gsm-sim` plugs into the board's empty
`iso7816-slot`.) A wasm run under `?icount=shift=3,sleep=off` replays the
same instruction stream: diff the trace sequences (`COM_SET` →
`DSP_CFR cleared` → `SCU_DSP_INT` → …) between the native build and
`dist-jit` to find where they diverge and bisect a wasm-only failure.
Remember: `>>EXIT<<` on serial = phone crashed; stop there.
