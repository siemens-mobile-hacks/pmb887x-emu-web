# Architecture

The Siemens/LG phone emulator runs entirely in the browser. Repo layout:

```
.
  build.sh, versions.env, scripts/          build pipeline (WASM + native modes)
  patches/0001-ui-*.patch                   -display wasm backend
  patches/0002-wasm-*.patch                 Asyncify-safe futex/condvar + icount2 helper skip
  patches/0003-tci-*.patch                  TCI TLB probe + direct helper dispatch (generic TCI)
  patches/0004-wasm-*.patch                 io-recompile MMIO boundary accounting
  patches/0007..0014-*.patch                TCI perf series (TB chaining, immediate forms,
                                            main-loop futex, io-recompile skip, inline ldst,
                                            size-specialized ops, SVC inline exit, io barriers)
  patches/0016-memory-romd-*.patch          romd FlatView variants + range-scoped TLB flush
  patches/0017-tcg-wasm64-backend.patch     the wasm64 TCG backend (tcg/wasm64/)
  patches/0018-io-fast-dispatch-*.patch     cputlb: fill-time MMIO dispatch + victim-TLB
                                            flag-masked compare (generic qemu-core)
  (patches 0001–0016 + 0018 are generated from the upstream branch
   build/qemu-upstream · wasm-browser-port — see doc/upstream-branch.md;
   0017 is captured from the working tree via scripts/capture-patch.sh)
  patches/attic/                            dropped patches (the original 0004 io-recompile
                                            skip, 0005 wasm32 JIT draft, 0006 fixed-104 MHz
                                            clock, 0015 diag counters)
  patches/bsp/                              bsp board-config workaround (hd155153np → pmb6272)
  site/                                     served web root (index.html / app.js /
                                            keyboards.js / fullflashes.js); dist/ = TCI build,
                                            dist-jit/ = wasm64-backend build (page ?dist=
                                            switch), dist-*/ snapshots for A/B (gitignored)
  tests/                                    native boot suite (run.mjs), tcg-isa op-suite,
                                            lockstep plugin, tcgbench perf bench
  tools/                                    headless-browser test/probe/bench scripts
  doc/                                      this documentation
```

## WASM (client-side)

Everything runs in the browser: `qemu-system-arm` (arm-softmmu) is compiled
to WebAssembly (wasm64, pthreads, Asyncify) and driven from a page. Two
engines are served side by side:

- `site/dist/` — the **TCI interpreter** build (the page default). Universally
  correct, the reference tier.
- `site/dist-jit/` — the **wasm64 TCG backend** (patch 0017): guest TBs are
  compiled at runtime into batched wasm modules (128 TBs/module), chain via
  tail calls through a shared funcref table, with an inline TLB probe and
  inline TB accounting. Boot-to-idle at TCI parity, ~7.4× TCI on compute
  (tcgbench); all correctness gates green — see
  [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md) /
  [wasm-tcg-backend-progress.md](wasm-tcg-backend-progress.md).

### Build pipeline

1. `scripts/build-deps.sh` installs emsdk 4.0.10 into `build/deps/emsdk`
   and builds glib 2.84, pixman 0.44.2, zlib 1.3.2 and libffi headers with
   emcc for wasm64 (mirrors qemu's own
   `tests/docker/dockerfiles/emsdk-wasm64-cross.docker`; pins in
   `versions.env`).
