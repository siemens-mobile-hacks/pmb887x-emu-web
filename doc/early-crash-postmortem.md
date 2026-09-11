# WASM early-boot crash — regression post-mortem (RESOLVED)

Committed to answer: *"the emulator was getting much further in the boot
process in dfb4e21c018e641cbcb64206944064db038b0874; in the next commit
(ea28492) it started crashing before anything is drawn."*

Status: **RESOLVED — the storm is fixed properly.** The early `FILE: flash
ExitCode 0x0552` abort is gone (0004 io-accounting rework); the follow-on
`l1bbcsg` L1 timeout was separately fixed by the timing model — first by
the interim fixed-104 MHz patch 0006, since dropped to `patches/attic/`
in favor of stock icount `shift=3,sleep=off` (see
[livelock-postmortem.md](livelock-postmortem.md) §4); the build boots
through both crash points 2.5–12× faster per wall second than the
stock rewind path (4–17M insns/s sustained at the time; the current
series runs far faster — see README.md). What follows is the
original investigation record, plus §9 for the 0004 rework.

## 1. Symptom (reproduced at HEAD 4294229)

Headless run (`WEB_DIST_DIR=dist node serve.mjs`, playwright picks
`s75_working20060710172101.bin`, startup `ONLINE`, 20 s+):

| build | framebuffer | serial tail |
|---|---|---|
| dfb4e21 state (patches 0001+0002) | **259 fb updates, 9284 lit px** — splash draws, boot progresses | `>>EXIT<< ExitCode: 0x0000 FILE: l1bbcsg … CepId: 0x3401` after ~20 s (the known slow-boot L1 timeout, see livelock-postmortem.md) |
| ea28492 state (patches 0001–0004, current `dist/`) | **3 fb updates, 0 lit px** — nothing ever drawn | `>>EXIT<< ExitCode: 0x0552 FILE: flash Checksum: 0xD00E ExitType: Exit CPSR: 0x6000011F CepId: 0xFFFF ExitString: 1362:Prog:00000032:4` within seconds |

The `FILE: flash` exit is a *boot-ROM/bootloader-stage* abort — far
earlier than the L1↔DSP handshake timeout of the previous state.

Repro scripts: `tools/smoke.mjs`, `tools/exectrace.mjs` (added during
this session; boots + dumps `/serial.log` and qemu `-d exec` traces via
MEMFS).

## 2. Which patch regressed it (full bisect)

The qemu wasm64 source tree (`build/qemu`) at the time of
investigation was verified byte-identical to
`QEMU_PMB887X_REV (2735ce4e) + patches 0001..0004` (0005 cannot apply
after 0003 — `git apply --check` fails on the duplicated hunks, so
`build-qemu.sh` skips it for the TCI/dist build; that part is fine).
`dist/` (rebuilt 05:39 during the recovery session) was built from
exactly that tree. So the only functional deltas vs dfb4e21 are patches
0003 (TCI fast paths, `tcg/tci.c`) and 0004 (skip `cpu_io_recompile`,
`accel/tcg/cputlb.c`).

Incremental rebuilds via `scripts/ninja-fast.sh` (~10 s each) with
patch-level swaps:

| tci.c | cputlb.c | result |
|---|---|---|
| 0001+0002 | 0001+0002 | GOOD — 259 upd / 9284 lit px, l1bbcsg exit |
| **0003** | 0001+0002 | **GOOD** — 384 upd / 16230 lit px (further!), l1bbcsg exit |
| 0003 | **0004** | **BAD** — 3 upd / 0 lit px, instant `flash 0x0552` exit |

→ **patch 0004 (`0004-wasm-skip-io-recompile-longjmp-storm.patch`) is
the regression.** Patch 0003 (inline TLB probe + direct helper
dispatch) is *correct* and even gets the phone visibly further than
dfb4e21.

Note: the "175k → 790k insns/s" claim for 0004 was measured in what the
session called the "post-crash idle" phase — i.e. *after* this same
early crash, when the guest sits in a tight loop. The speedup is real
but was banked on a build that never boots; re-measure on a booting
build (0003-only measures fine).

## 3. Guest divergence point (exec-trace diff)

`-d exec` traces of the 0003-only (good) and 0003+0004 (bad) builds
(`/tmp/exec-good.log`, `/tmp/exec-bad.log`; compare with
`tools/tracediff.mjs` methodology — align TB entry PCs, tolerate TB
granularity differences from the recompiles themselves):

