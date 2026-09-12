# Performance hand-off: the qemu-core device-path workstream

Status (2026-09-12, profile session — patches 0042–0045):
`/dist-jit` boot on a quiet host (rt=off, interleaved `--runs 4` vs the
session-start build): window 14.2 → **13.7 s (−4 %)**, t0.5G 21.8 →
**21.4 (−2 %)**, t0.75G 27.1 → **26.4 (−3 %)**, t1G −2 %, t1.3G
29.3 → **29.0 (−1 %)**; run-to-run spread also collapsed (window
13.7–13.8 vs 14.1–15.3).  Three mechanisms, all small and all measured as
a stack: **0044** devirtualises `helper_lookup_tb_ptr`'s
`get_tb_cpu_state` `call_indirect` and folds `curr_cflags`' debug-only
conditions (78 M calls/boot, helper self time 7.3 → 6.5 % of the vCPU);
**0045** skips the `arm_rebuild_hflags` a `msr CPSR_*` cannot affect
(2.1 M skips/boot, **0 mismatches** against a recompute-and-compare
build); **0043** gives the topology-commit TLB flush a physical-address
summary — entries walked per boot **280,759,680 → 1,179,712 (237×)**,
entries dropped unchanged at 22,007, boot effect on its own flat.
**0042** is the measurement infrastructure the rest was chosen with, plus
env knobs for the compaction thresholds.

**The two findings that should drive the next session are not the −3 %.**

1. **The shipping configuration is virtual-time-bound after t0.75G.**
`rt=banked` (what `site/app.js` ships) and `rt=off` (what every rung of
the ladder measures) are *identical through t0.75G* and then diverge
completely: t1.3G **38.9 s vs 29.3 s, +33 %**, because the boot consumes
~42 s of virtual time of which **~31.5 s is idle warp** — almost none of
it before t≈22 s of wall, then ~18 s of it inside the display-DMA stretch
(~4 s of wall).  The guest is genuinely halted across those warps, so the
cap is reproducing stock QEMU's `sleep=on` pacing.  Consequence: engine
work can only move the first ~0.75 G instructions, ~27 s of the 39 s a
user waits; the other 12 s is the guest's own timeline.  See the
playbook's "The shipping boot is virtual-time-bound after t0.75G".
Note native currently has **no** cap (0032 is emscripten-only), so native
fast-forwards the phone's clock exactly as `rt=off` does.

2. **Emitted code volume is the biggest remaining engine lever, and it is
now measured.**  The browser compiles **197 MB of wasm per boot** over
35k modules — 94 MB of unique TB bodies (**563 B per 4.85-insn TB**) plus
a second compile of nearly all of it by compaction (49 % of all bytes;
turning compaction off halves the bytes and measures *neutral*, see
§ REJECTED).  Per TCG opcode, **`qemu_ld`/`qemu_st` are 37 % of emitted
bytes at ~85 B each** (the inline TLB probe).  Cold execution of that
code dominates: the first 0.5 G instructions run at ~20 MIPS and take 21 s
of a 29 s boot.  Settled on the way: `tcg_qemu_tb_exec`'s 15–18 % profile
self-time is **misattribution** — the dispatcher is entered 1.2 M times
per boot, one iteration each.

Gates green: op-suite 1156/1156 byte-identical, native suite 4/4,
lockstep 250e6 serial+regs identical.  **Not run this session: the
three-fullflash browser gate** (`tools/bootcheck.mjs --dist dist-jit`) —
run it before trusting these patches on EL71/KE800.
New tooling: `tools/diagprobe.mjs` (read any `wasm_memstat` counter by
index over a boot) and idlebench's `<dist>@<query>` per-leg query, which
makes a *knob* A/B interleavable instead of cross-invocation.

