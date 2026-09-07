# qemu-pmb887x in the browser

The Siemens-phone emulator, running **entirely in the browser**:
qemu-system-arm compiled to WebAssembly (`./build.sh` + `./serve.mjs`) —
deterministic boot, splash draws, keypad/serial work — **boots in slow
motion** (fixed 104 MHz virtual clock, see below; full boot takes minutes
to tens of minutes at current TCI speed). See
[doc/livelock-postmortem.md](doc/livelock-postmortem.md) +
[doc/performance-handoff.md](doc/performance-handoff.md).

The page has a fullflash file picker, all `load`
options (device inference, IMEI/ESN→OTP, SIM, operator, startup scenario,
writable-flash) and an on-screen keypad with every phone key as its own
`<button>` (plus physical-keyboard mapping).

## Running it (experimental)

```bash
./build.sh          # ~30-60 min first run: emsdk 4.0.10 + glib/pixman/zlib
                    # built for wasm64, then qemu → dist/qemu-system-arm.wasm
./serve.mjs         # http://127.0.0.1:8080 (COOP/COEP headers for pthreads)
                    # phone/LAN: auto-redirected to https://<lan-ip>:6808
                    # (self-signed — accept the browser warning once; browsers
                    # ignore COOP/COEP on plain http, so https is required
                    # for any host other than localhost/127.0.0.1)
```

Everything runs client-side: the picked fullflash is written into the
emscripten MEMFS, board configs are unpacked from `dist/boards.tar`, and
qemu boots with a small `-display wasm` backend (see below). The TCG
interpreter (TCI) is the only TCG backend available on wasm64, so it is
several times slower than native.

**Timing model (fixed 104 MHz virtual clock):** the fork's
`precise-clocks=on` (icount2) normally adapts the virtual clock to the
host's measured execution rate so virtual ≈ real time — correct natively
(where the host outruns the 104 MHz guest) but fatal on wasm: it locks
the virtual CPU to ~0.5 MHz and every firmware wall-clock budget (the
L1↔DSP handshake first of all) starves → `>>EXIT<< FILE: l1bbcsg`. The
wasm build instead runs the virtual clock at the **fixed real-hardware
rate (104 MHz)**: virtual time is strictly instruction-proportional, so
all firmware deadlines carry the full native instruction budget and the
phone boots without crashing — just in slow motion (~0.5–5% of real
time while executing; WFI idle windows still advance at real pace).
Override for experiments with `?icount2freq=<hz>`.

**Known limitation (raw speed):** boot wall-time is minutes to tens of
minutes (TCI sustains ~0.3–5M guest insns/s during boot, tiering up over
the first minute; native needs ~10⁸–10⁹ insns to reach the idle screen).
Keypad and LCD remain live throughout. Full analysis: [doc/](doc/) — in
particular [doc/performance-handoff.md](doc/performance-handoff.md)
(targets + next steps), [doc/livelock-postmortem.md](doc/livelock-postmortem.md)
(the Asyncify-condvar fix, the wild-TB crash, the fixed-clock timing model)
and [doc/early-crash-postmortem.md](doc/early-crash-postmortem.md)
(the dropped 0004 io-recompile regression).

## Native (Linux) build

The same emulator, compiled natively (real TCG JIT — much faster than the
wasm TCI build; full boot to the idle screen takes ~1–2 minutes):

```bash
scripts/build-native.sh                          # worktree of the pinned rev → build/qemu-native-build
scripts/run-native.sh fullflashes/s75_working20060710172101.bin
```

`run-native.sh` mirrors the web boot exactly (same `-icount
precise-clocks=on`, `-drive if=pflash…`, `-serial file:…` and `PMB887X_*`
env vars; board inferred from the fullflash filename, IMEI/ESN → OTP
included). Options via env: `BOARD= STARTUP= SIM= OPERATOR= IMEI= ESN=`
`RW=1 DISPLAY_MODE=vnc=[:N] MONITOR=unix:/tmp/pmb.sock SERIAL=path`,
extra qemu args as positional args. Headless by default; the serial log
lands in `/tmp/pmb887x-serial.log`.

