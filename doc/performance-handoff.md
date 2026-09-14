# Performance hand-off

Where the work stands, what is open, and what binds. Patch numbers are
commits on the `qemu/` submodule branch ([upstream-branch.md](upstream-branch.md));
the per-patch numbers are in the playbook's "What landed" table, the
method in [optimization-playbook.md](optimization-playbook.md), the
hard-won conclusions in [lessons.md](lessons.md).

## Update (2026-09-14, round ten: 0056 + 0057 — the other two phones)

**Read this if you are about to optimize the S75.**  Rounds 4–9 all
measured the S75, and its meters had gone flat.  The user's report was
"mostly real time on the S75, EL71 and KE800 still very much behind",
and both of those turned out to be *board-specific* mechanisms that no
S75 meter could ever see.  The lesson is in
[lessons.md](lessons.md) ("the board you measure is the board you
fix"): before the next round of per-cent hunting, run the new meter on
all three boards.

**The meter that was missing.**  `tools/uibench.mjs` is the S75
stopwatch generalized: it boots any board, waits for it to settle, and
measures a fixed window twice — `idle` (no input) and `menu` (the
board's open-menu / back-to-idle key pair pressed every 2 s, which
repaints the whole screen).  No reference image, so it works on any
firmware.  It reports MIPS, v/wall, fps, halts/s and the display and
dispatch counters per second.  `--settle <s>` instead of the rate
detector whenever the number must be comparable across runs — a boot has
compile-bound stretches that read as "quiet".

The first run of it said what the S75 could not:

| board | idle v/wall | menu v/wall | menu MIPS | menu fps |
|---|---|---|---|---|
| S75 | 22.0 | 15.0 | 31 | 9.9 |
| EL71 | 14.9 | 6.5 | 60 | 12.6 |
| KE800 | n/a (`icount=none`) | 1.0 | **0.8** | **0** |

**KE800 (0056) — it was not slow, it was stuck.**  The LG boards run
`icount=none`, so every mid-TB MMIO access takes the stock
`cpu_io_recompile()`: a JS-exception unwind, `tb_phys_invalidate` of the
running TB (a whole-jump-cache flush, the TB being CF_PCREL), a
retranslation and a new `WebAssembly.Module`.  The io-barrier set from
0014 exists to make that a one-time cost per faulting insn, but at 64
direct-mapped slots on `(pc >> 2)` two hot MMIO insns simply evicted each
other forever.  The board sat at ~800 recompiles/s — and ~800
retranslations, jump-cache flushes and modules per second — which caps it
at about one TB per recompile, i.e. ~1 MIPS, whenever it has anything to
run.  With the set at 4096 × 2 ways on `(pc >> 1)`: menu **0.8–1.8 → 25–43
MIPS, 0 → 5–10 fps**, `ioRecomp` 1/s, `barrierEvict` 0/s.  The idle screen
is ~1 MIPS either way — an idle LG guest is halted, so that number was
never the churn.

**EL71 (0057) — a device smaller than a page.**  A target page shared by
several regions is represented by a subpage container, the TLB fills with
the container, and the container re-enters the flatview on every access
*and* blocks the fill-time dispatch cache.  Every pmb887x device under
1 KB is one (STM `0x30`, GPTU `0x100`, SCU `0x200`, VIC `0x2d8`); the
EL71 firmware polls the STM, so ~22 % of its vCPU was in the
re-dispatch.  The S75's hot register is in the TPU (`0x2000`, whole
pages), which is exactly why nine rounds of S75 profiles never showed a
single `subpage_*` symbol.  Resolving the leaf once at fill time, with
the run of offsets it backs and an offset delta, removed every one of
those symbols from the profile: **EL71 menu v/wall +10 %**, and — the
surprise — **S75 menu MIPS +22 %** and the J2ME stopwatch +9..+35 %.  So
the S75 had small-region traffic too; it was just spread thinly enough
under the dispatch helpers to never rank.

**What this leaves, and how far the EL71 still is.**  With the menu
driven every 700 ms the boards read v/wall 5.5 (S75), 4.0 (EL71) and
— `icount=none` — 52 MIPS / 10 fps (KE800).  A Pixel 8 Pro is ~5× slower
per instruction than the desktop every A/B here runs on (round six), so
those are ~1.1 and ~0.8 on the phone: exactly the user's "S75 mostly real
time, EL71 behind".  **The EL71 needs about +25 % to reach 1.0 on a
phone**, and more for headroom.

The next target is sized and is *one thing*: **the virtual-clock read on
the MMIO path**.  `io_prepare` (7.1 %) and `icount_get` (6.9 %) are the
EL71's top two symbols, and a caller-stack profile
(`PROF_FN=icount_get`) attributes **90 % of `icount_get` to one stack**:

    cpus_get_virtual_clock <- qemu_clock_get_ns <- stm_io_read <-
    int_ld_mmio_beN <- ... <- tcg_qemu_tb_exec

