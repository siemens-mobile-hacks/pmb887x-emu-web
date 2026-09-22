# Diagnostics toolkit

Everything here lives in `tools/` (playwright-core + the
playwright-downloaded Chromium; `npm i` in that dir once). Most tools
take the test fullflash from `tools/testflash.local.json` (copy the
`.example`) and the server port from `PORT` (default 8080).

## Page URL parameters

| Param | Effect |
|---|---|
| `?dist=<dir>` | build output under `site/` to run: default `dist-jit` (wasm64 TCG backend); `dist` = the TCI interpreter; any `dist-*` A/B snapshot |
| `?icount=<spec>` | override `-icount` (default `shift=3,sleep=off`; `none` for `lg-*` devices — `precise-clocks=on`, `shift=N`, `none`, …) |
| `?rt=off\|banked\|banked:<n>\|strict\|budget[:<win>[:<ms>]]` | `QEMU_ICOUNT_RTCAP` — the real-time cap on the sleep=off idle warp. Default **`budget:30:500`**: `banked` (the boot is never throttled, idle time is paced to wall) for the guest's first 30 seconds of *its own* clock, then the bank is capped at 500 ms — a later stall is repaid, but never by more than 500 ms of sprinted clock, so the phone stays close behind wall time instead of skipping minutes. `<win>`/`<n>` are guest seconds, not wall seconds — the boot costs the same virtual time on every host but anywhere from 39 s to minutes of wall. Plain `banked` and `strict` are pinned for the whole run and are the stable A/B legs (`banked:<n>` = banked then strict); benchmarks pass `rt=off` to measure engine speed. While the cap is still banking the pill's `slow` warning stays off (see below) |
| `?icount2debug=1` | `QEMU_ICOUNT2_DEBUG=1` — only meaningful with `?icount=precise-clocks=on`: prints the controller state each second |
| `?trace=<channels>` | `PMB887X_TRACE_IO/LOG` (e.g. `trace=dsp,scu`); channels: dsp, scu, gptu, tpu, vic, capcom, usart, rtc, … |
| `?tracebuf=1` | buffer raw stderr in `window.__qemulog` (no console flood) |
| `?debug=1` | print every stderr line to console (no dedup) |
| `?qargs=<args>` | append raw qemu arguments (e.g. `qargs=-d exec -D /exec.log`) |
| `?env=NAME=VAL` | extra environment for the build (repeatable) — the full knob inventory is its own section below |
| `?w64debug=1` | wasm64 backend console diagnostics (batch histogram, module events) |
| `?env=QEMU_LOG_PABT=1` | one stderr line per guest prefetch abort / BKPT (IFSR, IFAR, pc, lr, sp, cpsr) — the tool that pinned the W-12 panic; combine with `tracebuf=1`, never with `-d int` (its per-IRQ volume shifts timing enough to hide a race) |
| `?suite=<url>` | boot a bare-metal versatilepb image instead of a phone (`dist/tcgisa.bin`, `dist/tcgbench.bin`); with `?icount=1` the suite runs under the phones' stock timing model (the tcgbench icount-tax leg) |
| `?lockstep=1` (+ `ls-*`) | built-in guest-state fold on the wasm64 backend — the b-side of `tools/lockstep-wasm.mjs`; `ls-*` params set the insn budget and grid |
| `?iorewind=1` | force the stock io-recompile everywhere (0004's A/B escape hatch) |
| `?serialpoll=1` | don't tap the serial log's MEMFS ops — read the file on a 1 Hz timer instead (the page's fallback path; `SERIAL_POLL=1 tools/exitcheck.mjs` takes it through the EXIT checks) |

Fullflash, device, IMEI/ESN, SIM, operator, startup and the Siemens key mode
are form controls in the Firmware panel, not params. **Copy diagnostics**
carries the last of those as `siemensMode`, and what it did to this run's
image as `siemensKeys` (`replaced`/`complete` for a recalculation, the
recovered `esn` and whether it came from the cache for a sweep).
The pflash drive is always writable (there
is no longer a "writable flash" checkbox, and `tools/session.mjs` ignores a
`rw=1` token) — the image only lives in this run's MEMFS, and **Export ▸
Flash** in the Run panel hands that copy back. So is the stats HUD:
a two-line strip sampled at 2 Hz. Line 1 is this second's guest: speed
(`1.00×` — virtual seconds per wall second, 1.0 = real time, below it the
guest is compute-bound; green ≥ 0.95, amber ≥ 0.80, red under), `MIPS`
(guest insns/s; 125 = real time under the stock `shift=3`), `fps`, the
page's own paint cost in `ms`, `lag` (wall − virtual: what the real-time cap
still owes) and `halt/s`. `lag` counts from the run start, or from the
banked→paced switch once that has happened — the paced phase (strict, or
budget) *forgives* the debt rather than paying it back, so carrying the
boot's lag past the switch would show an amber token for a debt that no
longer exists. Line 2 is the machine:
a short user agent (`Android 8 · Chrome 147 · SM-G955U`), cores, memory and
`isolated`. Narrow screens drop whole tokens off the line rather than wrap
or shrink, paint first.

**"Performance HUD"** in the Run panel draws it — under the status pill on
desktop, and at phone widths (where the panel is the settings sheet) as an
overlay on the top edge of the screen box, which waits for a guest rather
than covering the idle panel. It used to be `?hud=1`, then a band across the
top of the page. The choice is remembered; with none stored it starts on at
phone widths, the one place with no debugger to fall back to, and off on
desktop. Either way the pill itself turns amber and gains `· slow` after
three seconds under 0.80× — except while the real-time cap is still banking
(`?rt=` above), where below 1.00× is what a boot looks like by construction:
the guest is behind and allowed to catch up, not slow. The three-second
hysteresis restarts at the switch. The HUD's own `×` and `lag` tokens keep
their colours throughout: the strip is a raw instrument, the pill is a
judgement about whether the user should care.

**"Copy diagnostics"**, beside the toggle, puts the last 60 s of samples,
the 10 s averages, the environment and the full unmodified user agent on the
clipboard as JSON — which is how a phone without a debugger reports its own
number. `window.__hud.diagnostics()` returns the same object.

## Runtime knobs (`?env=NAME=VAL`, repeatable)

Derived from `git grep getenv` in the submodule — if a knob is not here,
check there rather than assuming it is gone. Three classes, and the class
is what decides whether a number taken under one means anything:

**A/B knobs** — the same wasm both legs, so a pair taken in one browser
with one leg per query is a true interleaved A/B (`idlebench
"dist-jit@env=W64_SPEC_N=64,dist-jit"`). This is the cheapest honest
measurement in the ladder: no rebuild, no build-dir skew.

| Knob | Default | Effect |
|---|---|---|
| `W64_SPEC_N=<n>` | 32 (max 64) | speculative-successor budget per batch. Measured flat at 64 — see the playbook's REJECTED row before sweeping it again |
| `W64_BATCH_N=<n>` | 128 | staged members a batch may hold before it is forced closed. Rarely binding: batches average ~5 members because a close fires on first execution |
| `W64_NOBATCH=1` | off | batching off entirely (one module per TB). Firefox-fatal; a bisection aid only |
| `W64_LIVE_MAX=<n>` | 6144 | live-module FIFO cap; eviction forces a re-ensure (recompile) |
| `W64_COMPACT_BATCHES=<n>` | 256 | small batches merged per compaction |
| `W64_COMPACT_MEMBERS=<n>` | 1024 | member cap on a compacted module. Two sweeps found nothing — stop sweeping |
| `W64_NOCLOSEEXEC=1` | off | don't close a batch when its first member runs. Measured 12–17 % slower; kept as the proof that the close is what makes speculation pay |
| `W64_NOTLB=1` | off | drop the inline TLB probe, every memop to the helper |
| `W64_NOLC=1` | off | 0046 inline next-TB lookup cache off |
| `W64_IO_BARRIERS=<n>` | 4096 | usable io-barrier slots (power of two, 1..4096) |
| `W64_GCNUDGE=0\|1` | Firefox only | force the 32 MB-per-256-instantiations GC nudge off/on. Default decides from the user agent (0087) |
| `W64_COMPACT_LIVE=<n>` | ¾ `W64_LIVE_MAX` | live-module count at which compaction starts |
| `W64_INTERP=<n>` | 64 | interpreter-tier threshold: executions a TB must reach before it earns a module. `0` turns the tier off; flat from 32 to 512 |
| `W64_INTERP_ALL=1` | off | never compile — every TB stays interpreted. The tier's correctness gate, not a benchmark |
| `W64_INTERP_RANGE=<lo>:<hi>` | all | restrict the tier to one span of `tidx` — how a tier divergence is bisected to one TB |
| `W64_RAM1P=0` | on | turn off `do_ram_1p()`, the inline TLB probe the C-side memop callers got in 0114, so the interpreter tier's accesses go back through `mmu_lookup` (`ram1p` counts what it serves; `slowClean` is what it replaced) |

**TB-shape knobs** are the same class (one wasm, a leg per query) but they
change what the translator emits, so they move `tbGen`, `tbIcount` and the
exit mix as well as the clock. Each one is a landed mechanism with its off
switch kept; the playbook's row for that number is the evidence. Round
forty-one's two — continuing past `msr cpsr`, and absorbing a branch onto
the TB's second page — have no switch: they are unconditional, so the way
to A/B them now is a build.

| Knob | Default | Effect |
|---|---|---|
| `W64_MERGE=0\|1` | 1 | defer a conditional branch's taken arm to the end of the TB so translation carries on into the fall-through (0110) |
| `W64_FTMAX=<n>` | 3 | how many deferred taken arms one TB may hold at once (capped at `W64_FT_MAX`). 1 → 2 is 0112, +4.7 % |
| `W64_JOIN=0\|1` | 1 | place a deferred arm's label where the fall-through reaches its target, so an `if (cond) { … }` costs no exit at all (0111, +6.0 %) |
| `W64_LOOP=0\|1` | 1 | a back-edge to the TB's own first instruction becomes a wasm branch to the loop header instead of a TB exit |
| `W64_ABSORB=<n>` | 256 | how many bytes an unconditional forward branch may skip and keep translating inside the same TB. The skipped bytes join the TB's guest range, so a write to them invalidates it |
| `W64_ABSCHG=0\|1` | 1 | charge the skipped instructions to `max_insns`. Off looks like free absorbs and is not: with the distance also at 1024 it lifts absorbs 8 632 → 9 464 and `tbIcount` by 0.3 %, because `translator_is_same_page` binds first |
| `W64_LINSPEC=<mask>` | 0 | which linear successors are offered to the speculation seed list. Off by default — see the flash-write hazard note above `note_linear_succ` before turning any bit on |
| `W64_NORETSPEC=1` | off | stop seeding speculation with a call's return address (0109's A/B leg) |
| `W64_INLINE=<n>` | 4 | call inlining depth: a direct `bl` translates its callee in place and the callee's `bx lr` (conditional or not) becomes a compare against the return address (round 40). 0 turns it off. The callee may live on the entry page or on one other page, which takes the TB's second-page slot |
| `W64_PAGEBITS=<n>` | 12 | guest page size the TLB, the translator's page rules and TB invalidation work in. ARMv5 defaults to 1 KB for tiny pages, which this firmware never maps (`fillLarge` == `tlbFill`); a smaller guest page than the target's is still translated exactly, through the slow path. 12 is what round 40 measured; 16 is the ceiling, because `w64_inl_lo/hi` hold a page offset in a `uint16_t` |
| `W64_NOSVCINL=1` | off | take the guest's SVC through the dispatcher (`cpu_handle_exception`) instead of inside the TB (round 40, `helper_svc_inline`); the A/B leg for that patch, and the bisect knob that cleared it of the lockstep divergence |
| `W64_PCREL=1` | off | put `CF_PCREL` back on wasm64 (upstream's default for ARM system mode). Off since round 40 because the PC-relative unwind data cannot name an instruction on an inlined callee's page; with it on, inlining refuses every call. The earlier A/B of the flag alone read −0.7 % (2/3, inside noise) and +2 % lookup misses |

**Measurement knobs — these change the generated code**, so per-Mi rates
stay exact (icount determinism) but wall-clock numbers under them are not
comparable to anything. Never use one as an A/B leg.

| Knob | Effect |
|---|---|
| `W64_LDSTCOUNT=1\|2` | emit counter bumps into generated memops. `1` = miss arms only (nearly free, sits beside a helper call); `2` = every execution too (`ldstExec`), the memops-per-guest-instruction denominator, hot by construction |
| `W64_MODBENCH=1` | compile one real module's own bytes 200× back-to-back inside the vCPU worker (`modbenchNs`/`modbenchN`) — the warm-compile floor against the 83 µs a module really costs |
| `W64_TBSTATS=1` | per-TB-entry counters under icount, so `wasm_tbs` reads non-zero |
| `W64_XCOUNT=1` | count TB exits in the generated code — which chain an entry left by (`xGototb`, `xGototb1`, `xSelf`, `xGotoptr`), and whether a `goto_tb` went back to its own TB. The exit-mix meter every TB-shape knob is judged on |
| `W64_TBHIST=1` | `++w64_tbhist[tidx]` in the prologue: the per-TB entry histogram, and the cheapest per-entry counter the backend can emit |
| `W64_LSMCOUNT=1` | count `ldm`/`stm` blocks and the registers they transfer (`lsmN`, `lsmExec`) — the denominator for anything that batches a block's memops |
| `W64_XWHY=1` | attribute each `goto_ptr` exit to the guest instruction that asked for it: `xwOther` (a direct branch refused a `goto_tb`, i.e. mostly calls), `xwBx` (their returns), `xwDefer`, `xwPsr` (`msr cpsr`), `xwPcst` (a store to r15), `xwRfe`, `xwSvc`, and `xwBl` — a direct `bl` that `w64_inline_call` refused, split since round 41 into `xwBlPage` / `xwBlDepth` / `xwBlCond` / `xwBlRet` by *why* it refused. Round 42 splits the page case again, for a call and an absorbed branch alike, by which rule in `w64_inl_pick_page` refused the stream its page: `xwPgThird` (every tracked page is taken by another page — the only one a further slot would collect), `xwPgLin` (page 1 belongs to a linear crossing), `xwPgProbe` (the target page is not mapped for fetch), `xwPgRet` (a `bl` returning off the stream's page), `xwPgMore` (the TB had already asked for more pages than it tracks). With two tracked pages all 9 808/Mi of them were `xwPgThird` and the rest were zero; with three, half of what a third page granted comes back as a TB wanting a fourth — a demand that does not exist until the TB is long enough to reach it, which is why the translation-time page-set census could not see it. The `inl*` counters answer the same question at translation time; these answer it at runtime weight, which is the one that decides whether a refusal is worth a mechanism. Indirect exits are two thirds of all TB boundaries — see § 0h of the playbook |

**Retired in round forty-one**, once their question was closed: the four
calibration pads (`W64_LDSTPAD`, `W64_CALLPAD`, `W64_LOCALPAD`,
`W64_BYTEPAD`), the inline-TLB-probe ceiling family (`W64_TLBDUP`,
`W64_TLBCHEAP`, `W64_TLBHIT`, `W64_TLBSIMD`, `W64_TLBHOIST`), `W64_LC2`,
the unsound `W64_NOGENBUMP`, and `W64_GDUP`. Old handoff rounds still name
them because that is how those numbers were taken; the numbers themselves
are in the playbook's REJECTED table and its cost model. `lc2Hit`,
`padSink`, `tlbcHit` and `tlbcMiss` now read zero always — the counter ABI
is positional, so the slots stay.

**Verification and debug** — correctness cross-checks and console noise.

| Knob | Effect |
|---|---|
| `W64_LC_VERIFY=1` | every `goto_ptr` goes through the helper, which cross-checks each would-be inline hit (`lcVhit`/`lcVbad`) |
| `W64_DEBUG=1`, `W64_TBLOG=1`, `?w64debug=1` | speculation stats / per-TB translation log / batch histogram + module events |
| `QEMU_LOG_PABT=1` | one stderr line per guest prefetch abort or BKPT (IFSR, IFAR, pc, lr, sp, cpsr) — combine with `tracebuf=1`, never with `-d int` |
| `QEMU_COSTACK=1` | coroutine-stack audit (see the Asyncify work in lessons.md) |
| `W64_LOCKSTEP*` | the page's built-in guest-state fold; driven by `tools/lockstep-wasm.mjs`, not set by hand |
| `W64_COLOC=1` | with `W64_LC_VERIFY=1` (so every `goto_ptr` reaches the helper): how often an indirect exit lands in the batch module it is leaving — the ceiling on replacing the tail call with a branch inside one function |
| `W64_MISSDUMP=1` | print every lookup-miss address, so the miss stream can be intersected offline with the flash image. The printf makes the run much slower; the counters stay valid because they count guest events |
| `W64_DUMPTB=<n>` | hex of the `n`th TB's complete temp module, for `wasm-dis` |
| `W64_OPDUMP=<pc>` | the TCG ops of every TB translated at guest `pc`, before and after optimisation, plus the guest disassembly (the `-d op,op_opt,in_asm` the page has no other way to ask for). Capture the console with `tools/conlog.mjs`; the benchmark's `--log` tail drops lines under a burst |
| `W64_INLLOG=1` | one stderr line per inlining decision: `INL call` (site, callee, return address, depth, which tracked page), `INL ret` (a return check emitted), `INL end` (the TB ended inside a callee, with `is_jmp`, condjmp and the exit reason). `node tools/videobench.mjs --log "INL "` prints them inline with the phase markers |

## Exports on `window.__qemu` (the emscripten module)

`_wasm_fb_ptr/_width/_height/_stride/_take_dirty/_updates`,
`_wasm_vclock` (guest ns), `_wasm_tbs/_wasm_insns` (per-TB stats),
`_wasm_reg(n)/_wasm_pc()/_wasm_peek(addr)` (guest state probes),
`_wasm_irq_pending()`, `_wasm_memstat(idx)` (the diagnostic counters of
`include/qemu/wasm-diag.h`), `_wasm_send_key(lnx, down)`, `_wasm_quit()`,
`FS`, `ENV`.

**The `wasm_memstat` index is the ABI, and a hand-written index list in a
tool goes stale silently.** A wrong counter returns a plausible number,
not an error: a `specRet` left over from a rejected experiment once
shifted `hflagsCalls` and `lookupConfl` by one and two tools misreported
both for a whole round. So never transcribe an index — import
`tools/diagnames.mjs`, which parses the enum out of the header at run
time and throws if it finds implausibly few:

```js
import { NAMES } from "./diagnames.mjs";   // NAMES[i] is the camelCase name
```

Some counters sit on the hottest paths there are — every MMIO dispatch,
every virtual-clock read, every hflags rebuild, ~14 M read-modify-writes
a second on an idle S75. Those are marked `WASM_DIAG_HOT()` at their
increment sites and **compiled out of the shipping build**, so `ioLd`,
`ioSt`, `vclock`, `hflags` and `tpuRamW` read zero there — "not compiled
in", not "did not happen". To get real rates, add `#define
WASM_DIAG_HOT_COUNTERS 1` above that block in `wasm-diag.h` and rebuild;
never take a wall-clock A/B against such a build. The cold counters are
unconditional, so tb/flush/fill/warp diagnostics work everywhere.

**Reading the dispatcher and the CPU (0116).** `execIter` is
`cpu_exec_loop` iterations — since 0091 a chained TB never comes back, so
this is the chain-unwind count. `execSjmp` is `cpu_exec` entries, *not*
longjmps. `execLjmp` is the `cpu_loop_exit` longjmps actually taken, and
it should stay near zero: a longjmp in this build is the emscripten
JS-exception unwind, ~15 µs each. `armIrq` counts ARM exception entries
and the `exc*` histogram splits them by kind — on an S75 boot that reads
90 % `excSwi` (the guest's own syscalls, ~93 k/s) against 10 % `excIrq`,
with every other slot zero, and `armIrq / execIter` = 77 %, i.e. the
exception is what breaks a TB chain. All of these are cold by
construction: the hottest is `armIrq`, two orders below the
`WASM_DIAG_HOT()` paths above.

## When the guest stops dead (`site/app.js` §6b)

The vCPU is a worker thread and the page's state machine never hears
about one that dies or wedges, so a dead guest used to read "Running ·
0:21" behind a frozen splash screen — which is exactly what the round-29
lost-wakeup bug looked like on a phone, where there is no console to read
a log from.

The page now watches three counters and calls a stall when instructions
(`_wasm_insns`), halts (`wasm_memstat[halt]`) and display reads
(`_wasm_fb_updates`) are frozen **together** for 15 s. All three,
because a guest asleep in WFI stops retiring instructions while its halt
count keeps moving and the display keeps being read — one counter alone
cannot tell idle from dead. Fifteen seconds because a GC pause, a
compile burst or a merely slow phone must never be called dead, and it
still lands while the user is still looking at the splash.

What you get: the pill goes `· stopped` and turns red, an overlay says
how long it has been still plus either the worker's fatal message or the
last non-blank line qemu printed, and **Copy diagnostics** carries
`stalled`, `fatal` and a 40-line `log` tail (also on `window.__qemutail`).
The fatal message needs its own hook — a pthread that aborts, traps or
fails an allocation surfaces on the main thread as an `error` event and
nowhere else, so without the listener and `onAbort` the vCPU dying is
completely silent. The detector clears itself if any of the three
counters moves again, so a guest that recovers un-stalls.

## Scripts that matter

**Gates** (correctness — parallel-safe, run them through
`scripts/gate.sh`) and **benchmarks** (measurement — one at a time on a
quiet host) are different things, and mixing them is how a session gets
both a slow loop and a wrong number. `scripts/gate.sh quick|keep|close`
runs the whole gate set concurrently and prints one verdict table; the
benchmarks below are never in it.

Benchmarks — the meters:

| Script | Purpose |
|---|---|
| `workbench.mjs` | **the default A/B meter.** Wall time to execute a fixed stretch of guest work (`--board`, `--to <Mi>`). Under icount the guest between two instruction milestones is identical in every run of every build that does not change guest-visible behaviour, so this resolves a patch where a steady-state meter cannot — the SGOLD boards have no steady state (idle animates, the GSM stack cycles) and swing ~15 % run to run |
| `uibench.mjs` | per-board steady-state: MIPS, v/wall, fps, halts/s and the display/dispatch counters, at the idle screen and while the menu is driven. The only meter that sees a board-specific mechanism — rounds 4–9 measured the S75 only and both round-ten findings were invisible there. On `icount=none` boards v/wall is 1.0 by construction, so read MIPS/fps |
| `idlebench.mjs` | the end-to-end boot benchmark: fresh headless browser per run, S75v40lg1 to the idle screen (LCD bottom-139-rows vs a committed reference), guest-work milestones `t0.1G…t1.3G`, the v=2..7 window, A/B ratios between dists in one invocation, regression verdict vs `tests/results/idlebench-latest.json`; `--quick` (~1 min/dist), `--runs N`, `RT=banked`, a dist may be `<dir>@<query>` for knob A/Bs; `--board ke800` boots the LG fullflash (+ EFA sidecar, no icount) to its idle screen (`tools/test_targets/KE800-v11b_idle.png`, bottom 150 rows) — tIdle is its number, its own `idlebench-ke800-latest.json` baseline; the `-lcd.png` of any run is the canvas at its own resolution, i.e. a reference candidate |
| `tcgbench.mjs` | fast-iteration perf bench on versatilepb (`tests/tcgbench`): per-phase backend A/B + the device/icount-tax mirrors (`mmiopoll`/`rampoll`/`mmiow` ns/access, `ICOUNTS=0,1`, `SUITE=quick`) |
| `keylag.mjs` | key-press response latency per board — the meter for the EL71 key-lag complaint |
| `stopwatch.mjs` | J2ME pacing meter: boots S75v40lg1, walks the keypad to Extras → Stopwatch and prints `vratio` (virtual s per wall s), plus a `per-s` line with the display-path counters (`difTxWord`, `dmacBurst`, `dmacSchedTimer`, `dmacXlatFill`, `difMuxRebuild`, `lcCall`); `--devtools <port> --hold <s>` keeps the running app open for `wprof2.mjs PROF_ATTACH=<port>`; `CHROME_ARGS="--js-flags=--liftoff-only"` passes browser switches (a phone-tier A/B: `--liftoff-only` pins V8's baseline tier, `--no-liftoff` pins TurboFan; `--no-wasm-tier-up` is a no-op in Chrome 153) |
| `videobench.mjs` | **video-playback meter** (the "video is below real time on a phone" report): boots `SL65v49lg1_TIM.bin`, walks Menu → `8` (My stuff) → Videos → the clip, and measures a fixed span of the *guest's own clock* while it decodes, uncapped. `rt` is the number — virtual seconds delivered per wall second, 1.0 = real time on a real SL65, and a phone runs ~5× slower per instruction than the desktop this A/Bs on. `duty` is what the clip asks of the phone (**1.000**: this player never idles, so there is no headroom to warp over and `rt` is the whole story), `mi` the determinism check (0.03 % across windows), plus `fpsGuest`/`fps` and every `wasm_diag` counter per Mi. `--runs N` takes N windows on one boot, `--trace` prints frames/Mi per virtual second, `--devtools <port> --hold <s>` holds the clip *playing* (it restarts it at the end) for `wprof2.mjs PROF_ATTACH=<port>` |
| `loadbench.mjs` | startup-path benchmark (download, compile, instantiate) |
| `ab.mjs` | parallel boot-survival A/B of query variants against the deployed dist (`scripts/iterate.sh` uses it) |
| `slowhost.sh` | run a command on a "phone-sized" slice of this host (pinned cores + same-priority spinners) |

Gates — `scripts/gate.sh quick|keep|close` runs these; the individual
commands are worth knowing only for reproducing one failure:

| Script | Purpose |
|---|---|
| `bootcheck.mjs` | the four-fullflash browser gate: boots s75/el71/ke800/cx70 on one dist and judges progress in executed instructions; on a firmware `>>EXIT<<` it waits for the panic text and saves the serial tail (`tests/results/bootcheck-<dist>-<board>-serial.txt`); `--query "trace=dsp,scu&tracebuf=1"` adds page parameters to every board and saves the buffered stderr/device trace per board (`…-trace.txt`); `--flash s75,el71` boots the boards in that order as consecutive pages of one browser, which is its own test condition (the second page starts from cache at full speed) |
| `earlykey.mjs` | a key event delivered at the earliest instant the export exists must not take the module down (0081). One board per invocation |
| `tcgisa.mjs` | drives the guest op-suite on one page leg: `node tcgisa.mjs <port> <dist> [out] [ENV=VAL…]`. `scripts/run-tcg-isa.sh` is the gate and runs it once per built dist, comparing each against the native JIT serial log |
| `lockstep.mjs`, `lockstep-wasm.mjs` | cross-backend value-equality drivers — native JIT vs native TCI (plugin) / native JIT vs the wasm page (built-in fold); `scripts/run-lockstep.sh` is the native gate |
| `ffboot.mjs` | boot a dist in Playwright's Firefox (cross-browser smoke; `BROWSER=chromium` too) — `temp=` (per-TB throwaway modules) must stay ~0 and `errors=0` |
| `tests/run.mjs` | the native suite: four fullflashes booted with `run-native.sh`'s recipe, plus an insncount MIPS benchmark. Blind to every wasm-only path, which is why the browser gates exist |

Profiling and counters:

| Script | Purpose |
|---|---|
| `diagall.mjs` | **every** `wasm_memstat` counter by name plus a per-second DELTA block — the tool for deciding *where* time goes. Names come from `diagnames.mjs`, so it never goes stale |
| `counters.mjs` | every unconditional counter for one board as a rate (`--board`, `--from`, `--window`) |
| `xcensus.sh`, `census.sh` | **the tight meter for a TB-shape change**: counters per Mi, read at *matched instruction counts* rather than matched seconds. `xcensus.sh` is the boundary census (`W64_XCOUNT=1&W64_XWHY=1`), `census.sh` the memory-op one (`W64_LDSTCOUNT=2&W64_LSMCOUNT=1`); both run the J2ME meter. `videobench.mjs` takes the same knobs through `EXTRA_Q` and prints the same per-Mi block, which is the video-side census. The counters resolve to ~0.04 % against the clock's ±2 %, so they settle a mechanism the clock cannot — but the counter code goes into every TB, so **the wall time of a census leg is not comparable to anything**. **A mechanism meter, not a verdict meter**: it prices the exits a change removes and is silent on what the change adds, which is how `W64_FTMAX=8` read −1.7 % here and −1.1 % on the clock, and how the third tracked page (round 42) removed all 9 805 page refusals per Mi and moved the *total* boundary count by only 0.9 %, because an absorbed call relocates its caller's boundary instead of removing it |
| `memstat.mjs`, `diagprobe.mjs` | the memory-path subset over a boot / any counter by index (`name=idx`) |
| `modcost.mjs` | what fraction of wall time goes into translation + module construction — the ceiling probe for any tiering scheme. Reads the C-side phase timers through `_wasm_memstat`, *not* from the worker: the vCPU worker runs the guest without yielding, so a worker-side `evaluate()` never gets scheduled and hangs the tool |
| `modfloor.mjs` | synthesizes wasm modules of chosen shapes and times `new WebAssembly.Module` — the page-side floor to compare the emulator's own 83 µs against |
| `modgrow.mjs` | the one variable `modfloor` holds fixed: does module creation slow down as live modules accumulate?  Keeps every instance while building thousands, prints cost per bucket, then drops them all and re-measures.  Answer for the record: **flat** at ~50 µs from 500 to 6000 live, and dropping them changes nothing — the emulator's ~80 µs fixed cost is not the live set |
| `dispatch-probe.mjs` | what one TB→TB dispatch costs.  F functions of the real TB signature spread over a configurable number of module instances, each tail-calling the next index of a pseudo-random sequence; `--stride` adds the dependent descriptor load 0091 removed.  The mechanism is 2.4 ns; **the cost is locality** (5.5 ns at a 1-function working set → 46 ns at 4096) |
| `locals-probe.mjs` | what the backend's ~70 declared locals cost, by tier — wasm zeroes locals at entry and the baseline tier cannot drop the unused ones.  `--liftoff` pins the baseline tier, `JS_FLAGS=` passes any V8 flag.  `--split` also gives the per-module compile floor (~8 µs + 7–12 µs/KB) |
| `abortlog.mjs` | boots `BOARD=` (el71/s75/cx70/ke800) and prints every console line and pageerror verbatim.  The tool for "the run died and the meter only said so three layers up": a firmware panic arrives as a serial line (`sorry died at ...`), and workbench.mjs surfaces it as an unhandled Node exception about `wasm_insns` after runtime exit |
| `tierup-probe.mjs` | how many calls a wasm function needs to leave the baseline tier, and whether that depends on its size.  One continuous run per body size in a fresh instance, timed in chunks.  Answer: **~1–2.4 × 10⁴ calls across an 85× size range** — per call, not size-weighted |
| `import-probe.mjs` | what a TB module's helper call costs just for crossing the module boundary, four ways (local / `instance.exports` / `wasmTable.get()` / `call_indirect`).  **2.1–2.4 ns** optimized, 3.6–4.4 ns baseline — it is not where a helper's time goes |
| `haltprobe.mjs` | why is this board awake? — halt/wake attribution |
| `wprof2.mjs` | per-worker CDP profiler with `wasm-function[N]` → symbol resolution via the `.symbols` sidecar; `PROF_DELAY=<s>` picks the boot phase, `PROF_FN=<substr>` prints caller stacks, `PROF_ATTACH=` profiles a page another tool drove, `PROF_SAVE=<json>` keeps the raw profile. **Self-time names a neighbourhood, not a function** — confirm with a counter or a volatile-spin probe before believing a rank |
| `profcat.mjs`, `profjit.mjs` | categorize a saved profile by cost class; distribution of JIT-guest self time over TB functions |
| `threadmap.mjs`, `syscallprobe.mjs` | thread census / syscall CPU attribution |
| `asyncify-audit.mjs` | which frames the Asyncify onlylist still needs (`QEMU_COSTACK=1` is the evidence half) |

Probes and traces:

| Script | Purpose |
|---|---|
| `smoke.mjs`, `verify-boot.mjs`, `wshot.mjs`, `screenshot.mjs` | boot once / verify + insn rate / screenshot after the splash |
| `serialwatch.mjs [s] [query]` | push vclock/serial/fb/TB stats via console every 10 s — the general-purpose probe |
| `conlog.mjs` | capture qemu console lines matching a prefix (`MATCH=`, `SAVE_FS=` pulls MEMFS files out) |
| `iotrace.mjs`, `tracebuf.mjs`, `tracedump.mjs`, `dsplive.mjs` | `PMB887X_TRACE_*` captures (buffered / live-filtered) |
| `execdump.mjs`, `tracediff.mjs`, `iorec.mjs` | `-d exec` log dump / TB-sequence diff between builds / io_recompile frequency |
| `peekcode.mjs` | dump + disassemble guest memory ranges after a boot delay |
| `w64dbg.mjs`, `w64walk.mjs`, `repro.mjs` | wasm64 backend console diagnostics, structural module walker, failing-batch capture loop |
| `efa-web.mjs`, `preset-web.mjs` | E2E page tests: LG fullflash + EFA sidecar; preset download → cache → boot |
| `exitcheck.mjs` | the Siemens EXIT path end to end: boots an image that panics (default `fullflashes/BROKEN)S66_no_recalc.bin` as `siemens-s65`, ~3 s to the dump) and checks the page stopped the guest, beeped once, dimmed the canvas and started the 30 s fade, and drew the parsed dump over it — desktop and phone layouts, screenshots in `exitcheck*.png`; `--inject` writes the recorded EL71 (x75-shaped) dump into a healthy guest's log instead, once it has drawn something, which is the leg that watches a lit screen fade |
| `session.mjs` + `ctl.mjs` | persistent headless-browser session and its client |
| `vclock.mjs`, `bootmatrix.mjs` | virtual-clock progression per `?icount=` variant; parallel boot matrix over query variants |

## Native reference runs

```
env PMB887X_TRACE_IO=dsp,scu PMB887X_TRACE_LOG=dsp,scu \
    PMB887X_BOARD=build/bsp/lib/data/board/siemens-s75.toml \
    PMB887X_STARTUP=ONLINE PMB887X_SIM=virtual PMB887X_SIM_OPERATOR=00101 \
    PMB887X_FLASH0_OTP0=02004AB3C31100000000 PMB887X_FLASH0_OTP1=000094104502237315FF \
  build/qemu-native-build/qemu-system-arm -display none -icount shift=3,sleep=off -machine pmb887x \
    -drive if=pflash,format=raw,file=<fullflash>,readonly=on \
    -serial file:serial.log -D trace.log
```

(`scripts/run-native.sh` builds exactly this command line from the
fullflash name.) The wasm run is meant to replay the same instruction
stream: diff the trace sequences (`COM_SET` → `DSP_CFR cleared` →
`SCU_DSP_INT` → …) to find where they diverge, and diff the same trace
between `dist` and `dist-jit` to bisect a JIT-only failure. Remember:
`>>EXIT<<` on serial = phone crashed; stop there.
