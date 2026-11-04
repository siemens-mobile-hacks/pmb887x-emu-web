# Architecture

The Siemens/LG phone emulator runs entirely in the browser. Repo layout:

```
.
  qemu/                                     submodule: Azq2/qemu-pmb887x @ the pinned rev on the
                                            series branch (wasm-browser-port = origin/wasm-patches):
                                            the one qemu source tree, wasm and native builds alike
  pmb887x-emu/                              submodule: the meta-repo @ master (reference; also the
                                            source of the siemensfw library the page compiles)
  build.sh, versions.env, scripts/          build pipeline (WASM + native modes)
  site-src/recalc/                          emcc glue around pmb887x-emu's siemensfw library
                                            (src/siemens) → site/dist/siemens-recalc.wasm
                                            (Advanced ▸ Siemens keys + device detection)
  site/                                     served web root (index.html / app.js / keyboards.js /
                                            fullflashes.js / siemensfw.js); dist-jit/ = wasm64
                                            backend build, dist/ = boards.tar + key module +
                                            suite images, dist-*/ = A/B snapshots
                                            (all gitignored)
  tests/                                    native boot suite (run.mjs), tcg-isa op-suite,
                                            lockstep plugin, tcgbench perf bench
  tools/                                    headless-browser test/probe/bench scripts
  doc/                                      this documentation
```

## WASM (client-side)

Everything runs in the browser: `qemu-system-arm` (arm-softmmu) is compiled
to WebAssembly (wasm64, pthreads, Asyncify) and driven from a page. One
engine is served, plus the files every run needs:

- `site/dist-jit/` — the **wasm64 TCG backend** (0017 + its follow-ups):
  a new TB runs in an interpreter tier for its first 64 entries
  (`tcg/wasm64/w64-interp.c`), then the batch of TBs staged so far is
  compiled into one wasm module; TBs chain via tail calls through a
  shared funcref table, with an inline TLB probe and inline TB
  accounting. On wasm64 the ARM translator builds superblocks (a TB
  carries on past conditional branches, loops back to its own start,
  absorbs short forward branches and inlines direct calls — see
  [wasm-fast-paths.md](wasm-fast-paths.md)). The page engine for every
  board (LG included since 0034–0038). ~12 MB wasm, ~4 MB gzip'd
  (Asyncify onlylist, 0031).  A TCI interpreter build used to ship next
  to it (`?dist=dist`, ~7.4× slower on compute); it was removed in the
  2026-09-22 review, and the oracle for JIT-only failures is the native
  build (lockstep).
- `site/dist/` — where `boards.tar`, the Siemens key module and the
  suite images (`tcgisa.bin`, `tcgbench.bin`) are served from, whatever
  `?dist=` selects.

### Build pipeline

1. `scripts/build-deps.sh` installs emsdk 4.0.10 into `build/deps/emsdk`
   and builds glib 2.84, pixman 0.44.2, zlib 1.3.2 and libffi headers with
   emcc for wasm64 (mirrors qemu's own
   `tests/docker/dockerfiles/emsdk-wasm64-cross.docker`; pins in
   `versions.env`).
2. `scripts/build-qemu.sh` initialises the `qemu/` submodule at the
   pinned rev (and moves it there whenever HEAD differs), checks out the bsp at its pin
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
   included, plus `qemu-source.txt`: the identity of the qemu source the
   dist was built from (`scripts/qemu-source-id.sh`: HEAD, plus a hash of
   the uncommitted diff when there is one), which the lockstep driver
   matches against the native reference. `--enable-tcg-interpreter` is
   refused for a wasm host.
3. `serve.mjs` serves `site/` — static page files edited in place, build
   artifacts in `site/dist*/` — with the COOP/COEP headers pthreads need
   (SharedArrayBuffer), a gzip sidecar + ETag revalidation for the wasm,
   and an https port for phone/LAN access.

