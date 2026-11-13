# qemu-pmb887x in the browser

The Siemens/LG-phone emulator, running **entirely in the browser**:
qemu-system-arm compiled to WebAssembly (`./build.sh` + `./serve.mjs`) —
splash draws, keypad/serial/sound work, every board reaches its idle
screen (the timing model below gives the firmware its full timing budgets
however slow the host is — a slow host merely boots slower). The engine is
the wasm64 TCG JIT backend (`site/dist-jit/`, every board — guest TBs
compiled to wasm at runtime, ~12 MB wasm, ~4 MB gzip'd). The documentation
index is [doc/README.md](doc/README.md).

The page's **Firmware** panel is a two-way switch: **Preset** picks from a
dropdown of predefined fullflashes (inventory: `site/fullflashes.js`;
currently CX70 v56, EL71 v41, SL65 v49 (TIM), S75 v40, KE800 v11b + EFA
and KE970 v10d + EFA, fetched from
`git.siepatch.dev`) — pressing Start downloads it on first use (live
progress; one status line says whether it is cached, and a **Clear cache**
link drops the local copy) and keeps it in the browser's Cache API storage,
so later boots come straight from the cache. **Own file** takes a `.bin` of
your own, dropped or picked; LG fullflashes can be picked together with
their `.cfi-efa` sidecar in one go — the EFA block holding the LG EEPROM, a
missing one makes LG firmware factory-reset — and the sidecar picker only
appears once an LG device is selected. Start/Stop live in the status pill
above the screen — amber with a `· slow` suffix while the guest is running
under 0.80× real time — the **Run** panel holds the keypad/HUD settings,
**Copy diagnostics** and the flash + EFA exports, a two-line performance
strip sits on the top edge of the screen while the guest runs, and the
on-screen keypad has every phone key as its own `<button>` (plus
physical-keyboard mapping). With **Type letters on the phone** ticked (Run ▸
Keyboard), a letter, space or punctuation mark typed on the computer presses
its digit key as many times as that phone's multi-tap needs (the phone's
editor has to be in multi-tap, not T9; Shift reaches the characters on keys
that are phone keys of their own, e.g. Shift+1 for "!"). A character no key
cycles through, such as `$`, `;` or `{`, is picked from the phone's `*`
symbol picker. While typing is on, `-` `=` `/` and `` ` `` type their
characters; volume, `#` and `*` stay on the numpad. The tables and pickers
are read off the firmware and kept with the keypads in `site/keyboards.js`,
per keyboard and language. The phone itself is the same view everywhere and
fills whatever it is given: the screen takes the board's own aspect ratio and
the keypad scales with it, on a phone and on a desktop alike. From 900px wide
the two panels flank it; below that they are bottom sheets, and a window that
is short and wide puts the keypad beside the screen instead of under it.
`load` options (device
inference, IMEI/ESN→OTP, SIM, operator, startup scenario) are under
**Advanced**, and so is **Siemens keys** — the three ways pmb887x-emu can
reconcile an own-file Siemens fullflash with the ESN the phone is handed
(see below).

## Running it (experimental)

```bash
git submodule update --init qemu   # build.sh does this too; the qemu
                                   # tree is ~1 GB with history
./build.sh          # ~30-60 min first run: emsdk 4.0.10 + glib/pixman/zlib/libffi
                    # built for wasm64, then qemu → site/dist-jit/
                    # qemu-system-arm.wasm
./serve.mjs         # http://127.0.0.1:8080 (COOP/COEP headers for pthreads)
                    # phone/LAN: auto-redirected to https://<lan-ip>:6808
                    # (self-signed — accept the browser warning once; browsers
                    # ignore COOP/COEP on plain http, so https is required
                    # for any host other than localhost/127.0.0.1)
```

`serve.mjs` keeps a gzip'd sidecar of the wasm (dist-jit: ~12 MB → ~4 MB
on the wire; `GZIP=0` disables) and revalidates with ETags, so repeat
visits skip the re-download (`tools/loadbench.mjs` measures the startup
path). The page also prefetches the engine wasm (plus the small Siemens
keys tool) in the background once the page itself is up — fetched *and*
compiled ahead of time, so Start only instantiates; the idle status pill
shows the progress (`Prefetching emulator · …`, no percent while the body
arrives gzip-compressed). A Start that beats the download rides the very
same in-flight fetch out (`Downloading emulator · …`, Cancel aborts), and
a failed prefetch falls back to the loader fetching at boot as before
(`tools/engine-prefetch-web.mjs` covers the flow end to end).

