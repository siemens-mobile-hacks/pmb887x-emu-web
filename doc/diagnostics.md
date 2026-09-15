# Diagnostics toolkit

Everything here lives in `tools/` (playwright-core + the
playwright-downloaded Chromium; `npm i` in that dir once). Most tools
take the test fullflash from `tools/testflash.local.json` (copy the
`.example`) and the server port from `PORT` (default 8080).

## Page URL parameters

| Param | Effect |
|---|---|
| `?dist=<dir>` | build output under `site/` to run: default `dist-jit` (wasm64 TCG backend); `dist` = the TCI interpreter; any `dist-*` A/B snapshot |
| `?icount=<spec>` | override `-icount` (default `shift=3,sleep=off`; `none` for `lg-*` devices — `precise-clocks=on`, `shift=N`, `none`, …) |
| `?rt=off\|banked\|banked:<n>\|strict` | `QEMU_ICOUNT_RTCAP` — the real-time cap on the sleep=off idle warp. Default **`banked:30`**: `banked` (the boot is never throttled, idle time is paced to wall) for the guest's first 30 seconds of *its own* clock, then `strict` (lag is forgiven rather than banked, so a later stall is not repaid by sprinting the phone's clock). `<n>` is guest seconds, not wall seconds — the boot costs the same virtual time on every host but anywhere from 39 s to minutes of wall. Plain `banked` and `strict` are pinned for the whole run and are the stable A/B legs; benchmarks pass `rt=off` to measure engine speed. While the cap is still banking the pill's `slow` warning stays off (see below) |
| `?icount2debug=1` | `QEMU_ICOUNT2_DEBUG=1` — only meaningful with `?icount=precise-clocks=on`: prints the controller state each second |
| `?trace=<channels>` | `PMB887X_TRACE_IO/LOG` (e.g. `trace=dsp,scu`); channels: dsp, scu, gptu, tpu, vic, capcom, usart, rtc, … |
| `?tracebuf=1` | buffer raw stderr in `window.__qemulog` (no console flood) |
| `?debug=1` | print every stderr line to console (no dedup) |
| `?qargs=<args>` | append raw qemu arguments (e.g. `qargs=-d exec -D /exec.log`) |
| `?env=NAME=VAL` | extra environment for the build (repeatable) — wasm64 knobs such as `W64_SPEC_N`, `W64_LIVE_MAX`, `W64_COMPACT_BATCHES`/`W64_COMPACT_MEMBERS`, `W64_NOTLB=1`, `W64_TBSTATS=1` (per-TB-entry counters under icount, so `wasm_tbs` reads non-zero), `W64_DEBUG=1`, `W64_NOLC=1` (0046 inline next-TB lookup cache off: same-wasm knob A/B), `W64_LC_VERIFY=1` (every goto_ptr goes through the helper, which cross-checks each would-be inline hit — `lcVhit`/`lcVbad` in `tools/diagall.mjs`) |
| `?w64debug=1` | wasm64 backend console diagnostics (batch histogram, module events) |
| `?env=QEMU_LOG_PABT=1` | one stderr line per guest prefetch abort / BKPT (IFSR, IFAR, pc, lr, sp, cpsr) — the tool that pinned the W-12 panic; combine with `tracebuf=1`, never with `-d int` (its per-IRQ volume shifts timing enough to hide a race) |
| `?suite=<url>` | boot a bare-metal versatilepb image instead of a phone (`dist/tcgisa.bin`, `dist/tcgbench.bin`); with `?icount=1` the suite runs under the phones' stock timing model (the tcgbench icount-tax leg) |
| `?lockstep=1` (+ `ls-*`) | built-in guest-state fold on the wasm64 backend — the b-side of `tools/lockstep-wasm.mjs`; `ls-*` params set the insn budget and grid |
| `?iorewind=1` | force the stock io-recompile everywhere (0004's A/B escape hatch) |
| `?serialpoll=1` | don't tap the serial log's MEMFS ops — read the file on a 1 Hz timer instead (the page's fallback path; `SERIAL_POLL=1 tools/exitcheck.mjs` takes it through the EXIT checks) |

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
(guest insns/s; 125 = real time under the stock `shift=3`), `fps`, the
page's own paint cost in `ms`, `lag` (wall − virtual: what the real-time cap
still owes) and `halt/s`. `lag` counts from the run start, or from the
banked→strict switch once that has happened — strict *forgives* the debt
rather than paying it back, so carrying the boot's lag past the switch would
show an amber token for a debt that no longer exists. Line 2 is the machine:
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
three seconds under 0.80× — except while the real-time cap is still banking
(`?rt=` above), where below 1.00× is what a boot looks like by construction:
the guest is behind and allowed to catch up, not slow. The three-second
hysteresis restarts at the switch. The HUD's own `×` and `lag` tokens keep
their colours throughout: the strip is a raw instrument, the pill is a
judgement about whether the user should care.

**"Copy diagnostics"**, beside the toggle, puts the last 60 s of samples,
the 10 s averages, the environment and the full unmodified user agent on the
clipboard as JSON — which is how a phone without a debugger reports its own
number. `window.__hud.diagnostics()` returns the same object.

## Exports on `window.__qemu` (the emscripten module)

`_wasm_fb_ptr/_width/_height/_stride/_take_dirty/_updates`,
`_wasm_vclock` (guest ns), `_wasm_tbs/_wasm_insns` (per-TB stats),
`_wasm_reg(n)/_wasm_pc()/_wasm_peek(addr)` (guest state probes),
`_wasm_irq_pending()`, `_wasm_memstat(idx)` (the cold-path diagnostic
counters of `include/qemu/wasm-diag.h` — indices are positional, re-derive
them from the header after every edit: `grep WASM_DIAG_ | nl`),
`_wasm_send_key(lnx, down)`, `_wasm_quit()`, `FS`, `ENV`.

## Scripts that matter

Benchmarks and gates:

| Script | Purpose |
|---|---|
| `idlebench.mjs` | the end-to-end boot benchmark: fresh headless browser per run, S75v40lg1 to the idle screen (LCD bottom-139-rows vs a committed reference), guest-work milestones `t0.1G…t1.3G`, the v=2..7 window, A/B ratios between dists in one invocation, regression verdict vs `tests/results/idlebench-latest.json`; `--quick` (~1 min/dist), `--runs N`, `RT=banked`, a dist may be `<dir>@<query>` for knob A/Bs; `--board ke800` boots the LG fullflash (+ EFA sidecar, no icount) to its idle screen (`tools/test_targets/KE800-v11b_idle.png`, bottom 150 rows) — tIdle is its number, its own `idlebench-ke800-latest.json` baseline; the `-lcd.png` of any run is the canvas at its own resolution, i.e. a reference candidate |
| `tcgbench.mjs` | fast-iteration perf bench on versatilepb (`tests/tcgbench`): per-phase backend A/B + the device/icount-tax mirrors (`mmiopoll`/`rampoll`/`mmiow` ns/access, `ICOUNTS=0,1`, `SUITE=quick`) |
| `bootcheck.mjs` | the three-fullflash browser gate: boots s75/el71/ke800 on one dist and judges progress in executed instructions; on a firmware `>>EXIT<<` it waits for the panic text and saves the serial tail (`tests/results/bootcheck-<dist>-<board>-serial.txt`); `--query "trace=dsp,scu&tracebuf=1"` adds page parameters to every board and saves the buffered stderr/device trace per board (`…-trace.txt`); `--flash s75,el71` boots the boards in that order as consecutive pages of one browser |
| `stopwatch.mjs` | J2ME pacing meter: boots S75v40lg1, walks the keypad to Extras → Stopwatch and prints `vratio` (virtual s per wall s), plus a `per-s` line with the display-path counters (`difTxWord`, `dmacBurst`, `dmacSchedTimer`, `dmacXlatFill`, `difMuxRebuild`, `lcCall`); `--devtools <port> --hold <s>` keeps the running app open for `wprof2.mjs PROF_ATTACH=<port>` — the profile that ranks this workload; `CHROME_ARGS="--js-flags=--liftoff-only"` passes browser switches (a phone-tier A/B: `--liftoff-only` pins V8's baseline tier, `--no-liftoff` pins TurboFan; `--no-wasm-tier-up` is a no-op in Chrome 153) |
| `lockstep.mjs`, `lockstep-wasm.mjs` | cross-backend value-equality drivers — native JIT vs native TCI (plugin) / native JIT vs the wasm page (built-in fold); `scripts/run-lockstep.sh` is the native gate |
| `tcgisa.mjs`, `tcgisa64.mjs` | drive the guest op-suite page leg (`scripts/run-tcg-isa.sh` is the gate; `tcgisa64.mjs` takes a dist + `--env` knobs) |
| `ffboot.mjs` | boot a dist in Playwright's Firefox (cross-browser smoke; `BROWSER=chromium` too); gate rung 7 — `temp=` (per-TB throwaway modules) must stay ~0 |
| `ab.mjs` | parallel boot-survival A/B of query variants against the deployed dist (`scripts/iterate.sh` uses it) |
| `loadbench.mjs` | startup-path benchmark (download, compile, instantiate) |

Profiling and counters:

| Script | Purpose |
|---|---|
| `wprof2.mjs` | per-worker CDP profiler with `wasm-function[N]` → symbol resolution via the `.symbols` sidecar; `PROF_DELAY=<s>` picks the boot phase, `PROF_FN=<substr>` prints caller stacks, `PROF_ATTACH=` profiles a page another tool drove, `PROF_SAVE=<json>` keeps the raw profile |
| `profcat.mjs`, `profjit.mjs` | categorize a saved profile by cost class; distribution of JIT-guest self time over TB functions |
| `memstat.mjs`, `diagprobe.mjs` | sample the cold-path `wasm_memstat` counters over a boot (memstat: the memory-path set; diagprobe: any counter by index, `name=idx`) |
| `threadmap.mjs`, `syscallprobe.mjs` | thread census / syscall CPU attribution (see wasm-threads-audit.md) |
| `modbench.mjs`, `ffmodtest*.mjs` | WebAssembly.Module compile-cost and Firefox executable-memory probes |

Probes and traces:

| Script | Purpose |
|---|---|
| `smoke.mjs`, `verify-boot.mjs`, `wshot.mjs`, `screenshot.mjs` | boot once / verify + insn rate / screenshot after the splash |
| `serialwatch.mjs [s] [query]` | push vclock/serial/fb/TB stats via console every 10 s — the general-purpose probe |
| `conlog.mjs` | capture qemu console lines matching a prefix (`MATCH=`, `SAVE_FS=` pulls MEMFS files out) |
| `iotrace.mjs`, `tracebuf.mjs`, `tracedump.mjs`, `dsplive.mjs` | `PMB887X_TRACE_*` captures (buffered / live-filtered) |
| `execdump.mjs`, `tracediff.mjs`, `iorec.mjs` | `-d exec` log dump / TB-sequence diff between builds / io_recompile frequency |
| `peekcode.mjs` | dump + disassemble guest memory ranges after a boot delay |
| `w64dbg.mjs`, `w64walk.mjs`, `repro.mjs` | wasm64 backend console diagnostics, structural module walker, failing-batch capture loop |
| `efa-web.mjs`, `preset-web.mjs` | E2E page tests: LG fullflash + EFA sidecar; preset download → cache → boot |
| `exitcheck.mjs` | the Siemens EXIT path end to end: boots an image that panics (default `fullflashes/BROKEN)S66_no_recalc.bin` as `siemens-s65`, ~3 s to the dump) and checks the page stopped the guest, beeped once, dimmed the canvas and started the 30 s fade, and drew the parsed dump over it — desktop and phone layouts, screenshots in `exitcheck*.png`; `--inject` writes the recorded EL71 (x75-shaped) dump into a healthy guest's log instead, once it has drawn something, which is the leg that watches a lit screen fade |
| `session.mjs` + `ctl.mjs` | persistent headless-browser session and its client |
| `vclock.mjs`, `bootmatrix.mjs` | virtual-clock progression per `?icount=` variant; parallel boot matrix over query variants |

## Native reference runs

```
env PMB887X_TRACE_IO=dsp,scu PMB887X_TRACE_LOG=dsp,scu \
    PMB887X_BOARD=build/bsp/lib/data/board/siemens-s75.toml \
    PMB887X_STARTUP=ONLINE PMB887X_SIM=virtual PMB887X_SIM_OPERATOR=00101 \
    PMB887X_FLASH0_OTP0=02004AB3C31100000000 PMB887X_FLASH0_OTP1=000094104502237315FF \
  build/qemu-native-build/qemu-system-arm -display none -icount shift=3,sleep=off -machine pmb887x \
    -drive if=pflash,format=raw,file=<fullflash>,readonly=on \
    -serial file:serial.log -D trace.log
```

(`scripts/run-native.sh` builds exactly this command line from the
fullflash name.) The wasm run is meant to replay the same instruction
stream: diff the trace sequences (`COM_SET` → `DSP_CFR cleared` →
`SCU_DSP_INT` → …) to find where they diverge, and diff the same trace
between `dist` and `dist-jit` to bisect a JIT-only failure. Remember:
`>>EXIT<<` on serial = phone crashed; stop there.
