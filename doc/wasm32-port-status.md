# wasm32 runtime-JIT port — CLOSED (verdict: discarded)

**Status 2026-09-09: the wasm32 runtime-JIT path is dead.** The 0005
DRAFT was fully rebased onto the current patch series, built, and
benchmarked head-to-head against the TCI dist. The hoped-for 10–100x
does not exist in this architecture on this workload: the measured
ceiling is **~1.3x (quiet host) / ~2.3x (loaded host)** on the v=2..7
window — the only window where the JIT executes guest code correctly —
while carrying a ~4200-line backend, per-TB wasm instantiation through
JS, an instance-lifecycle failure domain, an unresolved deterministic
guest-data divergence (boot hangs in the BROM USART-RIS poll at v≈6,
then watchdog-resets into a recovery loop forever), and a completely
dead no-icount (LG) boot. Everything is preserved under
`patches/attic/wasm32-rebase/` (rebased sources + worktree diff + the
full post-mortem, including the root causes found along the way —
notably the `tcg_insn_unit` truncation bug that explains the draft's
historically "broken TCI fallback", and the tci.c stack-aliasing trap
that briefly regressed the TCI build −60% during the rebase).

The document below is kept as the historical bring-up record.

---

# wasm32 TCG backend port — status (work in progress, historical)

This documents the state of the runtime-JIT port (ktock/qemu-wasm's wasm32
TCG backend, qemu 10-era) onto this fork (qemu 11.0.92 + pmb887x), as of the
end of the session that produced patches 0003–0005. Read together with
[performance-handoff.md](performance-handoff.md) (targets and measurements)
and [livelock-postmortem.md](livelock-postmortem.md) (the asyncify/condvar
backstory).

## What existed right before the closure

Two independent web builds, both served simultaneously:

| | dist/ (port 8080) | dist-jit/ (port 8082) |
|---|---|---|
| TCG engine | TCI interpreter (wasm64) | **wasm32 runtime JIT** + TCI fallback |
| Build | `scripts/build-qemu.sh` | `scripts/build-qemu-jit.sh` |
| Patches | 0001–0004 + 0007–0015 | 0005 DRAFT — superseded by `patches/attic/wasm32-rebase/` |
| Status | boots (stock icount `shift=3,sleep=off`) at ~15M insns/s sustained, S75 idle screen ≈ 3 min | boots in slow motion to v≈6, then watchdog-reset loop (see verdict above) |

## Architecture (from ktock/qemu-wasm, adapted — kept for reference)

Every TB is dual-encoded: **TCI bytecode** (shared emitters,
`tcg/tci/tci-emitters.h.inc`, interpreted by the stock `tcg/tci.c` core)
**plus a standalone wasm module** built in a side buffer (`sub_buf`,
tcg.c) and appended to the TB in the code buffer. TB layout:

```
[tci_code_off][export sz][export vec][counter sz][counter vec]
[icount]         <- JS reader in instantiate_wasm and tb_icount_off in
                      wasm32.c know about it)
[code_size][TCI code][wasm module blob][helper index table]
```

`tcg/wasm32.c` dispatches: live wasm instance → call it through the
emscripten function table; else instantiate (JS `WebAssembly.Module` +
`Instance`, registered via `addFunction`, FinalizationRegistry GC) or fall
back to the TCI interpreter. TB chaining happens *inside* the instance
(self-loops) or through the C dispatch loop (cross-TB), so icount
accounting runs per dispatch-loop TB (reading the `[icount]` header slot).

## Bugs found during the sessions (kept — these bite any retry)

- **`tcg_insn_unit` truncation** (found in the 2026-09-09 session): the
  wasm32 build has `TCG_TARGET_INSN_UNIT_SIZE == 1`, so any
  `tcg_insn_unit insn = 0;` local in the shared emitters is a `uint8_t`
  and every `deposit32` truncates to the bare opcode — register and
  immediate fields are silently zeroed. This single bug produced the
  draft-era "TCI-BADSETCOND / stream desync on the first fallback TB"
  (the fallback stream was garbage) and was masked by
  `INSTANTIATE_NUM 0` (never exercise the fallback). Fixed by using
  `uint32_t insn` locals in the emitters header.
- **tci.c interpreter split trap** (2026-09-09): do NOT pass the
  interpreter stack into `tcg_tb_exec_tci` as a parameter — the pointer
  select destroys LLVM alias analysis in the interpreter loop and costs
  the *TCI build* −60% v-window. Keep one function with a local array,
  rename via `#define tcg_qemu_tb_exec tcg_qemu_tb_exec_tci` under
  CONFIG_TCG_WASM32.
- **ktock's `tcg_wasm_out_extract` used i64 shifts for i32 extracts** —
  fixed during the original port (see git history).
- The wasm side's TLB probe loads `CPUTLBDescFast.mask`/`table` with
  i64 loads over 4-byte fields on wasm32 — works only because the
  garbage high bits are masked away by the i32 wrap after the table
  add. Fragile; fix properly if resurrected.
- emscripten TLS cannot hold dynamic initializers; `emscripten_sleep`
  cannot be called from the asyncify-removed `tcg_qemu_tb_exec`.

## Measurement/tooling notes

- The old JIT-era numbers in this file (790k insns/s "raw capability")
  were duty-cycle estimates under icount2 and are obsolete; the
  2026-09-09 session produced real head-to-head numbers (see the verdict
  above and `patches/attic/wasm32-rebase/README.md`).
- `tools/iotrace.mjs` (kept) drives the fork's `PMB887X_TRACE_IO` device
  trace through a page boot — the tool that localized the divergence.
- `tools/tracediff.mjs` now compares the *pc* field of exec traces
  (it compared cs_base — a constant — before; "lockstep" results from
  before 2026-09-09 are void).
- `tools/serialwatch.mjs` now honors `PORT=` (it hardcoded 8080).

## Targets (historical, from performance-handoff.md)

Real-time needed ≥50M insns/s sustained. The wasm32 JIT measured ~2x
TCI at its best; TCI itself reached ~15M insns/s through patches
0007–0015. Any future big-lever work should start from the TCI series,
not from this backend.
