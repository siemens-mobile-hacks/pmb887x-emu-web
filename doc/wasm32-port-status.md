# wasm32 TCG backend port — status (work in progress)

This documents the state of the runtime-JIT port (ktock/qemu-wasm's wasm32
TCG backend, qemu 10-era) onto this fork (qemu 11.0.92 + pmb887x), as of the
end of the session that produced patches 0003–0005. Read together with
[performance-handoff.md](performance-handoff.md) (targets and measurements)
and [livelock-postmortem.md](livelock-postmortem.md) (the asyncify/condvar
backstory).

## What exists right now

Two independent web builds, both served simultaneously:

| | dist/ (port 8080) | dist-jit/ (port 8082) |
|---|---|---|
| TCG engine | TCI interpreter (wasm64) | **wasm32 runtime JIT** + TCI fallback |
| Build | `scripts/build-qemu.sh` | `scripts/build-qemu-jit.sh` |
| Patches | 0001–0004 + **0007–0009** (TCI TB chaining: per-TB `tci_tbhdr` icount2 accounting inside the interpreter — the same model this port uses for its dispatch loop, so a 0005 rebase must adopt 0007's header/goto_tb rather than re-derive it; 0006 was dropped 2026-09-08 — timing model is stock `-icount shift=3,sleep=off`, LG boots without icount) | 0001–0004 + **0005 (DRAFT, uncommitted)** — **stale** |
| Status | boots (stock icount `shift=3,sleep=off`, no `>>EXIT<<`) at ~7–17M insns/s (~2x pre-0007), S75 reaches the idle screen in ~4–5 min | was "lockstep with TCI to the same crash point" — but that crash point was the 0004 early abort; needs a fresh baseline against the current dist |
| Guest correctness | verified past both former crash points (BROM GPTU poll, L1 handshake) | matches TCI through early boot (exec-trace-verified, see below) |

Serve with:
```
cd web
WEB_DIST_DIR=$PWD/dist      PORT=8080 HTTPS_PORT=6808 node serve.mjs   # TCI
WEB_DIST_DIR=$PWD/dist-jit  PORT=8082 HTTPS_PORT=6810 node serve.mjs   # JIT
```
`serve.mjs` gained `WEB_DIST_DIR` (defaults to `dist`).

## The wins banked so far (dist/, TCI)

Root-caused with per-worker CDP CPU profiling (`tools/wprof2.mjs`, raw
DevTools-websocket Profiler sessions on the emscripten pthread workers —
playwright/puppeteer cannot reach them):

1. **The longjmp storm (patch 0004, 4.5×).** 50.7 % of the vCPU worker's
   self time was inside `__emscripten_throw_longjmp`. Caller stacks:
   `cpu_io_recompile ← do_ld_mmio_beN ← do_ld4_mmu ← tci_qemu_ld`. qemu 11
   only allows MMIO from a TB's last insn unless `can_do_io`; the firmware's
   MMIO poll loops re-trigger `cpu_io_recompile` on *every* iteration
   (measured 16,324 recompiles / 20 s across only 229 TBs). Natively that is
   a ~1 µs setjmp hop; emscripten's JS-exception longjmp costs ~150 µs.
   On emscripten the icount2 clock is already batched per TB (patch 0002),
   so skipping the recompile costs nothing in clock precision.
   175k → 790k insns/s sustained.

2. **TCI fast paths (patch 0003, ~10 % steady-state, bigger early).**
   Inline TLB probe in `tci_qemu_ld/st` (mirrors `prepare_host_addr` +
   `tlb_set_compare`) and direct typed C dispatch for helper calls whose
   libffi signature is i32/i64-only (≤5 args) — bypasses `ffi_call` →
   `ffi_call_js` → `getWasmTableEntry(fn).apply()`, a ~1.7 µs JS roundtrip.

Post-fix profile of the vCPU worker: 44 % `emscripten_futex_wait` (legit
WFI idle in the post-crash phase), 12 % `tcg_qemu_tb_exec`, ~10 % MMIO
dispatch (`access_with_adjusted_size` + `memory_region_dispatch_read`).
Interpreter-only ceiling ≈ 6M insns/s → real-time needs the JIT; that's
what 0005 is.

## INCIDENT + recovery (read this first in a new session)

A stray `scripts/build-qemu.sh` run reset the qemu tree (its
`git reset --hard` + `git clean -qfd`) and **deleted all uncommitted wasm32
files** mid-session. Everything was recovered from the 0005 DRAFT patch in
git (commit ea28492) plus hand re-application of the post-commit deltas;
both builds were re-verified working afterwards (JIT lockstep ✓, TCI 790k
insns/s ✓). Consequences:

- `scripts/build-qemu.sh` now **refuses to reset** when uncommitted wasm32
  work is present (tcg/wasm32.c etc. exist). To do a clean TCI rebuild,
  commit/refresh the 0005 patch first (or temporarily move the files).
- Regenerate the patch after any change:
  `cd web/build/qemu && git add -N tcg/wasm32 tcg/wasm32.c tcg/wasm32.h
  tcg/tci/tci-emitters.h.inc && git diff HEAD >
  ../../patches/0005-wasm32-tcg-backend-port-DRAFT.patch`
- The **TCI build dir (web/build/qemu-wasm) is currently misconfigured**
  (a meson reconfigure lost the emscripten cross-files and linked a native
  binary; also watch for the stale `scripts -> /home/perk11/...` symlink —
  delete it if it reappears). dist/ still holds the last good TCI binary
  (verified booting). To rebuild TCI: rm -rf web/build/qemu-wasm, stash the
  wasm32 files (or commit the patch), run build-qemu.sh, restore.
- The JIT build dir (web/build/qemu-wasm32) is healthy;
  `scripts/build-qemu-jit.sh` works as-is.

## The wasm32 port (patch 0005 DRAFT)

### Architecture (from ktock/qemu-wasm, adapted)

Every TB is dual-encoded: **TCI bytecode** (shared emitters,
`tcg/tci/tci-emitters.h.inc`, interpreted by the stock `tcg/tci.c` core,
now exported as `tcg_tb_exec_tci()`) **plus a standalone wasm module** built
in a side buffer (`sub_buf`, tcg.c) and appended to the TB in the code
buffer. TB layout:

```
[tci_code_off][export sz][export vec][counter sz][counter vec]
[icount]         <- NEW (added by the port; JS reader in instantiate_wasm
                      and tb_icount_off in wasm32.c know about it)
[code_size][TCI code][wasm module blob][helper index table]
```

`tcg/wasm32.c` dispatches: live wasm instance → call it through the
emscripten function table; else instantiate (JS `WebAssembly.Module` +
`Instance`, registered via `addFunction`, FinalizationRegistry GC) or fall
back to the TCI interpreter. TB chaining happens *inside* the instance
(returns only at real exits), so **icount2 accounting was moved into the
dispatch loop** (per chained TB, reading the `[icount]` header slot;
cpu_tb_exec's per-call accounting from patch 0002 is `#ifndef
CONFIG_TCG_WASM32` now). Without that, virtual time froze at JIT speed and
every virtual deadline hung (found the hard way).

### What was ported (0005 covers all of it)

- `tcg/wasm32.c` + `tcg/wasm32.h`: instance lifecycle, JS glue
  (`instantiate_wasm`, GC registry), the dispatch loop; the embedded 8.2
  TCI interpreter was replaced by a shim onto `tcg_tb_exec_tci()`.
- `tcg/wasm32/tcg-target.c.inc`: ktock's wasm emitters kept; dispatch
  rewritten from 8.2 `tcg_out_op` to qemu 11 **OUTOP descriptors**
  (~60 ops). Ops without ported emitters are `C_NotImplemented` and the
  middle end expands them: the carry family (addci/addcio/addco/addc1o/
  subbi/subbio/subbo/subb1o), negsetcond, qemu_ld2/st2 (i128), divs2/divu2,
  mul2/mulh are i32-only (armv5 guest never needs the 64-bit forms).
  `TCG_TARGET_HAS_tst 0` (TST conds expand).
- Opcode renames 8.2→11 (add_i32/i64→add, div_i32→divs, qemu_ld_a32_i32→
  qemu_ld + TCGType, ...), `s->page_bits/page_mask` → runtime
  `TARGET_PAGE_BITS/MASK` (qemu 11 removed the TCGContext fields).
- Shared TCI emitters: extracted from `tcg/tci/tcg-target.c.inc` into
  `tcg/tci/tci-emitters.h.inc` so both backends emit identical bytecode.
- `TCGHelperInfo.cif` (libffi descriptors) now also built for the wasm32
  backend (`CONFIG_TCG_WASM32`): the TCI fallback needs it for calls, and
  patch 0003's direct-call dispatch rides on it.
- meson: `wasm32` cpu family allowed (64-bit-host check bypassed),
  `CONFIG_TCG_WASM32`, wasm32.c + tci.c both compiled, deps built for
  wasm32 by `scripts/build-deps32.sh` (glib needs
  `-Wno-incompatible-function-pointer-types` + the HAVE_POSIX_SPAWN/
  PTHREAD_GETNAME_NP deletes).
- Hooks: `init_wasm32()` in rr/mttcg vCPU thread fns (was silently missing
  for a while — everything from garbage export offsets to "deadlocks"
  came from that), `set_done_flag()` after each ldst helper
  (`ldst_common.c.inc`), `tb_reset_jump` writes 0 (ktock semantics).

### Bugs found and fixed during bring-up (keep these in mind)

- **ktock's `tcg_wasm_out_extract` used i64 shifts for i32 extracts.**
  For len<32, `(x << (32-len)) >> (32-len)` is the *identity* on any
  32-bit value, so `gen_bx`'s `thumb = val & 1` stored the whole register
  (`env->thumb = 0x54` → hflags `0x2a000400` → guest derailed into a
  jump table and spun). Rewritten with real i32 ops (wrap → shl/shr_s or
  shr_u → extend). This was found by diffing `-d exec` traces between the
  two builds (`tools/tracediff.mjs`) and then dumping + `wasm-dis`-ing the
  generated module for TB0 (the dump hook is still in wasm32.c, writes
  `/mod0..2.wasm` to MEMFS).
- `tcg_out_movi/mov` in the wasm32 target self-recursed after the
  `tcg_tci_out_*` rename (MAX call stack) — now emit via the shared ops.
- My `tgen_brcond` initially emitted a raw-value test; 11's TCI brcond
  tests a setcond result — must emit setcond-into-TMP + brcond (like
  tcg/tci does).

### Optimization round 2 findings (post-lockstep, rate analysis)

The JIT executes guest code correctly but the sustained rate is still
~790k insns/s — the *same* as TCI. This is **not** "JIT is slow": with
`precise-clocks=on` virtual≈wall, so insns/s == the icount2-locked
frequency == raw capability while busy. Profile of the JIT vCPU worker
(`tools/wprof2.mjs`, symbolized via `--emit-symbol-map`):

| share | where | note |
|---|---|---|
| 37 % | `emscripten_futex_wait` | WFI / virtual-deadline idle (legit but check wakeup latency) |
| 12 % | `a_cas_p` (atomic CAS) | **lock/atomic contention — source not yet identified** (BQL per-TB in RR mode? `tb_add_jump` cmpxchg? iothread vs main loop?) — `wprof2.mjs` now has `PROF_FN=<substr>` caller-stack mode to answer exactly this |
| ~25 % | MMIO dispatch stack | `memory_region_dispatch_write/read`, `memory_region_read_accessor`, **`memory_region_name` (4.5 %!)**, `do_ld_mmio_beN`, `address_space_translate_iommu`, `address_space_map/write/read_full`, `access_with_adjusted_size` — the firmware's MMIO poll loops pay qemu's full per-access dispatch tax |
| ~25 % | everything else | guest execution + helpers + tcg dispatch |

With ~62 % busy that puts the raw JIT capability at **~1.3M insns/s** —
40× short of the 50M target. The bottleneck is *not* the wasm codegen
(the instances barely show in the profile) — it's host-side per-TB and
per-MMIO overhead. Measuring raw speed with `?icount=none` does not work
(virtual time freezes → devices never fire → run stalls at ~450k insns);
measure by duty-cycle math from profiles instead.

`wasm_tb_account` is now ungated (counters always tick; only
`icount2_advance` is icount2-gated), so `tools/rawspeed.mjs` and the WATCH
counters work in every mode.

### Known broken / remaining work (in order)

0. **Performance to real-time (the actual goal).** Priority order:
   a. Identify the `a_cas_p` 12 % — `PORT=8082 PROF_FN=a_cas node
      tools/wprof2.mjs 30 "" 100` during a compute-heavy window (the early
      boot stall phase is idle-heavy; the tool came back empty there).
      If it's BQL-per-TB from RR mode, try `-accel tcg,thread=multi`
      (the mttcg hook for init_wasm32 is already in place).
   b. MMIO dispatch tax — check whether `memory_region_name` being hot
      means per-access logging/tracing is on by default in the fork
      (PMB887X_TRACE_IO?); then look at caching the hot device polls.
   c. icount2 controller: initial frequency + adjust interval + WFI wakeup
      latency (37 % idle) — `system/icount2.c`, `?icount2debug=1` page flag.
   d. Verify instance execution rate directly (dump more `/mod*.wasm`,
      check the block-restart protocol cost per helper call).
1. **The TCI fallback still crashes** (`TCI-BADSETCOND` / stream desync on
   the very first fallback TB — the old `0x7d`-words dump). Worked around
   by `INSTANTIATE_NUM 0` in `tcg/wasm32.h` (always instantiate). This
   must be fixed before instance pressure hits (MAX_INSTANCE_ALIVE 15000,
   then it *needs* the fallback). Decode the first TB's TCI stream by hand
   against the shared emitters; the dump instrumentation in `tcg/tci.c`
   (`TCI-BASTOPC`, hexdump) is still in the tree for this.
2. **Raw JIT speed is not yet measured.** With `-icount precise-clocks=on`
   virtual≈wall locks both builds to the same wall-clock behavior (they
   reach the L1 crash at the same v), so the JIT's advantage only shows
   with `?icount=none` or after the icount2 frequency re-locks higher.
   `tools/rawspeed.mjs` exists but needs the counters ungated (they're
   behind `icount2_enabled()` in the dispatcher; print regardless).
3. **Debug instrumentation is still compiled in** (clearly marked):
   `/w32.log` dispatch logging (every 2000 loop iterations), the
   `/mod*.wasm` dumps, `cpsr/tbs/intr` logs in target/arm, `TCI-BASTOPC`
   in tci.c. Strip before calling 0005 done.
4. `ex=[…]` histogram shows `ex[3]`≈770 exits in both builds — worth a
   look once speed lands (handoff item 4).
5. The 0005 DRAFT patch was generated with `git add -N` + `git diff` from
   the working tree — **`scripts/build-qemu.sh` resets the tree and would
   destroy the uncommitted wasm32 work**. The patch in `web/patches/` is
   the backup; re-apply with `git apply` after the reset (or commit it).
   Regenerate it after any source change: `cd web/build/qemu && git add -N
   tcg/wasm32 tcg/wasm32.c tcg/wasm32.h tcg/tci/tci-emitters.h.inc &&
   git diff > ../../patches/0005-wasm32-tcg-backend-port-DRAFT.patch`.

### Measurement/tooling notes

- `tools/wprof2.mjs [s] [query] [sampleUs]` — per-worker CDP profiler
  (raw websocket via `--remote-debugging-port`, page-target auto-attach).
  Repaired in the 0007-0009 sessions (it never collected profiles
  before) and extended to symbolize `wasm-function[N]` via the
  `qemu-system-arm.js.symbols` sidecar (`--emit-symbol-map` in the link
  args — currently a local build.ninja hack; see
  doc/optimization-playbook.md). `PROF_FN=<substr>` env prints caller
  stacks for matching hot functions.
- `tools/bootbench.mjs [secs]` — the A/B benchmark used to select the
  0007-0009 patches: one JSON line with the deterministic v-window
  wall time + final progress. Methodology (and its traps) in
  doc/optimization-playbook.md.
- `tools/jitwatch.mjs`, `tools/tracediff.mjs`, `tools/iorec.mjs`,
  `tools/rawspeed.mjs`, `tools/list-targets.mjs` — the session's other
  probes; all take `PORT` env (8080 TCI / 8082 JIT).
- `scripts/ninja-fast.sh [targets]` — incremental rebuild with the right
  env (the full scripts reconfigure from scratch every time; that cost
  ~10 min per iteration until this existed).
- wasm32 deps: `scripts/build-deps32.sh` → `web/build/deps32/`
  (glib-2.84 + pixman + zlib + libffi, wasm32/masm64-LESS: no MEMORY64,
  no `-m64`, `INITIAL/TOTAL_MEMORY=2GB` fits the 4 GB wasm32 limit).

## Targets (unchanged from performance-handoff.md)

Real-time needs ≥50M insns/s sustained for a comfortable boot (≥300M
ideal); definition of done = boots to idle screen in <10 min, no
`>>EXIT<<` on serial, keypad navigates, LCD smooth. The JIT path is now
executing guest code correctly through early boot; the remaining gap to
close is the fallback bug, the raw-speed measurement, and tuning
(instantiation thresholds, ASYNCIFY_REMOVE additions, maybe
`-sSUPPORT_LONGJMP=wasm`).
