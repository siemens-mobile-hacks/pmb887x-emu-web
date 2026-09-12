# Architecture

The Siemens/LG phone emulator runs entirely in the browser. Repo layout:

```
.
  qemu/                                     submodule: Azq2/qemu-pmb887x @ the pinned rev on the
                                            series branch (wasm-browser-port = origin/wasm-patches):
                                            the one qemu source tree, wasm and native builds alike —
                                            see upstream-branch.md for the commit list
  pmb887x-emu/                              submodule: the meta-repo whose qemu pin matches (reference)
  build.sh, versions.env, scripts/          build pipeline (WASM + native modes)
  bsp-patches/                              bsp board-config workaround (hd155153np → pmb6272),
                                            applied by scripts/sync-bsp.sh
  site/                                     served web root (index.html / app.js /
                                            keyboards.js / fullflashes.js); dist-jit/ = wasm64
                                            backend build (page default), dist/ = TCI build
                                            (?dist=dist) + boards.tar, dist-*/ = A/B snapshots
                                            (all gitignored)
  tests/                                    native boot suite (run.mjs), tcg-isa op-suite,
                                            lockstep plugin, tcgbench perf bench
  tools/                                    headless-browser test/probe/bench scripts
  doc/                                      this documentation
```

## WASM (client-side)

Everything runs in the browser: `qemu-system-arm` (arm-softmmu) is compiled
to WebAssembly (wasm64, pthreads, Asyncify) and driven from a page. Two
engines are served side by side, built from the same tree:

- `site/dist-jit/` — the **wasm64 TCG backend** (0017 + its follow-ups):
  guest TBs are compiled at runtime into wasm modules, speculatively
  batched with their successors (compile-once, later compacted into
  ~1024-member modules), chain via tail calls through a shared funcref
  table, with an inline TLB probe and inline TB accounting. The page
  default for every board (LG included since 0034–0038). ~7.4× TCI on
  compute (tcgbench), ~1.6× faster to the idle screen, ~28 MB wasm
  (Asyncify onlylist, 0031). Design + history:
  [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md).
- `site/dist/` — the **TCI interpreter** build (`TCI=1` at build time,
  `?dist=dist` on the page). The reference/fallback tier and the oracle
  for bisecting JIT-only failures (diff the same device trace between
  the two engines). ~45 MB wasm. Also where `boards.tar` and the suite
  images (`tcgisa.bin`, `tcgbench.bin`) are served from, whatever
  `?dist=` selects.

### Build pipeline

1. `scripts/build-deps.sh` installs emsdk 4.0.10 into `build/deps/emsdk`
   and builds glib 2.84, pixman 0.44.2, zlib 1.3.2 and libffi headers with
   emcc for wasm64 (mirrors qemu's own
   `tests/docker/dockerfiles/emsdk-wasm64-cross.docker`; pins in
   `versions.env`).
2. `scripts/build-qemu.sh` initialises the `qemu/` submodule at the
   pinned rev (`scripts/fetch-qemu.sh`), checks out the bsp at its pin
   with `bsp-patches/` applied (`scripts/sync-bsp.sh`), packs the board
   configs into `site/dist/boards.tar` (`scripts/pack-boards.sh`), then
   runs `scripts/build-qemu-wasm64.sh`: configure like qemu's CI wasm64
   job (`--static --cpu=wasm64 --target-list=arm-softmmu
   --with-coroutine=wasm`, no `--enable-tcg-interpreter`) in
   `build/qemu-wasm64`, link with the Asyncify onlylist
   (`configs/meson/asyncify-only.txt`) and `qom_cast_debug=false`, and
   deploy atomically (tmp+rename) to `site/dist-jit/`, symbol map
   included. With `TCI=1` it additionally configures
   `build/qemu-wasm` with `--enable-tcg-interpreter` and deploys to
   `site/dist/` (the TCI dist keeps `ASYNCIFY_REMOVE=tcg_qemu_tb_exec`;
   the onlylist regresses it +26 %).
