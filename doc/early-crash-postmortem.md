# WASM early-boot crash — regression post-mortem (RESOLVED)

Committed to answer: *"the emulator was getting much further in the boot
process in dfb4e21c018e641cbcb64206944064db038b0874; in the next commit
(ea28492) it started crashing before anything is drawn."*

Status: **RESOLVED — patch 0004 dropped (moved to `patches/attic/`);
`dist/` = patches 0001–0003 + 0006.** The early `FILE: flash ExitCode
0x0552` abort is gone; the follow-on `l1bbcsg` L1 timeout is separately
fixed by 0006 (fixed 104 MHz virtual clock, see
[livelock-postmortem.md](livelock-postmortem.md)); the build now boots
through both crash points in slow motion. What follows is the original
investigation record.

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

The qemu wasm64 source tree (`web/build/qemu`) at the time of
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

- `web/build/qemu` tree: left as found — pristine rev + 0001–0004
  (uncommitted, `ui/wasm.c` untracked). `web/dist/` currently holds a
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

## 7. Resolution (2026-09-07)

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
- A proper fix for the io-recompile storm (if the perf work wants the
  ~4× back) must be clock-visibility-neutral per §4: either keep the
  recompile and stop re-entering the unsplit TB, or account-and-rewind
  per retaddr. Rework notes stay in `patches/attic/`.
- The instrumentation checklist below is kept for that future rework;
  the GPTU SRC7 poll sensitivity is the acceptance test.

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
- [ ] Re-test dist-jit with 0004 removed/reworked.
      → OPEN (paused perf effort; dist-jit still carries the old
        0003+0004-era assumptions and needs a fresh baseline).
