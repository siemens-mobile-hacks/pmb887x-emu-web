# Diagnostics toolkit

Everything here lives in `web/tools/` (playwright-core + the
playwright-downloaded `chromium-headless-shell`; `npm i` in that dir once).

## Page URL parameters (WASM mode)

| Param | Effect |
|---|---|
| `?icount=<spec>` | override `-icount` (`precise-clocks=on` default, `shift=N`, `none`) |
| `?icount2debug=1` | `QEMU_ICOUNT2_DEBUG=1` — on wasm prints the fixed-clock pace every second (rate, frequency, virtual/real); natively prints the precise-clocks controller state |
| `?icount2freq=<hz>` | `QEMU_ICOUNT2_FREQUENCY` — override the fixed wasm virtual-clock frequency (default 104 MHz, the real phone CPU). Lower = faster wall-clock boot but tighter-than-native firmware budgets (risk); higher = slower but looser |
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
| `wprof.mjs` | (experimental) CDP profiling attempt of the wasm worker — emscripten ES-module workers are not exposed to playwright's `page.workers()`; use `--emit-symbol-map` + `llvm-objdump`/`addr2line`-style manual symbolisation instead (see post-mortem) |

## Native reference runs

```
env PMB887X_TRACE_IO=dsp,scu PMB887X_TRACE_LOG=dsp,scu \
    PMB887X_BOARD=<bsp>/lib/data/board/siemens-s75.toml \
    PMB887X_STARTUP=ONLINE PMB887X_SIM=virtual PMB887X_SIM_OPERATOR=00101 \
    PMB887X_FLASH0_OTP0=02004AB3C31100000000 PMB887X_FLASH0_OTP1=000094104502237315FF \
  qemu-system-arm -display none -icount precise-clocks=on -machine pmb887x \
    -drive if=pflash,format=raw,file=<fullflash>,readonly=on \
    -serial file:serial.log -D trace.log
```

The wasm run is meant to replay the same instruction stream: diff the
trace sequences (`COM_SET` → `DSP_CFR cleared` → `SCU_DSP_INT` → …) to
find where they diverge. Remember: `>>EXIT<<` on serial = phone crashed;
stop there.
