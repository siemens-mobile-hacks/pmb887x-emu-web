 Dropped patches

## Stale copies from the previous pin (`*-old-2735ce4e.patch`)

`0002-old-2735ce4e.patch`, `0004-old-2735ce4e.patch` and
`0006-old-2735ce4e.patch` are pre-switch revisions of the patches
below, captured against the previous qemu pin (`2735ce4e`, before the
2026-09-07 move to alula's `dsp-stuff` @ `b31b98fe1e` — see
`tests/RESULTS-switch.md`). Kept for archaeology only; the current
patches/ series is authoritative.

## 0006 — wasm: run icount2 at the fixed hardware frequency (104 MHz)

Dropped 2026-09-08: **superseded by a stock-icount boot configuration.**
No wasm-specific virtual-clock patch is needed at all: `-icount
shift=3,sleep=off` (plain upstream QEMU icount) gives virtual time that
is strictly instruction-proportional (8 ns per guest insn, ≈ the phones'
104 MHz ARM9 cycle budget) and — the crucial part — `sleep=off` also
makes idle deterministic (virtual time jumps to the next timer deadline
instead of the vCPU parking in realtime while the clock catches up).
With the default `sleep=on`, every guest idle window burns wall time at
1× while execution runs at ~0.05×, and the L1↔DSP handshake — half of
which lives on host-paced timers (QEMU_CLOCK_HOST, dsp.c) — desyncs and
starves exactly like the adaptive icount2 controller did (`shift=3`
and `shift=4` both die with `>>EXIT<< FILE: l1bbcsg`; `shift=3,sleep=off`
boots — verified in the browser *and* natively, `tools/bootmatrix.mjs`
+ `tests/run.mjs`).

The icount2 code path stays available for experiments via
`?icount=precise-clocks=on` (0002's emscripten `ICOUNT2_MIN_FREQUENCY`
branch still applies), it just is not the default anywhere anymore.
LG firmware additionally needs no icount at all (`?icount=none`, now
the LG default — it boots on the plain realtime clock).

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

## 0015 — wasm: diagnostics counters (txn-failed, tb-gen/flush, io-rewind, lookup-tb)

Dropped 2026-09-09 after patch-isolation benchmarking (method: see
doc/optimization-playbook.md § "Patch-isolation testing"; harness:
scripts/switch-test.sh + tools/bootbench.mjs, S75, 110 s runs).

Empirically **not required and not performance-relevant**:

- boot: no `>>EXIT<<`, v and LCD updates advance normally (serialwatch);
- window (v=2→7 wall secs, primary metric): 25.8 / 25.9 / 25.8 s
  (one 31.8 s outlier under host load) vs full-stack baseline
  25.1–28.5 s over 5 runs — indistinguishable;
- nothing consumes its counters: `tools/memstat.mjs` reads the 0012-era
  `wasm_memstat(0..4)` counters (ldHelp/stHelp/ioLd/ioSt/fill), which
  stay; the 0015 additions (txnF/tbGen/tbFlush/ioRewind readout via the
  enum tail, lookupTB) had no reader;
- the patch also carried a whitespace-only junk hunk in tcg/tci.c (three
  blank lines — a capture-patch.sh artifact).

The cold-path counter *infrastructure* (include/qemu/wasm-diag.h, the
wasm_diag_stat array, `_wasm_memstat` export) comes from 0012/0014 and
remains; future ad-hoc counters can be added as un-captured local edits
or a fresh patch when a session needs them.

## goto-ptr-inline-cache.diff — wasm64: per-TB inline cache for lookup_and_goto_ptr (2026-09-11, REJECTED: flat)

The emitted `lookup_and_goto_ptr` computed the ARM lookup key inline
(regs[15], hflags.flags, hflags.flags2 with THUMB/CONDEXEC/VECLEN/
VECSTRIDE/VFPEN deposited; layout supplied by `w64_target_gp_layout()`
in target/arm) and tail-called a one-entry per-TB cache of the last
resolution (guards: CF_INVALID on the cached TB, descriptor fidx, the
lockstep brake, SS_ACTIVE).  Correct (op-suite 1156/1156, lockstep
250e6 clean, boots) and 80 % hits (57.8M hits / 14.9M misses per boot),
but idlebench `--quick` in both orders vs the session base gave t1.3G
ratios 0.824/0.864 with it against 0.823/0.844 without: the inline key
computation (~10 loads) costs about what the helper's jump-cache probe
saves.  Applies on top of 0030 (`git apply` after stripping the header).
