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
  site-src/recalc/                          emcc glue around pmb887x-emu's siemens_recalc.cpp
                                            → site/dist/siemens-recalc.wasm (Advanced ▸ Siemens keys)
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
   (`scripts/sync-bsp.sh`), packs the board configs into
   `site/dist/boards.tar` (`scripts/pack-boards.sh`), builds the Siemens
   key module into `site/dist/siemens-recalc.wasm`
   (`scripts/build-recalc-wasm.sh`), then runs
   `scripts/build-qemu-wasm64.sh`: configure like qemu's CI wasm64
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
`banked:30`, i.e. `banked` for the guest's first 30 s of its own clock
and `strict` after, page `?rt=`), `0035`/`0037` (virtual timers serviced when
icount is off — the LG boards). `0033` selects the RTC `CNT` layout
from the board config (`[rtc] format`: Siemens linear Unix seconds, LG
packed calendar).

### Page (site/)

- Firmware panel: a Preset/Own file mode switch (presets come from the
  `fullflashes.js` inventory and live in Cache API storage; own files are
  picked or dropped, `.bin` plus an optional `.cfi-efa` for LG) → file
  bytes written into the emscripten MEMFS; Advanced options (IMEI/ESN→OTP,
  SIM, operator, startup) become `PMB887X_*` env vars — the exact set the
  pmb887x-emu `load` tool uses. The panel is `disabled` while a guest runs.
