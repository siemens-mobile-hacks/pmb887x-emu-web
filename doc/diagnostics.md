# Diagnostics toolkit

Everything here lives in `tools/` (playwright-core + the
playwright-downloaded Chromium; `npm i` in that dir once). Most tools
take the test fullflash from `tools/testflash.local.json` (copy the
`.example`) and the server port from `PORT` (default 8080). Four take the
port as an argument instead: `costack-suite.mjs [port] [dist]`,
`tcgisa.mjs [port] [dist] …` and `verify-boot.mjs <tag> <secs> [port]`
(default 8080), and `uidiff.mjs <portA> <portB>`, which compares two
servers. `bootcheck.mjs`, `earlykey.mjs`, `gsmcheck.mjs` and
`lockstep-wasm.mjs` take `--port`, defaulting to `PORT`; they refuse an
option they do not know (exit 2).

## Page URL parameters

| Param | Effect |
|---|---|
| `?dist=<dir>` | build output under `site/` to run: default `dist-jit` (wasm64 TCG backend); any `dist-*` A/B snapshot. Only a bare directory name (letters, digits, `_`, `.`, `-`; not `.` or `..`) is taken; anything else blocks Start with a message |
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
image as `siemensKeys` (`changed`/`complete` for a recalculation, the
recovered `esn` and whether it came from the cache for a sweep).
The pflash drive is always writable — the image only lives in this run's
MEMFS, and **Export ▸ Flash** in the Run panel hands that copy back. The
stats HUD is a control too:
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

**"Performance HUD"** in the Run panel draws it as an overlay on the top
edge of the screen box, at every width, shown only while a guest is booting,
running or paused rather than covering the idle panel. It starts off and the
choice is remembered. Either way the pill itself turns amber and gains `· slow` after
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

## Environment (`?env=NAME=VAL`, repeatable)

The port has no tuning or measurement knobs: an A/B of a mechanism is a
build (`tools/perf/swab.sh`), and a census is a temporary patch
(performance.md, Counters and censuses). What qemu reads
(`git grep getenv` in the submodule):

| Variable | Effect |
|---|---|
| `W64_LOCKSTEP`, `W64_LOCKSTEP_*` | the page's built-in guest-state fold; set by `?lockstep=1` + `ls-*` and driven by `tools/lockstep-wasm.mjs`, not set by hand |
| `QEMU_COSTACK=1` | logs every distinct stack at a coroutine switch, for `tools/asyncify-audit.mjs` (lessons.md, Emscripten runtime) |
| `PMB887X_BOARD`, `PMB887X_STARTUP`, `PMB887X_FLASH0_OTP0/1`, `PMB887X_FLASH0_EFA_FILE` | set by the page (and `run-native.sh`) from the Firmware panel and the EFA sidecar (`hw/arm/pmb887x/board.c`, `board/startup.c`, `board/memory.c`) |
| `PMB887X_MEMORY_TIMING=1`, `PMB887X_WAIT_FOR_SERIAL=1`, `QEMU_ARM_STOP_ON_EXCP` | upstream board options (`hw/arm/pmb887x/board.c`) |

Device tracing and the SIM are qemu options, not environment:
`-debug-channels` (page `?trace=`) and `-device gsm-sim`.

## Exports on `window.__qemu` (the emscripten module)

`_wasm_fb_ptr/_width/_height/_stride/_take_dirty/_updates`,
`_wasm_vclock` (guest ns), `_wasm_insns` (guest instructions executed),
`_wasm_halts` (vCPU idle entries — the HUD's `halt/s` and the stall
detector), `_wasm_clock_banked()` (1 while the `vcpu-timers-bank` window
is open), `_wasm_audio_ring_ptr()` (the ring `audio-worklet.js` reads),
`_wasm_send_key(lnx, down)`, `_wasm_quit()`, `_wasm_accessory_buf()` +
`_wasm_accessory_plug()` (write a NUL-terminated profile name such as
`headset-stereo` or `none` at the buffer, then plug it), `_wasm_net_attach()`,
`_wasm_net_buf()`, `_wasm_net_take()`, `_wasm_net_put(len)` (the GSM cell's
IP side; the page's relay is `window.__gprsNet`, with `frames` counted
both ways), and the runtime's `FS`,
`ENV`, `HEAPU8`, `TTY`, `addFunction`/`removeFunction`. A dist built with
`tools/perf/freerun.diff` also has `_wasm_free_run`.

