 Dropped patches

## 0004 — wasm: skip io-recompile longjmp storm

Dropped 2026-09-07: **boot regression.** Skipping `cpu_io_recompile()`
removed more than the (very real) ~150 µs JS-longjmp cost — it changed
virtual-clock *visibility and accumulation* for mid-TB MMIO, and the
boot-ROM's GPTU SRC7 poll (`pmb8876_brom_r16` @ `0x400118c`) then read
the timer as not-yet-expired, returning 0 where the ROM requires 1.
Boot aborts within seconds with `>>EXIT<< FILE: flash ExitCode: 0x0552`.
Full analysis: `../doc/early-crash-postmortem.md` (bisect, divergence
point, mechanism).

**Superseded 2026-09-07 (same day, later session) by
`../0004-wasm-io-recompile-mmio-boundary-accounting.patch`** — kept in
`patches/` and part of the build again.  The rework does not skip the
rewind's *semantics*, only its repeated cost: on emscripten the mid-TB
MMIO accounting is performed at exactly the clock the stock rewind
produces (io-access boundary of the current TB, stock-equivalent
per-TB accumulation including the lost partial-TB cycles), the stock
rewind is kept for ROM-device (flash command) accesses — the boot ROM's
flash program/verify handshake aborts without it — and `QEMU_IO_REWIND=1`
(page: `?iorewind=1`) forces the stock behavior everywhere.  Verified:
boots past `0x400118c` with SRR set at the same virtual instant as the
stock build, splash ~3× earlier in wall time, 4–17M insns/s sustained
(stock rewind path: 0.2–5M), no `FILE: flash` exit.  Investigation
notes (what else was tried: TB splitting, mid-TB crediting, pacing,
DSP-core locking) are in `../doc/early-crash-postmortem.md` §9.

Acceptance test: boots past `0x400118c` with SRR set at the first poll,
reaches the L1 phase, no `FILE: flash` exit.