3. `serve.mjs` serves `site/` — static page files edited in place, build
   artifacts in `site/dist*/` — with the COOP/COEP headers pthreads need
   (SharedArrayBuffer), a gzip sidecar + ETag revalidation for the wasm,
   and an https port for phone/LAN access.

Incremental iteration: `scripts/ninja-fast.sh` (wasm64 → `site/dist-jit`
by default, `TCI=1` for the interpreter → `site/dist`; rebuild + atomic
deploy + boards.tar refresh, no tree reset). One-shot: `./build.sh`.

### The series

All qemu changes are commits on the submodule branch —
[upstream-branch.md](upstream-branch.md) has the full list with scope.
The structural ones:

`0001 ui: add wasm display/input backend`
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
    `wasm_reg/pc/peek`, `wasm_irq_pending`.
- qapi/ui.json: `DisplayType` gains `wasm` (CONFIG_WASM_UI); ui/meson.build
  compiles the backend; `configs/meson/emscripten.txt` link settings get the
  exports the page needs (`ENV`, `HEAPU8/32`, `EXIT_RUNTIME`).

`0002 wasm: Asyncify-safe futex/condvar`
(see [lessons.md](lessons.md) § Emscripten runtime for the reasoning)
- `include/qemu/futex.h`: emscripten futex wrappers (`emscripten_futex_*`);
  `HAVE_FUTEX` becomes defined on emscripten, switching QemuEvent/LockCnt to
  their futex fast paths.
- `util/qemu-thread-posix.c` + `include/qemu/thread-posix.h`: futex/seq
  based `QemuCond` for emscripten (pthread_cond everywhere else); 0021
  fixed the untimed wait (it passed a 0 ms timeout = immediate return).
- `target/arm/tcg/translate.c`: no per-instruction icount2 cycle helper on
  emscripten (it costs a libffi→JS roundtrip per guest insn under TCI).
- `system/icount2.c`: frequency floor 1 kHz instead of 1 MHz on emscripten
  (only used with `?icount=precise-clocks=on` — the default timing model
  is stock icount `shift=3,sleep=off` and does not involve icount2 at all;
  see [lessons.md](lessons.md) § Timing model).

`0003` (TCI inline TLB probe + direct helper dispatch) is **generic TCI**,
not emscripten-gated — native TCI measurably benefits. `0004` keeps the
stock io-recompile rewind for ROM-device (flash command) accesses and
accounts mid-TB MMIO at the io boundary on emscripten (design + dead
ends: [lessons.md](lessons.md) § Mid-TB MMIO; `0010` extends
the skip to the stock-icount model; `0014`/`0036` keep barrier insns in
single-insn TBs so the rewind stops recurring).

`0007–0016` is the TCI performance series — one mechanism per commit
(TB chaining, immediate forms, main-loop futex wait, io-recompile skip,
inline ldst fast path, size-specialized memory ops, SVC inline exception
exit, io barriers, romd FlatView variants). Numbers:
[optimization-playbook.md](optimization-playbook.md) "What landed".

`0017` is the wasm64 TCG backend (`tcg/wasm64/` + small hooks); 0019,
0020, 0022, 0026, 0029, 0030, 0034, 0038 are its follow-ups
(speculative batching, successor hints, goto_ptr handoff/tail call, no
icount2 prologue, explored flag, retaddr fix, narrowed speculation).
Its design doc is authoritative:
[wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md) (design + gates).

Generic qemu-core commits (help every backend including native): `0016`
(romd FlatView variants + range-scoped flush), `0018` (fill-time MMIO
dispatch resolution + flag-masked victim-TLB compare), `0040` (fill-time
TLB growth), `0043` (physical-address summary for the range flush),
`0045` (skip `arm_rebuild_hflags` on CPSR writes that cannot change it).