Incremental iteration: `scripts/ninja-fast.sh` (wasm64 → `site/dist-jit`;
rebuild + atomic deploy + `qemu-source.txt` + boards.tar refresh, no tree
reset). One-shot: `./build.sh`.

### The series

All qemu changes are commits on the submodule branch (`versions.env`
pins the tip; the structural ones are listed below with scope).

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
  - Diagnostics: `wasm_vclock`, `wasm_fb_updates`, `wasm_insns`,
    `wasm_halts`, `wasm_clock_banked` (the tool-only `wasm_tbs`,
    `wasm_reg/pc/peek`, `wasm_irq_pending` and `wasm_memstat` went in the
    2026-09-22 review).
- qapi/ui.json: `DisplayType` gains `wasm` (CONFIG_WASM_UI); ui/meson.build
  compiles the backend; the link settings in the cross file that
  `scripts/build-qemu-wasm64.sh` generates (they replace upstream
  `configs/meson/emscripten.txt`'s) add the exports the page needs (`ENV`,
  `HEAPU8`, `EXIT_RUNTIME`).

`0002 wasm: Asyncify-safe futex/condvar`
- `include/qemu/futex.h`: emscripten futex wrappers (`emscripten_futex_*`);
  `HAVE_FUTEX` becomes defined on emscripten, switching QemuEvent/LockCnt to
  their futex fast paths.
- `util/qemu-thread-posix.c` + `include/qemu/thread-posix.h`: futex/seq
  based `QemuCond` for emscripten (pthread_cond everywhere else); 0021
  fixed the untimed wait (it passed a 0 ms timeout = immediate return).
- Its icount2 parts (no per-insn icount2 helper, a 1 kHz frequency floor)
  went with icount2 itself in the 2026-10-29 dsp-lle merge.

`0003` (TCI inline TLB probe + direct helper dispatch) and the TCI-only
half of `0007–0016` (immediate forms, inline ldst fast path,
size-specialized memory ops) left with the TCI browser build in the
2026-09-22 review: `tcg/tci.c` is upstream's again. `0004` keeps the
stock io-recompile rewind for ROM-device (flash command) accesses and
accounts mid-TB MMIO at the io boundary on emscripten (design + dead
ends: [lessons.md](lessons.md) § Mid-TB MMIO; `0010` extends
the skip to the stock-icount model; `0014`/`0036` keep barrier insns in
single-insn TBs so the rewind stops recurring).

What remains of `0007–0016` is backend-independent: main-loop futex
wait, io-recompile skip, SVC inline exception exit, io barriers, romd
FlatView variants. Numbers in the commit messages on the `qemu/` branch.

`0017` is the wasm64 TCG backend (`tcg/wasm64/` + small hooks); 0019,
0020, 0022, 0026, 0029, 0030, 0034, 0038 are its follow-ups
(speculative batching, successor hints, goto_ptr handoff/tail call, no
icount2 prologue, explored flag, retaddr fix, narrowed speculation).
Speculative successor translation itself went in the 2026-09-22 review,
once the interpreter tier had made it stop paying.

Generic qemu-core commits (help every backend including native): `0016`
(romd FlatView variants + range-scoped flush), `0018` (fill-time MMIO
dispatch resolution + flag-masked victim-TLB compare), `0040` (fill-time
TLB growth), `0043` (physical-address summary for the range flush),
`0045` (skip `arm_rebuild_hflags` on CPSR writes that cannot change it).

Timing/halt path: the default clock is upstream's TCG `vcpu-timers`; the
fork adds `vcpu-timers-bank` (lag caught up during the boot, page
`?bank=`), `vcpu-timers-idle-lead` (an idle guest's timers run in batches
ahead of wall time, page `?idlelead=`), a host-clock reading reused while
the guest is behind real time, and spent budgets renewed inside
`cpu_exec()` (`tcg_vcpu_timers_next_budget`) instead of a loop exit per
timer. It also adds `cross-page-links` (TBs chained directly across guest
pages, unlinked on every TLB flush), on in the page's default accel. The
icount-era patches (`0023` idle warp on the vCPU thread, `0024` pmb887x
completion timers on the virtual clock, `0032` real-time cap,
`0035`/`0037` virtual timers without icount) are gone. `0033` selects
the RTC `CNT` layout from the board config (`[rtc] format`: Siemens
linear Unix seconds, LG packed calendar).