- First structural difference is expected: TB #2 (guest `0x40005c`)
  does a mid-TB MMIO; good rewinds (`cpu_io_recompile: rewound
  execution of TB to 0x400064`), bad chains straight through.
- **First real control-flow divergence** at good-TB #27872 / bad-TB
  #21252: the guest calls a subroutine at **`0x400118c`** (boot ROM,
  `pmb8876_brom_r16`, S75 = PMB8876 rev 0x10):

```asm
0040118c: ldr  r0, [pc, #0x30]   ; = 0xF4900000  (PMB8876_GPTU0_BASE)
00401190: ldr  r0, [r0, #0xfc]   ; read GPTU_SRC7
00401194: lsls r0, r0, #0x12     ; test bit 13 (MOD_SRC_SRR)
00401198: bpl  0x4011b8          ; SRR==0 -> return 0
0040119c..0x4011b0: read SRC7 again, OR 0x4000 (MOD_SRC_CLRR, ack), write back, return 1
004011b8: mov  r0, #0 ; return 0
```

Good build: **SRR set** → poll returns 1 → caller proceeds at
`0x400808`. Bad build: **SRR clear** at the first poll → returns 0 →
caller takes `0x400780 → 0x4001280…` and the boot aborts soon after
(`FILE: flash ExitCode: 0x0552`, `1362:Prog:00000032:4`).

Emulator side (`hw/arm/pmb887x/gptu.c`): reading any `GPTU_SRC*`
register first calls `gptu_sync_timer()` + `gptu_t2_sync_timer()`,
which advance the GPTU tick counters based on
`qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL)` and fire the expiry events that
`pmb887x_src_update(..., MOD_SRC_SETR)`-set the SRR bit. So the SRR the
ROM sees is purely a function of the **virtual clock at the moment of
the MMIO read** vs the timer's arming time (`timer->start = now` at
enable).

→ The two builds disagree about virtual time at that point in boot.

## 4. Host-side mechanism (identified, not yet instrumented)

Patch 0004's justification comment says the recompile protects icount
precision that "does not exist on emscripten anyway: this tree batches
icount2 accounting **once per TB in cpu_tb_exec() before execution**".
That premise is wrong in both halves:

1. The accounting (patch 0002 hunk in `cpu_tb_exec`,
   `accel/tcg/cpu-exec.c`) runs **after** `tcg_qemu_tb_exec()` returns:

```c
    ret = tcg_qemu_tb_exec(cpu_env(cpu), tb_ptr);
#ifdef __EMSCRIPTEN__
    if (icount2_enabled()) {
        wasm_tb_account(tb_icount);
        icount2_advance(tb_icount);   /* full TB icount, after the fact */
    }
#endif
```

2. `cpu_io_recompile()` (stock qemu 11, `accel/tcg/translate-all.c`)
   `cpu_loop_exit_noexc()`-longjmps **out of** `tcg_qemu_tb_exec`.
   When that happens the `icount2_advance(tb_icount)` above never runs
   for the partially-executed TB: those executed guest cycles are
   **never credited to the virtual clock** (the re-executed 1-insn
   CF_LAST_IO TB credits exactly 1 insn).

Consequently the two builds have systematically different virtual clocks
relative to executed guest instructions:

- **good (no 0004):** every mid-TB MMIO aborts its TB → virtual clock
  permanently *lags* executed instructions (lost partial-TB cycles);
  each mid-TB access is re-executed as a 1-insn TB, so device callbacks
  see the clock of the previous TB boundary + 1.
