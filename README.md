# qemu-pmb887x in the browser

The Siemens/LG-phone emulator, running **entirely in the browser**:
qemu-system-arm compiled to WebAssembly (`./build.sh` + `./serve.mjs`) —
deterministic boot, splash draws, keypad/serial work, S75 reaches its
idle screen in ~40 s (the stock icount timing model below keeps
correctness independent of host speed — a slow host merely boots
slower). Two engines ship: the wasm64 TCG JIT backend (`site/dist-jit/`,
the page default for every board — guest TBs compiled to wasm at
runtime, ~7.4× TCI on compute, ~28 MB download) and the TCI interpreter
(`site/dist/`, `?dist=dist`, the reference/fallback tier, ~45 MB; built
only with `TCI=1`). See [doc/lessons.md](doc/lessons.md) +
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
strip sits under the pill (on a phone, on the top edge of the screen, always
on while the guest is), and the on-screen keypad has every phone key as its
own `<button>` (plus physical-keyboard mapping). `load` options (device
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
                    # qemu-system-arm.wasm (the page default; TCI=1 also
                    # builds the interpreter dist, site/dist/)
./serve.mjs         # http://127.0.0.1:8080 (COOP/COEP headers for pthreads)
                    # phone/LAN: auto-redirected to https://<lan-ip>:6808
                    # (self-signed — accept the browser warning once; browsers
                    # ignore COOP/COEP on plain http, so https is required
                    # for any host other than localhost/127.0.0.1)
```

`serve.mjs` keeps a gzip'd sidecar of the wasm (dist-jit: 28 MB → ~4 MB
on the wire; `GZIP=0` disables) and revalidates with ETags, so repeat
visits skip the re-download (`tools/loadbench.mjs` measures the startup
path).

Everything runs client-side: the picked fullflash is written into the
emscripten MEMFS, board configs are unpacked from `site/dist/boards.tar`
(always fetched from `dist/`, whatever `?dist=` selects), and qemu boots
with a small `-display wasm` backend (see below). Both engines are built
from the same source tree, the `qemu/` submodule. The wasm64 backend is
~7.4× TCI on compute and ~1.6× faster to the idle screen; both stay well
behind native — the remaining time is translation/module-compile of cold
code in the first ~0.75 G instructions, and after that the guest's own
timeline (see [doc/performance-handoff.md](doc/performance-handoff.md)).

**Timing model (stock icount, `-icount shift=3,sleep=off`):** Siemens
firmware needs a virtual clock that is decoupled from wall time — with
virtual≈real (no icount, or the fork's adaptive `precise-clocks=on`)
every firmware wall-clock budget, the L1↔DSP handshake first of all,
gets only a fraction of the native instruction budget on wasm and the
phone crashes (`>>EXIT<< FILE: l1bbcsg`). The fix is plain upstream
QEMU icount, no fork-specific virtual-clock patch: `shift=3` (8 ns per
guest insn, ≈ the phones' 104 MHz ARM9) makes virtual time strictly
instruction-proportional, and `sleep=off` makes idle deterministic too
(virtual time jumps to the next timer deadline instead of the vCPU
parking in realtime) — with the default `sleep=on` the handshake still
dies on any host slower than the phone. Deadlines then always arrive
with the full native instruction budget, so the machine merely boots in
slow motion. On top of that the wasm builds default to a **real-time
cap** on the idle warp (`QEMU_ICOUNT_RTCAP=banked:30`, page `?rt=off|
banked|banked:<n>|strict`): the compute-bound boot is never throttled, but
a halted guest's clock and animations run at wall speed instead of racing
ahead. The default switches from `banked` to `strict` once the guest has
run 30 seconds of its own clock — roughly the boot — so the boot may still
catch up as fast as it can, while a stall *after* it is forgiven rather
than repaid by sprinting the phone's clock. Until it switches, the status
pill's `slow` warning stays off: below 1.00× is what a banked boot looks
like by construction.
**LG firmware needs no icount at all** — it boots fine on the plain
realtime clock — so the page omits `-icount` for `lg-*` devices by
default. Override either default with `?icount=<spec>`
(`precise-clocks=on`, `shift=N`, `none`, …). Why this model and not
another: [doc/lessons.md](doc/lessons.md).

**Where the time goes:** on the wasm64 backend an S75 boot to the idle
screen is ~29 s of wall with the real-time cap off and ~39 s with it on
(the shipping default) — the last ~12 s are virtual time the guest
spends halted on device timers, which the cap pays out as real sleep.
The first ~0.75 G instructions are compile-bound cold code (~197 MB of
wasm compiled per boot). Full analysis: [doc/](doc/) — in particular
[doc/optimization-playbook.md](doc/optimization-playbook.md) (the
measurement method + what landed/rejected),
[doc/performance-handoff.md](doc/performance-handoff.md) (current
status, open items, constraints) and [doc/lessons.md](doc/lessons.md)
(the conclusions behind the timing model, the io-recompile accounting,
the emscripten runtime traps and the measurement rules). Also
[doc/wasm-threads-audit.md](doc/wasm-threads-audit.md): the runtime
threading audit — the build really is multi-threaded in the browser (5
pthread workers; one vCPU thread executing guest code, the rest parked in
futex waits; no spin).

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

The arithmetic is not a reimplementation: `site-src/recalc/recalc_wasm.cpp`
compiles pmb887x-emu's own `src/siemens_recalc.cpp` to a 35 KB wasm module
(`scripts/build-recalc-wasm.sh` → `site/dist/siemens-recalc.wasm`).
`node tools/recalc-check.mjs` exercises it against a real fullflash without a
browser; `node tools/keysboot.mjs` boots one through every mode.

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
shift=3,sleep=off` — or no `-icount` at all for LG boards —, `-drive
if=pflash…`, `-serial file:…` and `PMB887X_*` env vars; board inferred
from the fullflash filename, IMEI/ESN → OTP included; `ICOUNT=<spec>`
overrides the timing model). Options via env: `BOARD= STARTUP= SIM=`
`OPERATOR= IMEI= ESN=`
`RW=1 DISPLAY_MODE=vnc=[:N] MONITOR=unix:/tmp/pmb.sock SERIAL=path`,
extra qemu args as positional args. Headless by default; the serial log
lands in `/tmp/pmb887x-serial.log`.

