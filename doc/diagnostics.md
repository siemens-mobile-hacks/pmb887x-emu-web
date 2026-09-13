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
| `?rt=off\|banked\|strict` | `QEMU_ICOUNT_RTCAP` — the real-time cap on the sleep=off idle warp (default `banked`: the boot is never throttled, idle time is paced to wall; benchmarks pass `rt=off` to measure engine speed) |
| `?icount2debug=1` | `QEMU_ICOUNT2_DEBUG=1` — only meaningful with `?icount=precise-clocks=on`: prints the controller state each second |
| `?trace=<channels>` | `PMB887X_TRACE_IO/LOG` (e.g. `trace=dsp,scu`); channels: dsp, scu, gptu, tpu, vic, capcom, usart, rtc, … |
| `?tracebuf=1` | buffer raw stderr in `window.__qemulog` (no console flood) |
| `?debug=1` | print every stderr line to console (no dedup) |
| `?qargs=<args>` | append raw qemu arguments (e.g. `qargs=-d exec -D /exec.log`) |
| `?env=NAME=VAL` | extra environment for the build (repeatable) — wasm64 knobs such as `W64_SPEC_N`, `W64_LIVE_MAX`, `W64_COMPACT_BATCHES`/`W64_COMPACT_MEMBERS`, `W64_NOTLB=1`, `W64_TBSTATS=1` (per-TB-entry counters under icount, so `wasm_tbs` reads non-zero), `W64_DEBUG=1` |
| `?w64debug=1` | wasm64 backend console diagnostics (batch histogram, module events) |
| `?env=QEMU_LOG_PABT=1` | one stderr line per guest prefetch abort / BKPT (IFSR, IFAR, pc, lr, sp, cpsr) — the tool that pinned the W-12 panic; combine with `tracebuf=1`, never with `-d int` (its per-IRQ volume shifts timing enough to hide a race) |
| `?suite=<url>` | boot a bare-metal versatilepb image instead of a phone (`dist/tcgisa.bin`, `dist/tcgbench.bin`); with `?icount=1` the suite runs under the phones' stock timing model (the tcgbench icount-tax leg) |
| `?lockstep=1` (+ `ls-*`) | built-in guest-state fold on the wasm64 backend — the b-side of `tools/lockstep-wasm.mjs`; `ls-*` params set the insn budget and grid |
| `?iorewind=1` | force the stock io-recompile everywhere (0004's A/B escape hatch) |

Fullflash, device, IMEI/ESN, SIM, operator, startup and rw are form
controls, not params.

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
| `idlebench.mjs` | the end-to-end boot benchmark: fresh headless browser per run, S75v40lg1 to the idle screen (LCD bottom-139-rows vs a committed reference), guest-work milestones `t0.1G…t1.3G`, the v=2..7 window, A/B ratios between dists in one invocation, regression verdict vs `tests/results/idlebench-latest.json`; `--quick` (~1 min/dist), `--runs N`, `RT=banked`, a dist may be `<dir>@<query>` for knob A/Bs |
| `tcgbench.mjs` | fast-iteration perf bench on versatilepb (`tests/tcgbench`): per-phase backend A/B + the device/icount-tax mirrors (`mmiopoll`/`rampoll`/`mmiow` ns/access, `ICOUNTS=0,1`, `SUITE=quick`) |
| `bootcheck.mjs` | the three-fullflash browser gate: boots s75/el71/ke800 on one dist and judges progress in executed instructions; on a firmware `>>EXIT<<` it waits for the panic text and saves the serial tail (`tests/results/bootcheck-<dist>-<board>-serial.txt`); `--query "trace=dsp,scu&tracebuf=1"` adds page parameters to every board and saves the buffered stderr/device trace per board (`…-trace.txt`); `--flash s75,el71` boots the boards in that order as consecutive pages of one browser |
| `stopwatch.mjs` | J2ME pacing meter: boots S75v40lg1, walks the keypad to Extras → Stopwatch and prints `vratio` (virtual s per wall s) |
| `lockstep.mjs`, `lockstep-wasm.mjs` | cross-backend value-equality drivers — native JIT vs native TCI (plugin) / native JIT vs the wasm page (built-in fold); `scripts/run-lockstep.sh` is the native gate |
| `tcgisa.mjs`, `tcgisa64.mjs` | drive the guest op-suite page leg (`scripts/run-tcg-isa.sh` is the gate; `tcgisa64.mjs` takes a dist + `--env` knobs) |
| `ffboot.mjs` | boot a dist in Playwright's Firefox (cross-browser smoke; `BROWSER=chromium` too) |
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