Timing/halt path: `0023` (idle warp on the vCPU thread), `0024`
(pmb887x completion timers on the virtual clock), `0025`, `0027`,
`0028`, `0032` (real-time cap on the sleep=off warp — wasm default
`banked`, page `?rt=`), `0035`/`0037` (virtual timers serviced when
icount is off — the LG boards). `0033` selects the RTC `CNT` layout
from the board config (`[rtc] format`: Siemens linear Unix seconds, LG
packed calendar).

### Page (site/)

- Fullflash picker (own file or preset — `fullflashes.js` inventory, Cache
  API storage) → file bytes written into the emscripten MEMFS; options
  (IMEI/ESN→OTP, SIM, operator, startup, rw) become `PMB887X_*` env vars —
  the exact set the pmb887x-emu `load` tool uses.
- `boards.tar` unpacked into `/boards`; qemu args mirror the native
  launcher (`-display wasm -icount shift=3,sleep=off -machine pmb887x
  -drive if=pflash… -serial file:/serial.log`; no `-icount` for `lg-*`
  devices; `QEMU_ICOUNT_RTCAP=banked` unless `?rt=` says otherwise).
- LCD canvas repaints from the staging buffer on `requestAnimationFrame`;
  every phone key is a `<button>` mapped to linux keycodes, plus
  physical-key mapping. Serial pane polls `/serial.log`.
- URL params (see [diagnostics.md](diagnostics.md)): `?dist=dist`
  switches engine, `?suite=` boots a bare-metal image headlessly,
  `?env=NAME=VAL` passes build knobs, `?icount=`/`?rt=`/`?trace=`/
  `?qargs=`/`?iorewind=1` override the boot recipe, `?lockstep=1` turns
  on the built-in guest-state fold.

### Engine history

- **wasm64 TCG backend (0017) — landed 2026-09-10/11**, compute 7.4× TCI,
  every gate green (op-suite ×3 byte-identical, full 2.5e9 lockstep,
  native suite ×4); the module economy, halt path, Asyncify onlylist and
  the EL71/KE800 fixes followed (0019–0038), making it the default for
  every board on 2026-09-12. Current status and open items:
  [performance-handoff.md](performance-handoff.md).

## Native (Linux) reference builds

- `scripts/build-native.sh` → `build/qemu-native-build/` (real TCG JIT,
  worktree of the pinned rev — the same series as the wasm builds; the
  emscripten parts are inert) — much faster than wasm; used by the
  test suite, the lockstep reference leg and quick experiments. No
  real-time cap by default (0032 is off outside emscripten), so a native
  boot fast-forwards the idle warp.
- `scripts/build-native-tci.sh` → native TCI with plugins force-enabled
  (the lockstep b-side).
- `scripts/run-native.sh` — launcher mirroring the web boot recipe exactly
  (same icount/pflash/serial/env-var set).

## Correctness / testing ladder

| gate | what it proves | driver |
|---|---|---|
| native boot suite | s75/el71/c81/ke800 boot-init/progress/no-exit | `node tests/run.mjs` |
| browser boot gate | s75/el71/ke800 boot on a wasm dist (progress in executed insns) | `node tools/bootcheck.mjs --dist dist-jit` |
| guest op-suite | 1156 (value, NZCV) cases byte-identical across native JIT / native TCI / wasm page | `scripts/run-tcg-isa.sh` |
| lockstep | whole-boot cross-backend value equality (regs + SRAM/SDRAM digests); full 2.5e9-insn gate | `scripts/run-lockstep.sh`, `tools/lockstep-wasm.mjs` |
| tcgbench | fast-iteration per-phase A/B + the device/icount-tax mirrors | `tools/tcgbench.mjs` |
| idlebench | deterministic boot-to-idle wall time + guest-work milestones (the human metric) | `tools/idlebench.mjs` |
| stopwatch | in-guest pacing while a J2ME app redraws (`vratio`) | `tools/stopwatch.mjs` |

Working method (measure → commit → A/B → keep/revert → document):
[optimization-playbook.md](optimization-playbook.md).