i.e. the firmware's STM poll, ~1.1 M MMIO loads/s, each reading the
virtual clock.  What that read costs, in order of suspicion:
1. `qemu_clock_get_ns(VIRTUAL)` → `cpus_get_virtual_clock()` → an accel
   indirect → `icount_get()`: two calls that are pure indirection once
   `icount_enabled()` is known.  `cpus_get_virtual_clock` is its own
   1.4 % frame.  Free to remove, ~2 %, probably below the meter alone.
2. `icount_get()`'s seqlock read loop — two `smp_rmb()`s, which on wasm
   lower to `atomic.fence` (seq-cst; V8 emits a real barrier on x86).
   **Every writer of `vm_clock_seqlock` in this configuration appears to
   run on the vCPU thread** (0023 moved the idle warp there and
   `sleep=off` keeps the main loop's warp timer out), so a read from that
   thread may not need the loop at all — but that has to be *audited*,
   not assumed, and a torn read would be a timing-dependent heisenbug of
   exactly the kind the lockstep gate is weakest against.
3. `icount_update_locked()` inside the read: it publishes executed
   instructions on every clock read.  A read-only variant
   (`qemu_icount + icount_get_executed(cpu)`, no store, no budget
   decrement) is arithmetically identical for the caller but makes other
   threads' view of `qemu_icount` staler — a fidelity decision, not a
   free one.

After that comes the 240×320 display chain: EL71 and KE800 push 3.3× the
pixels of the S75's 132×176 through a per-byte `ssi_transfer` →
`lcd_transfer` path, and `difTxWord/s` reads 138 k (EL71) and 223 k
(KE800) against the S75's 3.7 k in the same test.  The KE800 now looks
like a normal board and has never been profiled in its working state.

## Update (2026-09-14, round nine: 0055 — a negative result that closes the codegen-volume direction)

**Read this before picking a target.** Round nine's product is mostly
what it ruled out. If you are here to make the stopwatch faster, the
cheap directions are gone and the remaining ones are design changes,
not peepholes — skip to "What is actually left" at the end of this
section.

**How the target was chosen.** Rather than take the biggest symbol, I
asked `tools/profjit.mjs` whether guest time (49 % of the vCPU) is
*concentrated*. It is not: 25 % of jit time in the top 21 functions,
50 % in 272, 90 % needs 2389, top function 1.5 % of total. That rules
out hand-tuning hot TBs and says only uniform per-op overhead can
matter. The most uniform thing in the backend is the inline TLB probe —
`qemu_ld/st` are 37 % of all emitted bytes and the probe runs on every
guest memory access.

**0055.** The emitter wrote `local.set $x; local.get $x` in eight
places (that is what wasm's `local.tee` is for), and the probe also
round-tripped `tlb_addr` through `$scr1` although nothing reads it
after the compare. The probe drops from **seven local ops to three**;
`tcg_out_goto_tb` and `tcg_out_goto_ptr` lose one each at ~17 M TB
entries/s. Net −3 lines.

**Result: mechanism proven, speed flat.** Emitted bytes per TB
530.6 → 511.0 (**−3.7 %**), `modBytes` 194.2 → 189.1 MB (−2.6 %), with
a **0.04 %** run-to-run spread. Every speed meter: flat. It is landed
as a simplification on the byte evidence, not as a speed win, and the
commit message says so.

**Why that is the valuable part.** This is the fourth measurement
saying emitted-byte count is not the lever here, and the first from the
*reducing* direction. The 2026-09-13 hoist removed bytes and cost
+3..+10 %, which left "maybe that was register pressure" open;
`local.tee` only ever *shortens* a live range, so it cannot be that —
and it still buys nothing. Two experiments pointing opposite ways at
the same hypothesis is what closes it. **Do not spend another round on
codegen volume or op count.**

**Three device candidates sized and rejected without building** (all on
the fresh 0054 profile, details in playbook § Remaining 7):
`dif_tx_from_fifo` is the largest single non-guest symbol (5.7 %) but
its loop runs once per call in the display path, so there is nothing to
hoist, and its one cacheable decode keys on a per-word FIFO value;
`dif_mux` is already 0047's table lookup; `dmac_timer_reset`'s "8
channel passes" is seven two-bit-test early-outs plus the real channel.
Sizing on the profile cost minutes instead of hours — do this first.

**Two meter lessons worth more than the commit** (playbook
§ Measurement methodology):
- **`diagall`'s `tbBytes`/`tbGen` is a mechanism meter** with a 0.04 %
  spread. When no timing meter can resolve a codegen change, this
  separates "did nothing" from "did what it said, and that does not
  matter". It never answers "did it help".
- **idlebench `--quick` contradicted itself** across the two orders
  here (+6..8 % one way, +6..12 % the other), and its own same-wasm
  lines showed 12.5 s → 14.3 s (**+14 %**) for one dist between
  back-to-back invocations. Below ~15 % a single quick pair resolves
  nothing. Also: `insns` at fixed wall time is **bimodal** on this boot
  (~2440 M / ~2600 M for both builds) — an n=2 read of +3.5 % went to
  +1.0 % inside ±7.5 % at n=5.
- Method slip to avoid repeating: I called a browser leak from `ps`
  `%CPU`, which is a *lifetime* average — the processes had already
  exited. `top -bn1` for what is running now. Likewise a rising
  `load=` across a long A/B is just the 1-minute average accumulating;
  loadavg 4 on 32 cores is ~12 % utilisation.

**What is actually left.** Both cheap directions are exhausted. The
device chain is a 1–3 % tail with no single removable piece, and the
guest's 49 % is not reachable by codegen volume. The next structural
win must be a design change:
1. **AOT cache** (§ Remaining 5) — ~21 % of the *early* vCPU, so it
   helps boot, not the stopwatch. Large, and with a correctness surface
   today's gates do not cover. It is the best-costed option.
2. **Collapse the per-word DMA request/acknowledge dance**
   (§ Remaining 7) — the ~30 % that is left of the chain, but it
   changes what the guest could observe between words, so it needs a
   lockstep story before a line is written.
On a Pixel (~5× slower per instruction than the desktop Chrome every
A/B here runs on) the boot-vs-steady-state distinction is the whole
game — which argues for (1).

## Update (2026-09-14, round eight: 0054 — the last cheap per-word item, and where the tail ends)

Re-profiled the running stopwatch on 0053 (the previous profile was
0051, two backend changes stale): guest 47.2 %, devices 33.8 %,
tb-lookup 4.3 %, memory 4.2 %, other 5.8 %.

**Landed (0054).**  The display-DMA destination write still paid all of
`memory_region_dispatch_write`'s per-access work — validity, endianness,
ioeventfds, `access_with_adjusted_size`'s split loop — once per word,
for a translation window that had not changed since 0048 installed it.
That decision is a function of the region and the access width only, so
`memory_region_write_direct_ok()` now answers it once per window and
`memory_region_dispatch_write_direct()` runs the tail; the reentrancy
guard and the trace point are kept, both being observable.  Two
profile symbols disappeared outright (`access_with_adjusted_size`,
`memory_access_size`) and ~2.1 points of vCPU moved from device/memory
work to guest code.

**Both wall-clock meters read flat**, and that is the honest headline:
ten alternating stopwatch samples give 0.601 vs 0.593 inside a baseline
spread of 0.536–0.635, and idlebench in both orders shows only the
order bias.  The evidence for 0054 is the profile delta, exactly as for
0051.  Anyone tempted to read the +1.4 % as a win should not.

**Closed by inspection, so nobody spends a build on them** (both were
written down as open in § Remaining 7): a same-batch direct
`return_call` for chained TBs is impossible as described — the chain
slot is patched by `tb_add_jump` at runtime, after the module is
compiled, so the target is unknown at emission; and the per-exit `fidx`
load cannot go, because `w64_batch_evict_oldest()` makes eviction real
even though a boot reads `ensureN 0`.

**Housekeeping**: the submodule was on a detached HEAD — 0053 was
committed off-branch and `wasm-browser-port` still pointed at 0052.
Fast-forwarded (verified 0052 is an ancestor first).  Check
`git -C qemu status -sb` before committing; the branch is what gets
pushed.

**Where this leaves the device chain.**  After 0047–0054 it is a tail of
~1–3 % items, each below what the meters can resolve alone.  The next
structural win is not there: it is the guest's own ~49 %, or the AOT
cache (§ Remaining 5, costed at ~21 % of the early vCPU).  On the Pixel
— ~5× slower per instruction than the desktop Chrome every A/B here
runs on — that distinction is the whole game.

## Update (2026-09-13, round seven: 0053 — Firefox had been broken since the review session)

Firefox on the Pixel stalled at the Siemens logo.  Not 0052: local
Playwright Firefox failed identically on every snapshot back to 0046,
and a six-build bisect pinned it to the prologue cleanup `58bb2742`
from the 2026-09-13 review session (playbook row 0053, lessons.md).
The batch was opened as a side effect of an import the cleanup
removed; ~20 % of TBs then ran from throwaway per-TB modules, which
Firefox's module budget cannot absorb and Chrome does not notice.
Fixed with an explicit open at TB start.  Firefox boots to idle again;
Chrome gates green; perf pair vs 0052: stopwatch flat, boot tIdle −3 %
in both idlebench orders (the throwaway modules were a `Module`
compile per TB).

**Process change**: the Firefox boot is gate rung 7 in the playbook and
in the session checklist.  It existed as a tool since 0019 and was
never in the ladder, which is how nine commits shipped broken.  For a
backend change run rungs 3–7, all of them, before committing.  The
`ffboot` line now prints `temp=` (modules created − closes −
compactions); it must read ~0.

## Update (2026-09-13, round six: 0052 — guest per-TB overhead, and the Pixel's own numbers)

**The Pixel 8 Pro reading exists now** (two `?hud=1` screenshots from
the device, Chrome 153, 9 cores, 8 GB, cross-origin isolated): a J2ME
game at **13.9 MIPS, v/wall 0.71, 29 fps, 416 halts/s**, and the
stopwatch at **10.6–17.8 MIPS, v/wall 1.15 over a 10 s window** while
paying back 8.6 s of lag (0.14 lifetime).  The desktop Chrome that
every A/B here runs on does the same stopwatch at ~73 MIPS / 0.58, so
the phone is ~5× slower per instruction, not the ~35 % the Liftoff-only
experiment suggested.  Every percent measured here is worth the same
percent on the phone, but real time on the phone needs roughly 1.4×
on the game and more on the stopwatch — a structural cut, not a
sequence of 3 % ones.

**0052** (playbook row): the per-TB structure sized (17 M TB entries/s,
4.2 insns/TB, 1.5 labels/TB, no backward branch in the firmware) and
its dispatch loop replaced by nested forward blocks — the first
JIT-side change since 0046 that moved the meter: stopwatch +3.5 % with
every new leg above every old one, JIT share of the profile down and
the device share flat, boot flat (bootcheck; idlebench both orders −5 % / +3 %, the order bias).
Gates: lockstep 250e6 identical, op-suite 1156/1156.  Left on the
per-TB path: the chain jump's table call (a direct `return_call` for
same-batch targets is the next small one) and the icount decrement
(the timing model).  The recipe: `EXTRA_Q="env=W64_TBSTATS=1"` makes
the stopwatch's `insns/tb` real; native `-d op_opt -D file` gives the
label/branch shape per TB.

## Update (2026-09-13, round five: 0051 — "keep looking")

Fresh stopwatch profile of 0050, three small cuts on the per-word
display chain (playbook row 0051): the `BUS()` checked cast still in
`ssi_transfer` (one per LCD byte), the DIF's six-pin rebuild skipped
when its inputs match the previous pass (it runs twice per word), and
the FIFO's modulo per push/pop.  Profile: "other" 1416 → 1056 ms of
20.3 s, the cast gone; the stopwatch meter reads +4 % on a quiet pair,
inside its drift.  A fourth change — the same input cache on
`dif_trigger_dma` — blanked the Siemens displays (self re-entry through
the DMAC; the native suite caught it) and, once guarded, never hit; it
is not in.  Gates green (native 4/4, lockstep, bootcheck).  What is left
of the chain is ten pieces of 1–5 % each with no single call to
remove (playbook § Remaining 7); the next real lever is structural
(collapse the per-word request/acknowledge dance into one pass per
burst) or on the guest side (per-TB overhead, IRQ entry/exit ~3.5 %).
The Pixel reading with `?hud=1` is still the missing datum.

## Update (2026-09-13, round four: 0050 — "still below real time on a Pixel 8 Pro")

What the phone is short of was measured on the desktop, because the
container has no `/dev/kvm` and an unaccelerated Android emulator says
nothing about speed.  Findings (details in the playbook row 0050):

- **One thread is the whole budget.**  With the J2ME stopwatch running,
  the vCPU worker is at 98 % and every other thread under 4 %; the S75
  boot reaches idle at 40–41 s with Chrome on 32 cores or pinned to
  one.  A Pixel 8 Pro therefore runs this on its single Cortex-X3 at
  whatever clock it sustains, and any number it reads is the desktop's
  single-thread number scaled by that core.  Thread placement, core
  count and contention are not the problem; per-instruction cost is.
- **V8's tier is not the gap.**  TurboFan-only (`--no-liftoff`) gains
  3 % on the stopwatch and doubles the boot (75 s); Liftoff-only
  (`--liftoff-only`, the baseline tier a phone's slower background
  compile would leave more code in) costs +35 % on the boot (54 s) and
  breaks the stopwatch's keypad navigation (dropped presses).  So the
  worst case for a phone that tiers up late is ~1.35×, not the 2–3× the
  user sees.  (`--no-wasm-tier-up` does nothing in Chrome 153; verify a
  V8 flag with `%IsLiftoffFunction` under `--allow-natives-syntax`
  before trusting an A/B — the first "Liftoff" sample of this round was
  the default tier.)
- **The device can now report its own number**: `?hud=1` shows MIPS,
  `v/wall` (1.0 = real time), the real-time-cap lag, fps, halts/s, the
  page's paint cost and the core/memory/UA facts; a tap copies the last
  60 s as JSON.  The next step for the phone is that reading on the
  Pixel, in the idle screen, in a menu and in the stopwatch — it says
  whether the phone sits at the expected ~0.6–0.8× of this host (per-
  core speed, thermal throttling) or far below it (something
  Android-specific: memory64 bounds checks without a trap handler,
  a wasm memory limit, background-tab throttling).
- **0050 itself** came from the fresh stopwatch profile: the 16 KB
  stack buffer `-ftrivial-auto-var-init=zero` cleared on every one-word
  DMA transfer (7.5 % of the vCPU) and two checked QOM casts per LCD
  byte (1.7 %).  Stopwatch, four pairs both orders: 0.541–0.547 vs
  0.458–0.533, ahead in every pair, means 0.544 vs 0.496 (**+10 %**),
  and the new build's readings are five times tighter; boot flat (the second-listed leg reads 2–4 % faster whichever
  build it is); gates green.  The remaining chain is ~30 % in ten small pieces (playbook
  § Remaining 7); the guest's own 46 % is spread over thousands of TBs
  (half the JIT time in the top 367 of 4498 functions), so it is per-TB
  overhead, not any TB's code quality.