Status (2026-09-12, display-path / TLB session — patches 0039–0041):
`/dist-jit` boot on a load-7 host: t0.5G ~22.5 s, t1.3G ~30 s (rt=off,
`--quick`; the stack measured −2..−3 % at t0.5G/t1.3G and −18..−20 % at
t0.1G vs the session-start build, plus −3..−5 % from
`-Dqom_cast_debug=false`, all both orders).  **The J2ME stopwatch
("Java timers at 0.1×") is a throughput problem with a meter, not a
pacing bug**: while it runs the guest never halts (halts/s = 0, warp
share 0 — counters, 0041), so virtual time is instruction time and the
displayed rate is guest MIPS / 125; native does 150+ MIPS and is paced by
the RT cap, wasm did 25.  `node tools/stopwatch.mjs` boots S75v40lg1
(the same flash idlebench measures), walks the keypad to Extras →
Stopwatch (verified screen states, retries) and prints
`vratio`: 0.19 at session start → **0.29–0.33** after the display-path fixes
(0039: VIC bitmap, DIF pin/request caches, mux tables, DMAC burst reads,
QOM casts off) and fill-time TLB growth (0040: 83k fills/s → 35/s; QEMU
only resized the TLB at flush time and this phase never flushes).  Left
in that state: devices 33 %, guest code 33 %, `helper_lookup_tb_ptr`
12 % (2.9 M lookups/s), MMIO 6 % — 1.0× needs ~3× on this workload.  The
old-build check is done and says this is **not a regression**: the saved
`dist-jit-0022` build reads **0.12× (15.1 MIPS)** on the same flash and
meter, 2.4× slower than the current build.
Early-boot attribution (profcat): guest 50 % spread over ~5.4k cold TB
functions, lookups 12 %, module compile 13 %, translation ~6 %; V8 flag
bounds say code quality is not the lever (eager TurboFan 2.5× slower).
Tooling: `tools/stopwatch.mjs`, `tools/profcat.mjs`/`profjit.mjs`,
`wprof2` `PROF_ATTACH`/inclusive table, `tools/slowhost.sh` (phone-shaped
CPU throttling), idlebench idle floor 15 s / 1.2 G insns.

Status (2026-09-11, RTC session — patch 0033): **the displayed clock and
the initial date are fixed; both were one bug, and it was never a wasm
or warp-patch regression.**  The pinned rev's "fix RTC date/time
encoding" (3e497d7ae7) seeds RTC `CNT` as a packed calendar (fields
sec/min/hour/yday with 964/4/40 reloads) — right for the LG firmware
(KE800 reads the fields), wrong for Siemens, which treats `CNT` as one
linear Unix-seconds counter: the packed value decodes to "Wed 02 May
2091" and, because a minute wrap is +965 in the linear reading, the
shown clock jumped +16 min at every minute boundary (the "~22×").
Reproduced identically on the pristine native build (~300× there, the
idle virtual clock also warping without 0032).  0033 adds a per-board
`cnt-format` read from the board config's `[rtc] format` key (default
`unix`; the LG configs set `calendar` via `patches/bsp/0002`).  Verified on native S75/C81/KE800 and on both
wasm dists (S75 "Пт 11 Сен", advancing 1 min per wall minute).  The
RTC-CNT-vs-vclock method that found it: `?trace=rtc&tracebuf=1` reads
decoded both ways next to LCD screenshots (`tools/` has no permanent
script; the probe lived in the session scratchpad).  Note for the
benchmarks: nothing else changed, no perf gate re-run was needed.