DSP: since the 2026-10-29 dsp-lle merge (now part of upstream
`smh/master`) the Teak DSP is emulated low-level — the mask ROM and the
code the ARM downloads run through the DSP's own TCG front end
(`hw/arm/pmb887x/dsp/tcg.c`) on the wasm64 backend, synchronously on the
vCPU thread, from inside the ARM device access that needs them. That
nesting is why `tcg_qemu_tb_exec` on wasm64 is re-entrant (a call frame
per nesting depth, and interpreter records freed only once no run on the
thread is using them).

### Page (site/)

- Firmware panel: a Preset/Own file mode switch (presets come from the
  `fullflashes.js` inventory and live in Cache API storage; own files are
  picked or dropped, `.bin` plus an optional `.cfi-efa` for LG) → file
  bytes written into the emscripten MEMFS; Advanced options become
  `PMB887X_*` env vars (`PMB887X_BOARD`, `_STARTUP`, `_FLASH0_OTP0/1` from
  IMEI/ESN), except the SIM: with a board set whose boards declare an
  `"iso7816-slot"` (bsp ≥ 85d4f78, which the qemu from the 2026-11-04
  smh/master merge needs) a virtual SIM is `-device gsm-sim,operator=…`;
  an older qemu with an older board set reads the `PMB887X_SIM*` vars the
  page still sets. The panel is `disabled` while a guest runs.
- Which phone a fullflash came from (`detectDevice()` in `fullflashes.js`):
  the filename first (`DEVICE_RULES`), then the image itself, so a dump named
  `dump.bin` still selects its board:
  - `0x3C` `"CJKT"` — every pmb887x NOR dump, LG included
    (`build/bsp/boot/fakesign.py`). Separates "not a fullflash" from
    "a fullflash I can't identify".
  - Siemens phones are the library's business: `probeFullflash()` in
    pmb887x-emu's siemensfw (`src/siemens`), whose browser build the page
    loads through `site/siemensfw.js` (entry point `sr_probe` in
    `site-src/recalc/recalc_wasm.cpp`), reads the vendor/model records
    straight out of the image and derives the board name — the same code
    path the emulator itself takes when `--device` is not given, so what
    the page detects and what boots agree by construction. It checks the
    vendor at four fixed offsets (`0x8FC80`, `0x220`, `0x880`, `0xC80`) for
    both `SIEMENS` and `BENQ-SIEMENS`, with the model in the 16 bytes
    before it; the page hands it the head of the image (`PROBE_HEAD` =
    `0x90000`, covering the farthest record) and it never reads further.
    Its board name is used as-is; a model with no board of its own goes
    through `MODEL_VARIANTS`, and the filename rules over the model string
    are the last resort.
  - LG carries none of the Siemens structures, so the fallback is a JS
    scan: the model comes from the J2ME user agent (`LG-KE800 MIC/…`), over
    a bounded window. How far in the string sits is the phone's business —
    ~4.2 MiB on a KE800 dump, ~32.1 MiB on a KE970 one — so the window is
    40 MiB, read in 1 MiB slices and only for an image the library could
    not place. There is no bootcore-block reading any more — if the library
    cannot place the image, walking the boot area in JS would only re-guess
    what upstream decided not to read.
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
    different part from CL61 (flash `0x880D` vs `0x8819`), and `C70` has no
    source putting it on the same silicon as a board here. (`M75` and `ME75`
    left that table for `DEVICE_RULES` when bsp `e79169f` added boards of
    their own — the 2026-09-20 round that also brought `M65`, `SK65` and
    `SL65`.)