Everything runs client-side: the picked fullflash is written into the
emscripten MEMFS, board configs are unpacked from `site/dist/boards.tar`
(always fetched from `dist/`, whatever `?dist=` selects), and qemu boots
with a small `-display wasm` backend (see below). It is built from the
`qemu/` submodule. The wasm64 backend stays well behind native (see
[doc/performance.md](doc/performance.md)).

**Timing model (upstream TCG vcpu-timers,
`-accel tcg,thread=multi,vcpu-timers=on,vcpu-timers-bank=30,vcpu-timers-idle-lead=2000,cross-page-links=on`):** the
virtual clock counts guest CPU cycles at the CPU clock the CGU programs,
and the virtual timers run on the vCPU thread. Every firmware timing
budget — the L1↔DSP handshake first of all — therefore carries the full
native instruction budget however slow the host is: a slow host slows the
clock, a fast one waits for wall time, as the real phone does. Upstream
drops any lag over 100 ms; `vcpu-timers-bank` (this fork, page `?bank=<s>`,
default 30, `0` = upstream) makes the guest catch up on all of it during
its first 30 s of its own clock — the boot — which it does whenever it
idles, so the boot ends close to the phone's own timeline. It never runs
ahead of wall time. `vcpu-timers-idle-lead` (page `?idlelead=<us>`) lets a
waiting guest run its timers in batches up to that far ahead instead, one
host sleep per batch (default 2000 µs). `cross-page-links` chains TBs
directly across guest pages. Every board runs this clock. `?icount=<spec>` selects stock
icount instead (`shift=3,sleep=off` is the deterministic model the
lockstep tools use; it runs unpaced); `?icount=none` runs the plain
realtime clock. Why not the plain realtime clock:
[doc/lessons.md](doc/lessons.md).

**Where the time goes:** on the wasm64 backend an S75 boot to the idle
screen is ~23.7 s of wall against ~23 s of the guest's own boot timeline:
the first ~11 s (translation of cold code, the DSP's cell search, ARM
execution) run below real time, and the bank repays that in the idle
stretches after it. On a slower host the compute-bound part grows. Full
analysis: [doc/performance.md](doc/performance.md) (the A/B method, where
the time goes, closed ideas and open levers) and
[doc/lessons.md](doc/lessons.md) (the reasons behind the timing model, the
emscripten runtime traps and the measuring rules). The build is
multi-threaded in the browser: one vCPU thread executes guest code, and the
other pthread workers park in futex waits.

## Siemens keys

Siemens firmware binds itself to the NOR flash serial number: the keys in
the bootcore and the confidential EEPROM blocks must match the ESN the phone
is handed, or it refuses to boot. A dump read off a real phone answers to
*that* phone's ESN, not to the page's. **Advanced ▸ Siemens keys** offers the
three ways `pmb887x-emu` settles this, for a `siemens-*` device in **Own
file** mode (the presets in the inventory are published already
recalculated, so the modes have nothing to do there):

| mode | what happens |
| ---- | ------------ |
| **Automatically recalculate keys** (default) | The bootcore HASH/IMEI and the confidential EEPROM blocks in *this run's copy* are rewritten for the IMEI and ESN in the fields below. Your file is not touched; **Export ▸ Flash** hands the patched copy back. A flash that already matches is left alone. |
| **Brute-force ESN** | The IMEI, SKEY and stored key are read out of the image and the 2³² ESN space is swept for the one they were built from; the flash then boots byte for byte with its own identity. ~10 M candidates/s per core in a browser (20 M under node) over `min(hardwareConcurrency, 8)` workers, so single-digit minutes at worst — with progress on the status pill and Cancel in place of Start. The answer is remembered (keyed on the IMEI + stored key, so it follows the image, not the filename) and re-verified on every reuse; **Clear ESN cache** drops it. Needs intact keys — there is nothing to recover from a cleared bootcore. |
| **Run as is** | The fullflash goes to the phone unchanged. |