Status (2026-09-11, Asyncify + real-time-cap session — patches 0031,
0032): `/dist-jit` boots to idle in **33.2 s** (idlebench `--runs 2`
interleaved vs the session-start dist at 40.3 s: **−18 %**; −24 % vs the
morning's 43.8 s), early phase t0.1G **−39 %**, t0.5G −19 %.  Two
mechanisms.  **0031 — Asyncify instrumentation allowlist**: the emscripten
fiber coroutine backend unwinds the whole C stack at a switch, and the old
`-sASYNCIFY_REMOVE=tcg_qemu_tb_exec` (instrument all-but-the-interpreter)
pulled ~21k functions / 17 MB into instrumentation via the `invoke_*`
longjmp wrappers — ~25 % of the early-boot vCPU on the wasm64 backend,
which runs guest code as JIT'd modules and needs almost none of it.
Replaced with `-sASYNCIFY_ONLY=@configs/meson/asyncify-only.txt`
(functions captured on a real switch stack with `QEMU_COSTACK=1`), which
also cut the wasm **45.1 → 27.8 MB**.  Prereqs: flash `blk_pwrite` moved
to a main-loop BH (a vCPU-thread block coroutine cannot unwind a JIT
frame — it derailed on the first rw-flash write), and the vCPU thread is
marked so a stray switch aborts loudly.  **wasm64-only**: the same
onlylist regressed the TCI `/dist` +26 % (its hot path is the
interpreter), so `/dist` keeps `ASYNCIFY_REMOVE`; the override lives in
`scripts/build-qemu-wasm64.sh`.  **0032 — real-time icount cap**
(`QEMU_ICOUNT_RTCAP`, `?rt=`, wasm default banked): sleep=off warps the
virtual clock to the next deadline as fast as the host runs it, so a
halted guest's clock/animations ran ~3.7× wall (a regression vs native,
where the warp is RT-paced).  The vCPU now sleeps (kick-interruptible)
until wall reaches the virtual target; "banked" never throttles the
compute-bound boot (virtual runs *behind* wall there), only idle overrun,
so boot-to-idle is unchanged and the idle virtual clock tracks wall (v
166 → 44.8 s at t=45 s).  The displayed digital clock still advanced
too fast per virtual second after this session — resolved by 0033 (see
the status above: the RTC `CNT` seed layout, not a rate or warp issue).
The J2ME stopwatch running ~0.1× is the
opposite problem (compute-bound guest, not a pacing bug) and the cap does
not address it.  Gates: op-suite native JIT+TCI 1156/1156 byte-identical,
wasm64 lockstep 250e6 serial+regs identical, both dists boot to the idle
screen.

Status (2026-09-11, halt-path session — patches 0023–0030, closing
run): `/dist-jit` boots to idle in **43.8 s median** (runs 43.8 / 41.9;
idlebench --runs 2 interleaved against the saved session-start dist:
50.2 s in the same invocation, 52.9 s in the morning's run; 71–76 s two
sessions ago) and `/dist` in **57.9 s** (63.6 s base in the same
invocation).  t1.3G: dist-jit 48.7 → 42.6 s, dist 61.5 → 55.8 s.
Where the JIT boot's time goes now (host-time counters, one boot):
translation ~6.7 s (38 µs per TB × 176k), module compile ~3.9 s (35k
modules, ~33 µs fixed + 5.5 µs/KB), the display-DMA stretch ~7 s of
guest work at 10–20 MIPS, the rest guest execution.  The next levers
are structural: fewer/larger modules (an interpreter tier for cold TBs,
or the AOT cache for second boots), cheaper translation (the generic
TCG passes at wasm speed), and the per-word IRQ/WFI path of the display
stretch.  Rejected this session with numbers: the per-TB goto_ptr inline
cache (80 % hits, flat — `patches/attic/goto-ptr-inline-cache.diff`).
Patches 0028–0030 mechanisms: a timer re-armed beyond the running icount budget no longer
kicks the vCPU (0028; 37k kicks/s → the needed 1 %), and the per-TB
atomic icount2 tick accounting is emitted only under the opt-in icount2
model (0029; −5 % on every milestone).  Trap found and fixed on the way:
the virtual-clock completions (0024) stall the opt-in
`?icount=precise-clocks` boot because icount2 runs due timers
synchronously inside `timer_mod` — that mode keeps the realtime clock
(`pmb887x_completion_clock()`); a 40 s precise-clocks smoke is now part
of the gates.  Earlier in the session: the halted vCPU warps
the virtual clock and runs its timers itself instead of the two-hop
main-loop handoff (0023, both dists), display-DMA completions on the
virtual clock (0024), no realtime-clock JS imports in the icount budget
+ WFI without a longjmp (0025), goto_ptr tail calls inside wasm (0026),
CPSR writes / exception returns via goto_ptr instead of a plain exit
(0027, the most frequent exit of the boot).  Method that found them:
counters over profiles — the caller-stack profile claimed 30 % halt
wait in the early phase, the halt counters said <1k halts before
38 s; the exit-kind histogram + a per-TB exit histogram (descriptor
tagged exit_tb(0), `tcg_tb_lookup`, `peekcode.mjs` disassembly)
pointed at `msr CPSR`.  What is left: per-module compile (~10 % of
the early vCPU), `helper_lookup_tb_ptr` + qht (~8 %), the display
stretch's guest work (~7 s at 10–20 MIPS), `TB_EXIT_REQUESTED` rounds
(~25k/s).  Gates green: op-suite ×4 identical, native 4/4 (branch
binary), lockstep 250e6, Firefox idle (errors=0).

