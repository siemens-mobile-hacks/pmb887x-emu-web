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
only with `TCI=1`). See
[doc/livelock-postmortem.md](doc/livelock-postmortem.md) +
[doc/performance-handoff.md](doc/performance-handoff.md).

The page has a fullflash file picker (multi-select: LG fullflashes can be
picked together with their `.cfi-efa` sidecar — the EFA block holding the
LG EEPROM; a missing EFA makes LG firmware factory-reset) plus a dropdown
of predefined fullflashes (inventory: `site/fullflashes.js`; currently
S75 v40, EL71 v41 and KE800 v11b + EFA, fetched from `git.siepatch.dev`):
pressing Start with one selected downloads it on first use (live progress;
the trash icon next to the dropdown drops the cached copy) and keeps it in
the browser's Cache API storage — later boots come straight from the cache,
an alternative to uploading your own file. Then all `load` options (device
inference, IMEI/ESN→OTP, SIM, operator, startup scenario, writable-flash)
and an on-screen keypad with every phone key as its own `<button>` (plus
physical-keyboard mapping).

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
cap** on the idle warp (`QEMU_ICOUNT_RTCAP=banked`, page `?rt=off|
banked|strict`): the compute-bound boot is never throttled, but a halted
guest's clock and animations run at wall speed instead of racing ahead.
**LG firmware needs no icount at all** — it boots fine on the plain
realtime clock — so the page omits `-icount` for `lg-*` devices by
default. Override either default with `?icount=<spec>`
(`precise-clocks=on`, `shift=N`, `none`, …). History: the interim
hard-coded 104 MHz icount2 patch (0006) lives in `patches/attic/`.

**Where the time goes:** on the wasm64 backend an S75 boot to the idle
screen is ~29 s of wall with the real-time cap off and ~39 s with it on
(the shipping default) — the last ~12 s are virtual time the guest
spends halted on device timers, which the cap pays out as real sleep.
The first ~0.75 G instructions are compile-bound cold code (~197 MB of
wasm compiled per boot). Full analysis: [doc/](doc/) — in particular
[doc/optimization-playbook.md](doc/optimization-playbook.md) (the
measurement method + what landed/rejected),
[doc/performance-handoff.md](doc/performance-handoff.md) (status per
session, targets, next steps),
[doc/livelock-postmortem.md](doc/livelock-postmortem.md) (the
Asyncify-condvar fix, the wild-TB crash, the icount timing model) and
[doc/early-crash-postmortem.md](doc/early-crash-postmortem.md) (the 0004
io-recompile saga: dropped, then reworked correctly). Also
[doc/wasm-threads-audit.md](doc/wasm-threads-audit.md): the runtime
threading audit — the build really is multi-threaded in the browser (5
pthread workers; one vCPU thread executing guest code, the rest parked in
futex waits; no spin).

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
    sync-bsp.sh         bsp checkout @ pin + patches/bsp workarounds → build/bsp
    pack-boards.sh      build/bsp board configs → site/dist/boards.tar (run by
                        every deploy path)
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
    run-tcg-isa.sh      guest op-suite gate (3 backends, byte-compared)
    run-lockstep.sh     native cross-backend lockstep gate
    build-deps32.sh     wasm32 dependency stack (the attic 0005 experiment;
                        historical, kept for reference — doc/wasm32-port-status.md)
    capture-patch.sh, switch-test.sh
                        patch-file-era tools (capture working-tree edits as
                        patches/NNNN, rebuild minus/revert a patch). NOT
                        functional against the submodule tree — the pinned
                        rev already contains every patch. Kept for the
                        history in doc/optimization-sessions.md.
  patches/
    0001..0045-*.patch  the series as patch files — a frozen mirror of the
                        commits on the qemu branch (0033 is missing: it
                        was folded into the pinned rev as the top commit).
                        No build step reads them; the commit list in
                        doc/upstream-branch.md is the authoritative index
    bsp/0001            board-config workaround applied by sync-bsp.sh
                        (hd155153np RF → the defined pmb6272 stub)
    attic/              dropped patches + the wasm32 rebase record
                        (see attic/README.md)
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
    run.mjs (+ RESULTS-switch.md)  native boot suite (s75/el71/c81/ke800) and
                        the A/B harness for qemu/bsp bumps
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