The native build is made from the same pinned revision as the wasm
builds, i.e. it carries the whole patch series. Almost all of it is
`__EMSCRIPTEN__`-gated or TCI-only and inert natively; the generic parts
(romd FlatView variants, fill-time MMIO dispatch, fill-time TLB growth,
the range-flush summary, the CPSR hflags skip, the per-board RTC seed)
are semantics-preserving and are what the native suite (`tests/run.mjs`)
and the lockstep gate cover.

## Layout

```
.
  qemu/                 git submodule: Azq2/qemu-pmb887x, branch
                        wasm-browser-port (= origin/wasm-patches) — the
                        whole wasm/TCI/perf series committed on top of
                        qemu-pmb887x master; the ONLY qemu source tree
                        (wasm and native builds alike). See doc/upstream-branch.md.
  pmb887x-emu/          git submodule: the siemens-mobile-hacks meta-repo
                        (branch wasm-patches) whose qemu submodule pin is
                        the same revision; initialised for reference, not
                        built from
  build.sh              one-shot WASM build (toolchain → deps → qemu →
                        site/dist-jit, the page default; TCI=1 also builds
                        site/dist)
  serve.mjs             static server for the WASM page (COOP/COEP); serves
                        site/ — static files are edited in place, build
                        artifacts (qemu wasm/js, boards.tar) live in
                        site/dist/ (TCI + boards.tar) and site/dist-jit/
                        (wasm64 backend)
  versions.env          pinned qemu-pmb887x / bsp / toolchain revisions
  scripts/
    build-deps.sh       emsdk + glib/pixman/zlib/libffi built with emcc (wasm64)
    fetch-qemu.sh       initialise the qemu (+ pmb887x-emu) submodules and
                        check qemu out at the pinned rev
    sync-bsp.sh         bsp checkout @ pin → build/bsp
    pack-boards.sh      build/bsp board configs → site/dist/boards.tar (run by
                        every deploy path)
    build-recalc-wasm.sh  site-src/recalc + pmb887x-emu's siemens_recalc.cpp →
                        site/dist/siemens-recalc.wasm (likewise)
    build-qemu.sh       submodule → wasm64 TCG backend build → site/dist-jit/
                        (the default) + boards.tar; TCI=1 also builds the
                        interpreter dist → site/dist/
    build-qemu-wasm64.sh  the wasm64 backend build itself (build/qemu-wasm64;
                        configure via qemu's configure, Asyncify onlylist,
                        qom_cast_debug off, atomic deploy + symbol map)
    build-native.sh     native Linux JIT build (worktree of the pinned rev)
    build-native-tci.sh native TCI build (plugins on — the lockstep b-side)
    run-native.sh       native launcher (same boot recipe as the web page)
    ninja-fast.sh       incremental rebuild + deploy (default: wasm64 →
                        site/dist-jit; TCI=1: dist) — the iteration loop
    ninja-wasm64.sh     bare incremental ninja in the wasm64 build dir
    iterate.sh          one-command edit→rebuild→browser-verdict loop
    gate.sh             every correctness gate, run concurrently, one
                        verdict table: quick | keep | close
    run-tcg-isa.sh      guest op-suite gate (every built backend,
                        byte-compared against the native JIT)
    run-lockstep.sh     native cross-backend lockstep gate
  site-src/recalc/      emcc glue around pmb887x-emu's siemens_recalc.cpp
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

## Pins

`versions.env` pins:

- qemu-pmb887x `b7822c674b` — the tip of the series branch
  (`wasm-browser-port` locally, `wasm-patches` on Azq2/qemu-pmb887x):
  qemu-pmb887x master merged in, the series on top of it, the "hacky
  AFE (LLE+HLE)" DSP fix cherry-picked from alula's `dsp-stuff` branch,
  and the per-board RTC seed. Master alone aborts every Siemens fullflash
  during L1 GSM frame handling (`>>EXIT<< FILE: l1bbcsg`, ~25–30 s);
  the AFE commit is what makes s75/el71/c81 boot. The master merge also
  brought the SGOLD DSP mask-ROM fix, which upstream leaves inside a
  disabled `#ifdef STUB_DSP` and this branch compiles. `alula/dsp-stuff`
  is merged too and changed nothing: both of its content commits are
  already here verbatim (same patch-id), and its remaining differences are
  a `dsp_hexdump()` that indexes words where the offset counts bytes, the
  pre-fix `dsp_realize()`, and two `#if 0` debug blocks.
