# qemu-pmb887x in the browser

The Siemens/LG-phone emulator, running **entirely in the browser**:
qemu-system-arm compiled to WebAssembly (`./build.sh` + `./serve.mjs`) —
deterministic boot, splash draws, keypad/serial work, S75 reaches its
idle screen in ~40 s (the stock icount timing model below keeps
correctness independent of host speed — a slow host merely boots
slower). The engine is the wasm64 TCG JIT backend (`site/dist-jit/`,
every board — guest TBs compiled to wasm at runtime, ~28 MB download;
the former TCI interpreter build was ~7.4× slower on compute and has
been removed). See [doc/lessons.md](doc/lessons.md) +
[doc/performance-handoff.md](doc/performance-handoff.md).

The page's **Firmware** panel is a two-way switch: **Preset** picks from a
dropdown of predefined fullflashes (inventory: `site/fullflashes.js`;
currently S75 v40, EL71 v41 and KE800 v11b + EFA, fetched from
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
physical-keyboard mapping). The phone itself is the same view everywhere and
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

`serve.mjs` keeps a gzip'd sidecar of the wasm (dist-jit: 28 MB → ~4 MB
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
`qemu/` submodule. The wasm64 backend stays well behind native — the remaining time is translation/module-compile of cold
code in the first ~0.75 G instructions, and after that the guest's own
timeline (see [doc/performance-handoff.md](doc/performance-handoff.md)).

**Timing model (upstream TCG vcpu-timers,
`-accel tcg,thread=multi,vcpu-timers=on,vcpu-timers-bank=30`):** the
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
host sleep per batch. Every board uses it. `?icount=<spec>` selects stock
icount instead (`shift=3,sleep=off` is the deterministic model the
lockstep tools use; it runs unpaced); `?icount=none` runs the plain
realtime clock. Why not the plain realtime clock:
[doc/lessons.md](doc/lessons.md).

**Where the time goes:** on the wasm64 backend an S75 boot to the idle
screen is ~23.7 s of wall against ~23 s of the guest's own boot timeline:
the first ~11 s (translation of cold code, the DSP's cell search, ARM
execution) run below real time, and the bank repays that in the idle
stretches after it. On a slower host the compute-bound part grows. Full analysis: [doc/](doc/) — in particular
[doc/optimization-playbook.md](doc/optimization-playbook.md) (the
measurement method + what landed/rejected),
[doc/performance-handoff.md](doc/performance-handoff.md) (current
status, open items, constraints) and [doc/lessons.md](doc/lessons.md)
(the conclusions behind the timing model, the io-recompile accounting,
the emscripten runtime traps and the measurement rules). The build
really is multi-threaded in the browser (5 pthread workers; one vCPU
thread executing guest code, the rest parked in futex waits; no spin).

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
native build has no real-time cap by default):

```bash
scripts/build-native.sh                          # worktree of the pinned rev → build/qemu-native-build
scripts/run-native.sh fullflashes/s75_working20060710172101.bin
# LG (device auto-inferred; the EFA block is picked up from
# <fullflash>.cfi-efa next to the flash — keep them together):
scripts/run-native.sh fullflashes/KE800-v11b.bin
```

`run-native.sh` mirrors the web boot exactly (same `-icount
shift=3,sleep=off`, `-drive
if=pflash…`, `-serial file:…` and `PMB887X_*` env vars; board inferred
from the fullflash filename, IMEI/ESN → OTP included; `ICOUNT=<spec>`
overrides the timing model). Options via env: `BOARD= STARTUP= SIM=`
`OPERATOR= IMEI= ESN=`
`RW=1 DISPLAY_MODE=vnc=[:N] MONITOR=unix:/tmp/pmb.sock SERIAL=path`,
extra qemu args as positional args. Headless by default; the serial log
lands in `/tmp/pmb887x-serial.log`.

The native build is made from the same pinned revision as the wasm
builds, i.e. it carries the whole patch series. Almost all of it is
`__EMSCRIPTEN__`-gated or wasm64-only and inert natively; the generic parts
(romd FlatView variants, fill-time MMIO dispatch, fill-time TLB growth,
the range-flush summary, the CPSR hflags skip, the per-board RTC seed)
are semantics-preserving and are what the native suite (`tests/run.mjs`)
and the lockstep gate cover.

## Layout