- Advanced ▸ Siemens keys (`site/recalc.js`, `site/recalc-worker.js`): for a
  `siemens-*` device in Own file mode only — the presets are published
  already recalculated — the three ways pmb887x-emu reconciles a fullflash
  with the ESN it is handed. **Automatically recalculate keys** (the
  default) rewrites the bootcore HASH/IMEI and the confidential EEPROM
  blocks in this run's copy for the IMEI/ESN below; **Brute-force ESN**
  reads the identity out of the image and sweeps the 2^32 ESN space in
  `min(hardwareConcurrency, 8)` Web Workers (~25M candidates/s per core on
  the library's batched MD5;
  progress on the pill, Cancel is the pill's action, the answer is kept in
  `localStorage["siemens-esn-v1"]` keyed on IMEI + stored key and
  re-verified on every hit) and then boots the image untouched with its own
  IMEI/ESN; **Run as is** hands it over unchanged. The arithmetic is
  pmb887x-emu's siemensfw library compiled to wasm, not a reimplementation
  — see `site-src/recalc/recalc_wasm.cpp` for how the sweep is re-expressed
  over the library's batched MD5 without its std::thread pool.
- The status pill above the screen carries the run state and the only
  Start/Stop/Cancel there is (`window.__ui` mirrors that state for the
  drivers in `tools/`). A capture in progress is a second pill beside it,
  ended with **Finish** — "Stop" only ever means the emulator.
- **The phone column is the same view at every size, and it is laid out in
  CSS alone.** One `100dvh` page that never scrolls: a single 32px control
  row (state/firmware pill, screenshot, record, fullscreen, settings), the
  screen at the board's own `[peripheral.LCD0]` aspect ratio flanked by edge
  tabs for the side keys, and the keypad under it. From 900px wide (and
  621px tall) the Firmware and Run panels come back as the two columns
  flanking it and the title bar returns; below that they are bottom sheets.
  Nothing else differs between the two, and nothing is scaled after layout —
  there is no `zoom`, no `transform` and no measure-and-apply pass, so a
  window resize is one reflow. `tools/ui-acceptance.mjs` checks all of this;
  `tools/uidiff.mjs` compares two builds' keypad geometry normalised by the
  screen box.
  - Everything is derived from `.phone-panel`'s own box, published to its
    descendants by `container-type: size` as `cqw`/`cqh`. The custom
    properties are inherited as *unresolved tokens*, so those units resolve
    where they are used — on a descendant — and each therefore means "of the
    phone column". `--key-h` is one keypad row (5.08% of the column, or the
    widest keypad that still fits, whichever is smaller, between 30px and
    72px); `--pad-h` is `7 × --key-h + 6 × --kgap`, because the keypad is
    always exactly seven key rows whatever board is in it — the rows divide
    that height rather than setting it, which is what used to make the screen
    box depend on which phone was selected. `--box-h` is then what the column
    has left, `--box-w` that at the board's ratio, `--tab-w` what a
    ratio-locked box could not use (14px to 44px, and no more than 13% of the
    box), and `--asm-w` the whole assembly, which the control row matches.
  - The one thing CSS cannot know is the panel's aspect ratio, because that is
    board data: `setAspect()` publishes it as `--ar` on `.phone-panel` — from
    the board config, or from the guest's own framebuffer once it is running.
    That is the entire layout contribution of `app.js`.
  - A board with keys on one side only collapses the empty column
    (`.aux-keys-*:empty`), and `.phone-panel:has(.aux-keys-* button)` is what
    tells the arithmetic above how many tabs to leave room for. The screen is
    then balanced back to centre with a margin on the empty side, but only
    out of width nothing else wants — where the box is width-limited it keeps
    every pixel and hangs half a tab off centre instead.
  - Short and wide (`max-height: 620px`, from 560px) puts the keypad *beside*
    the screen instead of under it — a phone on its side, or a shallow
    window. Same pieces and the same arithmetic; only the axis the two share
    changes. Three things about that block have already gone wrong once, and
    a phone in landscape with the seven-key `generic` flank is what shows all
    three:
    - **`align-items` means a different axis in the grid.** The column
      layout's `align-items: center` centres the pieces *horizontally*; left
      alone in the grid it stops stretching the screen row to its track, so
      the row content-sizes to the flank and grows past the bottom of the
      window. The block sets `align-items: stretch` for that reason.
    - **A flank must be stretched, never `height: 100%`.** That percentage
      cannot resolve against a grid track, so the column sizes itself to its
      keys instead of shrinking them into the row.
    - **The tabs' spare width is what the keypad has not taken.** Reusing the
      column layout's figure hands them width the keypad is standing in and
      pushes it off the side. The one-flank centring margin is scoped by the
      exact complement media query rather than reset inside the block,
      because `:has()` gives those selectors more specificity than a plain
      descendant reset can beat.
  - **`min-height` on `html, body` must stay 0.** A `min-height: 100vh` here
    beats the `height` we set, and Chrome for Android resolves `100vh` to the
    URL-bar-*retracted* height — so the column gets floored ~80px taller than
    the viewport it must fit in and the keypad's last row goes under the
    bottom edge. This was the actual cause of "the keypad does not fit", and
    headless cannot see it: there `100vh == innerHeight` and the floor is a
    no-op. Reproduce it in a headless phone context with
    `:where(body){min-height:947px}`.
  - `viewport-fit=cover` is deliberately not set, so the viewport stops above
    the system bars and the `env(safe-area-inset-*)` on `main` read 0; they
    are kept only in case that meta returns.
  - `#btn-fullscreen`, the control row's third icon (after the recorder), is
    the only way to get the browser and system bars back — worth ~80px on a
    phone. It needs a user gesture, syncs on `fullscreenchange` (swipe, Back
    and Esc never go through the button), stands down while a capture runs
    (the recording pill needs that width at 320px), and is hidden where the
    Fullscreen API is not available (iOS Safari).
  - `?vp=1` draws the height budget on the page, and it self-shows on a real
    overflow, since this class of bug is reported with a screenshot and the
    numbers have to be inside it. `used` is measured (the lowest edge of the
    phone against the height the column was given), not added up, so it holds
    for the landscape arrangement too. `diagnostics()` reports the same under
    `viewport` (`inner`, `visual`, `bodyH`, `bodyMin`, `safeAreaBottom`, the
    three heights and `fits`).
  - Drivers in `tools/` that set controls in the two panels need a viewport
    at least 900x621, or the panel they are reaching into is a closed sheet.