- bsp (pmb887x-dev) `21fdacb` — bsp master merged into the branch that
  carries the LG `[rtc] format = "calendar"` the LG firmware needs.
  Master is where `[peripheral.RF] type = "hd155153np"` — a device the
  emulator has no table entry for — got commented out, which is why
  there is no longer a `bsp-patches/` directory to apply.
- emsdk 4.0.10, glib 2.84.0, pixman 0.44.2, zlib 1.3.2, libffi v3.5.2
  (mirrors qemu's `emsdk-wasm64-cross.docker`).

Bumping: change the pin, `scripts/fetch-qemu.sh`, rebuild; `tests/run.mjs`
is the A/B harness — it boots
s75/el71/c81/ke800 natively and benchmarks before/after, and
`node tools/bootcheck.mjs --dist dist-jit` is the browser-side gate.

## Performance work (see doc/performance-handoff.md + doc/optimization-playbook.md)

The wasm64 TCG backend landed as 0017 (tail-call chaining,
regs-as-locals, batched modules; design and gates in
doc/wasm-tcg-backend-plan.md), then the
qemu-core device path (0018), the module economy (0019–0022), the halt
path (0023–0030), the Asyncify onlylist + real-time cap (0031/0032),
the RTC seed layout (0033), the EL71/KE800 fixes that made every board
boot on the JIT (0034–0038), the display path + TLB growth (0039–0041)
and the TB-lookup / hflags / range-flush work (0042–0045); since then
the device access path, the wake cost, wasm atomics and the BQL, the
SGOLD boards, the flat-view variant cache and the module pipeline, to
0088. The per-patch table with numbers is the playbook's "What landed";
**the ranked open items are `doc/performance-handoff.md` § Open items**.

- `site/dist-jit/` — the wasm64 TCG backend build, what the page runs
  by default for every board (`scripts/build-qemu-wasm64.sh`). Boots
  in Firefox too; `tools/ffboot.mjs` is the cross-browser smoke.
- `site/dist/` — the TCI build (`TCI=1`), the reference/fallback tier
  and the oracle for bisecting JIT-only failures; `?dist=dist`.
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
  the 2.5e9 lockstep and Firefox (1175 s, against 2874 s serially);
  `node tools/stopwatch.mjs` is the in-guest pacing gate — it boots
  S75v40lg1, walks the keypad to Extras → Stopwatch and prints `vratio`,
  virtual seconds per wall second while a J2ME app redraws (1.0 = real
  time; the guest never halts there, so it is also guest MIPS ÷ 125);
  profiling: `tools/wprof2.mjs` (per-worker CDP CPU profiles, `PROF_ATTACH=`
  to profile a page another tool drove), `tools/profcat.mjs` /
  `tools/profjit.mjs` (cost-class split, JIT-time concentration),
  `tools/diagprobe.mjs` (any `wasm_memstat` counter over a boot).
