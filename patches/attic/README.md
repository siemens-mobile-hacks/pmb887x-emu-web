# Dropped patches

## 0004 — wasm: skip io-recompile longjmp storm

Dropped 2026-09-07: **boot regression.** Skipping `cpu_io_recompile()`
removed more than the (very real) ~150 µs JS-longjmp cost — it changed
virtual-clock *visibility and accumulation* for mid-TB MMIO, and the
boot-ROM's GPTU SRC7 poll (`pmb8876_brom_r16` @ `0x400118c`) then read
the timer as not-yet-expired, returning 0 where the ROM requires 1.
Boot aborts within seconds with `>>EXIT<< FILE: flash ExitCode: 0x0552`.
Full analysis: `../doc/early-crash-postmortem.md` (bisect, divergence
point, mechanism).

If the performance work wants the ~4× back, the rework must be
clock-neutral, e.g.:

- keep the recompile but stop re-entering the unsplit TB (fix TB
  chaining after the rewind), or
- account the TB's icount2 *before* execution and credit back the
  un-executed tail from the `retaddr` insn offset on rewind — with a
  determinism argument per device that a too-far clock at the MMIO
  callback is safe (the GPTU SRC7 poll says it is not today).

Acceptance test: boots past `0x400118c` with SRR set at the first poll,
reaches the L1 phase, no `FILE: flash` exit.