- Which phone a fullflash came from (`detectDevice()` in `fullflashes.js`):
  the filename first (`DEVICE_RULES`), then the image itself, so a dump named
  `dump.bin` still selects its board. Offsets, all verified against the sample
  dumps in `fullflashes/` (S75, EL71, C81, S66, KE800) — re-derive with
  `grep -abo` for the model string if a new dump ever disagrees:
  - `0x3C` `"CJKT"` — every pmb887x NOR dump, LG included
    (`build/bsp/boot/fakesign.py`). Separates "not a fullflash" from
    "a fullflash I can't identify".
  - Siemens/BenQ-Siemens firmware record, 16-byte NUL-padded ASCII fields at a
    fixed offset, the same on SGold and SGold2: `0x8FC60` build tag (`lg1`),
    **`0x8FC70` model** (`S75`), **`0x8FC80` vendor** (`SIEMENS`, even for the
    BenQ-Siemens-era phones), `0x8FC90` version. Model + `v` + the version byte
    at `0x8FC50` + the build tag reproduces the preset naming convention
    (`S75v40lg1`).
  - Fallback for an erased record: the bootcore header `siemens_recalc.cpp`
    parses — magic `02 02 4C 53` / `00 02 4C 53` at `0x200` with the model at
    `0x210`, or `00 03 4C 53` at `0x1200` with the model at `0x3E000`. Its own
    version record names the model `BC65`/`BC75`/`BC85`; that is the bootcore,
    not the phone, so those are discarded.
  - LG has none of the above: the model comes from the J2ME user agent
    (`LG-KE800 MIC/…`, ~4.2 MiB in), scanned over a bounded window.
  - `MODEL_VARIANTS` maps a model with no board of its own onto the board that
    emulates it. Sourced, never guessed — a wrong row boots someone's phone as
    the wrong hardware, so a model that cannot be placed is left to the user.
    `C1F0`→EL71 is upstream's own (`pmb887x-emu/README.md`); `ELF1`/`ELC1`→EL71
    and `S66`→S65 come from ru.wikipedia (the S66 is the Americas-band S65, and
    the dump agrees: 32 MiB, `BC65`, the R65 family that holds S65);
    `C66`/`CT65`/`CV65`/`CO65`→C65 from the en.wikipedia C65 article ("known in
    North America as the Siemens C66" plus its carrier variants); `CX66`→CX65
    from the en.wikipedia model list. Every row but the upstream one says in
    the UI that it is substituting, because same-family is not the same board:
    the configs carry per-model `HW_DET_MOB_TYPE` strap bits (S65 `01100`,
    C65 `10010`) that firmware can read. Deliberately not mapped: `CL61A` is a
    different part from CL61 (flash `0x880D` vs `0x8819`), and `M75`, `C70`
    and `ME75` have no source putting them on the same silicon as a board here.
- Advanced ▸ Siemens keys (`site/recalc.js`, `site/recalc-worker.js`): for a
  `siemens-*` device in Own file mode only — the presets are published
  already recalculated — the three ways pmb887x-emu reconciles a fullflash
  with the ESN it is handed. **Automatically recalculate keys** (the
  default) rewrites the bootcore HASH/IMEI and the confidential EEPROM
  blocks in this run's copy for the IMEI/ESN below; **Brute-force ESN**
  reads the identity out of the image and sweeps the 2^32 ESN space in
  `min(hardwareConcurrency, 8)` Web Workers (~10M candidates/s per core;
  progress on the pill, Cancel is the pill's action, the answer is kept in
  `localStorage["siemens-esn-v1"]` keyed on IMEI + stored key and
  re-verified on every hit) and then boots the image untouched with its own
  IMEI/ESN; **Run as is** hands it over unchanged. The arithmetic is
  pmb887x-emu's `siemens_recalc.cpp` compiled to wasm, not a reimplementation
  — see `site-src/recalc/recalc_wasm.cpp` for why it is `#include`d.
- The status pill above the screen carries the run state and the only
  Start/Stop/Cancel there is (`window.__ui` mirrors that state for the
  drivers in `tools/`). A capture in progress is a second pill beside it,
  ended with **Finish** — "Stop" only ever means the emulator.
- At phone widths (< 600px) the page is one column with no scroll: a single
  32px row (state/firmware pill, screenshot, record, settings), the screen at
  the board's own `[peripheral.LCD0]` aspect ratio flanked by thin edge tabs
  for the side keys, and the keypad, which keeps its natural height
  (`--key-h`) while `fitScreen()` gives the screen box whatever is left. The
  Firmware and Run panels move into two bottom sheets.
  `tools/ui-acceptance.mjs` checks all of this, `tools/uidiff.mjs` that the
  keypad itself did not move. Three things about the height are not obvious,
  and headless Chromium shows none of them — only a real phone does:
  - `100dvh` is not what is on screen on Chrome for Android while the URL bar
    is showing, so the column's height is `--app-h`, published from
    `visualViewport.height` by `syncAppHeight()` (ignored while pinch-zoomed;
    `100dvh` is the pre-JS fallback).
  - **`min-height: 0` on `html, body` is load-bearing.** The base rule floors
    body at `min-height: 100vh`, min-height beats height, and Chrome for
    Android resolves `100vh` to the URL-bar-*retracted* height — so without the
    reset the column is floored ~80px taller than the viewport it must fit in,
    and the keypad's last row goes under the bottom edge. This was the actual
    cause of "the keypad does not fit", and headless cannot see it: there
    `100vh == innerHeight` and the floor is a no-op. `?vp=1` named it — the
    phone reported `screen 559` where flex should have given 479, and a row
    that overshoots its flex share means an ancestor is taller than the
    viewport, not that the viewport was mis-measured. Reproduce it in a
    headless phone context with `:where(body){min-height:947px}`.
  - **The column is correct by construction, and `fitScreen()` must never
    compute a height budget of its own.** `.screen-row` is `flex: 1;
    min-height: 0`: the status row and the keypad keep their natural heights,
    the browser hands the row exactly what is left, and `fitScreen()` only
    fits the box *inside* the flex-resolved `.screen-cell` rect. Deriving a
    budget in JS instead (from `.phone-panel`'s rect, or `innerHeight` minus
    padding) is self-concealing: a box that is too tall grows the very
    measurement the next fit reads, so it never converges. Three viewport
    theories — `dvh`, `visualViewport`, safe-area insets — and a `--sysbar`
    fudge constant were spent on the `min-height` bug above before this was
    restored. If the keypad is ever clipped again, check the body floor first.
  - `viewport-fit=cover` is deliberately not set, so the viewport stops above
    the system bars and the `env(safe-area-inset-*)` on `main` read 0; they
    are kept only in case that meta returns.
  - `#btn-fullscreen`, the control row's third icon (after the recorder), is
    the only way to get the browser and system bars back — worth ~80px on a
    phone. It needs a user gesture, syncs
    on `fullscreenchange` (swipe/Back/Esc never go through the button), and is
    hidden where the Fullscreen API is not available (iOS Safari).
  - `?vp=1` draws that budget on the page, since this class of bug is reported
    with a screenshot and the numbers have to be inside it.
  `diagnostics()` reports the resulting budget under `viewport` (`inner`,
  `visual`, `appH`, `safeAreaBottom`, the three column heights and `fits`), so
  a "the keypad does not fit" report carries numbers rather than a
  description.
- `boards.tar` unpacked into `/boards`; qemu args mirror the native
  launcher (`-display wasm -icount shift=3,sleep=off -machine pmb887x
  -drive if=pflash… -serial file:/serial.log`; no `-icount` for `lg-*`
  devices; `QEMU_ICOUNT_RTCAP=banked:30` unless `?rt=` says otherwise).
- LCD canvas repaints from the staging buffer on `requestAnimationFrame`;
  every phone key is a `<button>` mapped to linux keycodes, plus
  physical-key mapping.
- Serial is a push, not a poll: `tapSerial()` wraps the MEMFS `stream_ops`
  of `/serial.log` in `preRun`, so every write the guest makes surfaces as
  a callback on the page (with pthreads, FS syscalls from the vCPU worker
  are proxied to the page's thread, which is why this works at all). The
  guest's thread is blocked inside that syscall, so the tap only copies
  the bytes — the pane redraw and the EXIT scan run off a timeout. A build
  whose FS internals moved falls back to the old 1 Hz read of the file.
- **Siemens EXIT**: a panicking firmware prints a crash dump on the trace
  USART, framed `FF FE <len> <len^1> <text>` per message — `>>EXIT<<` plus
  labelled fields on x75/x85, `EXIT: <code>` with the values as separate
  messages on x65. Receiving one ends the run: the page beeps, requests
  the guest's shutdown, drops the canvas to 45 % brightness and fades it to
  black over 30 s (a CSS filter, so screenshots and captures still hand
  back what the phone last drew), and draws the parsed dump over the top
  of the dying screen. `tools/exitcheck.mjs` drives the whole path.
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
