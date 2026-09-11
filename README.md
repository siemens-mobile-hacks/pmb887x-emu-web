# qemu-pmb887x in the browser

The Siemens/LG-phone emulator, running **entirely in the browser**:
qemu-system-arm compiled to WebAssembly (`./build.sh` + `./serve.mjs`) —
deterministic boot, splash draws, keypad/serial work, boot to the idle
screen in ~70–75 s (the stock icount timing model below keeps correctness
independent of host speed — a slow host merely boots slower). Two engines
ship: the TCI interpreter (default) and a wasm64 TCG JIT backend
(`?dist=dist-jit` — guest TBs compiled to wasm at runtime, ~7.4× TCI on
compute). See
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
./build.sh          # ~30-60 min first run: emsdk 4.0.10 + glib/pixman/zlib/libffi
                    # built for wasm64, then qemu → site/dist/qemu-system-arm.wasm
./serve.mjs         # http://127.0.0.1:8080 (COOP/COEP headers for pthreads)
                    # phone/LAN: auto-redirected to https://<lan-ip>:6808
                    # (self-signed — accept the browser warning once; browsers
                    # ignore COOP/COEP on plain http, so https is required
                    # for any host other than localhost/127.0.0.1)
```

`serve.mjs` keeps a gzip'd sidecar of the 45 MB wasm (~11 MB on the wire;
`GZIP=0` disables) and revalidates with ETags, so repeat visits skip the
re-download (`tools/loadbench.mjs` measures the startup path).

Everything runs client-side: the picked fullflash is written into the
emscripten MEMFS, board configs are unpacked from `site/dist/boards.tar`, and
qemu boots with a small `-display wasm` backend (see below). Two TCG
engines are built from the same patched tree: the interpreter (TCI,
`site/dist/`, the page default) and the wasm64 TCG backend (patch 0017,
`site/dist-jit/`, page switch `?dist=dist-jit`) — ~7.4× TCI on compute,
but still ~27 % slower than TCI over the boot's translation-heavy
first 0.5 G insns (user-visible: ~86 vs 78 s to the idle screen; see
doc/optimization-playbook.md, 2026-09-11 benchmark audit). Both stay
well behind native on
device-heavy phases (a shared qemu-core dispatch cost — see
[doc/performance-handoff.md](doc/performance-handoff.md)).

**Timing model (stock icount, `-icount shift=3,sleep=off`):** Siemens
firmware needs a virtual clock that is decoupled from wall time — with
virtual≈real (no icount, or the fork's adaptive `precise-clocks=on`)
every firmware wall-clock budget, the L1↔DSP handshake first of all,
gets only ~1/130th of the native instruction budget on wasm-TCI and the
phone crashes (`>>EXIT<< FILE: l1bbcsg`). The fix is plain upstream
QEMU icount, no fork-specific virtual-clock patch: `shift=3` (8 ns per
guest insn, ≈ the phones' 104 MHz ARM9) makes virtual time strictly
instruction-proportional, and `sleep=off` makes idle deterministic too
(virtual time jumps to the next timer deadline instead of the vCPU
parking in realtime) — with the default `sleep=on` the handshake still
dies on any host slower than the phone. Deadlines then always arrive
with the full native instruction budget, so the machine merely boots in
slow motion. **LG firmware needs no icount at all** — it boots fine on
the plain realtime clock — so the page omits `-icount` for `lg-*`
devices by default. Override either default with `?icount=<spec>`
(`precise-clocks=on`, `shift=N`, `none`, …). History: the interim
hard-coded 104 MHz icount2 patch (0006) lives in `patches/attic/`.

**Raw speed:** the boot sustains ~55M guest insns/s (it was ~17M through
patches 0007–0016; the wasm64 backend + 0018's MMIO dispatch fix moved it
further) and S75 reaches its idle screen in ~70–75 s on the deterministic
idlebench protocol (~160 s on the older s75_working soak flash). The
remaining gap to the ~562 MIPS compute ceiling (tcgbench) is the
qemu-core device path — the current workstream
([doc/performance-handoff.md](doc/performance-handoff.md)). Keypad and LCD
remain live throughout. Full analysis: [doc/](doc/) — in
particular [doc/optimization-playbook.md](doc/optimization-playbook.md)
(the measurement method + what landed/rejected, per session),
[doc/performance-handoff.md](doc/performance-handoff.md)
(targets + next steps), [doc/livelock-postmortem.md](doc/livelock-postmortem.md)
(the Asyncify-condvar fix, the wild-TB crash, the icount timing model)
and [doc/early-crash-postmortem.md](doc/early-crash-postmortem.md)
(the 0004 io-recompile saga: dropped, then reworked correctly).
Also [doc/wasm-threads-audit.md](doc/wasm-threads-audit.md): the runtime
threading audit — the build really is multi-threaded in the browser (5
pthread workers; one vCPU thread executing guest code, the rest parked in
futex waits; no spin).

## Native (Linux) build

The same emulator, compiled natively (real TCG JIT — much faster than the
wasm TCI build; full boot to the idle screen takes ~1–2 minutes):

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

## Layout

```
.
  build.sh              one-shot WASM build (toolchain → deps → qemu → site/dist)
  serve.mjs             static server for the WASM page (COOP/COEP); serves
                        site/ — static files are edited in place, build
                        artifacts (qemu wasm/js, boards.tar) live in
                        site/dist/ (TCI) and site/dist-jit/ (wasm64 backend)
  versions.env          pinned qemu-pmb887x / bsp / toolchain revisions
  scripts/
    build-deps.sh       emsdk + glib/pixman/zlib/libffi built with emcc (wasm64)
    fetch-qemu.sh       clone/refresh the pinned qemu + bsp sources into build/
    sync-bsp.sh         bsp checkout @ pin + patches/bsp workarounds
    build-qemu.sh       applies patches/ to the pinned rev, builds the TCI
                        wasm dist → site/dist/ (+ boards.tar)
    build-qemu-wasm64.sh  same patched tree, wasm64 TCG backend → site/dist-jit
    build-native.sh     native Linux JIT build (pristine worktree, no patches)
    build-native-tci.sh native TCI build (plugins on — the lockstep b-side)
    build-deps32.sh     wasm32 dependency stack (the attic 0005 experiment;
                        historical, kept for reference — its build script
                        build-qemu-jit.sh was removed, see doc/wasm32-port-status.md)
    run-native.sh       native launcher (same boot recipe as the web page)
    ninja-fast.sh       incremental TCI rebuild + deploy (~8 s)
    ninja-wasm64.sh     incremental wasm64-backend rebuild
    capture-patch.sh    capture build/qemu edits as patches/NNNN-*.patch
    switch-test.sh      patch-isolation A/B harness (rebuild minus/revert N)
    run-tcg-isa.sh      guest op-suite gate (3 backends, byte-compared)
    run-lockstep.sh     native cross-backend lockstep gate
    iterate.sh          one-command edit→rebuild→browser-verdict loop
  patches/
    0001-ui-add-wasm-*.patch   wasm display/input backend (applied to the clone)
    0002-wasm-*.patch          Asyncify-safe futex/condvar + per-TB (not
                              per-insn) icount2 accounting
    0003-tci-*.patch           TCI inline TLB probe + direct helper dispatch
                              (generic TCI — measurably helps native TCI too)
    0004-wasm-*.patch          io-recompile MMIO boundary accounting (stock
                              rewind kept for flash-command accesses; the
                              original skip lives in attic/)
    0007-wasm-tci-*.patch      TCI TB chaining + in-interpreter icount2
                              accounting (~2x guest throughput)
    0008-tci-immediate-*.patch immediate-form TCI ops (add/and/or/xor/
                              andc/setcond vs small constants; no tci_movi
                              materialization; +7-9% on top of 0007)
    0009-wasm-mainloop-*.patch futex-based main-loop wait (emscripten poll()
                              can't sleep — the loop busy-spun ~23k/s through
                              a proxied syscall; +8% early / +22% end-to-end)
    0010-wasm-io-recompile-*.patch skip the io-recompile rewind under stock
                              icount (the ~150us emscripten longjmp per MMIO
                              access dominated the vCPU; -19% v-window)
    0011-tci-inline-ldst-*.patch TLB fast path inlined into the TCI
                              interpreter loop (-10-12% v-window)
    0012-tci-size-specialized-*.patch size-specialized guest memory ops
                              (exact-mop fast forms for the MO_ALIGN|
                              MO_ATOM_NONE family; dead re-probe removed;
                              -1.4..-16% v-window, +18-25% boot progress
                              @110s, wins every interleaved A/B pair)
    0013-svc-inline-exception-*.patch take SVC exceptions without the
                              cpu_loop_exit longjmp (frontend stores the
                              exception state + exit_tb; cpu_handle_interrupt
                              delivers pending exceptions first; the ~15us
                              JS-exception unwind was paid ~9.4k/s for guest
                              SWIs; -26% v-window, +30-77% boot progress)
    0014-wasm-io-barriers-*.patch stop the recurring ROM-device io_recompile
                              (barrier insns get single-insn TBs so can_do_io
                              is set - stock clock precision, no unwind;
                              ioRewind 1.67k/s -> ~0; +3-5% insns@110s)
    0016-memory-romd-flatview-*.patch romd FlatView variants + range-scoped
                              tlb flush: flash romd toggles (~18k/boot) stop
                              re-rendering every FlatView and stop flushing
                              the whole TLB per toggle (commit time -89%,
                              v-window -10%, variance collapsed)
    0017-tcg-wasm64-backend.patch the wasm64 TCG backend (tcg/wasm64/:
                              per-TB wasm functions → tail-call chaining →
                              128-TB batched modules → inline TLB probe →
                              inline TB accounting; served as site/dist-jit;
                              7.4× TCI compute, early boot phase still
                              ~27 % behind TCI — see
                              doc/wasm-tcg-backend-plan.md + -progress.md)
    0018-io-fast-dispatch-victim-tlb.patch fill-time MMIO dispatch
                              resolution in the iotlb entry + flag-masked
                              victim-TLB compare (MMIO entries carry
                              TLB_FORCE_SLOW and never hit the victim TLB;
                              index-aliased MMIO pages re-walked the page
                              tables on every access — ARMv5 1K pages):
                              tcgbench mmiopoll 534->202 ns/access on
                              dist-jit (606->252 on dist), mmiow -25%;
                              native-jit parity reached
    0019-wasm64-speculative-batching.patch  wasm64 only: goto_tb
                              successors translated ahead on a lookup miss,
                              TBs compiled once (as the batch of miss +
                              successors, no per-TB temp module), landed
                              batches compacted into ~1024-member modules
                              + live cap/re-ensure + Firefox GC nudge:
                              idlebench tIdle 76->65 s (-15 %), every
                              milestone -13..-15 %; Firefox no longer runs
                              out of executable memory (16k-module budget)
    0020-wasm64-successor-hints.patch  call-return + ldr-pc trampoline
                              successors, W64_SPEC_N 32: batches 3 -> 13
                              members, misses -60 %, t0.5G -5..-8 %
    0021-wasm-wait-fixes.patch untimed QemuCond waits passed a 0 ms
                              futex timeout (= immediate return: the
                              vCPU halt wait spun on the BQL) and event
                              notifiers did proxied eventfd writes (~1 ms
                              each, per icount deadline): tIdle -5..-13 %
                              on both dists (the display-DMA stretch)
    0022-wasm64-goto-ptr-handoff.patch  the dispatcher read the goto_ptr
                              handoff slot at frame+0 instead of frame+8,
                              so every indirect jump unwound to
                              cpu_exec_loop (14.9M of 16.8M exits/boot):
                              window -8..-10 %, t1.3G -2..-5 %
    0023-idle-warp-on-vcpu-thread.patch  icount rr: a halted vCPU warps
                              the virtual clock and runs its timers
                              itself instead of the two-hop main-loop
                              handoff per deadline (halt cond wait never
                              reached during the boot); both dists
    0024-device-timers-virtual-clock.patch  dmac/dif/ssc completion
                              timers on QEMU_CLOCK_VIRTUAL (the display
                              DMA word completes at the next TB boundary
                              / first idle warp, no main-loop round trip)
    0025-wasm-halt-path-costs.patch  no realtime-clock reads in the
                              icount budget on wasm (2 JS clock imports
                              per vCPU loop round), WFI without a longjmp
    0026-wasm64-goto-ptr-tailcall.patch  goto_ptr tail-calls the looked-up
                              TB in wasm (goto_ptr dispatcher exits
                              14.9M/30 s -> 17k, true misses only)
    0027-arm-cpsr-write-goto-ptr.patch  msr CPSR / exception returns end
                              their TB with goto_ptr; the helper requests
                              the interrupt check only when one is
                              pending (was the most frequent exit: ~190k/s)
                              0023-0027 together: dist-jit tIdle 51.9->46.2 s,
                              dist 62.2->58.2 s (idlebench --runs 2)
    0028-icount-timer-notify-budget.patch  a timer_mod from the vCPU
                              thread kicks the vCPU only when the new
                              deadline is inside the running icount
                              budget (was 37k needless kicks/s)
    0029-wasm64-no-icount2-prologue.patch  the per-TB atomic icount2
                              tick accounting is emitted only when the
                              opt-in icount2 model is on: t0.5G -5 %,
                              t1.3G -5 % (session base -16 %)
    0030-wasm64-spec-explored-flag.patch  speculation stops re-walking
                              neighbourhoods whose successors all exist
                              (walk overhead 0.87 -> 0.29 s per boot)
    0031-wasm64-asyncify-onlylist.patch  instrument only the functions on
                              a real coroutine-switch stack (ASYNCIFY_ONLY),
                              not everything the invoke_* wrappers reach:
                              dist-jit wasm 45.1 -> 27.8 MB, tIdle -18 %.
                              wasm64-only (regresses TCI +26 %); flash
                              blk_pwrite deferred to a main-loop BH
    0032-icount-realtime-cap.patch  optional real-time cap on sleep=off
                              (QEMU_ICOUNT_RTCAP / ?rt=, wasm default
                              banked): the vCPU sleeps instead of warping
                              the virtual clock past wall time, so the idle
                              clock/animations run at real-time; the boot
                              (virtual behind wall) is never throttled
    0033-rtc-cnt-format-per-board.patch  RTC CNT seeded in the layout the
                              firmware expects (pmb887x-rtc "cnt-format",
                              board.rtc.format / vendor default: LG =
                              packed calendar, Siemens = linear Unix
                              seconds): fixes the year-2091 date and the
                              +16 min-per-minute displayed clock
    attic/                    dropped patches (the original 0004 io-recompile
                              skip: boot regression, superseded by the reworked
                              0004; 0015 diag counters: measured neutral, no
                              consumers — see attic/README.md)

  The patch series is generated from the upstream branch
  `wasm-browser-port` (git worktree `build/qemu-upstream`, one commit
  per patch, base = the pinned qemu rev, ready to PR against
  Azq2/qemu-pmb887x): every commit carries its rationale + measurements,
  the hunks carry inline why-comments.  0017 is the exception — captured
  from the working tree via scripts/capture-patch.sh.  See
  doc/upstream-branch.md — regenerate patches/*.patch after branch edits
  (`git format-patch b31b98fe..wasm-browser-port`).
  tests/
    tcg-isa/               phase-0a guest op-suite (bare-metal ARM926
                           versatilepb image asserting (value, NZCV)
                           per op class; runs on native JIT, native TCI
                           and the wasm page, byte-compared):
                           scripts/run-tcg-isa.sh is the gate,
                           tools/tcgisa.mjs drives the page leg,
                           `?suite=dist/tcgisa.bin` boots it in the
                           browser — see doc/wasm-tcg-backend-plan.md
    lockstep.c (+ tools/lockstep*.mjs, scripts/run-lockstep.sh)
                           whole-boot cross-backend value equality
                           (per-epoch register + memory digests; the
                           full 2.5e9-insn gate) — see tests/README.md
    tcgbench/ (+ tools/tcgbench.mjs)
                           fast-iteration perf bench on versatilepb:
                           per-phase backend A/B + the device/icount-tax
                           mirrors (mmiopoll/rampoll) — the primary meter
                           of the current workstream
    run.mjs (+ RESULTS-switch.md)  A/B harness for qemu/bsp bumps
  site/                 the served web root — editable static page (index.html /
                        app.js / style.css / keyboards.js; fullflashes.js holds
                        the preset-fullflash inventory + Cache API handling)
                        plus dist/ — wasm build artifacts (gitignored)
  tools/                headless-browser test/screenshot helpers (playwright)
                        test fullflash path lives in tools/testflash.local.json
                        (gitignored — copy from tools/testflash.local.json.example)
```

The WASM build is fully decoupled from the upstream sources: it clones
`Azq2/qemu-pmb887x` and `Azq2/pmb887x-dev` at the revisions pinned in
`versions.env` into `build/` (gitignored) and applies only the patch in
`patches/`. Nothing in this repo's other components is modified.

## The wasm UI patch

`patches/0001-ui-add-wasm-display-input-backend.patch` adds `ui/wasm.c`
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

`versions.env` pins qemu-pmb887x `b31b98fe1e` (alula's `dsp-stuff`
branch — master + the AFE LLE+HLE fix; see below) and bsp `49b0130`
(= the submodule pins of the latest pmb887x-emu master, 2026-09-07).
Notes for bumping:

- qemu-pmb887x **master** (`1f7fc803bf`) aborts every Siemens fullflash
  during L1 GSM frame handling (`>>EXIT<< FILE: l1bbcsg`, ~25–30 s) —
  the DSP needs the "hacky AFE (LLE+HLE)" commit that lives on alula's
  `dsp-stuff` branch (fetched automatically via
  `QEMU_PMB887X_ALT_REPO`; scripts/fetch-qemu.sh).
- the bsp main branch defines `[peripheral.RF] type = "hd155153np"` —
  a device the emulator does not define (only the `pmb6272` stub);
  `patches/bsp/0001` re-points the two affected includes until upstream
  grows the device.
- `tests/run.mjs` (+ `tests/RESULTS-switch.md`) is the A/B harness for
  bumping: it boots s75/el71/c81/ke800 and benchmarks before/after.

## Performance work (see doc/performance-handoff.md + doc/wasm-tcg-backend-plan.md)

The wasm32 runtime-JIT backend (the old 0005 draft, ktock design) was
fully rebased, benchmarked (~1.3–2.3x TCI ceiling, boot hangs) and
**discarded** on 2026-09-09 — see doc/wasm32-port-status.md and
patches/attic/wasm32-rebase/. Its redesigned successor **landed**: patch
0017, the wasm64 TCG backend (tail-call chaining, regs-as-locals, batched
modules) — compute-complete 2026-09-11 (compute 7.4× TCI, all gates
green; the boot's early phase is still ~27 % behind TCI — the
"TCI parity" reading was a saturated tIdle; doc/wasm-tcg-backend-plan.md +
-progress.md). The current workstream is the qemu-core device path
(MMIO dispatch, timer storms) that every backend pays identically
(doc/performance-handoff.md; its first slice landed as 0018).

- `site/dist/` — TCI build (patches 0001–0004 + 0007–0018; timing model is
  stock `-icount shift=3,sleep=off`, no fork-specific clock patch — see
  the interim 0006 in patches/attic; 0004 reworked: the
  io-recompile longjmp storm is gone, MMIO accounted at the rewind's
  clock, stock rewind kept for flash-command accesses — see
  doc/early-crash-postmortem.md §9).
- `site/dist-jit/` — the wasm64 TCG backend build (0017 + 0019 on top of
  the shared series; `scripts/build-qemu-wasm64.sh`, page switch
  `?dist=dist-jit`).  Boots in Firefox too (0019); `tools/ffboot.mjs`
  is the cross-browser smoke.
- Fast iteration: `scripts/ninja-fast.sh` / `scripts/ninja-wasm64.sh`
  (incremental, correct env) + `node tools/tcgbench.mjs` (seconds-per-leg
  A/B) + `node tools/idlebench.mjs --quick` (~1 min per dist: boot
  window + guest-work milestones, A/B ratios, regression verdict);
  full `tools/idlebench.mjs` runs are the end-to-end gate (bootbench.mjs
  is deprecated);
  profiling: `tools/wprof2.mjs` (per-worker CDP CPU profiles).
