# Performance hand-off: getting the phone to fully boot in WASM

Status (superseded — see [wasm32-port-status.md](wasm32-port-status.md)
and [early-crash-postmortem.md](early-crash-postmortem.md)):
**the timing problem is fixed and boot correctness no longer depends on
speed — and the io-recompile storm is fixed too.** The first 0004
(skip `cpu_io_recompile`) was a regression (early `FILE: flash`
boot-ROM abort) and was dropped; the reworked 0004 (MMIO-boundary
accounting, see post-mortem §9) removes the storm correctly: the
stock rewind's icount2 clock is reproduced without the ~150 µs
longjmp (kept only for ROM-device flash-command accesses).
Patch 0006 runs icount2 at the fixed hardware rate (104 MHz) so
virtual time is instruction-proportional and every firmware deadline
carries the full native instruction budget — the phone boots with
**no `>>EXIT<<`**. Measured on the reworked build: splash in ~25–30 s
(stock rewind path: ~85 s), 4–17M insns/s sustained (stock path:
0.2–5M), 49.8 s of virtual time / 1.25B insns in the first 180 s.
What remains
here is raw throughput for *wall-clock* boot time only. The document
below is the original hand-off from the previous session; its
measurement methodology and constraints still apply.

Historical status: **correct but slow.** The wasm build is now deterministic and
crash-free (see [livelock-postmortem.md](livelock-postmortem.md)); what
remains is raw interpreter throughput. This document sets the targets and
leaves the implementation open.

## Measurements (2024 session, S75 fullflash, Chrome headless)

| Build | Steady rate | Notes |
|---|---|---|
| per-instruction icount2 helper (upstream-style) | ~574k insns/s | every guest insn = one TCI helper call = one libffi→`ffi_call_js`→JS roundtrip (~1.7 µs) |
| per-TB accounting + broken chaining (buggy) | ~10k cycles/s | the wild-TB bug; see post-mortem |
| per-TB accounting, chaining terminated via `exit_tb` | ~90–180k insns/s | ~2.6 insns/TB; ≈28 µs per cpu_exec round-trip |
| + `-sASYNCIFY_REMOVE=tcg_qemu_tb_exec` | ~400–700k insns/s | interpreter un-instrumented; V8 tier-up visible over the first minute |

Observations that constrain any fix:

- Guest TBs here average **~3–4 instructions** (branchy firmware, polling
  loops). Per-TB overheads are amortised over very little work.
- The firmware **busy-polls** (SCU_UID2 ×800 loops, DSP flag polling,
  handshake retries): natively it executes on the order of 10⁸–10⁹
  instructions during the first ~30 virtual seconds of boot. It needs a
  sustained guest pace of **≥50M insns/s**, ideally ≥300M.
- `precise-clocks=on` (icount2) locks virtual ≈ real time by adapting its
  frequency; when the host can't keep up, every wall-clock-timeout protocol
  (L1↔DSP handshake first) fails — ExitCode 0x0B, phone crash.
- TCI always routes loads/stores through `helper_*_mmu`
  (`tcg/tci.c:tci_qemu_ld/st`) — no inline TLB fast path.
- The DSP worker (teakra interpreter, C++) is *fast* once the condvar fix
  is in; it is not the bottleneck.

## Target

**Definition of done:** the S75 fullflash boots to its idle screen in the
browser (WASM mode) in under ~10 minutes wall time, no `>>EXIT<<` on
serial, keypad input visibly navigates the menu, and the LCD updates
smoothly.

That implies ≥ **3–5M guest insns/s sustained** (the phone will still boot
"slow-motion"; icount2 will lock low and virtual deadlines arrive with the
full instruction budget the firmware expects — correctness holds at any
speed once deadlines are instruction-proportional, but the L1 handshake
needs the DSP round-trips to fit inside firmware wall-clock budgets, so
realistically we want ≥50M insns/s for a comfortable boot).

## Next steps (open implementation)

1. **Port a native wasm TCG backend (recommended path).**
   ktock's [qemu-wasm](https://github.com/ktock/qemu-wasm) (qemu 8.2) ships
   a working wasm32 TCG backend (`tcg/wasm32.c`, `tcg/wasm32/tcg-target.c.inc`,
   ~5.4k lines) that emits wasm at runtime (table growth + JS trampolines;
   `-sALLOW_TABLE_GROWTH` + `addFunction` are already in our link flags).
   Upstream qemu merged only the TCI path for wasm, not this backend.
   Task: rebase that backend onto this fork (APIs moved 8.2→11:
   `tcg-opc`, TB management, `qemu_thread_jit_*`, splitwx…), decide
   wasm32+MEMORY64 vs wasm64 addressing, keep TCI as a fallback
   (`--enable-tcg-interpreter` coexistence). Expected: 10–100× TCI.
   Risk: port surface; self-modifying-code invalidation; the fork's DSP
   TCG engine (newer revisions) would eventually want the same treatment.

2. **Or: make TCI competitive (partial credit, smaller effort).**
   - Inline TLB fast path for `qemu_ld/qemu_st` in `tcg/tci.c` (mirror
     `accel/tcg/cputlb.c`'s `tlb_hit` probe before calling
     `helper_*_mmu`). Expected 2–5×.
   - Direct C dispatch for common helper signatures instead of
     `ffi_call` for `INDEX_op_call` (cache `cif` per call site; fast-path
     signatures ≤4 args).
   - Reduce per-TB `cpu_exec` round-trip cost: batch `icount2_advance`
     every N TBs, avoid `icount2_sync` when no virtual timer is armed.
   Even stacked, this likely lands at 2–5M insns/s — enough for a
   "slow-motion" correct boot, not a comfortable one.

3. **V8 tier-up warm-up.** `tcg_qemu_tb_exec` is a huge function; Liftoff→
   TurboFan tier-up takes ~a minute under load (visible in the rate
   curves). Pre-warm by running a synthetic hot loop right after boot, or
   ship `--wasm-tiering-budget`-tuned flags in the page (Chrome flags may
   not be controllable from a plain page — a service-worker or NMP could
   help; investigate `WebAssembly.compileStreaming` + eager tiering APIs).

4. **Re-check the DSP paths once speed lands.** At ≥10M insns/s re-run the
   DSP trace comparison (`tools/dsplive.mjs`) against the native run —
   expect the boot-loader handshake (PC `A09A26xx`, `SCU_DSP_INT` pulses,
   `boot command: PLOAD…` prints) to appear, then the L1 exit to
   disappear. If any timing pathology remains, revisit the icount2 floor
   (system/icount2.c) and the per-TB accounting granularity.

5. **If a JIT lands, revisit `-sASYNCIFY`.** With a wasm TCG backend the
   interpreter disappears; Asyncify remains only for the coroutine
   backend. Consider `-sASYNCIFY_ADVISE`/`ASYNCIFY_ONLY` to shrink the
   instrumented set further, or the stack-switching proposal once it
   ships broadly (`-fwasm-exceptions`/`--experimental-wasm-stack-switching`).

## Non-goals / notes for whoever picks this up

- Do not "fix" timing by pinning icount2's frequency high without also
  raising execution speed: virtual time would outrun instructions and every
  deadline fires early (measured: boot hangs in the BROM delay loops).
- `QEMU_ICOUNT2_DEBUG=1` (page: `?icount2debug=1`) prints the controller
  state every second — frequency, executed cycles, error. Keep it.
- All diagnostics used in this investigation are in `web/tools/` and
  documented in [diagnostics.md](diagnostics.md); the raw numbers above are
  reproducible with `node serialwatch.mjs 120`.