- **bad (with 0004):** TBs always run to completion → every cycle is
  credited; a device callback mid-TB sees the clock as of the previous
  TB boundary (current TB's cycles not yet added).

One of these two clock lags makes the BROM's GPTU SRC7 handshake see
the timer as not-yet-expired at the first poll and return 0, which the
ROM treats as a fatal boot failure. The sign analysis (which build is
ahead/behind at exactly `0x401190`) was not finished — instrument to
confirm (see follow-ups). Either way it demonstrates the actual bug:
**skipping `cpu_io_recompile` changes virtual-clock visibility and
accumulation, contrary to the patch's stated rationale.**

## 5. Recommended fix directions

1. **Immediate unblock:** drop patch 0004 (move it out of
   `patches/` or gate it off) — 0001–0003 boots correctly and is
   faster than dfb4e21. Expected cost: the io-recompile longjmp storm
   returns (~175k insns/s instead of 790k).
2. **Proper fix for the storm** (pick one):
   - Keep the recompile but stop *re-paying* it: cache the split TB
     (qemu already keeps the original TB cached; the storm is that a
     TB whose MMIO insn is not last re-triggers forever — ensure the
     *chained* TB after the rewind is the 1-insn CF_MEMI_ONLY one so
     the poll loop never re-enters the bad TB. Check why TB chaining
     isn't preventing the repeat on wasm).
   - Or account icount2 **before** execution (as 0004's comment
     claims) *and* credit-back/rewind on `cpu_io_recompile`
     (requires calling `icount2_advance` compensation from the
     rewind path, based on the retaddr→insn offset), then skipping
     the recompile becomes clock-neutral *for accumulation* — but
     mid-TB callbacks would then see a too-far clock, which is
     exactly what the GPTU poll is sensitive to. This needs a
     determinism argument per device.
   - Or make the GPTU (and friends) insensitive to mid-TB clock skew
     — not recommended; the BROM genuinely polls timers.
3. Re-verify the perf claims on a *booting* build (insns/s during
   actual boot, not post-crash idle), and re-run the JIT/lockstep
   verification — dist-jit contains 0003+0004 too and should be
   re-tested against the same early crash (its "lockstep to the same
   crash point" claim was probably lockstep into *this* early crash).

## 6. Session artifacts / state

- `build/qemu` tree: left as found — pristine rev + 0001–0004
  (uncommitted, `ui/wasm.c` untracked). `dist/` currently holds a
  **0003+0004 (bad/crashing) build** (rebuilt during this session from
  the same sources; equivalent content to what was there before).
  Rebuild good variant with: `cp /tmp/q12/tcg/tci.c` … see below.
- Source variant backups:
  - `/tmp/q12/`  = clone at rev + **0001+0002** (dfb4e21-equivalent
    `tcg/tci.c`, `accel/tcg/cputlb.c`)
  - `/tmp/qtest/` = clone at rev + **0001–0004**
  - `/tmp/tci-134.c`, `/tmp/cputlb-134.c` = the 0003/0004 variants
  - `/tmp/qtree-snapshot/` = full snapshot of the original build tree
    (2.8 GB — delete when done)
- Traces: `/tmp/exec-good.log` (**0003-only** build, 85 MB, captured to
  ~60 s without reaching the L1 exit), `/tmp/exec-bad.log` (0003+0004,
  71 MB, includes the `flash 0x0552` exit at ~50 s).
- BROM extraction: `/tmp/brom_pmb8876_brom_r16.bin` (from
  `hw/arm/pmb887x/gen/brom_data.h`; S75 = `cpu.rev 0x10` → r16).
- `tools/exectrace.mjs` added (boot + serial/trace dump helper).
- The `serve.mjs` started for testing was stopped.

## 7. Resolution (2026-09-07, updated by the 0004 rework)

- **0004 dropped** (moved to `patches/attic/`, `accel/tcg/cputlb.c`
  restored to pristine) — immediate-unblock option §5.1. Verified in
  `dist/` (0001–0003 + 0006): no early `flash` exit, TB stream runs
  past the old divergence point, ~320k insns/s during actual boot
  (the storm costs less than the 175k estimate).
- **The follow-on `l1bbcsg` L1 timeout was NOT caused by the good
  build's clock lag** — it was the icount2 controller locking virtual
  time to wall time on a host ~130× slower than the guest. Fixed by
  `0006-wasm-icount2-fixed-104MHz-virtual-clock.patch`: on emscripten
  the virtual clock runs at the fixed real-hardware rate (104 MHz), so
  all firmware budgets carry the full native instruction budget and
  the machine boots in slow motion (see
  [livelock-postmortem.md](livelock-postmortem.md)).
- ~~A proper fix for the io-recompile storm (if the perf work wants the
  ~4× back) must be clock-visibility-neutral per §4~~ → **done, see §9.**
- The instrumentation checklist below is superseded by §9;
  the GPTU SRC7 poll sensitivity was the acceptance test (and passed:
  SRR sets at the same virtual instant as the stock build).

## 9. The 0004 rework: MMIO-boundary accounting (2026-09-07, later session)

`patches/0004-wasm-io-recompile-mmio-boundary-accounting.patch`
replaces the dropped attic patch. Design, verified on real runs:

- **Keep the rewind's icount2 semantics, not its cost.** On emscripten
  (icount2 only) `io_prepare()` no longer longjmps for regular MMIO:
  `wasm_io_account()` (translate-all.c) moves the clock to
  `T0 + (k-1)` for the k-th io access of the TB (T0 = ticks at TB
  start; io insn index from the same insn_start unwind the rewind
  uses) — exactly the clock the stock path shows the callback (first
  access: TB boundary; later: +1 per earlier io insn's 1-insn
  CF_MEMI_ONLY TB). `cpu_tb_exec()` then credits only
  `wasm_io_account_rest()`: stock accumulation, *including* the
  lost partial-TB cycles (the firmware timing is tuned to them).
- **ROM devices (flash command interface) keep the stock rewind** —
  without it the boot-ROM's flash program/verify handshake aborts with
  the very same `FILE: flash 0x0552`. The BROM polls flash status in a
  tight loop after issuing CFI/devid commands; the rewind's TB
  serialization is required there (flash commands toggle romd mode,
  invalidating the executing flash-backed TBs). Those accesses are
  rare, so the ~150 µs longjmp costs nothing.
- **`QEMU_IO_REWIND=1`** (page: `?iorewind=1`) forces the stock rewind
  everywhere — the A/B escape hatch.

Measured (S75 fullflash, headless Chrome, same machine):

| build | splash | sustained rate | deep boot |
|---|---|---|---|
| stock rewind (0001–0003+0006) | ~85 s | 0.2–5M insns/s | 1.97 s vclock @ 120 s |
| 0004 rework | ~25–30 s | 4–17M insns/s | 49.8 s vclock / 1.25B insns @ 180 s |

Acceptance: GPTU SRC7 SRR sets at the same virtual instant as stock
(119.617 ms vs 119.651 ms), no `>>EXIT<<`, `?iorewind=1` still boots.

Dead ends investigated on the way (all reproduced the boot abort or a
worse wedge, all documented for the next person):

1. **TB splitting at known io PCs** (record the io insn PC on first
   rewind, invalidate the unsplit TB, end re-translations after it):
   correct rewinds (~1 per distinct io insn) but the machine wedged
   ~120–165M insns in — several threads busy-spinning, no qemu lock
   held (watchdog-instrumented); correlated with the TB invalidation,
   never root-caused (emscripten runtime-level livelock).
2. **Mid-TB crediting** (credit the io index at the access, remainder
   at TB end): passes SRC7 but ~34 µs of virtual clock ahead of stock
   by the flash phase → `FILE: flash 0x0552` again.
3. **Prefix-drop** (credit `icount - last_io_idx` at TB end only):
   loses the per-io +1 visibility → same abort.
4. **Wall pacing** (futex sleep per mid-TB io access, up to 150 µs to
   mimic the storm's pacing): does not help — the flash abort is not
   a wall-time race but the ROM-device/romd semantics above.
5. **DSP core mutex** (serialize teakra access vs the worker thread —
   a real data race in the fork): masks nothing once (4) is understood;
   the race exists upstream but does not bite at these speeds once the
   flash rewind is kept. Not carried in the patch.

Also note: the stock wasm build's per-TB accounting under-credits TBs
  chained through `helper_lookup_tb_ptr` (indirect branches) — only the
  first TB of a chain is credited. The rework reproduces that behaviour
  exactly (chained io: +1, session prefix lost) rather than "fixing"
  it, to stay clock-identical to the booting baseline.

## 8. Original follow-up checklist (superseded by §7)

- [ ] Instrument `gptu.c` (SRC7 read: print `now`, `timer->start`,
      `freq`, ticks) + `icount2.c` (running total) for both builds;
      confirm which clock is ahead at `0x401190` and by how much
      (expected: bad ≈ good + Σ(partial-TB icounts lost by good)).
- [ ] Check whether the good build's clock lag is also what ultimately
      starves the L1/DSP handshake (the old 0x0B timeout) — i.e. the
      lag may be *why* dfb4e21 "worked" as far as it did.
      → ANSWERED: no; that starvation was the adaptive controller
        (fixed by 0006), not the partial-TB lag.
- [ ] Decide fix direction (§5), implement, re-measure boot-phase
      insns/s, update performance-handoff/wasm32-port-status docs
      (790k figure + "TCI 790k ✓" claim need a booting-build re-run).
      → DONE: §5.1 (drop 0004) + 0006; figures updated in
        performance-handoff.md.
- [x] Re-test dist-jit with 0004 removed/reworked.
      → RESOLVED (superseded): dist-jit was later rebuilt as the wasm64
        TCG backend (patch 0017) from the current patch series and fully
        re-gated (op-suite ×3, lockstep windows + full 2.5e9 gate,
        idlebench) — see doc/wasm-tcg-backend-progress.md.