```
.
  qemu/                 git submodule: Azq2/qemu-pmb887x, branch
                        wasm-browser-port (= origin/wasm-patches) — the
                        whole wasm/perf series committed on top of
                        qemu-pmb887x master; the ONLY qemu source tree
                        (wasm and native builds alike).
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
    build-native.sh     native Linux JIT build (worktree of the pinned rev)
    build-native-tci.sh native TCI build (plugins on — the lockstep b-side)
    build-release.sh    release build: hard-sync to the pins, rebuild the
                        dists, bundle for static deployment
    bundle-dist.sh      assemble the deployable static bundle in dist/ (what
                        deploy/nginx/ serves; pre-gzip'd + manifest)
    run-native.sh       native launcher (same boot recipe as the web page)
    ninja-fast.sh       incremental rebuild + deploy (wasm64 →
                        site/dist-jit) — the iteration loop
    ninja-wasm64.sh     bare incremental ninja in the wasm64 build dir
    iterate.sh          one-command edit→rebuild→browser-verdict loop
    gate.sh             every correctness gate, run concurrently, one
                        verdict table: quick | keep | close
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
    run.mjs             native boot suite (s75/el71/c81/ke800) and the A/B
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

The first commit of the series (`ui: add wasm display/input backend for
emscripten builds`) adds `ui/wasm.c` (compiled only for `host_os ==
'emscripten'`) plus small qapi/meson wiring:

- a `DisplayChangeListener` that blits the console surface into an
  XRGB8888 staging buffer exported to JS (dirty-flag guarded),
- adaptive `dpy_refresh` polling (the pmb887x LCD only redraws when
  `GraphicHwOps.gfx_update` is polled),
- linux-keycode input from JS through an SPSC ring drained by a bottom half
  on the qemu main loop (safe to call from the browser main thread),
- a thread-safe `wasm_quit()` mapped to the QMP-quit shutdown cause,
- diagnostic exports (`wasm_fb_*`, `wasm_vclock`, `wasm_memstat`, …) and
  the emscripten link settings the page needs (`ENV`, heap views,
  `EXIT_RUNTIME`).

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

The sound itself comes from the real DSP firmware: qemu-pmb887x `dsp-lle`
runs the Teak DSP (mask ROM plus the code the ARM downloads) through a TCG
JIT on the vCPU thread, in lockstep with the guest's virtual clock. Two host
voices carry it: the AFE DAC ring (PMB8876 boards: S75, EL71, C81, CX70, LG)
and the I2S2 link to the PASIC codec in the d1094xx PMIC (PMB8875 boards such
as SL65, whose mask ROM renders melodies there).

Nothing back-pressures the guest any more — the DSP produces samples at the
speed of the guest's virtual clock, and during a Siemens boot that is ~0.25×
real time in the browser. Three pieces keep that from coming out as stutter:

- `hw/arm/pmb887x/audio/buffer.c` leaves a mid-stream underrun as a gap
  instead of padding it with silence; it pads only after 200 ms with no
  samples (an enabled voice that never writes would stall every other voice
  on the mixer).
- `wasmaudio.c` paces its writes on the host clock, so that idle padding
  cannot fill the ring ahead of real time (≈70 ms queued at steady state).
- `audio-worklet.js` banks a cushion before playing and after every dropout.
  It starts at 80 ms; a dropout grows it to cover a 5 s sound rendered at
  the measured producer speed (at least doubling, at most 4 s), and a second
  of silence resets it and skips the silent backlog. The C81 boot chime,
  rendered over ~8 s of wall time, plays in one piece once it is banked.

Muting is *not* the same as having no audiodev: the backend keeps consuming
at the nominal rate when nobody is listening, so a mute drops audio instead of
stalling the phone. `?sound=off` leaves the machine without an audiodev at
all, which is what the benchmarks use.

Verify with `tools/audioprobe.mjs` (`TOGGLE_AT=` exercises mute/unmute):

```sh
TESTFLASH=fullflashes/KE800-v11b.bin node tools/audioprobe.mjs
```

Boot chimes in the browser (ring peak, matching a native `-audio wav`
capture): C81 23317, EL71 13059, SL65 6841, KE800 13262, KE970 8571. S75
v40 has no boot chime, only a short blip. The LG chimes are about half the
level the old HLE path produced (27844 / 28937): that is the DSP's own
output now, not a loss on the way. Native captures: `node` + `-audio wav,path=…` on
`scripts/run-native.sh`.

## Pins

`versions.env` pins:

- qemu-pmb887x `6e821e08b6` — the series branch (`wasm-browser-port`
  locally, `wasm-patches` on Azq2/qemu-pmb887x) with
  siemens-mobile-hacks/qemu-pmb887x `dsp-lle` (`393263e08d`) merged in.
  `dsp-lle` replaces the HLE DSP and the "hacky AFE (LLE+HLE)" fix this
  branch used to carry with a real DSP LLE (the Teak mask ROM and the
  downloaded code run through a TCG JIT, synchronously on the vCPU thread),
  which is what gives the Siemens boards sound. It also reworks
  capcom/dif/dmac/flash/vic/lcd (taken as is), drops icount2 /
  `precise-clocks` (gone from the series too: the wasm64 backend, cputlb,
  qemu-timer and translate.c lost their icount2 paths) and adds
  `-accel tcg,thread=multi,vcpu-timers=on`. Because the DSP JIT now runs
  nested inside an ARM MMIO access, `tcg_qemu_tb_exec` on wasm64 is
  re-entrant (a frame per nesting depth; interpreter records freed only
  once no run is using them). On top of the merge: the 0602 mask ROM's
  `mov [Rn], cfgj` translates (it halted the SL65 DSP before the first
  sample), the audio buffer leaves mid-stream underruns as gaps (see
  Sound), `screendump` writes unpadded PPM rows (130-pixel-wide
  LCDs such as the SL65's came out sheared), and three LG fixes: the
  USIF's TX DMA asks for one word per request (with dsp-lle's DMAC
  request FIFO a burst request moved 16 bytes, short Bluetooth packets
  never completed and `twu_transport_usif.c` reset the phone every ~16 s),
  the DIF v2 holds back a firmware-written TX DMA request until its now
  slowly draining FIFO has room (the extra burst overflowed it and the
  idle screen arrived in fragments), and an AFE rate change reinitialises
  the host voice in place instead of reopening it (which truncated a
  `-audio wav` file).
- bsp (pmb887x-dev) `e90ceb3` — bsp master as of 2026-10-29. qemu's
  generated `gen/` tables match it byte for byte (regenerated with
  `tools/qemu.sh` and compared), so the pad-name hold-back of the previous
  pin is over. Older history: `63b56fa` brought the KE970 jog dial
  (`[peripheral.SCROLL] type = "ke970-scroll"`), `e79169f` the M65, M75,
  ME75, SK65 and SL65 boards, and perk11's LG `[rtc] format = "calendar"`
  (PR#6) landed as `e8d490e`; a plain checkout of the pin is the whole
  tree, with no `bsp-patches/` to apply.
- pmb887x-emu `91a9b14` — master. Not built from (qemu comes from the root
  submodule); it is the source of the siemensfw library (`src/siemens`)
  that `scripts/build-recalc-wasm.sh` compiles for the page's Siemens-key
  and device-detection module. The 2026-10-29 bump (eb53c78..91a9b14) adds
  unit-test runners, a `--headless` option and moves its submodule
  pointers — `src/siemens` is unchanged. Its own runner still passes
  `-icount precise-clocks=on`, which `dsp-lle` no longer has.
- emsdk 4.0.10, glib 2.84.0, pixman 0.44.2, zlib 1.3.2, libffi v3.5.2
  (mirrors qemu's `emsdk-wasm64-cross.docker`).

Bumping: change the pin, rebuild (`build-qemu.sh` moves the submodule to
the pin); `tests/run.mjs`
is the A/B harness — it boots
s75/el71/c81/ke800 natively and benchmarks before/after, and
`node tools/bootcheck.mjs --dist dist-jit` is the browser-side gate.

## Performance work (see doc/performance-handoff.md + doc/optimization-playbook.md)

The wasm64 TCG backend landed as 0017 (tail-call chaining,
regs-as-locals, batched modules), then the
qemu-core device path (0018), the module economy (0019–0022), the halt
path (0023–0030), the Asyncify onlylist + real-time cap (0031/0032),
the RTC seed layout (0033), the EL71/KE800 fixes that made every board
boot on the JIT (0034–0038), the display path + TLB growth (0039–0041)
and the TB-lookup / hflags / range-flush work (0042–0045); since then
the device access path, the wake cost, wasm atomics and the BQL, the
SGOLD boards, the flat-view variant cache and the module pipeline, to
0088. Per-patch numbers are in the commit messages on the `qemu/` branch;
**the ranked open items are `doc/performance-handoff.md` § Open items**.

- `site/dist-jit/` — the wasm64 TCG backend build, what the page runs
  for every board (`scripts/build-qemu-wasm64.sh`). Boots in Firefox
  too; `tools/ffboot.mjs` is the cross-browser smoke.  The oracle for
  JIT-only failures is the native build (lockstep), not a second wasm
  engine.
- Fast iteration: `scripts/ninja-fast.sh` (incremental, correct env,
  atomic deploy, ~8 s) + `node tools/workbench.mjs --board <b>` (wall
  time over a fixed stretch of guest work — the keep/revert meter) +
  `node tools/diagall.mjs` (every counter by name, 0.04 % spread, to
  confirm the mechanism); `node tools/idlebench.mjs` is the end-to-end
  boot number and `node tools/tcgbench.mjs` the device-path mirror.
- Gates: **`bash scripts/gate.sh keep`** runs them all at once (152 s on
  a 32-core host, against 846 s serially) — a gate never reads a wall
  clock as a result, so unlike the benchmarks it is safe to parallelise.
  `gate.sh close` adds the ordered four-board boot, the native lockstep,
  the 2.5e9 lockstep and Firefox (719 s, against 2274 s serially);
  `node tools/stopwatch.mjs` is the in-guest pacing gate — it boots
  S75v40lg1, walks the keypad to Extras → Stopwatch and prints `vratio`,
  virtual seconds per wall second while a J2ME app redraws (1.0 = real
  time; the guest never halts there, so it is also guest MIPS ÷ 125);
  `node tools/scenebench.mjs <stopwatch|music|idle>` does the same on the
  EL71 and measures sound: dropouts and silenced time while the media
  player plays an AAC track (`tools/slowhost.sh` in front of it for a
  slow machine);
  profiling: `tools/wprof2.mjs` (per-worker CDP CPU profiles, `PROF_ATTACH=`
  to profile a page another tool drove), `tools/profcat.mjs` /
  `tools/profjit.mjs` (cost-class split, JIT-time concentration),
  `tools/diagprobe.mjs` (any `wasm_memstat` counter over a boot).