Status (2026-09-11, end of the wasm64 module-economy session — patches
0019–0022): `/dist-jit` boots to idle in **52.9 s median** (idlebench --runs 2; was
71–76 s at the start of the day) and `/dist` in **67.4 s** (was 71–76 s); Firefox
boots to idle with no console errors (was out of executable memory at
10 s).  Mechanisms, in landing order: speculative successor translation
+ compile-once batching + compaction (0019, −15 %), call-return / ldr-pc
successor hints (0020, −5..−8 % t0.5G), untimed cond waits that really
wait + atomic event notifiers (0021, both dists, −5..−13 % tIdle), the
goto_ptr handoff-slot offset fix (0022, window −8..−10 %).  Rejected with
numbers: device timers on the virtual clock, 32k jump cache, compaction
threshold sweep (playbook § REJECTED).  What is left is structural: the
display-DMA stretch (~9 s, one IRQ + halt per word), per-module compile
cost (~10 % of the early vCPU), `helper_lookup_tb_ptr` (~6 %).  Working
method and forensics: playbook + sessions doc (2026-09-11 entries).

Status (2026-09-11, end of device-path session): **slice 1+ landed as
0018** — the MMIO dispatch tax is at native parity (tcgbench mmiopoll
202 ns/access on `/dist-jit`, 252 on `/dist`, vs 223 native; was
534/606).  Two mechanisms: fill-time dispatch resolution in the iotlb
entry, and a flag-masked victim-TLB compare that fixes a real qemu-core
bug (the victim TLB never hit MMIO entries — index-aliased MMIO pages
under ARMv5 1K target pages re-walked the page tables on every
access).  All gates green (op-suite ×3 byte-identical, native suite
×4 on the branch binary, lockstep 20e6+250e6, full 2.5e9 + idlebench
at close).  Remaining plan: slice 3 (timer storms/main-loop wakeups,
~8 %) and the optional `/dist-jit` tail items.  History below kept
for context; the session log lives in the playbook (2026-09-11).