- `boards.tar` unpacked into `/boards`; qemu args (`-display wasm
  -audio wasm,… -accel
  tcg,thread=multi,vcpu-timers=on,vcpu-timers-bank=30,vcpu-timers-idle-lead=2000,cross-page-links=on
  -machine pmb887x -drive if=pflash… -serial file:/serial.log -monitor
  none [-device gsm-sim,…]`, every board alike; `?bank=`/`?idlelead=` set
  those two values, `?icount=` swaps the accel for `-icount`, a `?qargs=`
  with its own `-accel` drops it). The native launcher uses the same
  drive/serial/env/SIM set but boots under `-icount shift=3,sleep=off`
  by default.
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
- URL params (see [diagnostics.md](diagnostics.md)): `?dist=<dir>`
  runs another build output (A/B snapshots), `?suite=` boots a bare-metal image headlessly,
  `?env=NAME=VAL` passes environment variables, `?icount=`/`?bank=`/
  `?idlelead=`/`?trace=`/`?qargs=`/`?sound=off` override the boot recipe,
  `?lockstep=1` turns on the built-in guest-state fold.

### Engine history

- **wasm64 TCG backend (0017) — landed 2026-09-10/11**, compute 7.4× TCI,
  every gate green (op-suite ×3 byte-identical, full 2.5e9 lockstep,
  native suite ×4); the module economy, halt path, Asyncify onlylist and
  the EL71/KE800 fixes followed (0019–0038), making it the default for
  every board on 2026-09-12. Current status, methods and cost model:
  [performance.md](performance.md).

