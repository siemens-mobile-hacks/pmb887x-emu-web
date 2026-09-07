# Architecture

The Siemens phone emulator runs entirely in the browser, rooted in `web/`:

```
web/
  build.sh, versions.env, scripts/          build pipeline (WASM mode)
  patches/0001-ui-*.patch                   -display wasm backend
  patches/0002-wasm-*.patch                 condvar/crash/icount2 fixes
  patches/0003-tci-*.patch, 0006-icount2-*   TCI fast paths; fixed 104 MHz clock
  patches/attic/                            dropped patches (0004: boot regression)
  site/                                     WASM-mode page
  dist/                                     build output (served)
  tools/                                    headless-browser test/probe scripts
  doc/                                      this documentation
```

## WASM (client-side, experimental)

Everything runs in the browser: `qemu-system-arm` (arm-softmmu) is compiled
to WebAssembly (wasm64, TCG interpreter, pthreads, Asyncify) and driven from
a page.

### Build pipeline

1. `scripts/build-deps.sh` installs emsdk 4.0.10 into `web/build/deps/emsdk`
   and builds glib 2.84, pixman 0.44.2, zlib 1.3.2 and libffi headers with
   emcc for wasm64 (mirrors qemu's own
   `tests/docker/dockerfiles/emsdk-wasm64-cross.docker`).
2. `scripts/build-qemu.sh` clones `Azq2/qemu-pmb887x` @ `2735ce4e` and
   `Azq2/pmb887x-dev` (bsp) @ `9277046` (pins in `versions.env`) into
   `web/build/`, applies `web/patches/*.patch` onto the pristine tree and
   configures like qemu's CI wasm64 job:
   `--static --cpu=wasm64 --target-list=arm-softmmu --enable-tcg-interpreter
   --with-coroutine=wasm`. Output: `dist/qemu-system-arm.{js,wasm}` plus
   `dist/boards.tar` (bsp board configs, unpacked by the page at boot).
3. `serve.mjs` serves `dist/` with the COOP/COEP headers pthreads need
   (SharedArrayBuffer).

The pinned revision predates the fork's "native TCG DSP emulation"
(`43d084b2`) and the unfinished `PLL→CGU` rename — see versions.env comments.

### The patches

`0001-ui-add-wasm-display-input-backend.patch`
- `ui/wasm.c`, compiled only for `host_os == 'emscripten'`; select with
  `-display wasm`.
  - DisplayChangeListener that blits the console surface into an XRGB8888
    staging buffer exported to JS (`wasm_fb_ptr/width/height/stride`,
    dirty-flag protocol `wasm_fb_take_dirty`).
  - Adaptive `dpy_refresh` (16..500 ms): the pmb887x LCD only repaints when
    `GraphicHwOps.gfx_update` is polled.
  - Input: `wasm_send_key(linux_keycode, down)` → SPSC ring → bottom half on
    the qemu main loop → `qemu_input_event_send_key_linux` (thread-safe from
    the browser main thread).
  - `wasm_quit()` → thread-safe `qemu_system_shutdown_request`.
  - Diagnostics: `wasm_vclock`, `wasm_fb_updates`, `wasm_tbs/insns`,
    TB-exit histogram `wasm_exits`, `wasm_irq_bits`.
- qapi/ui.json: `DisplayType` gains `wasm` (CONFIG_WASM_UI); ui/meson.build
  compiles the backend; `configs/meson/emscripten.txt` link settings get the
  exports the page needs (`ENV`, `HEAPU8/32`, `EXIT_RUNTIME`).

`0002-wasm-fix-Asyncify-broken-condvars-batch-icount2-acco.patch`
(see [livelock-postmortem.md](livelock-postmortem.md) for the reasoning)
- `include/qemu/futex.h`: emscripten futex wrappers (`emscripten_futex_*`);
  `HAVE_FUTEX` becomes defined on emscripten, switching QemuEvent/LockCnt to
  their futex fast paths.
- `util/qemu-thread-posix.c` + `include/qemu/thread-posix.h`: futex/seq
  based `QemuCond` for emscripten (pthread_cond everywhere else).
- `target/arm/tcg/translate.c`: no per-instruction icount2 cycle helper on
  emscripten (it costs a libffi→JS roundtrip per guest insn under TCI).
- `accel/tcg/cpu-exec.c`: account executed TBs once per TB in `cpu_tb_exec`
  (`icount2_advance(tb->icount)`, snapshotted before execution — the TB can
  be invalidated while the interpreter runs).
- `tcg/tci/tcg-target.c.inc`: `tcg_out_goto_tb` terminates the TB with
  `exit_tb(tb|idx)` instead of a chain jump, so every TB boundary returns
  through `cpu_exec` (required for the per-TB accounting; chaining between
  real TBs still happens via `tb_add_jump`).
- `system/icount2.c`: frequency floor 1 kHz instead of 1 MHz on emscripten
  so the precise-clocks controller can lock to the real interpreter rate
  (superseded by 0006 — see below — which disables the controller
  entirely).
- `configs/meson/emscripten.txt`: `-sASYNCIFY_REMOVE=tcg_qemu_tb_exec`
  (the interpreter must not run Asyncify-instrumented).

`0006-wasm-icount2-fixed-104MHz-virtual-clock.patch`
(see [livelock-postmortem.md](livelock-postmortem.md) §4)
- `system/icount2.c`: on emscripten the virtual clock runs at the **fixed
  real-hardware rate (104 MHz)** instead of adapting to the host's
  measured rate. Locking virtual time to wall time on a host ~130×
  slower than the guest starves every firmware wall-clock budget (the
  L1↔DSP handshake → `>>EXIT<< l1bbcsg`); a fixed rate makes virtual
  time instruction-proportional — the phone boots in slow motion with
  native timing semantics. `QEMU_ICOUNT2_FREQUENCY` / `?icount2freq=`
  override; native builds keep the adaptive controller.

### Page (site/)

- Fullflash picker → file bytes written into the emscripten MEMFS; options
  (IMEI/ESN→OTP, SIM, operator, startup, rw) become `PMB887X_*` env vars —
  the exact set the pmb887x-emu-mcp `load` tool uses.
- `boards.tar` unpacked into `/boards`; qemu args mirror the MCP
  (`-display wasm -icount precise-clocks=on -machine pmb887x -drive
  if=pflash… -serial file:/serial.log`).
- LCD canvas repaints from the staging buffer on `requestAnimationFrame`;
  every phone key is a `<button>` mapped to the same qcodes the MCP
  `press_key` tool uses (converted to linux keycodes), plus physical-key
  mapping. Serial pane polls `/serial.log`.

### wasm32 runtime JIT (dist-jit/, experimental)

`scripts/build-qemu-jit.sh` builds the same emulator with **ktock/qemu-wasm's
wasm32 TCG backend** ported onto this tree (patch 0005, DRAFT): each TB is
compiled at runtime into a standalone wasm module (instantiated per TB via
`WebAssembly.Module`/`addFunction`, TCI bytecode as interpreter fallback).
Uses the wasm32 dependency stack (`scripts/build-deps32.sh`, no MEMORY64).
Status, porting notes and the remaining bug list: [wasm32-port-status.md](wasm32-port-status.md).
