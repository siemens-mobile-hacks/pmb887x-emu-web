# Performance hand-off

Where the work stands, what is open, and what binds. Patch numbers are
commits on the `qemu/` submodule branch ([upstream-branch.md](upstream-branch.md));
the per-patch numbers are in the playbook's "What landed" table, the
method in [optimization-playbook.md](optimization-playbook.md), the
hard-won conclusions in [lessons.md](lessons.md).

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

1. **Emitted code volume** — the biggest engine lever left. Candidates:
   shrink the inline TLB probe (hoist `env + fast_ofs` into a per-TB
   local), the AOT cache (persist translated batches in Cache
   API/IndexedDB keyed by flash hash — removes the whole 197 MB on a
   second boot). Meter: 0042 counters + `idlebench --quick`
   t0.25G/t0.5G. Turning compaction off is measured neutral (do not
   reopen without compacting off the vCPU thread).
2. **J2ME throughput** (stopwatch 0.33× → 1.0× needs ~3× on that
   workload): the DIF/DMAC per-word path and the TB-lookup path.
3. **The idle-warp share of the boot is a fidelity question**, not a
   performance one: whether ~31.5 s of idle warp is what a real S75
   takes needs a measurement against hardware before any device timer
   period is touched. Engine work can only move the first ~0.75 G
   instructions (~27 of the 39 s a user waits).
4. **wasm64 batcher `SOURCE-CORRUPT`** — seen once (a staged member's
   body changed under an open batch; correctness safe, the batch is
   dropped). Leading hypothesis: a code-buffer position handed out twice
   around `w64_speculate()`'s `tb_gen_code()` into an open batch. Needs
   the `/w64bad-<n>.bin` forensic dump pulled out of MEMFS.
5. **Native has no real-time cap** (0032 defaults off outside
   emscripten): native and web agree on the timing model and disagree
   on pacing. Aligning them is a one-line default that takes a native
   S75 boot from ~15 s to ~40 s and needs `tests/run.mjs` timeouts
   revisited first.
6. **Timer storms / main-loop wakeups** — smaller: the main loop's own
   realtime timers (gui refresh, DSP AFE 1 ms tick, PCM refill) and
   `qemu_notify_event` wakes; `TB_EXIT_REQUESTED` rounds ~25k/s early.

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