Status (2026-09-11): **the wasm64 TCG backend is compute-complete; the
boot's early phase is NOT at TCI parity.**  The earlier "boot-to-idle
at TCI parity (idlebench median 76.4 s both)" reading was phase
cancellation (see the playbook's 2026-09-11 benchmark-audit log): on
the guest-work milestones
`/dist-jit` is +27 % at t0.5G and +31 % on the v=2..7 window vs
`/dist` (user-side manual boots: 86 s vs 78 s), then 2.7× faster on
the last 0.55 G insns.  Compute 7.4× TCI on tcgbench
(562 MIPS sustained on compute phases vs the TCI page's 53; per-phase
7–18×), every correctness gate green (op-suite 1156/1156 byte-identical
×3 backends, full 2.5e9 lockstep gate, native suite ×4).  That
workstream's history lives in
[wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md) /
[wasm-tcg-backend-progress.md](wasm-tcg-backend-progress.md) (and the
discarded wasm32/ktock attempt in
[wasm32-port-status.md](wasm32-port-status.md)); the original 2024
hand-off text is in git history — everything it demanded (deterministic
boot, ≥50M insns/s comfortable boot, correct-at-any-speed timing) is
done and closed.

**What remains for wall-clock boot time sits one layer down — in
qemu-core and the emscripten runtime — where every backend pays it
identically.**  This document is the hand-off for that workstream:
measured baseline, targets, plan, constraints.  Working method:
[optimization-playbook.md](optimization-playbook.md) (unchanged rules;
the A/B meter for this workstream is tcgbench's tax mirrors, not the
v-window alone).

## Where the time goes (slice-0 attribution, measured 2026-09-11 — the pre-0018 baseline)

| component | number | whose code | note |
|---|---|---|---|
| one MMIO access | **590 ns** wasm64 / **632 ns** TCI / **224 ns** native JIT | qemu-core + emscripten | the mirrors: `rampoll` vs `mmiopoll`, same instruction shape |
| one RAM access | 4.7 / 52.8 / 1.5 ns | backend | wasm64 ≈ native here |
| boot sustained rate | ~55 MIPS | — | vs 562 MIPS compute ceiling: the boot cannot spend the backend's speed |
| icount (`shift=3,sleep=off`) | free on short-TB workloads | qemu-core | measured on tcgbench `ICOUNTS=0,1` post account-inline |
| vCPU: `cpu_exec_loop` + dispatcher | ~9 % | qemu-core | |
| vCPU: `helper_lookup_tb_ptr` | ~4 % | qemu-core | |
| main thread: mailbox/futex-wake/`_emscripten_get_now` | ~8 % | emscripten runtime | device bookkeeping wakeups |
| remaining emitter levers | ~10–15 % of vCPU ≈ few % end-to-end | wasm64 | tail work, `/dist-jit` only |

(0018 has since landed — mmiopoll is now ~202 ns on `/dist-jit` and
~252 ns on `/dist`, i.e. native parity; the table above preserves the
slice-0 baseline the plan was written against.)

The two facts that define the workstream:

1. **wasm64 ≈ TCI on MMIO (7 % apart)** — the dispatch tax is shared
   qemu-core cost, so fixing it helps `/dist` as much as `/dist-jit`
   (and native).
2. **both wasm builds pay ~2.6× native per access** (590/632 vs 224 ns)
   — ~370 ns per access of pure dispatch-path overhead that runs before
   the device callback.  The firmware busy-polls (~90k dispatches/s in
   poll phases), so a poll-dense phase spends most of its wall time in
   this path.

The path being taxed (re-resolved generically on every access):
TB/interpreter → `helper_*_mmu` → `io_readx` → `iotlb_to_section` →
`address_space_read` → FlatView/`flatview_translate` →
`memory_region_dispatch_read` → ops resolution (+ RCU/atomic guards)
→ device callback.

## Targets

**Definition of done for this workstream**: S75v40lg1 boots to idle in
**≤ 55–60 s on both `/dist` and `/dist-jit`** (idlebench protocol),
with the full correctness matrix green — op-suite ×3 byte-identical,
native suite ×4, lockstep windows (full 2.5e9 gate at close) — because
qemu-core changes touch every backend.

Intermediate gates (meters, all seconds-fast):

- tcgbench mirrors: **`mmiopoll` ≤ 300 ns/access** on wasm (from 590;
  native is 224) and no regression on `rampoll`/compute phases;
- bootbench v-window and idlebench improve **on both dists** (a
  qemu-core win that only shows on `/dist-jit` is suspect);
- wprof main-thread self-time (mailbox/futex/`get_now`) halves.

Realistic ceiling: ~1.3–1.8× end-to-end.  The boot still has to do real
device work; this is not another 7×.

## Plan (measurement-gated slices, same discipline as the backend plan)

1. **Slice 0 — attribute the 590 ns** (~a day; gates everything else).
   wprof2 with symbol maps on a tcgbench MMIO-heavy run (both wasm
   dists), plus `perf` on the native JIT running the same phase.  Split
   the cost into: helper entry/import call, `io_readx`, section/FlatView
   resolution, `memory_region_dispatch_read`, RCU/atomics, callback.
   If the atomics dominate instead of the lookups, slice 2 comes first.
2. **Slice 1 — precompute the dispatch resolution at TLB-fill time**
   (the headline change, ~2–4 days).  When an iotlb entry is filled for
   an MMIO page, store the already-resolved `(read_fn, write_fn, opaque,
   attrs)` in the entry; the miss path becomes one compare + one
   indirect call.  Invalidation rides the FlatView generation counter —
   the machinery 0016 built for romd variants is the template.  **This
   is NOT the rejected memory.c runtime cache** (that added a per-access
   condition chain and measured worse); this adds zero per-access checks
   — the resolution moves to fill time.  Watch upstreamability: generic
   TCG-system-mode win.
3. **Slice 2 — the wasm multiplier.**  Whatever slice 0 says: single-vCPU
   non-MTTCG builds don't need the full RCU/seqlock treatment on this
   path (the main thread is the only other contender and mostly sleeps)
   — plain loads under a build flag if atomics show up; check the
   helper-import boundary cost on wasm64.
4. **Slice 3 — timer storms and the main loop.**  Coalesce icount timer
   deadlines; skip LCD composites for unchanged frames; batch main-thread
   wakeups (the ~8 %).  Meter: idlebench + wprof main-thread time.
5. **Tail (optional, `/dist-jit` only)**: backend plan phase-3 leftovers
   (`lookup_tb_ref` direct import, dispatch loop) and phase-5 AOT cache
   (Cache API/IndexedDB batch persistence, keyed by flash hash) — see
   the backend plan; they do not block anything here.

## Constraints (what still binds, from the whole project's history)

- **The timing model is fixed**: stock `-icount shift=3,sleep=off`,
  instruction-proportional deadlines; correctness must never depend on
  execution speed (lockstep gates enforce this).  Do not "fix" pacing by
  pinning clock frequencies — virtual time outrunning instructions
  kills the boot (measured, BROM delay loops).
- **The firmware busy-polls** (SCU/DSP/USART status loops): per-access
  costs are multiplied by ~50–100k/s.  Any per-access condition added to
  a hot path must pay for itself at that rate — this is exactly how the
  memory.c fast path was rejected.
- **qemu-core changes shift all backends**: A/B on both dists, correctness
  matrix per landing (op-suite ×3, native suite ×4, lockstep windows;
  full gate at workstream close).
- **3–4 insn/TBs** are the firmware's shape — per-TB overheads amortize
  over almost nothing; per-access and per-wake costs are the only ones
  that scale with this workload.
- emscripten traps that don't compose: wasm-EH longjmp × ASYNCIFY,
  `poll()` never sleeps, condvar waits are whole-ms.  See the playbook
  cheat-sheet before designing anything that waits or unwinds.
- Diagnostics that stay useful: `QEMU_ICOUNT2_DEBUG=1` (controller
  state, for the `?icount=precise-clocks` experiment path only),
  `wasm-diag.h` cold counters, `tools/wprof2.mjs` + symbol maps
  (`PROF_DELAY=` selects boot phase), tcgbench mirrors + `ICOUNTS`.

## Non-goals

- More emitter/interpreter micro-optimization as the primary lever —
  the backend holds a ~10× compute reserve the boot cannot spend until
  this workstream lands (the tail items above are optional extras).
- Changing the timing model or any device's semantics for speed.
- MTTCG, in-wasm JIT APIs, resurrecting the ktock dispatch design
  (measured ceilings — see backend plan §7).
