# Performance hand-off: the qemu-core device-path workstream

Status (2026-09-11, later): **0019 landed on the wasm64 backend** —
compile-once batching with speculative successor translation and batch
compaction: idlebench tIdle 76 → 65 s (−15 %) on `/dist-jit`, and the
Firefox out-of-memory (its ~16k live-module executable budget) is fixed.
Details: playbook landed table + sessions doc (2026-09-11, 0019).  The
device-path status below is unchanged.

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
