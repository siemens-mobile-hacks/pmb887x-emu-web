# Diagnostics toolkit

Everything here lives in `web/tools/` (playwright-core + the
playwright-downloaded `chromium-headless-shell`; `npm i` in that dir once).

## Page URL parameters (WASM mode)

| Param | Effect |
|---|---|
| `?icount=<spec>` | override `-icount` (default `shift=3,sleep=off`; `none` for `lg-*` devices — `precise-clocks=on`, `shift=N`, `none`, …) |
| `?icount2debug=1` | `QEMU_ICOUNT2_DEBUG=1` — only meaningful with `?icount=precise-clocks=on`: prints the controller state each second |
| `?trace=<channels>` | `PMB887X_TRACE_IO/LOG` (e.g. `trace=dsp,scu`); channels: dsp, scu, gptu, tpu, vic, capcom, usart, … |
| `?tracebuf=1` | buffer raw stderr in `window.__qemulog` (no console flood) |
| `?debug=1` | print every stderr line to console (no dedup) |
| `?qargs=<args>` | append raw qemu arguments (e.g. `qargs=-d exec -D /exec.log`) |
| `?fullflash=`, others | options are form controls, not params |

## Exports on `window.__qemu` (the emscripten module)

`_wasm_fb_ptr/_width/_height/_stride/_take_dirty/_updates`,
`_wasm_vclock` (guest ns), `_wasm_tbs/_wasm_insns` (per-TB stats),
`_wasm_exits(i)` (TB exit-code histogram, i=8 → REQUESTED-without-exit_request),
`_wasm_irq_bits`, `_wasm_send_key(lnx, down)`, `_wasm_quit()`, `FS`, `ENV`.

## Scripts

| Script | Purpose |
|---|---|
| `smoke.mjs` | boot once, catch page errors |
| `serialwatch.mjs [s] [extra-query]` | push vclock/serial/fb/TB stats via console every 10 s — the main probe |
| `dsplive.mjs [s] [query]` | live-filtered qemu trace lines (COM_SET/CFR/SCU_DSP_INT/…) via console |
| `tracebuf2.mjs` | dump buffered trace with flexible filters |
| `execdump.mjs` | run with `-d exec -D /exec.log`, dump the exec log from MEMFS |
| `wshot.mjs` | WASM-mode screenshot, waits for framebuffer activity |
| `wprof.mjs` | (experimental, superseded) CDP profiling attempt via playwright's `page.workers()` — use `wprof2.mjs` instead |
| `wprof2.mjs` | per-worker CDP profiler (raw websocket, page-target auto-attach). Repaired in the 0007–0009 sessions and extended with `wasm-function[N]` → symbol resolution via the `.symbols` sidecar. `PROF_FN=<substr>` prints caller stacks of a hot function |
| `bootbench.mjs` | the A/B boot benchmark for patch selection: one JSON line with the deterministic v-window wall time + final progress (see doc/optimization-playbook.md) |

## Native reference runs

```
env PMB887X_TRACE_IO=dsp,scu PMB887X_TRACE_LOG=dsp,scu \
    PMB887X_BOARD=<bsp>/lib/data/board/siemens-s75.toml \
    PMB887X_STARTUP=ONLINE PMB887X_SIM=virtual PMB887X_SIM_OPERATOR=00101 \
    PMB887X_FLASH0_OTP0=02004AB3C31100000000 PMB887X_FLASH0_OTP1=000094104502237315FF \
  qemu-system-arm -display none -icount shift=3,sleep=off -machine pmb887x \
    -drive if=pflash,format=raw,file=<fullflash>,readonly=on \
    -serial file:serial.log -D trace.log
```

The wasm run is meant to replay the same instruction stream: diff the
trace sequences (`COM_SET` → `DSP_CFR cleared` → `SCU_DSP_INT` → …) to
find where they diverge. Remember: `>>EXIT<<` on serial = phone crashed;
stop there.