## Layout

```
web/
  build.sh              one-shot WASM build (toolchain → deps → qemu → dist)
  serve.mjs             static server for the WASM page (COOP/COEP)
  versions.env          pinned qemu-pmb887x / bsp / toolchain revisions
  scripts/
    build-deps.sh       emsdk + glib/pixman/zlib built with emcc (wasm64)
    build-qemu.sh       clones pinned qemu-pmb887x, applies patches/, builds
    build-native.sh     native Linux build (pristine worktree, no patches)
    run-native.sh       native launcher (same boot recipe as the web page)
  patches/
    0001-ui-add-wasm-*.patch   wasm display/input backend (applied to the clone)
    0006-wasm-icount2-*.patch  fixed 104 MHz virtual clock on emscripten
    attic/                    dropped patches (0004 io-recompile skip: boot regression)
  site/                 WASM-mode page (index.html / app.js / style.css)
  tools/                headless-browser test/screenshot helpers (playwright)
                        test fullflash path lives in tools/testflash.local.json
                        (gitignored — copy from tools/testflash.local.json.example)
  dist/                 WASM build output — serve this (gitignored)
```

The WASM build is fully decoupled from the upstream sources: it clones
`Azq2/qemu-pmb887x` and `Azq2/pmb887x-dev` at the revisions pinned in
`versions.env` into `web/build/` (gitignored) and applies only the patch in
`web/patches/`. Nothing in this repo's other components is modified.

## The wasm UI patch

`web/patches/0001-ui-add-wasm-display-input-backend.patch` adds `ui/wasm.c`
(compiled only for `host_os == 'emscripten'`) plus small qapi/meson wiring:

- a `DisplayChangeListener` that blits the console surface into an
  XRGB8888 staging buffer exported to JS (dirty-flag guarded),
- adaptive `dpy_refresh` polling (the pmb887x LCD only redraws when
  `GraphicHwOps.gfx_update` is polled),
- linux-keycode input from JS through an SPSC ring drained by a bottom half
  on the qemu main loop (safe to call from the browser main thread),
- a thread-safe `wasm_quit()` mapped to the QMP-quit shutdown cause,
- diagnostic exports (`wasm_fb_*`, `wasm_vclock`) and the emscripten link
  settings the page needs (`ENV`, heap views, `EXIT_RUNTIME`).

Select with `-display wasm` — the same way `-display none` works.

## Pins

`versions.env` pins qemu-pmb887x `2735ce4e` (2026-08-02, interpreter-DSP era)
and bsp `9277046`. Notes for bumping:

- `43d084b2` (“native TCG DSP emulation”) and later run the DSP on a TCG
  worker thread; that revision boots natively but hits the wasm stall
  earlier (the MCU↔DSP `COM_SET` handshake livelocks).
- qemu-pmb887x master after `5da18a97` has an unfinished `PLL→CGU` rename
  (fix `hw/arm/pmb887x/i2c_v2.c` + `board.c` first) and the bsp S75 board
  gained an unimplemented RF peripheral (`hd155153np`) that aborts boot.

## Performance work (see doc/performance-handoff.md + doc/wasm32-port-status.md)

- `dist/` — TCI build (patches 0001–0003 + 0006; 0004 dropped — it caused
  an early boot-ROM abort, see doc/early-crash-postmortem.md), boots in
  slow motion.
- `dist-jit/` — wasm32 runtime-JIT build (0005 DRAFT + the old
  0003+0004-era tree), currently stale: needs a fresh baseline against
  the 0004-less, 0006-carrying dist; port in progress.
- Serve both: `WEB_DIST_DIR=$PWD/dist node serve.mjs` and
  `WEB_DIST_DIR=$PWD/dist-jit PORT=8082 HTTPS_PORT=6810 node serve.mjs`.
- Fast iteration: `scripts/ninja-fast.sh` (incremental, correct env);
  profiling: `tools/wprof2.mjs` (per-worker CDP CPU profiles).
