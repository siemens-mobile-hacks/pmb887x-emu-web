# Performance hand-off

Where the work stands, what is open, and what binds. Patch numbers are
commits on the `qemu/` submodule branch ([upstream-branch.md](upstream-branch.md));
the per-patch numbers are in the playbook's "What landed" table, the
method in [optimization-playbook.md](optimization-playbook.md), the
hard-won conclusions in [lessons.md](lessons.md).

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

1. **The TB lookup path** — the biggest *measured* lever left, ~12.6 %
   of the vCPU mid-boot: 153.4 M lookups per boot,
   one per ~12 guest instructions, because every `bx lr` / `pop {pc}` /
   `ldr pc` and (since 0027) every `msr CPSR_*` goes through
   `helper_lookup_tb_ptr`.  The concrete next step is the one the
   2026-09-11 rejection named and nobody built: **an hflags-generation
   counter in `env`, so the emitted `goto_ptr` can carry a per-TB inline
   cache keyed on `(pc, gen)`** — two loads and two compares instead of
   an imported helper that recomputes the whole ARM key.  The earlier
   inline-cache attempt failed precisely because it computed that key
   inline at 80 % hit rate.  Meter: `idlebench --quick` t0.5G +
   `tools/diagall.mjs` lookup/jc/qht counters.

1b. **Emitted code volume — closed as a lever.** Three measurements now
   agree it is not what the early phase is bound by: the prologue
   cleanup (−12 % bytes/TB, flat), compaction off (−49 % compiled bytes,
   a wash) and this session's TLB-probe hoist (fewer bytes *and* fewer
   executed ops, +3..+10 % slower).  The AOT cache is still open but is
   now costed at ~21 % of the early-phase vCPU, not "the whole 197 MB" —
   see the playbook's § Remaining 5 before committing to it.
2. **J2ME throughput** (stopwatch ~0.30× → 1.0× needs ~3× on that
   workload): the DIF/DMAC per-word path and the TB-lookup path.
   2026-09-13: still ~0.30× (37–39 MIPS). The wide jump-cache entry was
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
   measurable.

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