2. `scripts/build-qemu.sh` clones `Azq2/qemu-pmb887x` @ `b31b98fe1e`
   (alula's `dsp-stuff`, fetched via `QEMU_PMB887X_ALT_REPO`) and
   `Azq2/pmb887x-dev` (bsp) @ `49b0130` into `build/`, applies
   `patches/*.patch` + `patches/bsp/` onto the pristine tree and configures
   like qemu's CI wasm64 job:
   `--static --cpu=wasm64 --target-list=arm-softmmu --enable-tcg-interpreter
   --with-coroutine=wasm`. Output: `site/dist/qemu-system-arm.{js,wasm}` plus
   `site/dist/boards.tar` (bsp board configs, unpacked by the page at boot).
   `scripts/build-qemu-wasm64.sh` builds the same patched tree *without*
   `--enable-tcg-interpreter` in a separate dir (`build/qemu-wasm64`) and
   deploys atomically (tmp+rename) to `site/dist-jit/`, symbol map included.
3. `serve.mjs` serves `site/` — static page files edited in place, build
   artifacts in `site/dist*/` — with the COOP/COEP headers pthreads need
   (SharedArrayBuffer), a gzip sidecar + ETag revalidation for the ~45 MB
   wasm, and an https port for phone/LAN access.

Incremental iteration: `scripts/ninja-fast.sh` (TCI → `site/dist`) and
`scripts/ninja-wasm64.sh` (wasm64 build dir; deploy via
`build-qemu-wasm64.sh`). One-shot: `./build.sh` (deps → TCI dist).

### The patches

`0001-ui-add-wasm-display-input-backend-for-emscripten-bui.patch`
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
  - Diagnostics: `wasm_vclock`, `wasm_fb_updates`, `wasm_tbs/insns`.
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
  (only used with `?icount=precise-clocks=on` — the default timing model
  is stock icount `shift=3,sleep=off` and does not involve icount2 at all;
  see [livelock-postmortem.md](livelock-postmortem.md) §4).
- `configs/meson/emscripten.txt`: `-sASYNCIFY_REMOVE=tcg_qemu_tb_exec`
  (the interpreter must not run Asyncify-instrumented).

`0003` (TCI inline TLB probe + direct helper dispatch) is **generic TCI**,
not emscripten-gated — native TCI measurably benefits (see
[upstream-analysis.md](upstream-analysis.md)). `0004` keeps the stock
io-recompile rewind for ROM-device (flash command) accesses and accounts
mid-TB MMIO at the io boundary on emscripten (design + dead ends:
[early-crash-postmortem.md](early-crash-postmortem.md) §9; `0010` extends
the skip to the stock-icount model).

`0007–0016` is the TCI performance series — one mechanism per patch, each
with a measured header (TB chaining, immediate forms, main-loop futex wait,
io-recompile skip, inline ldst fast path, size-specialized memory ops, SVC
inline exception exit, io barriers, romd FlatView variants). Summaries +
numbers: README.md patch list and
[optimization-playbook.md](optimization-playbook.md) "What landed".

`0017` is the wasm64 TCG backend (`tcg/wasm64/` + small hooks); its own
docs are authoritative:
[wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md) (design + gates) and
[wasm-tcg-backend-progress.md](wasm-tcg-backend-progress.md) (session log).

`0018` is generic qemu-core (cputlb): fill-time MMIO dispatch resolution in
the iotlb entry + a flag-masked victim-TLB compare (the victim TLB never
hit MMIO entries before — index-aliased MMIO pages under ARMv5 1K target
pages re-walked the page tables on every access). Helps every backend
including native. Numbers: [performance-handoff.md](performance-handoff.md).

`0006-wasm-icount2-fixed-104MHz-virtual-clock.patch` — **dropped
2026-09-08, superseded** (see [livelock-postmortem.md](livelock-postmortem.md)
§4): it ran icount2 at a hard-coded 104 MHz on emscripten. The stock
configuration `-icount shift=3,sleep=off` (site default; LG boards boot
without any `-icount`) does the same job with zero fork-specific
clock code. The patch lives in `patches/attic/`.

### Page (site/)

- Fullflash picker (own file or preset — `fullflashes.js` inventory, Cache
  API storage) → file bytes written into the emscripten MEMFS; options
  (IMEI/ESN→OTP, SIM, operator, startup, rw) become `PMB887X_*` env vars —
  the exact set the pmb887x-emu `load` tool uses.
- `boards.tar` unpacked into `/boards`; qemu args mirror the native
  launcher (`-display wasm -icount shift=3,sleep=off -machine pmb887x
  -drive if=pflash… -serial file:/serial.log`; no `-icount` for `lg-*`
  devices).
- LCD canvas repaints from the staging buffer on `requestAnimationFrame`;
  every phone key is a `<button>` mapped to linux keycodes, plus
  physical-key mapping. Serial pane polls `/serial.log`.
- URL params (see [diagnostics.md](diagnostics.md)): `?dist=dist-jit`
  switches engine, `?suite=` boots the guest op-suite headlessly,
  `?env=NAME=VAL` passes build knobs, `?icount=`/`?trace=`/`?qargs=`/
  `?iorewind=1` override the boot recipe.

### Engine history

- **wasm32 runtime JIT (ktock port, the old 0005 draft) — CLOSED
  2026-09-09, discarded** (~1.3–2.3× TCI ceiling, deterministic boot hang,
  ~4200-line surface). Record:
  [wasm32-port-status.md](wasm32-port-status.md) +
  `patches/attic/wasm32-rebase/`.
- **wasm64 TCG backend (0017) — landed 2026-09-10/11, performance
  complete**: boot-to-idle at TCI parity on the deterministic idlebench
  protocol, compute 7.4× TCI, every gate green (op-suite ×3 byte-identical,
  full 2.5e9 lockstep, native suite ×4). The remaining end-to-end lever is
  the qemu-core device path — the current workstream,
  [performance-handoff.md](performance-handoff.md).

## Native (Linux) reference builds

- `scripts/build-native.sh` → `build/qemu-native-build/` (real TCG JIT,
  pristine pinned rev, no patches) — much faster than wasm; used by the
  test suite, the lockstep reference leg and quick experiments.
- `scripts/build-native-tci.sh` → native TCI with plugins force-enabled
  (the lockstep b-side).
- `scripts/run-native.sh` — launcher mirroring the web boot recipe exactly
  (same icount/pflash/serial/env-var set).

## Correctness / testing ladder

| gate | what it proves | driver |
|---|---|---|
| native boot suite | s75/el71/c81/ke800 boot-init/progress/no-exit | `node tests/run.mjs` |
| guest op-suite | 1156 (value, NZCV) cases byte-identical across native JIT / native TCI / wasm page | `scripts/run-tcg-isa.sh` |
| lockstep | whole-boot cross-backend value equality (regs + SRAM/SDRAM digests); full 2.5e9-insn gate | `scripts/run-lockstep.sh`, `tools/lockstep-wasm.mjs` |
| tcgbench | fast-iteration per-phase A/B + the device/icount-tax mirrors | `tools/tcgbench.mjs` |
| idlebench | deterministic boot-to-idle wall time (the human metric) | `tools/idlebench.mjs` |

Working method (measure → patch → A/B → keep/revert → document):
[optimization-playbook.md](optimization-playbook.md).
