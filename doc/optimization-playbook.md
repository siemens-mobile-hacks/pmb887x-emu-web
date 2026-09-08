# WASM performance optimization playbook

This documents the working method of the 2026-09-07/08 optimization
sessions (patches 0007–0009, ~2.4× guest throughput, boot to idle screen
~500 s → ~195 s) so future sessions can pick up the same loop:
**profile → hypothesize → small patch → measure → keep or revert →
document**.  Read together with [performance-handoff.md](performance-handoff.md)
(targets/constraints) and [wasm32-port-status.md](wasm32-port-status.md)
(the JIT port).

## The golden rules

1. **No change lands without a measurement.** If a patch does not
   measurably improve the A/B benchmark, it is reverted, and the
   negative result is written into the patch-series docs so it is not
   retried blind.
2. **Small, self-contained patches.** One mechanism per patch, stacked
   as `patches/NNNN-*.patch` via `scripts/capture-patch.sh`, each with
   measured numbers in its header.
3. **Every step stays under ~5 minutes.** Incremental builds (~8 s),
   benchmark runs (110 s), profiles (30–40 s).  Anything longer (full
   rebuilds, long soaks) runs in the background and is polled.
4. **Tests after every landed patch**: `node tests/run.mjs` (native
   suite, ~65 s, all PASS) plus a wasm boot verification (deep boot /
   idle screen screenshot, no `>>EXIT<<`).

## The fast feedback loop

```bash
# 0. serve the current dist (keep running)
WEB_DIST_DIR=$PWD/dist PORT=8080 HTTPS_PORT=6808 node serve.mjs &

# 1. edit sources in build/qemu (patches 0001..000N already applied there)

# 2. incremental rebuild + deploy (~8 s)
bash scripts/ninja-fast.sh

# 3. A/B benchmark (110 s; prints one JSON line)
PORT=8080 node tools/bootbench.mjs 110
#   window = wall secs of deterministic guest work between v=LO and v=HI
#   (defaults LO=2 HI=7).  Lower is better.  Primary metric.

# 4. profile the workers when looking for the next target (~40 s)
PORT=8080 node tools/wprof2.mjs 40 "" 100          # per-worker self-time
PROF_FN=phys_page PORT=8080 node tools/wprof2.mjs 30 "" 100   # callers

# 5. capture the surviving change as the next patch (stacks on 0001..N)
bash scripts/capture-patch.sh my-change-name
# then prepend a Subject/description header WITH MEASUREMENTS to the
# generated patches/NNNN-my-change-name.patch (see 0007/0008/0009)

# 6. confirm nothing is left un-captured (must print "nothing to do")
bash scripts/capture-patch.sh verify-tmp
```

Native suite after landing: `node tests/run.mjs --label <patch> --timeout 240`.

### Boot verification (correctness bar)

- `tools/serialwatch.mjs <secs>` — WATCH lines (v/u/serial/insns/ex[]);
  check: no `>>EXIT<<`, v advances, LCD updates (u) grow.
- Long soak to the idle screen: screenshot + eyeball (wallpaper, clock,
  "Поиск сети"): see the `shot`-style script in git history of this doc
  or `tools/smoke.mjs` as a base.  Idle screen wall times by build:
  0007 ≈ 260 s, 0008 ≈ 235 s, 0009 ≈ 195 s.

## Measurement methodology (and its traps)

- **Primary metric — the v-window**: wall seconds between virtual time
  v=2.0 and v=7.0 (interpolated from 10 s WATCH samples).  Guest work is
  deterministic, so equal v-ranges are equal work; idle (WFI) stretches
  are real-time-gated for every build and dilute all builds equally.
  Use `tools/bootbench.mjs` — it implements this correctly.
- **TRAP (cost hours once)**: when post-processing serialwatch logs,
  align samples by *WATCH-line index*, never by raw file line number —
  interleaved `[qemu] warning:` lines corrupt line-based time math and
  produced a completely false "regression" reading once.  bootbench.mjs
  parses console events directly and is immune.
- **Run-to-run variance**: single-run windows vary ±5–8 % (V8 tier-up
  timing, host noise).  Always run a candidate **twice** and compare
  against **two** baseline runs; require both candidate runs to beat
  both baselines for changes < 10 %.