pmb887x-emu's Siemens fullflash code is a library of its own upstream (`src/siemens`, "siemensfw", namespace
`SiemensFW`), and `scripts/build-recalc-wasm.sh` compiles that library plus
the page's glue (`site-src/recalc/recalc_wasm.cpp`) into
`site/dist/siemens-recalc.wasm` — recalculation and ESN recovery are the
library's own code, and the sweep re-expresses its BKEY/HASH method over the
same batched MD5 primitive (25 M candidates/s per core) without the
std::thread pool a browser cannot host. The module is also the Siemens half
of the page's device detection (below).
`node tools/recalc-check.mjs` exercises it against a real fullflash without a
browser; `node tools/keysboot.mjs` boots one through every mode. Device
detection has its own pair: `node tools/detect-check.mjs` (headless, every
dump in `fullflashes/`) and `node tools/detect-web.mjs` (through the page,
including the boards.tar wiring).

## Native (Linux) build

The same emulator, compiled natively (real TCG JIT — much faster than
the wasm builds; S75 boots to the idle screen in ~15 s, unpaced: the
launcher's default `-icount shift=3,sleep=off` never waits for wall time):

```bash
scripts/build-native.sh                          # qemu/ as checked out → build/qemu-native-build
scripts/run-native.sh fullflashes/s75_working20060710172101.bin
# LG (device auto-inferred; the EFA block is picked up from
# <fullflash>.cfi-efa next to the flash — keep them together):
scripts/run-native.sh fullflashes/KE800-v11b.bin
```

`run-native.sh` follows the web boot recipe (same `-drive if=pflash…`,
`-serial file:…`, `PMB887X_*` env vars and, with a bsp from 85d4f78 on,
`-device gsm-sim,operator=…`; board inferred from the fullflash filename,
IMEI/ESN → OTP included) but defaults to the deterministic
`-icount shift=3,sleep=off` instead of the page's vcpu-timers clock:
`ICOUNT=<spec>` sets another `-icount`, `ICOUNT=vt` runs
`-accel tcg,thread=multi,vcpu-timers=on`, `ICOUNT=none` neither. Options via
env: `BOARD= STARTUP= SIM= OPERATOR= IMEI= ESN= EFA_FILE=`
`RW=1 DISPLAY_MODE=vnc=[:N] MONITOR=unix:/tmp/pmb.sock SERIAL=path`,
extra qemu args as positional args. Headless by default, the flash is
opened read-only unless `RW=1`, the monitor is on stdio and the serial log
lands in `/tmp/pmb887x-serial.log`.

`build-native.sh` builds `qemu/` as it is checked out — the same tree the
wasm builds compile — and writes `qemu-source.txt` (HEAD plus a hash of
any uncommitted diff, `scripts/qemu-source-id.sh`) next to the binary;
`tools/lockstep-wasm.mjs` refuses a native reference whose stamp does not
match the dist's. So the native build carries the whole fork series too.
Much of it is `__EMSCRIPTEN__`-gated or wasm64-only and inert natively; the
parts compiled into every build (marked **all** in
[doc/wasm-fast-paths.md](doc/wasm-fast-paths.md)) are semantics-preserving
and are what the native suite (`tests/run.mjs`) and the lockstep gate
cover.

## Layout

```
.
  qemu/                 git submodule: Azq2/qemu-pmb887x, branch
                        wasm-browser-port — the wasm/perf series committed
                        on top of siemens-mobile-hacks/qemu-pmb887x master,
                        which is merged in regularly; the ONLY qemu source
                        tree (wasm and native builds alike).
  pmb887x-emu/          git submodule: the siemens-mobile-hacks meta-repo
                        @ master; its qemu submodule is not used (the root
                        qemu/ submodule is the build source), but the repo is
                        the source of the siemensfw library the page compiles
                        for key recalculation, ESN recovery and Siemens
                        device detection (scripts/build-recalc-wasm.sh)
  build.sh              one-shot WASM build (toolchain → deps → qemu →
                        site/dist-jit)
  serve.mjs             static server for the WASM page (COOP/COEP); serves
                        site/ — static files are edited in place, build
                        artifacts (qemu wasm/js, boards.tar) live in
                        site/dist/ (boards.tar, key module) and
                        site/dist-jit/ (the wasm64 backend)
  versions.env          pinned qemu-pmb887x / bsp / toolchain revisions
  scripts/
    build-deps.sh       emsdk + glib/pixman/zlib/libffi built with emcc (wasm64)
    build-qemu.sh       initialise the qemu (+ pmb887x-emu) submodules, check
                        qemu out at the pinned rev, sync bsp/boards/siemensfw
                        and build the wasm dist (wasm64 backend →
                        site/dist-jit/)
    sync-bsp.sh         bsp checkout @ pin → build/bsp
    pack-boards.sh      build/bsp board configs → site/dist/boards.tar (run by
                        every deploy path)
    build-recalc-wasm.sh  pmb887x-emu's siemensfw library (src/siemens) +
                        the page's glue (site-src/recalc) →
                        site/dist/siemens-recalc.wasm (likewise)
    build-qemu-wasm64.sh  the wasm64 backend build itself (build/qemu-wasm64;
                        configure via qemu's configure, Asyncify onlylist,
                        qom_cast_debug off, atomic deploy + symbol map)
    build-native.sh     native Linux JIT build of qemu/ as checked out (+ its
                        qemu-source.txt stamp)
    build-native-tci.sh native TCI build of the same tree (plugins on — the
                        lockstep b-side)
    qemu-source-id.sh   names the qemu sources a build came from (HEAD + a
                        hash of the uncommitted diff); the wasm builds and
                        build-native.sh write it to qemu-source.txt and
                        lockstep-wasm.mjs compares the two
    build-release.sh    release build: hard-sync to the pins, rebuild the
                        dists, bundle for static deployment
    bundle-dist.sh      assemble the deployable static bundle in dist/ (what
                        deploy/nginx/ serves; pre-gzip'd + manifest)
    run-native.sh       native launcher (the web page's boot recipe, icount
                        clock by default)
    ninja-fast.sh       incremental rebuild + deploy (wasm64 →
                        site/dist-jit) — the iteration loop
    iterate.sh          one-command edit→rebuild→browser-verdict loop
    gate.sh             builds the native references, then every
                        correctness gate, run concurrently, one verdict
                        table: quick | keep | close
    run-tcg-isa.sh      guest op-suite gate (every built backend,
                        byte-compared against the native JIT)
    run-lockstep.sh     native cross-backend lockstep gate
  site-src/recalc/      emcc glue around the siemensfw library
                        (the only C++ here outside the submodules)
  tests/
    tcg-isa/            guest op-suite (bare-metal ARM926 versatilepb image
                        asserting (value, NZCV) per op class; runs on native
                        JIT, native TCI and the wasm page, byte-compared):
                        scripts/run-tcg-isa.sh is the gate, tools/tcgisa*.mjs
                        drive the page leg, `?suite=dist/tcgisa.bin` boots it
    lockstep.c (+ tools/lockstep*.mjs, scripts/run-lockstep.sh)
                        whole-boot cross-backend value equality (per-epoch
                        register + memory digests) — see tests/README.md
    tcgbench/ (+ tools/tcgbench.mjs)
                        fast-iteration perf bench on versatilepb: per-phase
                        backend A/B + the device/icount-tax mirrors
    run.mjs             native boot suite (s75/el71/c81/ke800/ke970) and the A/B
                        harness for qemu/bsp bumps
  site/                 the served web root — editable static page (index.html /
                        app.js / style.css / keyboards.js; fullflashes.js holds
                        the preset-fullflash inventory + Cache API handling)
                        plus dist/, dist-jit/ — build artifacts (gitignored);
                        dist-*/ are A/B snapshots
  tools/                headless-browser test/bench/probe helpers (playwright);
                        the ones that matter are listed in doc/diagnostics.md.
                        Test fullflash path lives in tools/testflash.local.json
                        (gitignored — copy from tools/testflash.local.json.example)
```

## The wasm UI backend

`ui/wasm.c` (compiled only for `host_os == 'emscripten'`, plus small
qapi/meson wiring) is:

- a `DisplayChangeListener` that blits the console surface into an
  XRGB8888 staging buffer exported to JS (dirty-flag guarded),
- adaptive `dpy_refresh` polling (the pmb887x LCD only redraws when
  `GraphicHwOps.gfx_update` is polled),
- linux-keycode input from JS through an SPSC ring drained by a bottom half
  on the qemu main loop (safe to call from the browser main thread),
- a thread-safe `wasm_quit()` mapped to the QMP-quit shutdown cause,
- the exports the page reads (`wasm_fb_*`, `wasm_vclock`, `wasm_insns`,
  `wasm_halts`, `wasm_clock_banked`; full list in
  [doc/diagnostics.md](doc/diagnostics.md)) and the emscripten link
  settings the page needs (`FS`, `ENV`, heap views, `EXIT_RUNTIME`).

Select with `-display wasm` — the same way `-display none` works.

## Sound

`audio/wasmaudio.c` (again `host_os == 'emscripten'` only) is a mixeng
backend selected with `-audio wasm`. It publishes S16 frames into a fixed
ring that lives in the wasm heap; because the heap is a `SharedArrayBuffer`,
`site/audio-worklet.js` reads those same bytes on the audio render thread.
Nothing is copied per buffer and the main thread is never on the path.

The page passes `out.frequency=<AudioContext.sampleRate>,out.channels=2`, so
the guest's mixer resamples the DSP's 8/16 kHz output straight to the output
device and the worklet copies frames rather than interpolating them.

The sound itself comes from the real DSP firmware: qemu-pmb887x's DSP LLE
(`hw/arm/pmb887x/dsp/`, upstream code since the `dsp-lle` branch went into
siemens-mobile-hacks master) runs the Teak DSP (mask ROM plus the code the
ARM downloads) through a TCG JIT (`dsp/tcg.c`) synchronously on the vCPU
thread, in lockstep with the guest's virtual clock. Two host
voices carry it: the AFE DAC ring (PMB8876 boards: S75, EL71, C81, CX70, LG)
and the I2S2 link to the PASIC codec in the d1094xx PMIC (PMB8875 boards such
as SL65, whose mask ROM renders melodies there).

Nothing back-pressures the guest — the DSP produces samples at the
speed of the guest's virtual clock, and during a Siemens boot that is ~0.25×
real time in the browser. Three pieces keep that from coming out as stutter:

- upstream's PCM output (`hw/audio/pcm-out.c`, `SPEAKER_PREFILL_MS` in
  `hw/audio/speaker.c`) holds a voice back until 60 ms of samples are
  queued, then plays until the queue runs dry; a mid-stream underrun stays
  a gap and waits for the next 60 ms instead of being padded with silence.