- qemu-pmb887x `debfa3d6f5` — the tip of the series branch
  (`wasm-browser-port` locally, `wasm-patches` on Azq2/qemu-pmb887x):
  qemu-pmb887x master (`8b9d485bc2`) + 41 series commits + the "hacky
  AFE (LLE+HLE)" DSP fix cherry-picked from alula's `dsp-stuff` branch +
  the per-board RTC seed. Master alone aborts every Siemens fullflash
  during L1 GSM frame handling (`>>EXIT<< FILE: l1bbcsg`, ~25–30 s);
  the AFE commit is what makes s75/el71/c81 boot.
- bsp (pmb887x-dev) `e6e73d1` — carries the LG `[rtc] format =
  "calendar"` the LG firmware needs. The bsp main branch also defines
  `[peripheral.RF] type = "hd155153np"`, a device the emulator does not
  define (only the `pmb6272` stub); `patches/bsp/0001` re-points the two
  affected includes until upstream grows the device.
- emsdk 4.0.10, glib 2.84.0, pixman 0.44.2, zlib 1.3.2, libffi v3.5.2
  (mirrors qemu's `emsdk-wasm64-cross.docker`).

Bumping: change the pin, `scripts/fetch-qemu.sh`, rebuild; `tests/run.mjs`
(+ `tests/RESULTS-switch.md`) is the A/B harness — it boots
s75/el71/c81/ke800 natively and benchmarks before/after, and
`node tools/bootcheck.mjs --dist dist-jit` is the browser-side gate.

## Performance work (see doc/performance-handoff.md + doc/optimization-playbook.md)

The wasm32 runtime-JIT backend (the old 0005 draft, ktock design) was
fully rebased, benchmarked (~1.3–2.3× TCI ceiling, boot hangs) and
**discarded** on 2026-09-09 — see doc/wasm32-port-status.md and
patches/attic/wasm32-rebase/. Its redesigned successor landed as the
wasm64 TCG backend (0017: tail-call chaining, regs-as-locals, batched
modules; doc/wasm-tcg-backend-plan.md + -progress.md), then the
qemu-core device path (0018), the module economy (0019–0022), the halt
path (0023–0030), the Asyncify onlylist + real-time cap (0031/0032),
the RTC seed layout (0033), the EL71/KE800 fixes that made every board
boot on the JIT (0034–0038), the display path + TLB growth (0039–0041)
and the TB-lookup / hflags / range-flush work (0042–0045). The
per-patch table with numbers is the playbook's "What landed"; open items
are its "Remaining opportunities".

- `site/dist-jit/` — the wasm64 TCG backend build, what the page runs
  by default for every board (`scripts/build-qemu-wasm64.sh`). Boots
  in Firefox too; `tools/ffboot.mjs` is the cross-browser smoke.
- `site/dist/` — the TCI build (`TCI=1`), the reference/fallback tier
  and the oracle for bisecting JIT-only failures; `?dist=dist`.
- Fast iteration: `scripts/ninja-fast.sh` (incremental, correct env,
  atomic deploy) + `node tools/tcgbench.mjs` (seconds-per-leg A/B) +
  `node tools/idlebench.mjs --quick` (~1 min per dist: boot window +
  guest-work milestones, A/B ratios, regression verdict); full
  `tools/idlebench.mjs` runs are the end-to-end gate;
  `node tools/bootcheck.mjs --dist dist-jit` boots s75/el71/ke800 in
  the browser (the three-fullflash final gate);
  `node tools/stopwatch.mjs` is the in-guest pacing gate — it boots
  S75v40lg1, walks the keypad to Extras → Stopwatch and prints `vratio`,
  virtual seconds per wall second while a J2ME app redraws (1.0 = real
  time; the guest never halts there, so it is also guest MIPS ÷ 125);
  profiling: `tools/wprof2.mjs` (per-worker CDP CPU profiles, `PROF_ATTACH=`
  to profile a page another tool drove), `tools/profcat.mjs` /
  `tools/profjit.mjs` (cost-class split, JIT-time concentration),
  `tools/diagprobe.mjs` (any `wasm_memstat` counter over a boot).