There are no counter exports: the September ones (`_wasm_memstat`,
`_wasm_tbs`, `_wasm_reg/_pc/_peek`) are gone, and no tool reads them.

## When the guest stops dead (`trackStall` in `site/app.js`)

The vCPU is a worker thread and the page's state machine never hears
about one that dies or wedges. Without a detector a dead guest reads
"Running · 0:21" behind a frozen splash screen, and a phone has no console
to read a log from.

The page watches three counters and calls a stall when instructions
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

Shared code for the tools is in `tools/lib/`: `boards.mjs` (the test
fullflashes by short id, and `expectedBoard()`, the board the page's own
filename rules give a file name), `page.mjs` (loading an own-file fullflash
the way a user does; `bounded()` for a page that may be frozen),
`argv.mjs` (`--name value` options, from a list of the tool's own; any
other exits 2) and `build-dirs.mjs` (the native build
directories and test plugins, with `scripts/build-dirs.sh`'s defaults and
overrides: `WEB_BUILD`, `QEMU_NATIVE_BUILD`, `QEMU_NATIVE_TCI_BUILD`,
`TEST_PLUGINS_DIR`). Three modules at the top of `tools/`
are shared too: `testflash.mjs` (the test fullflash, from `TESTFLASH` or
the gitignored `testflash.local.json`; importing it throws when neither
names an existing file), `ppm2png.mjs` (qemu's `screendump` PPM to the PNGs
in `tests/results`) and `gprs-gateway.mjs` (`startGateway()`: bts-emulator's
`gprs-gw` on loopback for a test, or the one already listening there; used
by `gprscheck.mjs --web` and `ffboot.mjs`).

**Gates** (correctness — parallel-safe, run them through
`scripts/gate.sh`) and **benchmarks** (measurement — one at a time on a
quiet host) are different things. `scripts/gate.sh quick|keep|close`
builds the native references (`build-native.sh`, `build-native-tci.sh`,
into the directories `scripts/build-dirs.sh` names) first, then runs the
whole gate set concurrently and prints one verdict table; the benchmarks
are never in it. How to measure and how to read the numbers:
[performance.md](performance.md).

Benchmarks:

| Script | Purpose |
|---|---|
| `tools/scenebench.mjs` | scenario benchmark, one fresh browser per run: `stopwatch`, `music`, `idle` (EL71), `midi`, `video` (SL65), `bobby`, `towerblox` (S75). Navigation is checked against `tools/test_targets/<phone>_*.png` and redone on a dropped key. Scenes, metrics and options are in performance.md, Benchmarks |
| `tools/perf/swab.sh` | **the A/B meter for a mechanism change**: `swab.sh <scene> <distA> <distB> [pairs 1-4] [measure s]` runs both legs of a scene at once on pinned physical cores, sides alternating, with V8's bounds checks forced and the guest clock free-running. Both dists must be built with `tools/perf/freerun.diff` |
| `tools/perf/bootab.sh`, `tools/bootbench.mjs` | paired boot A/B, paced as on the page: burst wall time, stretched and silent audio, lag |
| `tools/parbench.sh` | `parbench.sh bobby dist-a,dist-b 4 30` runs every run of every dist as a concurrent single-run scenebench. The guest falls behind real time under the contention, which hides costs of the real-time regime; keep runs × dists ≤ ~8 |
| `tools/slowhost.sh`, `tools/dutyhost.sh` | slow-host models for big effects: pinned cores shared with spinners, or the whole process tree stopped and resumed |
| `tools/tcgbench.mjs` | per-phase backend bench on versatilepb (`tests/tcgbench`), with the `mmiopoll`/`rampoll`/`mmiow` device-tax mirrors |
| `tools/idlebench.mjs` | boot to the idle screen in a fresh browser per run, with guest-work milestones and A/B ratios between dists (`BANK=<s>` sets `?bank=`, a dist may be `<dir>@<query>`) |
| `tools/uibench.mjs`, `tools/keylag.mjs` | per-board steady state (MIPS, v/wall, fps); key-press response latency per board |
| `tools/loadbench.mjs` | startup path (download, compile, instantiate) |
| `tools/ab.mjs` | parallel boot-survival A/B of query variants against the deployed dist (`scripts/iterate.sh` uses it) |