## Update (2026-09-13, third perf session, round three: 0049 — the ke800 stall)

The "pre-existing ke800 first-page stall" below was a **GPTU timer storm
starving the vCPU**, not a firmware wait.  The LG firmware chains T1A..D
into one 32-bit timer at 26 MHz and the model re-armed its QEMU timer at
every 8-bit overflow of the free-running byte: ~100 k main-loop
callbacks per second, each holding the BQL and each ~10 µs in wasm (JS
clock imports).  The main-loop worker read 100 % busy, the vCPU worker
94 % in `futex_wait`, ~40 k guest instructions per second.  0049 steps
the T0/T1 chains lazily (`gptu_t01_add_ticks` already carries overflow
counts; the sync stops only at overflows that reload other timers) and
arms the QEMU timer for the next *observable* overflow — a service
request or a T2 trigger.  ke800 booted alone now reaches its idle
screen (`idlebench --board ke800`: tIdle ~65–77 s cold, insns@idle
~1.8–2.0 G; native 31 s; on 0048 the same run crawled to 1.5 G in
377 s and never idled), the **S75 boot is 4–5 % faster in both orders**
(the storm taxed the icount boot as well), the native four-board suite,
op-suite, lockstep and bootcheck are green, and the LG board is now in
the boot benchmark with its own reference image and baseline file.  See the playbook row and
§ Remaining 8 (closed), and lessons.md ("a stalled guest may be a
starved one").

## Update (2026-09-13, third perf session, round two: 0048)

The profile after 0047 (guest 39 %, devices 33 %, memory API 10 %) put
the DMAC's per-word memory-API walk first — one 4-byte word per request,
each translated twice through the flatview — and the VIC second: the
DIF's TX request line is masked at the VIC but toggles twice per word,
and every toggle re-drove the CPU's IRQ line, which is a `cpu_interrupt`
that forces the TB loop out.  0048 gives each DMAC channel a translated
window keyed on a new `memory_region_topology_gen()` (the window is the
flat range, because the firmware walks the DIF's 16 KB FIFO window with
an incrementing destination — the first cut sized it to one access and
refilled on every word, which the `dmacXlatFill` counter showed at once),
and the VIC drives the CPU lines only on a level change (0027's
`cpsr_write_check_irq` re-checks a pending interrupt on unmask, so
nothing depended on the repeats).  Stopwatch **0.46 → 0.50** over two
alternating pairs (+5..+10 %, host load moving during the runs); boot:
see the playbook row.  Gates green, lockstep against the pre-0047 native
oracle.

**A pre-existing stall found on the way, not caused by this session's
changes:** `bootcheck --flash ke800` (the LG board booted as the *first*
page of a browser) stops at the KE800 logo at ~570–590 M instructions
with 4 framebuffer updates and never moves, on 0046, 0047 and 0048 alike
(3 of 3 single-board runs); as the third page of the s75/el71/ke800
sequence the same build reaches ~1.9 G (2 of 3 today).  The LG boards
run `icount=none`, so the firmware sees real time, and a cold first page
compiles slower — a timing-dependent stall that the gate's progress
threshold does not catch (it reports PASS at 590 M).  Open: reproduce
on the deployed page from a cold cache, tighten the ke800 threshold, and
find what the firmware waits for (the buffered stderr shows only the
ONLINE key sequence).

## Update (2026-09-13, third perf session: 0047)

**Open item 2 (J2ME throughput) moved 0.35 → 0.48–0.53×** from the
device side, with no boot change.  The method that found it: profile the
*running app*, not the boot (`tools/stopwatch.mjs --devtools 9560 --hold
120`, then `PROF_ATTACH=9560 node tools/wprof2.mjs 30`).  That profile
said devices 46 % of the vCPU, guest code 30 %, and its top symbol was
`dif_update_mux` at 12.7 %: the DIF v2 rebuilt its mux tables on every
mux-register write, and the firmware writes those per LCD command.
0047 makes the rebuild lazy and the builder linear in the 32 output
bits, stops the DMAC re-arming its timer from inside its own callback
on every burst acknowledgement, and clears only the raised request bit
per acknowledgement (each no-op clear re-ran the DIF event handler).
Gates green including lockstep against the pre-change native oracle.

What is left on that path is the per-word chain itself — the display
DMA is one 4-byte word per request, ~500 k/s — written up as the
playbook's § Remaining 7 with the candidate trims.  The counters that
size it are on the stopwatch's new `per-s` line.

## Update (2026-09-13, second perf session: 0046)

**Open item 1 is built and landed** as 0046: a per-TB inline next-TB
cache on every ARM goto_ptr exit.  Not the design item 1 described —
an hflags generation is useless here because hflags change 88 k times
per second (mode switches), and the obvious fix, comparing every key
word inline, measured **+2..+4 % slower** at an 84 % hit rate.  What
landed compares only what can differ at the exit (pc, a generation that
moves on jump-cache invalidations, and thumb after a `bx`); hflags and
condexec are stamped statically by the translator and checked once when
the slot is filled.  Verified with a cross-check mode over a full boot
(101 M would-be hits, 0 mismatches).

The numbers, and the lesson in them: **~80 % of the helper calls are
gone and the boot milestones did not move** (`--quick --runs 2`, both
orders, flat inside a ±5 % positional bias that this run measured
directly), while the **J2ME stopwatch went 0.33 → 0.35 (+7..+9 %, four
alternating samples)**.  The profile's "12.6 % of the vCPU in the
lookup path" was real CPU time but not boot wall time that skipping the
helper could recover.  Open item 2 (J2ME throughput) is now ~0.35×.

Also found: **0044 was never active.**  Its `CONFIG_TARGET_ARM` guard is
a macro no build defines (accel/tcg is target-independent; `TARGET_ARM`
is poisoned there), so the devirtualised `arm_get_tb_cpu_state` call
fell back to the ops call from the day it landed.  Switched on in 0046
under `CONFIG_TCG_WASM64`; on its own it is flat (−1..+2 %).  The
−2..−4 % credited to 0044 belonged to the rest of the 0043–0045 stack.

## Update (2026-09-13, perf session)

**The cost model this document was ranked on was wrong, and the ranking
changes with it.**  A wprof2 profile of the vCPU worker (the numbers are
in the playbook's § Remaining 0c) says translation is **~3–4 %** of the
vCPU, not the ~6.7 s per boot that "176k TBs × 38 µs" implies, and that
the two real cost centres are the **TB lookup path** (12.6 % mid-boot)
and **`Module`**, the browser's wasm compile (14.1 % early, 7.7 % mid).
Emitted code volume — open item 1 below, the previous "biggest lever
left" — is now closed as a lever by a third measurement (see below).

**No performance change landed.**  Four candidates were built and
measured; all four are flat or worse, and each has a REJECTED row with
its numbers.  One correctness fix landed:

- `bf0b67d4` **batcher `SOURCE-CORRUPT` fixed** (open item 4, closed):
  `encode_search()`'s overflow path abandons a TB without advancing
  `code_gen_ptr`, so `tcg_tb_alloc()` carves `TranslationBlock`s out of
  the bytes the open batch still points at.  Root-caused from the
  forensic dump (seven TB structs at the 192-byte struct stride), fixed
  by withdrawing the staged member, and confirmed with a positive
  control: 5 dropped batches per 60 s → 0.

Measured and rejected: the **wide TB jump-cache entry** (flat), the
inline **TLB-probe hoist** (+3..+10 % slower — fewer emitted bytes
*and* fewer executed ops per access, still worse), the jump cache at
**8k entries** (no gain), and **`W64_NOCLOSEEXEC`** (12–17 % slower —
closing the batch on its first executing member is what makes
speculation pay, and module count is bounded by "how often a
not-yet-compiled TB runs", not by `W64_BATCH_N`).

**Read the playbook's "phantom win" note before trusting any A/B in
this repo.**  The jump-cache entry appeared to win −4..−6 % across four
invocations in both orders and was committed, then measured flat
against a clean baseline and dropped.  The session's baseline dist had
been built by `ninja-fast.sh` over a `build/qemu-wasm64/` left
mid-state by the previous session and ran ~5 % slow; both-orders
agreement cancels position, not a bad baseline.  Keep/revert decisions
now want a pristine `git worktree` build per revision and `--runs 4`.
That also means **numbers in this document from earlier sessions carry
the same risk** wherever the baseline came from an incremental build
over an inherited tree.

Also new: `tools/diagall.mjs` dumps every `wasm_memstat` counter by
name, and the wasm64 leg of the op-suite (`tools/tcgisa64.mjs`) is
**broken on the pinned rev too** — it dies with `null function` in an
Asyncify rewind before printing any TAP, on `dist-jit` and
`dist-jit-base` alike.  That is a pre-existing hole in the gate for the
shipping backend; lockstep and bootcheck are covering it meanwhile.

## Update (2026-09-13)

The review-fix batch landed (`doc/wasm-port-review.md` §1 status), plus
the W-12 speculation fix (EL71 second-page `Prefetch_Abort`, a real
firmware-visible bug) and the prologue cleanup, which measured **flat**
(quick pairs −2..−7 %, full pair +1..+3 %, inside spread). Lesson for
open item 1 below: emitted-byte counts overstate what the per-TB
scaffolding cost at run time; the compile-bound early phase is not
moved by ~12 % fewer bytes per TB. Boot numbers are unchanged: t0.5G
21.1–21.8 s, t1.3G 28.4–28.8 s, tIdle 29.5 s (`rt=off`, quiet host).

## Status (2026-09-12, after patches 0042–0045)

Every board, LG included, runs on the wasm64 backend (`dist-jit`) by
default. `/dist-jit` S75v40lg1 boot on a quiet host, `rt=off`,
interleaved `--runs 4`: window **13.7 s**, t0.5G **21.4 s**, t0.75G
**26.4 s**, t1.3G **29.0 s**; under the shipping `rt=banked` cap the
same boot reaches t1.3G at **~39 s** (see below). Gates green: op-suite
1156/1156 byte-identical, native suite 4/4, lockstep 250e6 serial+regs
identical, `bootcheck --dist dist-jit` s75/el71/ke800.

Where a `/dist-jit` boot's time goes (host-time counters): the first
~0.5 G instructions are compile-bound cold code — ~20 MIPS, 21 s of a
29 s `rt=off` boot; the browser compiles **197 MB of wasm per boot**
over 35k modules (94 MB of unique TB bodies at 563 B per 4.85-insn TB,
the rest compaction recompiling them; `qemu_ld`/`qemu_st` are 37 % of
emitted bytes at ~85 B each). Translation is ~38 µs per TB × 176k,
module compile ~33 µs fixed + 5.5 µs/KB. After t0.75G the boot is
virtual-time-bound: it consumes ~42 s of virtual time of which ~31.5 s
is idle warp on millisecond device timers (~18 s of it inside the
display-DMA stretch), which the real-time cap pays out as real sleep.
`tcg_qemu_tb_exec`'s 15–18 % profile self-time is misattributed guest
code (the dispatcher is entered 1.2 M times per boot, one iteration
each).

The J2ME stopwatch meter (`tools/stopwatch.mjs`): vratio **0.29–0.33**
(41 MIPS; 1.0 = real time, native does 150+ MIPS paced by the cap).
Left in that state: devices 33 % (DIF FIFO word loop, DMAC per-word
MMIO writes, SRB events), guest code 33 %, `helper_lookup_tb_ptr` 12 %
(2.9 M lookups/s — the JVM's indirect dispatch), MMIO 6 %.

MMIO dispatch is at native parity since 0018 (tcgbench mmiopoll 202
ns/access on `/dist-jit`, 252 on `/dist`, 223 native).

## Open items (ranked; details and meters in the playbook's § Remaining)

1. **The TB lookup path — DONE (0046, 2026-09-13)**, with a result that
   re-ranks the list: serving ~80 % of the 130 M lookups per boot inline
   moved the J2ME stopwatch +7..+9 % and the boot milestones **not at
   all**.  The lookup helper was never a boot lever; it was a
   throughput lever for the one workload that is lookup-bound.  What is
   left of it (26 M helper calls per boot, the alternating-target
   exits) is a stopwatch item, not a boot item — see the playbook's
   § Remaining 6.  Meters: `tools/stopwatch.mjs` (alternate builds, 4
   samples), `tools/diagall.mjs` `lcCall`/`lcFill`/`keyGen`, and
   `W64_LC_VERIFY=1` (`lcVhit`/`lcVbad`) for any change to the key.

1b. **Emitted code volume — closed as a lever.** Three measurements now
   agree it is not what the early phase is bound by: the prologue
   cleanup (−12 % bytes/TB, flat), compaction off (−49 % compiled bytes,
   a wash) and this session's TLB-probe hoist (fewer bytes *and* fewer
   executed ops, +3..+10 % slower).  The AOT cache is still open but is
   now costed at ~21 % of the early-phase vCPU, not "the whole 197 MB" —
   see the playbook's § Remaining 5 before committing to it.
2. **J2ME throughput** (stopwatch ~0.5× after 0047 → 1.0× needs ~2× on
   that workload): the DIF/DMAC per-word path (playbook § Remaining 7)
   and the guest's own ~30 %.
   2026-09-13 (third session): **0.35 → 0.48–0.53× (60–67 MIPS)** from
   0047 — the DIF mux-table rebuild per register write, the DMAC timer
   re-arm per burst and the four-bit DMA acknowledgement clears; then
   **→ ~0.50×** from 0048 (DMAC translation windows, VIC line cache).
   2026-09-13 (second session): **0.33 → 0.35× (43.7–44.7 MIPS)** from
   0046, the inline lookup cache; the helper share of that profile
   (12 %) is now mostly gone.  Earlier that day: still ~0.30× (37–39 MIPS). The wide jump-cache entry was
   flat here too (8 alternating samples, means 0.3005 vs 0.3005) — the
   meter agreed with the boot before the boot's own baseline was found
   to be bad, which is worth remembering: two meters agreeing on "flat"
   was the true signal. The 33 % sitting in the DIF FIFO word loop, the
   DMAC per-word MMIO writes and the SRB events is where its ~3× has to
   come from, not from engine-side lookup work. Beware that this meter
   drifts with host load: four consecutive samples fell 0.313 → 0.281
   as loadavg went 1.97 → 2.77, which alone reads as a 4 % regression.
3. **The idle-warp share of the boot is a fidelity question**, not a
   performance one: whether ~31.5 s of idle warp is what a real S75
   takes needs a measurement against hardware before any device timer
   period is touched. Engine work can only move the first ~0.75 G
   instructions (~27 of the 39 s a user waits).
4. **wasm64 batcher `SOURCE-CORRUPT` — CLOSED** (`bf0b67d4`). It was
   `encode_search()`'s overflow path, not `w64_speculate()`. The
   forensic dump was the whole story: seven `TranslationBlock` structs
   written over one staged member at the 192-byte struct stride.
5. **Native has no real-time cap** (0032 defaults off outside
   emscripten): native and web agree on the timing model and disagree
   on pacing. Aligning them is a one-line default that takes a native
   S75 boot from ~15 s to ~40 s and needs `tests/run.mjs` timeouts
   revisited first. **Reviewed 2026-09-13 and deliberately not done**:
   it is a fidelity change that makes every native run 2.7× slower, so
   it costs the fastest gate in the ladder (rung 5) and buys the shipped
   web build nothing. `QEMU_ICOUNT_RTCAP=banked` already reaches it for
   anyone who wants a paced native run; flip the default only alongside
   the hardware reference measurement item 3 needs.
6. **Timer storms / main-loop wakeups** — smaller, and now sized: the
   clock/timer path is ~2.5 % of the vCPU mid-boot (`icount_get` 1.1 %,
   `tpu_update_timer` 0.5 %, `timer_mod_ns` 0.4 %,
   `qemu_clock_deadline_ns_all` 0.3 %, `cpus_get_virtual_clock` 0.4 %)
   at ~37k `timer_mod` per second. Halving it is below the ±3 % noise
   floor of a single pair, so it only lands bundled with something
   measurable.  **Except on the LG board** (2026-09-13, 0049): without
   icount the main loop runs every device timer on wall time, and the
   GPTU's per-byte-overflow deadline was a 100 kHz storm that starved
   the vCPU outright.  The `gptuTimer` counter (`diagall.mjs`,
   stopwatch `per-s`) is the meter for the GPTU; the TPU/CAPCOM/STM
   models have not been audited for the same "deadline = next hardware
   tick" pattern.

## Constraints (what still binds)

- **The timing model is fixed**: stock `-icount shift=3,sleep=off` +
  the real-time cap on wasm; correctness must never depend on execution
  speed (lockstep gates enforce it). Do not "fix" pacing by pinning
  clock frequencies.
- **The firmware busy-polls** (~50–100k MMIO dispatches/s in poll
  phases) and its TBs are 3–4 insns: per-access and per-wake costs are
  the only ones that scale; any per-access condition on a hot path must
  pay for itself at that rate.
- **qemu-core changes shift all backends**: A/B on both dists,
  correctness matrix per landing (op-suite ×3, native suite ×4,
  lockstep windows; full 2.5e9 gate at workstream close), plus the
  three-fullflash browser gate.
- **Quote boot improvements against `rt=banked` as well as `rt=off`**,
  or they read larger than a user will see.
- emscripten traps that don't compose: wasm-EH longjmp × ASYNCIFY,
  `poll()` never sleeps, condvar waits are whole-ms, proxied syscalls
  are ~1 ms — [lessons.md](lessons.md) § Emscripten runtime.

## Non-goals

- More emitter/interpreter micro-optimization as the primary lever —
  the backend holds a ~10× compute reserve the boot cannot spend on
  cold code.
- Changing the timing model or any device's semantics for speed.
- MTTCG, in-wasm JIT APIs, or a per-TB-instance dispatch design
  (measured ceilings — [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md) §1, §7).