## Native (Linux) reference builds

- `scripts/build-native.sh` → `build/qemu-native-build/` (real TCG JIT,
  built from `qemu/` as it is checked out, uncommitted edits included —
  the very tree the wasm builds compile; the emscripten parts are inert)
  — much faster than wasm; used by the test suite, the lockstep
  reference leg and quick experiments. It writes `qemu-source.txt` next
  to the binary, and `tools/lockstep-wasm.mjs` refuses a reference whose
  stamp is missing or differs from the dist's (`--no-ref-check` for a
  deliberate cross-version comparison, `--a-bin` for another build).
  It used to build a worktree at the `versions.env` pin, which nothing
  kept in step with the submodule.
- `scripts/build-native-tci.sh` → native TCI with plugins force-enabled
  (the lockstep b-side), from the same source.
- `scripts/run-native.sh` — launcher mirroring the web boot recipe's
  pflash/serial/env-var set and SIM device, but timed by
  `-icount shift=3,sleep=off` by default (deterministic and unpaced, so
  a native boot fast-forwards idle time; `ICOUNT=vt` runs vcpu-timers
  instead).

## Correctness / testing ladder

**`scripts/gate.sh quick|keep|close` runs all of the gates below
concurrently** and prints one verdict table — a gate never reads a wall
clock as a result, so host load cannot change a verdict. Before its jobs
start it brings the native reference builds (`build-native.sh`, and
`build-native-tci.sh` when a job needs TCI) up to date with `qemu/`. The
benchmarks at the bottom are *not* in it and must be run one at a time on
a quiet host.

| gate | what it proves | driver |
|---|---|---|
| native boot suite | s75/el71/c81/ke800/ke970 boot-init/progress/no-exit | `node tests/run.mjs` |
| browser boot gate | s75/el71/ke800/ke970/cx70 boot on a wasm dist (progress in executed insns) | `node tools/bootcheck.mjs --dist dist-jit` |
| early key | a key delivered before the machine exists does not kill the module | `node tools/earlykey.mjs --board <b>` |
| guest op-suite | 1156 (value, NZCV) cases byte-identical across every backend built (the wasm64 page leg is one of them since 0090 fixed its Asyncify hole) | `scripts/run-tcg-isa.sh` |
| lockstep | whole-boot cross-backend value equality (regs + SRAM/SDRAM digests) against a native reference built from the dist's own source (`qemu-source.txt`); full 2.5e9-insn gate | `scripts/run-lockstep.sh`, `tools/lockstep-wasm.mjs` |
| Firefox smoke | the module budget, by its effect: no page errors, and the guest is still executing after 120 s (`progress=ok`) | `BROWSER=firefox node tools/ffboot.mjs` |

| benchmark | what it measures | driver |
|---|---|---|
| scenebench | EL71 scenarios: stopwatch redraw speed, music playback dropouts, idle host CPU; SL65 MIDI and video; S75 J2ME games (Bobby Carrot, Tower Bloxx) with sound | `tools/scenebench.mjs` |
| parbench | scenebench A/B with every run of every dist started at once | `tools/parbench.sh` |
| free-run A/B | paired A/B on pinned cores with the guest clock running free (both dists built with `tools/perf/freerun.diff`) | `tools/perf/swab.sh` |
| uibench | per-board steady state (MIPS, v/wall, fps) | `tools/uibench.mjs` |
| tcgbench | fast-iteration per-phase A/B + the device/icount-tax mirrors | `tools/tcgbench.mjs` |
| idlebench | boot-to-idle wall time + guest-work milestones (the human metric) | `tools/idlebench.mjs` |
| stopwatch | in-guest pacing while a J2ME app redraws (`vratio`) | `tools/stopwatch.mjs` |

Working method, cost model and history: [performance.md](performance.md)
and [optimization-playbook.md](optimization-playbook.md).