Gates — `scripts/gate.sh` runs these; the individual commands are worth
knowing only for reproducing one failure:

| Script | Purpose |
|---|---|
| `bootcheck.mjs` | the five-fullflash browser gate: boots s75/el71/ke800/ke970/cx70 on one dist and judges progress in executed instructions; on a firmware EXIT dump (`>>EXIT<<` on x75/x85, the bare `EXIT: <code>` line on the x65 CX70) or a page that went back to idle it fails the board, waits for the panic text and saves the serial tail (`tests/results/bootcheck-<dist>-<board>-serial.txt`); `--query "trace=dsp,scu&tracebuf=1"` adds page parameters to every board and saves the buffered stderr/device trace per board (`…-trace.txt`); `--flash s75,el71` boots the boards in that order as consecutive pages of one browser, which is its own test condition (the second page starts from cache at full speed) |
| `earlykey.mjs` | a key event delivered at the earliest instant the export exists must not take the module down. One board per invocation |
| `tcgisa.mjs` | drives the guest op-suite on one page leg: `node tcgisa.mjs [port] [dist] [out] [ENV=VAL…]`. `scripts/run-tcg-isa.sh` is the gate and compares each built dist against the native JIT serial log |
| `lockstep.mjs`, `lockstep-wasm.mjs` | cross-backend value-equality drivers — native JIT vs native TCI (plugin) / native JIT vs the wasm page (built-in fold); `scripts/run-lockstep.sh` is the native gate. `lockstep-wasm.mjs` refuses a reference whose `qemu-source.txt` is missing or names other qemu sources than the dist's (`--no-ref-check` skips that, `--a-bin` picks another native build). Both remove their `/tmp/lockstep-<label>-<stamp>` run dirs when every run was clean (`--keep` keeps them). The wasm leg's register and SDRAM digests are sampled at other instructions than the native leg's, so they hardly ever match; why, and what the gate checks meanwhile: performance.md, What lockstep-wasm compares |
| `ffboot.mjs` | boot a dist in Playwright's Firefox (`BROWSER=chromium` too) — `errors=0` and `progress=ok` (guest clock ≥ 20 s, the screen drew, insns still rising over the last 20 s) |
| `gprscheck.mjs` | EL71: boot with the built-in cell, open an 8 KB page served on this host (`gprs-host.mjs`) in the phone's browser, and check that the host gets the GET and the page shows on the LCD. Native: a slirp netdev (needs qemu with slirp); `--web`: the page's GPRS relay through `serve.mjs` to bts-emulator's `gprs-gw`, started from a checkout next to this repository ([gsm-network.md](gsm-network.md)) |
| `gsmcheck.mjs` | boot a phone with the GSM option and check that it registers on the built-in cell (status icons against a reference picture; EL71), that the page opened no socket but its GPRS relay and that keys are answered a minute later; `--gsm 0` unticks the option, the negative control ([gsm-network.md](gsm-network.md)) |
| `tests/run.mjs` | the native suite: five fullflashes (s75/el71/c81/ke800/ke970) booted with `run-native.sh`'s recipe, plus an insncount MIPS benchmark. Blind to every wasm-only path, which is why the browser gates exist |
| `detect-check.mjs`, `detect-web.mjs`, `efa-web.mjs`, `preset-web.mjs`, `engine-prefetch-web.mjs`, `ui-acceptance.mjs` | page tests: device detection (headless and through the page; each file must land on the board the page's own filename rules give its real name, a name with no model is skipped, and a board without a display must be refused with a note), LG fullflash + EFA sidecar, preset download → cache → boot, the engine's background download, the layout |

Profiling:

| Script | Purpose |
|---|---|
| `tools/perf/v8tick.py` | resolves a V8 `--prof` log of the vCPU isolate into self-time buckets; the precise sampler (performance.md, Profiling) |
| `wprof2.mjs` | per-worker CDP profiler with `wasm-function[N]` → symbol resolution via the `.symbols` sidecar; `PROF_ATTACH=` profiles a page another tool drove, `PROF_DELAY=<s>` picks the boot phase, `PROF_FN=<substr>` prints caller stacks, `PROF_SAVE=<json>` keeps the raw profile. **Self time names a neighbourhood, not a function** |
| `profcat.mjs`, `profjit.mjs` | categorize a saved profile by cost class; distribution of JIT-guest self time over TB functions |
| `tools/perf/wasmgrab.mjs`, `tools/perf/wasm-bhint.mjs` | save a running page's hottest TB modules to read their TurboFan code; add a branch-hint section to a captured module |
| `threadmap.mjs`, `syscallprobe.mjs` | thread census / syscall CPU attribution |
| `asyncify-audit.mjs`, `costack-suite.mjs` | which frames the Asyncify onlylist still needs (`QEMU_COSTACK=1` is the evidence half); `costack-suite.mjs [port] [dist]` collects that evidence from the op-suite page, every distinct `[qemu] COSTACK` stack |
| `modfloor.mjs`, `modgrow.mjs`, `modshape-probe.mjs`, `dispatch-probe.mjs`, `dispsize-probe.mjs`, `callref-probe.mjs`, `locals-probe.mjs`, `tierup-probe.mjs`, `import-probe.mjs`, `merge-probe.mjs`, `bcprobe.mjs`, `tests/wasm/dispatchbench.mjs` | synthetic V8 probes that build their own wasm modules in a page: module creation cost, dispatch mechanisms and locality, declared locals by tier, tier-up, cross-instance calls, the memory bound check by memory type (`bcprobe.mjs --chrome`). Their September results are in performance.md (Closed ideas) and lessons.md (wasm and V8) |
| `wasmclone-probe.mjs`, `wasmcache-probe.mjs` | the AOT-cache question in two parts, `PORT=<p> node tools/<probe> [--count N] [--browsers chromium,firefox]`: whether a `WebAssembly.Module` restored from IndexedDB skips compilation and what persisting it costs, then whether Chromium's wasm code cache serves `compileStreaming` of Cache API responses. Both answered no (performance.md, Closed ideas, AOT cache) |
| `interp-probe.c` | the same TCI-shaped interpreter loop built native (`gcc -O2`) and to wasm (`emcc -O3 … -sENVIRONMENT=node`), to price an interpreted guest instruction in wasm against native (lessons.md; 7.3 ns per op both ways) |

Probes and traces:

| Script | Purpose |
|---|---|
| `smoke.mjs`, `verify-boot.mjs`, `wshot.mjs` | boot once / verify + insn rate / screenshot after the splash. `verify-boot.mjs <tag> <secs> [port]` fails on a firmware EXIT, a page error or qemu exiting; `SIEMENS_MODE=as-is` (or `recalc`, `recover-esn`) picks the Siemens keys mode, and with `TESTFLASH` set to the broken S66 image that boots it into its EXIT |
| `compare-lcd.mjs <secs> <reference.png>` | boot the test flash to its idle screen and compare the LCD with a reference picture (`tools/test_targets/`); fails over `MAX_DIFF` percent (5) of the pixels, on a size mismatch or an EXIT |
| `uidiff.mjs <portA> <portB>` | the keypad and side-key boxes, relative to the LCD, of two served copies of the page; prints every key that moved |
| `serialwatch.mjs [s] [query]` | push vclock/serial/fb/insns via console every 10 s — the general-purpose probe |
| `conlog.mjs` | capture qemu console lines matching a prefix (`MATCH=`, `SAVE_FS=` pulls MEMFS files out) |
| `iotrace.mjs`, `tracebuf.mjs`, `tracedump.mjs`, `dsplive.mjs` | `?trace=` (`-debug-channels`) captures (buffered / live-filtered) |
| `iotrace2.mjs` | `TRACE=<channels> iotrace2.mjs --board <s75\|el71\|ke800\|cx70>`: the same trace summarised as a ranked table of the MMIO registers the firmware touches, for "what is it spinning on" |
| `execdump.mjs`, `iorec.mjs` | `-d exec` log dump / io_recompile frequency |
| `exitcheck.mjs` | the Siemens EXIT path end to end: boots an image that panics (default `fullflashes/BROKEN)S66_no_recalc.bin` as `siemens-s65`, picked once detection lands, with the Siemens keys run as is, ~5 s to the dump; the default recalculation would repair that image's keys, and it would never panic) and checks the page stopped the guest, beeped once, dimmed the canvas and started the 30 s fade, and drew the parsed dump over it — desktop and phone layouts, screenshots in `exitcheck*.png`; `--inject` writes the recorded EL71 (x75-shaped) dump into a healthy guest's log instead, once it has drawn something, which is the leg that watches a lit screen fade |
| `audioprobe.mjs`, `recprobe.mjs` | the sound path and the video capture (README, Sound) |
| `recalc-check.mjs`, `keysboot.mjs` | the Siemens key module without a browser; a boot through every key mode |
| `session.mjs` + `ctl.mjs` | persistent headless-browser session and its client; a command that reads the page (`status`, `wait`, `rate`, `serial`) fails after 20 s on a page whose main thread is frozen |
| `vclock.mjs`, `bootmatrix.mjs` | virtual-clock progression per `?icount=` variant; parallel boot matrix over query variants |

## Native reference runs

```
env PMB887X_BOARD=bsp/lib/data/board/siemens-s75.toml \
    PMB887X_STARTUP=ONLINE \
    PMB887X_FLASH0_OTP0=02004AB3C31100000000 PMB887X_FLASH0_OTP1=000094104502237315FF \
  build/qemu-native-build/qemu-system-arm -display none -icount shift=3,sleep=off -machine pmb887x \
    -drive if=pflash,format=raw,file=<fullflash>,readonly=on \
    -device gsm-sim,operator=00101 \
    -debug-channels log=dsp,scu,io=dsp,scu -serial file:serial.log -D trace.log
```

(`build/qemu-native-build` is the JIT build's default directory; it is
`$QEMU_NATIVE_BUILD` when that is set, else `$WEB_BUILD/qemu-native-build`
when `WEB_BUILD` is.
`scripts/run-native.sh` builds this command line from the fullflash
name; pass `-debug-channels …` after the fullflash, as an extra
argument. `-device gsm-sim` plugs into the board's empty
`iso7816-slot`.) A wasm run under `?icount=shift=3,sleep=off` replays the
same instruction stream: diff the trace sequences (`COM_SET` →
`DSP_CFR cleared` → `SCU_DSP_INT` → …) between the native build and
`dist-jit` to find where they diverge and bisect a wasm-only failure.
Remember: `>>EXIT<<` on serial = phone crashed; stop there.