- `wasmaudio.c` paces its writes on the host clock, so a guest that runs
  ahead of real time cannot fill the ring ahead of it (≈70 ms queued at
  steady state). It also publishes `streaming` in the ring header, which
  drops when the mixer disables the voice. The mixer does that only after
  the last device stopped and its frames were written, so it marks the end
  of every sound.
- `audio-worklet.js` banks a cushion before playing and after every dropout.
  It starts at 80 ms; a dropout grows it to cover a 5 s sound rendered at
  the measured producer speed and stretched as far as the worklet stretches
  (at least doubling, at most 400 ms). The speed
  is measured only while a sound is in progress. When a sound ends, whatever
  it banked plays at once and the cushion goes back to 80 ms; a second of
  silence inside a stream does the same and skips the silent backlog.
- The worklet keeps the delay low inside a long stream such as game music.
  After every 2 s in which the producer kept up and nothing dropped out, the
  cushion halves, and the lowest the bank went above 80 ms is played out 10 %
  faster at the same pitch: the worklet splices out 4–20 ms stretches where
  the sound repeats itself, with a 12 ms crossfade (time-domain WSOLA, as
  WebRTC's NetEQ does). The delay never stays above 500 ms: past it the bank
  is cut back to the cushion in one crossfaded jump.
- While the guest renders slower than real time (below 95 %), the sound
  slows down with it at the same pitch. The speed it follows is the
  producer's, smoothed over 250 ms and corrected by how far the bank is from
  the cushion. A phase vocoder does the slow-down: 2048-frame Hann windows
  (43–46 ms) every quarter window, with identity phase locking (Laroche &
  Dolson), so a note is held longer rather than repeated. Attacks go through
  at full speed, and entering and leaving it are sample-exact. It slows down
  to 0.15×, below the 0.25× the cushion is sized for, so the bank refills
  and pays back the attacks. Until a window and a hop (~55 ms) are banked,
  the same splices as above jump back instead of ahead and play a stretch
  where the sound repeats itself again, down to a quarter speed. Below that
  the sound is choppy rather than late. The vocoder's code runs once on
  made-up input when the first ring is attached (30–40 ms on a desktop), so
  V8 has compiled it before a real stream first needs it. The ring header
  counts the frames skipped or replayed (`drainedMs`, `cutMs` and
  `stretchedMs` in
  `tools/scenebench.mjs`).

Muting is *not* the same as having no audiodev: the backend keeps consuming
at the nominal rate when nobody is listening, so a mute drops audio instead of
stalling the phone. `?sound=off` leaves the machine without an audiodev at
all, which is what the benchmarks use.

Verify with `tools/audioprobe.mjs` (`TOGGLE_AT=` exercises mute/unmute):

```sh
TESTFLASH=fullflashes/KE800-v11b.bin node tools/audioprobe.mjs
```

A video capture records the sound too, also while the speaker is muted (the
mute then only closes the speaker's gain). `tools/recprobe.mjs` plays a MIDI
on the SL65, records it with the page's button and checks the file with
ffprobe/ffmpeg (`--unmuted` for the other case).

Boot chimes in the browser (ring peak, matching a native `-audio wav`
capture): C81 23317, EL71 13059, SL65 6841, KE800 13262, KE970 8571. S75
v40 has no boot chime, only a short blip. Native captures: `node` + `-audio wav,path=…` on
`scripts/run-native.sh`.

## Pins

`versions.env` pins what `build-qemu.sh` and `build-release.sh` check out;
its comments record every bump and why. In outline:

- qemu-pmb887x (`QEMU_PMB887X_REV`, branch `wasm-browser-port`) — the fork
  series on top of siemens-mobile-hacks/qemu-pmb887x master, which is
  merged in regularly (last: `0539060008` on 2026-11-12). Upstream carries
  the DSP LLE (the Teak mask ROM and the downloaded code run through a TCG
  JIT synchronously on the vCPU thread), the `vcpu-timers` clock,
  `-debug-channels`, the SIM as `-device gsm-sim` and the CFI flash with
  its own writeback. What the fork adds is outlined in
  [doc/architecture.md](doc/architecture.md), and every speed-only change
  is listed in [doc/wasm-fast-paths.md](doc/wasm-fast-paths.md).
- bsp (pmb887x-dev, `PMB887X_BSP_REV`) — a bsp master revision; a plain
  checkout of the pin is the whole tree. Each board declares an empty
  `iso7816-slot` for the card: the page and `run-native.sh` add
  `-device gsm-sim,operator=…` when the board set has that slot. qemu's
  generated `gen/` tables (pad names) must match the bsp (regenerate with
  bsp's `tools/qemu.sh` and compare).
- pmb887x-emu `91a9b14` — master. Not built from (qemu comes from the root
  submodule); it is the source of the siemensfw library (`src/siemens`)
  that `scripts/build-recalc-wasm.sh` compiles for the page's Siemens-key
  and device-detection module. Its own runner still passes
  `-icount precise-clocks=on` and `PMB887X_SIM*` variables, which qemu no
  longer has.
- emsdk, glib, pixman, zlib and libffi versions mirror qemu's
  `emsdk-wasm64-cross.docker`.

Bumping: change the pin, rebuild (`build-qemu.sh` moves the submodule to
the pin); `tests/run.mjs` is the A/B harness — it boots
s75/el71/c81/ke800/ke970 natively and benchmarks before/after, and
`bash scripts/gate.sh keep` is the browser-side gate.

## Performance work

[doc/performance.md](doc/performance.md) is the entry point: the owner's
rules, the measuring method, the cost model, closed ideas and history.

- Fast iteration: `scripts/ninja-fast.sh` (incremental build and atomic
  deploy to `site/dist-jit` or `$WEB_DIST`), then
  `tools/perf/swab.sh <scene> <distA> <distB>` (paired free-run A/B of two
  builds on pinned cores; both dists need `tools/perf/freerun.diff`) or
  `tools/perf/bootab.sh` for the boot.
- `node tools/scenebench.mjs <scene>` runs the scenarios (`stopwatch`,
  `music`, `idle` on the EL71, `midi` and `video` on the SL65, `bobby` and
  `towerblox` on the S75) and measures sound as well: dropouts and
  silenced time while the guest plays.
- Gates: **`bash scripts/gate.sh keep`** builds the native references and
  then runs every gate at once. A gate never reads a wall clock as a
  result, so unlike the benchmarks it is safe to parallelise. `gate.sh
  close` adds the ordered boot of all five boards in one browser, the
  native lockstep, the 2.5e9 lockstep, Firefox, device detection, the EFA
  page test and the UI checks.
- Profiling: V8 `--prof` with `tools/perf/v8tick.py`, or
  `tools/wprof2.mjs` (per-worker CDP profiles).