- **Cross-checks**: final `v` and `insns` after a fixed duration (same
  run length only!), the per-sample insns deltas matched by v, and the
  wprof2 self-time profile (a real speedup shrinks the optimized
  function's share or the wall time around it).
- The WATCH console spam also floods the page console; keep runs
  single-purpose (don't reuse a browser tab across builds).

## Profiling recipe

`tools/wprof2.mjs` (repaired in this session — it never collected
profiles before) attaches the CDP Profiler to the emscripten pthread
workers:

- Worker #0 is the vCPU (TCI interpreter).  Workers #1–#4: pool,
  io_dump/RCU, **main loop** (worker #2), DSP.
- wasm functions show up as `wasm-function[N]`; wprof2 maps them via the
  `qemu-system-arm.js.symbols` sidecar.  That sidecar exists because
  `--emit-symbol-map` is hacked into `build/qemu-wasm/build.ninja`
  LINK_ARGS (measurement-only, a fresh `build-qemu.sh` reconfigure drops
  it — re-add it there if needed).  The map is also handy to resolve
  symbols by hand: `grep -m1 "^NNNN:" qemu-system-arm.js.symbols`.
- `PROF_FN=<substr>` prints caller stacks for a hot function — this
  found the io-recompile storm (previous session) and the flash-romd /
  poll-storm root causes in this one.

## What landed (with numbers)

| Patch | Mechanism | Measured effect |
|---|---|---|
| 0007 TCI TB chaining | restore `goto_tb` chaining; per-TB icount2 accounting moved into the interpreter via a `tci_tbhdr` header op executed at every TB entry; the old 0004-era session io accounting collapses to a deadline-sync | +84–113 % insns at fixed wall time; `cpu_exec_loop` 9.3 %→0.8 % of vCPU; boot to idle ~260 s |
| 0008 TCI immediate forms | `tci_add/and/or/xor/andc_ri`, `tci_setcond32_ri` + constraint letters + `tcg_target_const_match` + outop `out_rri`/`out_ri` wiring — constants stop materializing through `tci_movi` (18.9 %→12.8 % of ops; `add` 7.4 %→1.0 %) | window 46.7→42.9–43.7 s (+8 %); idle screen ~235 s |
| 0009 futex main-loop wait | emscripten `poll()` cannot sleep (it ignores the timeout — the browser main thread must not block), so the main loop busy-spun ~23k iterations/s through a proxied syscall, 2 BQL handoffs each, and the aio eventfd wake never worked at all.  Replaced with a worker-local ns-precision futex wait woken by `qemu_notify_event`/`aio_notify`; main-loop wait no longer times out on virtual deadlines (the vCPU runs those) | window 43.7→40.1–40.4 s (+8 %); +22 % boot progress @110 s; idle screen ~195 s |

## What was tried and REJECTED (do not retry without new ideas)

| Experiment | Result | Why |
|---|---|---|
| Lazy flash romd restore (flip back to array mode on first array read, not eagerly on every `0xFF`) | 7.4× fewer topology flips but **32 % slower** in the flash-heavy window | keeping romd off during bursts turns array reads (incl. fetches) into MMIO dispatches, which costs more than the flips save |
| icount2_advance thread-local batching (single-writer mirror, publish every 256 calls) | no measurable change (±noise) | the per-TB atomics are cheap on wasm; reverted |
| TCI store-immediate ops (`tci_st32_ri`/`st8_ri`, incl. the `tcg_out_sti` constant-spill hook) | window 42.9→50.6–50.7 s, final insns −20 % — consistent regression across runs | not root-caused; suspected interaction with allocator behavior/stream size; documented in 0008's header |
| QemuCond-based main-loop wait (instead of the raw futex) | same early-window numbers but only ~half the end-to-end gain | qemu condvar waits truncate to whole milliseconds on wasm; the firmware's ~100 µs WFI windows each pay +1 ms |
| `-sSUPPORT_LONGJMP=wasm` (native unwinding for the SVC-exception longjmps) | binaryen's Asyncify pass crashes on it (verified with a standalone emcc test) | wasm-EH longjmp and `-sASYNCIFY` are incompatible in emsdk 4.0.10; ASYNCIFY is required (coroutine backend/condvar sleeps) |

## Remaining opportunities (ranked, with the analysis already done)

1. **Exception longjmps, ~15–17 % of vCPU** — the firmware takes ~1 SVC
   (RTOS syscall) per ~1200 guest insns; each pays ~15 µs of
   JS-exception unwinding (`__emscripten_throw_longjmp`).  Blocked by
   the Asyncify/wasm-EH incompatibility above.  Ideas: re-test the
   incompatibility on newer emsdk; or the 0005 wasm32 JIT's
   block-restart protocol (its own dispatch returns normally instead of
   unwinding).  Do NOT try per-helper setjmp trampolines — the cost is
   the JS throw itself, not the distance.
2. **TCI interpreter dispatch, ~35 % of vCPU** — 0008 already removed
   the biggest op-class (constant materialization).  Remaining op mix:
   `st32` 20 %, `ld32u` 13 %, `movi` 13 % (now mostly wide constants),
   branches/compares ~15 %.  The known big lever is more allocatable
   registers (13 today) to cut the spill traffic — but that needs 5-bit
   register fields = a full TCI stream-format change (conflicts heavily
   with 0005's shared emitters).  Smaller ideas not yet tried:
   `tci_call_tag()` memoization (~1 %, sub-noise alone), TLB-probe
   specialization in `tci_qemu_ld/st` (~1–2 %).
3. **Flash romd topology churn, ~5.6 % of vCPU** — the firmware's
   status-poll loop (`[write 0x70, read status, write 0xFF]` × ~7 k/s)
   flips the flash partitions out of romd mode twice per poll, each
   flip a full `generate_memory_topology` rebuild (~7 ms on wasm: radix
   tree + dispatch rebuild for the whole machine).  Device-level fixes
   fail (see rejected table).  The real fix is qemu-core: make a romd
   flip not re-render identical FlatViews (romd_mode participates in
   `flatrange_equal`) — medium-large, upstream-relevant surgery.
4. **V8 tier-up warm-up** — the interpreter function tiers up over the
   first ~60 s (visible in the per-sample rates).  Not controllable from
   a plain page; maybe `WebAssembly.compileStreaming` hints someday.
5. **Main-loop residuals** — after 0009 the main loop sleeps properly;
   remaining cost is per-wake glib iteration + BQL handoffs (vCPU BQL
   waits ≈ 3 %).  Only worth revisiting if a profile shows it again.

## Gotchas cheat-sheet

- **emscripten**: `poll`/`ppoll` never sleep; condvar timed waits are
  whole-ms; `emscripten_futex_wait(ptr, val, double max_wait_ms)` has
  ns precision and is the right sleep primitive; wasm-EH longjmp and
  ASYNCIFY don't compose.
- **qemu-11 outop machinery**: backends get immediates via
  `tcg_target_const_match` + `out_rri`/`out_ri`/`out_i` hooks
  (TCGOutOpBinary/Brcond/Store); constraint operands combining a
  register class **and** a const letter are required (`rS`, `ri`) — a
  bare const letter with no register class trips
  `get_constraint_priority`'s `n > 1` assert at boot.
- **Per-build opcode numbering**: TCI extra opcodes are appended per
  patch (0007's `tci_tbhdr`, 0008's `_ri` forms); keep new DEFs appended
  so numbering stays stable, and remember `#ifdef __EMSCRIPTEN__` blocks
  in `tcg-target-opc.h.inc` shift numbering between builds.
- **capture-patch.sh** diffs against pinned-rev+applied-patches via a
  throwaway worktree; it refuses nothing except tree-state mismatches,
  and its numbering now uses base-10 (`10#`) — octal `0008` used to
  crash it.
- **The wasm TB layout**: `tb->tc.ptr` points at the TCI stream;
  every TB starts with `tci_tbhdr` (icount) — chain jumps and
  `lookup_tb_ptr` targets all pass through it.  Anything that jumps
  into a TB must land on the header.

## Session checklist

1. `git log` / `ls patches/` — see where the series stands.
2. Serve dist, run `bootbench` twice — establish today's baseline.
3. Profile, pick ONE target, check the rejected list first.
4. Patch → build → bench twice → keep/revert → capture with a measured
   header.
5. `node tests/run.mjs --label <name> --timeout 240` + wasm boot soak.
6. Update this playbook's tables (landed/rejected/remaining) and the
   README patch list.
