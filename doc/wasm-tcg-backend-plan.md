# A real WASM TCG backend — feasibility verdict and plan

Status: **LANDED** — the backend described here ships as `site/dist-jit`,
the page default for every board since 2026-09-12 (commit 0017 on the
`qemu/` submodule branch plus its follow-ups 0019–0038; see
[architecture.md](architecture.md)). What follows is the design record
and the phase log as it was written; current numbers and open items live
in [performance-handoff.md](performance-handoff.md) and the playbook.
The "TCI parity" reading below was later shown to be phase cancellation
(the JIT lost early and won late); the early phase was then fixed by the
module economy and Asyncify work.

Phase log (2026-09-09: **phase 0a done** — the guest op-suite
below is implemented in [tests/tcg-isa/](../tests/tcg-isa/), gate
`scripts/run-tcg-isa.sh` green on all three backends (native JIT, native
TCI, wasm TCI page: 1156/1156 each, serial byte-identical, ~8 s total);
2026-09-10: **phase 0b done** — the lockstep harness is implemented
([tests/lockstep.c](../tests/lockstep.c) plugin + `tools/lockstep.mjs`
driver + `scripts/run-lockstep.sh` gate), green over 3 full S75 boots:
JIT vs TCI, 2.5G guest insns each (whole boot through idle), 2385+
register-digest epochs + 298 SRAM/SDRAM memory digests identical per run,
serial byte-identical, ~6 min wall for all three runs in parallel;
supersedes the "port a native wasm TCG backend" idea in
[performance-handoff.md](performance-handoff.md) §1 with what was learned
from actually trying it.
2026-09-11: **phase-3 next-slice selection now measurement-gated** — a
first end-to-end "boot to idle screen" benchmark landed
(`tools/idlebench.mjs`, committed reference `tools/test_targets/
S75v40lg1_idle.png`, bottom-139-rows compare — see §5 phase-3 status), and
an early-window wprof2 profile of the phase-3 backend shows the window is
*not* MMIO-bound (top: dispatcher 15 %, per-TB-entry accounting import
8.3 %, lookup_tb_ptr 3.7 %, temp-module instantiate ~3 %) — the §4.7
MMIO-fast-path premise must be re-verified against a late-window profile
before any emitter work. 2026-09-11 (later): **the late-window profile
killed the §4.7 premise (MMIO absent from the top in both windows) and
slice 2 — inline TB accounting — landed the same day**: v=2..7 window
−16 % (36.6→30.7 s vs the import-call fallback), and on the idlebench
human metric /dist-jit is now statistically indistinguishable from
/dist (median 76.4 s both, 9+9 interleaved runs; was +8–10 % behind).
2026-09-11 (latest): **tcgbench landed — the fast-iteration perf bench
on versatilepb, and the device/icount-tax mirrors priced the remaining
gap**: compute 562 MIPS sustained = **7.4× the TCI page** on the bench
(the verdict's "compute 3–10×" hit the top of its range; per-phase up
to 18×), but **1.07× on MMIO-dense phases** — the dispatch tax (~590 ns
wasm vs ~224 native vs ~632 TCI) is shared qemu-core cost, so the
device-bound phone boot sits at TCI parity on a ~10× compute reserve it
cannot spend.  icount shift=3 measured FREE on short-TB workloads now
that TB accounting is inline.  Phone-firmware boots are final gates
only from here on.
Note: the "JIT ~1.3–2.3x" numbers in
[optimization-playbook.md](optimization-playbook.md) belong to the
discarded wasm32/ktock port, not this backend.)

Question on the table: *stop micro-optimizing TCI ("qemu for JS through
hacks") and instead add a proper TCG backend that emits WASM — wasm bytecode
is conceptually just another machine code, so this should be solvable.*

**Verdict: yes, solvable and worth doing — but only as a redesigned backend,
not as a re-adopt of ktock/qemu-wasm.** This repo already ran that design:
the wasm32 runtime-JIT port (old 0005, rebased 2026-09-09) measured a
**~1.3–2.3x ceiling** over TCI and was discarded
([wasm32-port-status.md](wasm32-port-status.md),
[patches/attic/wasm32-rebase/](../patches/attic/wasm32-rebase/)). The failure
was architectural, not fundamental: every identified cause has a known fix,
and the wasm platform has since shipped the features the fix needs. Realistic
expectation for the redesign: **compute 3–10x TCI, end-to-end ~2–4x
(≈30–60M guest insns/s)** — bounded by the device-model MMIO tax, not by
code quality. That clears the ≥50M insns/s "comfortable boot" bar from
[performance-handoff.md](performance-handoff.md); it is not a 100x.

## 1. What the prior attempt proved (and why it capped at ~2x)

Facts from the 2026-09-09 head-to-head (S75, v=2..7 window, quiet host):

| build | window |
|---|---|
| TCI (0001–0016) | 24.8–28.3 s |
| wasm32 JIT (ktock design, rebased) | ~17–20 s |

The JIT wins ~1.3x quiet / ~2.3x loaded, then plateaus. Root causes, all
structural to the ktock architecture:

1. **TCG regs as wasm globals.** Every TCG value op pays `global.get` +
   `global.set` — the engine stays memory-bound exactly like TCI. Codegen
   gains don't materialize if every operand round-trips linear memory.
2. **Per-boundary dispatch.** TBs here average **3–4 guest insns** (branchy,
   polling firmware). At ~4–5M TB entries/s, the protocol
   *wasm instance return → C dispatch loop → `call_indirect` into next
   instance prologue* (~30–100 ns) is the single dominant cost. A wasm JIT
   only pays off if TB-to-TB control flow never leaves wasm.
3. **One `WebAssembly.Module`+`Instance` per TB**, compiled through the JS
   boundary on first execution — a per-TB floor cost plus a whole instance
   lifecycle failure domain (15000-alive cap, FIFO eviction,
   FinalizationRegistry GC pressure — see `wasm32.c` in the attic).
4. **No value-level correctness harness.** The killer bug was a *data*
   divergence (USART RIS poll loop read a wrong value; PC flow identical for
   470k+ TBs). PC tracing cannot see this class of bug; it took the whole
   session to localize and was still unfixed at discard.

Also proven: the platform primitives work — shared-memory imports, table
growth (`addFunction`), cross-instance calls, hot-TB tiering with a TCI
fallback (which is why the JIT booted at all).

## 2. Prior art check (2026-09-09/10)

- **[ktock/qemu-wasm](https://github.com/ktock/qemu-wasm)** — alive (last
  commits Sep 2025), same architecture as our discarded rebase: per-TB
  `WebAssembly.Module`/`Instance`, regs as globals, C dispatch between
  instances, tiering at 1000 executions/TB, TCI fallback. **No tail calls,
  no batching.** Their demos boot x86_64/aarch64/riscv64 Linux — long,
  straight-line TBs where per-TB costs amortize; our 3–4 insn/TB firmware is
  the worst case for that design. Upstreaming effort is real and ongoing:
  TCI-for-32bit-guests merged in QEMU 10.1; the TCG JIT-mode series is at
  PATCH v2 on the list — **track it**, our fork (qemu 11.0.92 base) is close
  to the series base and their emitter coverage (~3.5k lines) is directly
  reusable as a reference.
- **[copy/v86](https://github.com/copy/v86)** — production wasm emulator
  whose JIT compiles x86 basic blocks to wasm through the browser
  `WebAssembly` APIs: proves the "generate wasm at runtime, browser compiles
  it" model works in production, and independently converged on the same
  lessons (batch/block batching, caching, module-count discipline).
- **No in-wasm compiler exists** (the wasm-jit-api/executable-memory
  proposals are not shippable) — the browser `WebAssembly` API remains the
  only compiler, so a JS-boundary at *translation* time is unavoidable.
  That's fine: it's off the execution hot path.

What we can take from ktock today: the tcg-target API surface for wasm
(`tcg-target*.h`, constraint sets, op-coverage list as an emitter reference),
the trap list (below), and eventually upstream fixes. What we must **not**
take: the dispatch/instance design (measured ceiling above).

## 3. Platform readiness (all verified shipped)

| need | status |
|---|---|
| `return_call_indirect` (tail calls) | baseline in all four engines (Chrome 112+, Firefox 121+, Safari 18.2+) — this is what makes "never leave wasm" possible |
| memory64 (i64 addressing of the shared heap) | Chrome 133+, Firefox 134+; the page *already* requires this (main module is wasm64) — no new constraint |
| shared Memory + shared Table imports across modules | standard; cross-instance `call_indirect` is an engine-level direct call, no JS hop |
| async off-thread `WebAssembly.compile` | V8/SpiderMonkey compile off-thread; tier-up need not stall the vCPU |
| wasm-EH longjmp across module frames | emscripten `-sSUPPORT_LONGJMP=wasm` unwinds through foreign (TB-module) frames; TB code never catches |
| emscripten link flags | `-sALLOW_TABLE_GROWTH` already in our link flags; main module exports table+memory, TB modules import them |

Trap list to carry over from the attic (all bit us once):
`tcg_insn_unit` truncation (don't reuse TCI emitters — emit raw bytes from
the new backend), tci.c interpreter-split aliasing regression (−60%), the
Firefox `HEAP8.slice` copy requirement for module bytes, emscripten TLS with
dynamic initializers, `i64` loads over 4-byte TLB fields.

## 4. Target architecture — "wasm64 tail-call backend"

One sentence: **TB functions live in batched wasm modules, chain via tail
calls through a shared funcref table, keep TCG values in wasm locals, and
exit to C by return code only.**

1. **TB = one wasm function** `(func (param $ctx i64) (result i32)`,
   assembled into **batched modules** (128–1024 TBs per
   `WebAssembly.Module`, compiled asynchronously off the vCPU thread; fresh
   TBs run on TCI until their batch lands — one-shot BROM/init code is
   never wasm-compiled).
2. **TCG regs as wasm locals.** V8/JSC/SpiderMonkey SSA-allocate locals;
   spill to `env`/ctx only at TB boundaries and around helper calls. Kills
   the per-op global traffic that held the old port at ~2x.
3. **Tail-call chaining.** `goto_tb` →
   `return_call_indirect $tbsig (local.get $ctx) (i64.load $chain_slot)`.
   The shared funcref Table maps TB index → function; **chaining = writing
   the target index into the TB's chain slot in linear memory** (patching
   *data* sidesteps wasm code immutability); unchained/invalidated slots
   point at a bailout trampoline that returns to the C dispatcher.
   `tb_add_jump`/`tb_phys_invalidate` map 1:1 onto slot writes; SMC
   invalidation also resets the table entry via a freelist. No frame growth
   — tail-call semantics.
4. **Exits by return code, never longjmp from TB code**: interrupt pending /
   icount deadline / TLB flush / helper-requested unwind. Helpers that can
   `cpu_loop_exit` are called through a C trampoline guarded by setjmp
   (wasm-EH unwinds the foreign frames correctly); SVC can reuse the inline
   exception exit from patch 0013.
5. **Inline TLB fast path in emitted code** — the same probe TCI got in
   0011/0012 (`mask`/`table` compare + size-specialized load/store), miss →
   imported `helper_*_mmu`.
6. **icount**: prologue decrements a ctx deadline by `tb->icount`, returns
   `EXIT_ICOUNT` when exhausted. The stock `shift=3,sleep=off` model stays
   byte-for-byte identical (deadlines are instruction-proportional —
   correctness must not depend on this backend at all).
7. **MMIO / device-dispatch follow-up** (separate from the backend;
   re-scoped by measurement 2026-09-11).  The original premise — "at ≥4x
guest speed, device dispatch becomes ~30–40 % of the profile" — is
**dead at current speeds**: MMIO dispatch is absent from the top of both
boot-window profiles (early and late).  What the tcgbench tax mirrors
pinned instead: a single MMIO access costs **~590 ns on wasm64,
~632 ns on the TCI page, ~224 ns on the native JIT** (RAM access:
4.7 / 52.8 / 1.5 ns) — the wasm64-vs-TCI delta on MMIO is ~7 %
(shared path), while the ~2.6× native-vs-wasm multiplier sits in the
whole TLB-miss → `*_mmu` helper → memory.c FlatView →
device-callback path, independent of backend compute speed.  So the
lever exists but lives in **qemu-core** (per-region callback caching in
the FlatView, in the spirit of 0016 — where it would also help /dist
and native), NOT in memory.c (rejected there on TCI) and NOT in the
wasm64 emitter.  It is not the next thing to build — boot profiles say
so — but tcgbench's `rampoll`/`mmiopoll` mirrors are its clean
before/after metric the day it is.

## 5. Plan — phases, gates, effort

Tooling: `tools/bootbench.mjs` (A/B windows), `tools/rawspeed.mjs`,
`tools/wprof2.mjs` (CPU profiles), `tools/tracediff.mjs` (PC traces),
the op-suite runner (`tools/tcgisa.mjs` + `scripts/run-tcg-isa.sh`,
below), the lockstep harness, and **`tests/tcgbench` +
`tools/tcgbench.mjs` (2026-09-11: the fast-iteration perf bench on
versatilepb — per-phase backend attribution in ~10 s/leg; doubles as
the device/icount-tax bench via `rampoll`/`mmiopoll` mirrors and
`ICOUNTS=0,1`; phone boots are final gates only)**. Every phase ends
boot-clean on S75 *and* LG (no-icount).

- **Phase 0a — guest op-suite (quick per-op debugging; the lesson of the
  failed attempt made cheap).** A bare-metal ARM926EJ-S test image,
  compiled with `arm-none-eabi-gcc`, that exercises the guest instruction
  classes mapping onto TCG ops and prints TAP + raw computed values over a
  UART. One common harness for all tests; one test file per op class;
  every case asserts hand/oracle-computed `(value, NZCV)` pairs *and* dumps
  them for byte-exact cross-backend diffing. This is the "bisect by op"
  tool from phase 0 of the old plan — and the future wasm64 backend's
  per-op unit tests.
  - **Status: implemented 2026-09-09** — [tests/tcg-isa/](../tests/tcg-isa/)
    (README has the details), runner `scripts/run-tcg-isa.sh` +
    `tools/tcgisa.mjs` + the page's `?suite=` boot path
    ([site/app.js](../site/app.js)). Gate green: 1156 cases, 0 failures on
    native JIT / native TCI / wasm TCI page, serial byte-identical across
    all three, full run ≈0.3 s native / ≈3 s wasm (page load included
    ≈8 s). Two emulator behaviors pinned while authoring (documented in
    the suite README): qemu's `ror`-by-register with amount ≡ 0 (mod 32)
    carries C from bit 31 (v7 silicon: bit 0), and same-TB SMC executes
    the already-translated tail (ARM has no `precise_smc` — only
    i386/s390x do). One platform limitation found: the semihosting
    `SYS_EXIT` path kills the wasm page (exit from the vCPU pthread →
    `PThread.terminateAllThreads` tears the renderer down before
    `onExit` runs) — the page image parks after printing and the runner
    verdicts from the TAP text instead; also relevant for phase 1+ exit
    design.
  - **Machine: `-M versatilepb`** (not pmb887x): same arm926 core, zero
    board/BROM/flash dependencies, and — verified — already compiled into
    the shipping wasm build (`CONFIG_VERSATILE`, `CONFIG_PL011`,
    `CONFIG_GENERIC_LOADER` are set in `build/qemu-wasm/arm-softmmu-
    config-devices.mak`), so **no qemu changes at all** are needed for the
    whole suite. Load via `-kernel` (raw image at 0x00010000, entry there,
    qemu's 0x0 bootloader sets r0=0/r1=0x183/r2=atags at 0x100 — below the
    image, no clobber observed); terminate via semihosting `SYS_EXIT`
    (`svc 0x123456`) → clean process exit (wasm page: the existing
    `onExit` hook).
  - **Output: PL011 UART0 at 0x101F1000** (gotcha: 0x10009000 is UART3) →
    `-serial file:` natively / `/serial.log` in the browser page; qemu
    drains DR writes even without CR/LCRH init, so the harness is ~30
    lines. Format: TAP (`ok/not ok n - name`, `1..N`, `# result:`) +
    `# name: v=XXXXXXXX f=NZCV` dump lines — human-verdict + machine-diff
    in one stream.
  - **Coverage** (guest insn → TCG ops under test): `adds/subs/rsbs/adcs/
    sbcs` incl. flag matrices (add/sub/adc/sbc/setcond, add2/sub2);
    `ands/orrs/eors/bics/movs/mvns` with preset C/V (and/or/xor/andc,
    N/Z-only flag rules); shifts imm/reg incl. amount 0/31/32/33 and RRX
    with both C values (shl/shr/sar/rotl/rotr + carry-out); `mul/mla/
    umull/umlal/smull/smlal` boundary values (mulu2/muls2, 64-bit add);
    `clz`; `ldr/str` all widths + `ldrsb/ldrh/ldrsh` sign-extends +
    unaligned word semantics (qemu_ld/st MO_* matrix, the patched inline
    TLB fast path and size-specialized forms 0011/0012);
    `ldrd/strd`/`ldm/stm` incl. writeback modes; `swp/swpb` (atomics);
    `qadd/qsub/qdadd/qdsub` (saturation → setcond/min/max);
    `msr/mrs` flag round-trips (cpu-context moves); ARM↔Thumb interwork
    (second frontend); self-modifying code (TB invalidation path) and a
    mixed-size memory-stress checksum. Not covered: guest division insns
    (arm926 has none — TCI div ops are unreachable for this target) and
    floats (no FPU; softfloat is helpers).
  - **Run matrix & oracle:** native JIT build → native TCI build → wasm
    TCI dist (page param to pass `-M versatilepb` + kernel file; serial
    compared via `/serial.log`). Expected values are authored from the
    **native JIT as the reference** (emulator semantics — e.g. this qemu
    serves pre-v6 unaligned `ldr` as a natural LE load, not the v5
    rotation; silicon would differ). *Gate: suite green on all three and
    byte-identical serial output; full run < 1 min per backend.*
  - Smoke-verified 2026-09-09 (native JIT + native TCI, byte-identical):
    `-kernel` load/entry, `adds` flag values (0x9/0x6), `msr/mrs` presets,
    unaligned `ldr`, semihosting exit (exit code 0).
  - Later: the same image doubles as the wasm64 backend's op-level unit
    tests (phase 1/2 gates) — one suite, three backends, plus optional
    `?jit=shadow` double-execution on wasm.
  - Rejected/superseded detours (kept for the record): running the tests
    on the pmb887x machine via the BSP's `unit/` framework +
    `chaos-boot.pl` (BROM serial-upload of a pv-boot loader — works, but
    needs serial *input* plumbing on the wasm page and drags in board
    state; revisit for board-level device tests); a `PMB887X_BOOT_BLOB`
    qemu hook (unneeded — `-kernel` does it for versatilepb).
- **Phase 0b — lockstep harness (whole-boot guarantee).**
  Value-level diff of guest state (regs + selected memory) per TB between
  TCI and the new backend, natively first (easy to drive, both backends
  from the same tree), then on wasm. Divergence → bisect by op with the
  phase-0a suite (per-op shadow evaluation). *Gate: 0 divergences over 3
  full S75 boots.* ~3–5 days. Non-negotiable before any emitter work.
  - **Status: implemented + gate green 2026-09-10** —
    [tests/lockstep.c](../tests/lockstep.c) (TCG plugin) +
    `tools/lockstep.mjs` (driver) + `scripts/run-lockstep.sh` (gate;
    `scripts/build-native-tci.sh` builds the plugin-enabled TCI side —
    upstream configures plugins off with TCI by default, CI cost not
    incompatibility). Zero qemu changes. Gate: 3 × full S75 boot
    (2.5G guest insns, through the idle screen), JIT vs TCI — every
    epoch digest and memory digest identical, serial byte-identical;
    positive control (`--corrupt`: 1-bit r0 flip at a chosen insn)
    flags the epoch and pinpoints the exact insn + register in the
    dense rerun. el71 smoke and `--self` (JIT vs JIT) clean.
  - **Design (the three qemu properties it owes to, measured 2026-09-10):**
    1. *TB partitioning is TCG-internal, not guest state.* First cut
       folded (vaddr, n_insns) per TB — diverged at ~124M insns with
       *identical registers*: the icount refill path
       (accel/tcg/cpu-exec.c, `cflags_next_tb | insns_left`)
       retranslates deadline-capped TBs and the exact cap depends on
       generated-code expiry behavior (JIT 70-insn TB vs TCI 69-insn TB
       at the same pc, same executed stream). Fix: sample on a counter
       of **executed guest instructions** — inline add per insn +
       `QEMU_PLUGIN_COND_GE` conditional callback (C work only at
       sample points); the digest stream is a pure function of the
       guest program, so any two backends are comparable.
    2. *Plugin register reads need `QEMU_PLUGIN_CB_R_REGS`* — TCG syncs
       dirty globals to env around such calls (that's what makes the
       values architectural); and `gdb_get_reg32` **appends** to the
       caller's buffer (truncate between reads — the first run was
       green but vacuous, every register reading back r0's bytes).
    3. *Per-insn global sync costs ~100x inside multi-insn TBs*
       (0.25 MIPS on S75 — the allocator can't keep globals in host
       regs). Under `-accel tcg,one-insn-per-tb=on` the same
       instrumentation runs at **~40 MIPS JIT / ~9.5 MIPS TCI** —
       nothing to keep alive across a 1-insn TB. The driver boots both
       sides with it (also makes TB boundaries insn-aligned on every
       backend — the natural execution shape for the wasm64 backend's
       per-TB functions anyway).
  - **Determinism findings:** the one real nondeterminism source is the
    pmb887x RTC seeding from host time (`qemu_get_timedate` in
    hw/arm/pmb887x/rtc.c) — pin with `-rtc base=2000-01-01T00:00:00,
    clock=vm` (under `-icount` the vm clock is guest-driven; the gate
    is therefore S75/el71-class icount boards — LG boards run
    `run-native.sh`'s no-icount path on the host realtime clock and
    aren't digest-comparable). Everything else (devices, DSP handshake,
    flash writes) is value-deterministic across backends for whole
    boots — that is the phase-0b result the emitter work now stands on.
  - **Cost:** full-boot gate ≈ 6 min (3 runs parallel, TCI-bound at
    ~9.5 MIPS instrumented); dense localization rerun over one epoch
    (2^20 insns) ≈ 30 s. Throughput numbers say per-insn sampling is
    affordable natively; on wasm the same instrumentation will ride
    the built-in patch (below).
  - **wasm leg (follow-up for phase 1):** the wasm build can't dlopen
    plugins — port the fold logic (~200 lines) into a small built-in
    qemu patch compiled into the wasm build, emitting the same log
    format into MEMFS (`/lockstep.log`, like `/serial.log`); the
    driver is format-driven and already backend-agnostic (it only
    compares two logs + serial).
  - Also pinned while building: qemu 11 forces plugins off for TCI in
    configure (`7866b0f721`) — `meson configure -Dplugins=true` on the
    TCI build dir re-enables them and TCI executes plugin callbacks
    correctly (verified byte-identical against the JIT over full
    boots).
- **Phase 1 — backend skeleton.** `tcg/wasm64/` target files (reg model =
  abstract locals, constraints modeled on ktock's but i64-addressed),
  conservative emitters for all ops (rare ops may call a C helper — e.g.
  128-bit moves), single-TB modules, **no chaining** (every TB returns to
  C). *Gate: lockstep-clean full boot; expect ≈TCI speed (dispatch still
  via C) — correctness only.* ~1–1.5 weeks.
  - **Status: implemented 2026-09-10; full-boot gate pending** —
    `tcg/wasm64/` (TCGOutOp-table emitters, per-TB standalone wasm modules,
    regs as typed i32/i64 locals, MMU always via `*_mmu` helper imports,
    single `loop` + region-`if` label scheme, no chaining — every TB returns
    to the C `tcg_qemu_tb_exec` dispatcher). 1156 op-suite tests green;
    full S75 boot reaches the same standby UI as TCI (~2x slower).
    Lockstep: built-in env-driven fold in `wasm64.c` (W64_LOCKSTEP*,
    byte-identical E/M/T/X log to `tests/lockstep.c`, regs via
    `gdb_read_register`, memory via chunked `cpu_memory_rw_debug`), plus
    `tools/lockstep-wasm.mjs` (native reference JIT vs wasm64 in headless
    Chromium, grabs `/lockstep.log`+`/serial.log` from page FS at exit).
    20M-insn gate clean: serial byte-identical + internal-SRAM digest
    byte-identical (the HARD fields); register E-lines and the SDRAM slice
    are SOFT — the emscripten leg is not wall-clock-deterministic (the
    main loop interleaves with the vCPU thread differently run-to-run, so a
    few SDRAM bytes / the transient register vector differ; the firmware's
    visible behaviour — serial, CPU-local SRAM, full boot — is identical).
    Full-gate attempt #1 (3 × 2.5e9) timed out with no wasm-side output:
    the driver had no live visibility into the browser leg and skipped the
    partial grab on timeout, and the null `mem` arg silently re-enabled
    the 16MB full-SDRAM digest. Driver fixed (live E-line progress via
    page FS, 1MB SDRAM slice default, timeout salvage). Attempt #2 with
    the fixed driver exposed the real wall: all legs freeze at exactly
    761,266,176 insns with renderer RSS ~7.2GB — per-TB module+instance
    accumulation under one-insn-per-tb (~800k live modules, no eviction)
    exhausts the renderer. **Conclusion: the 2.5e9 one-insn-per-tb gate is
    architecturally blocked until phase-2 batching/eviction lands** —
    interim gate = 700M-insn windows (just under the wall) + the op-suite;
    the full gate moves to the batched backend, where it also gets fast.
    Also discovered: S75/el71 fullflash boots are UART-silent (all serial
    logs 0 bytes) — the "serial byte-identical" check has been vacuous;
    the HARD behavioral anchors are the internal-SRAM digest and clean
    budget/exit (an LCD-frame digest in the fold is the natural upgrade).
- **Phase 2 — chaining, batching, tiering.** Shared table + chain slots +
  tail calls; batched async compilation; TCI as the cold tier.
  *Gate: ≥2x TCI on the v=2..7 window; live modules < 100; vCPU never
  stalls > 5 ms on a batch compile.* ~1 week.
  - **Status: chaining landed 2026-09-10 (split, per the no-45-min-wait
    rule)** — `goto_tb` reads `tb->jmp_target_addr[n]` (qemu-core-
    maintained, TCI-style) at runtime and tail-calls the target through
    a shared funcref table (`return_call_indirect`); unlinked slots fall
    through so `tb_add_jump` links the pair; TB prologues call an
    imported `w64_tb_account(icount)` at every entry (icount2 + lockstep
    fold stay per-TB-entry exact while chained); a `w64_chain_stop`
    brake unwinds chains at the lockstep budget. Validated with the
    op-suite (1156/1156) + 20M/250M lockstep windows (HARD SRAM digests
    identical). Measured: v=2..7 window 45.9s → 38.4s; TCI reference on
    the same host 24.4s (so 0.63x TCI — batching + the phase-3 TLB
    inline are still needed for the ≥2x gate; the finalV gap, 66 vs 165,
    says the MMIO-heavy later boot hurts most, as predicted §4.7).
    Bring-up found a second emscripten -O3 artifact: the prelude
    custom-section filler miscompiled a reassigned `content` (computed
    127, emitted LEB 255) exactly at the content==127 boundary that the
    chaining's +19 prelude bytes exposed — worked around by precomputing
    bytes into locals (same class as the phase-1 typecode bug; if a third
    appears, consider -O2 for tcg/tcg.c).
  - **Status: batching landed 2026-09-10 — the 761M wall is gone.**
    Every TB still executes immediately through a single-member **temp
    module** (phase-2a path unchanged) and simultaneously joins the open
    batch; every N=128 members one batch module is assembled (union
    type/import tables, `call` operands rewritten in place from
    fixed-width 2-byte LEBs recorded at emission, one active element
    segment per member registering it into the shared chain table at its
    tidx, one `run(env,sp,tp,tidx)` thunk) and instantiated synchronously;
    members flip to the thunk (desc+4 = 0x80000000|batch id), temps are
    `removeFunction`d and GC'd. tb_flush tears down batches, temps, TAB
    and recycles the tidx space. goto_tb gained a target-fidx brake for
    future LRU eviction. **Gates: 20M (incl. W64_BATCH_N=4) / 250M / 700M
    clean and the full 2.5e9 one-insn-per-tb gate passes 3/3** (298 HARD
    SRAM digests + serial identical per run, wall ~795s each) with
    renderer RSS flat ~1.9–2.1GB throughout (was: OOM at exactly
    761,266,176 insns,
    ~7.2GB). Boot window 38.0–38.4s batched ≈ nobatch (0.58x TCI —
    unchanged, as expected: that window is MMIO/helper-bound; phase 3 is
    that lever). Async compile / TCI cold tier deferred until profiling
    shows the sync hiccup matters; LRU cap deferred (RSS plateau says
    ~live_TBs/128 instances ≈ 6k at the 800k-TB working set is fine —
    revisit on longer soaks). Bring-up found one more trap, this time
    self-inflicted: distinguishing batch ids from mod_len in desc+4
    needs a tag bit, else every fresh temp TB trips the "evicted member"
    abort on first dispatch.
- **Phase 3 — hot-path tuning.** Inline TLB probe, size-specialized
  loads/stores, direct imports for top helpers (ld/st mmu, `lookup_tb_ref`,
  ARM div/rem). *Gate: ≥3x end-to-end vs the current TCI dist — target
  ~45–60M insns/s sustained, S75 idle screen < 90 s.* ~1 week.
  - **Status: slice 1 (inline TLB probe + size-specialized ld/st) landed
    2026-09-10** — `qemu_ld/st` emit the tci_tlb_probe semantics inline
    (`tlb_mask_table_ofs`, page|alignment compare, flags-in-window
    misses) + a size/sign-specialized wasm access at `addr+addend`; miss
    falls to the phase-1 `*_mmu` helper arm (`W64_NOTLB=1` disables).
    Gates: op-suite 1156/1156 (incl. `W64_NOTLB`/`W64_NOBATCH` knob runs
    — which also caught a page bug: `?env=` was only wired into the
    phone-boot path, not `bootSuite`); lockstep 20M/250M/700M + the full
    2.5e9 one-insn-per-tb gate clean on this backend. Perf: v=2..7
    window 38.1→31.8 s (0.78x TCI's 24.7), finalV@110 s 164 vs phase-2's
    69 (TCI 151) — end-to-end boot progress ≥ TCI.  Bring-up found a
    genuine emitter bug (ldrd with `data == addr`: the hit arm's
    `local.set` flipped the tracked representation between the two
    arms' emissions — fix: snapshot zext(addr) into $scr2; diagnosed by
    dumping the TB module bytes + `wasm-dis`).
  - **Status 2026-09-11: slice selection is now measurement-gated.**
    Two inputs changed the plan:
    1. **A user-side regression report forced a real end-to-end
       benchmark into existence**: on the user's machine, boot-to-idle on
       /dist measured 73 s at 2:26 PM and 80 s later that day, and /dist-jit
       was reported "an order of magnitude slower". The new
       `tools/idlebench.mjs` (below) pins the protocol: S75v40lg1.bin
       fullflash, `tools/test_targets/S75v40lg1_idle.png` reference, only
       the bottom 139 LCD rows compared (everything above animates at
       idle), startup=ONLINE, fresh headless browser per run, run config
       + artifact hashes in `tests/results/idlebench-latest.json`.
       **First results (this host, 2 runs each): /dist 70.4/74.4 s,
       /dist-jit 78.4/78.4 s to idle (v≈51.5, pct-diff ≤0.08 % at match,
       zero W64 diagnostics)** — i.e. the wasm64 backend is ~8–10 %
       behind TCI on the human metric, and the reported 10x is NOT in the
       served artifacts. The 73→80 s /dist delta is within the playbook's
       ±5–8 % single-run noise band. Next: the user re-runs the same
       protocol on their machine (same flash + reference + fresh reload);
       if their /dist-jit still shows 10x it is environment-specific
       (Chrome version / machine state) and the new /w64bad-* forensics
       will capture whatever fires.
  - **Status 2026-09-11 (later): slice selection resolved by
     measurement — slice 2 (inline TB accounting) landed the same
     day.** The two inputs above resolved as follows:
    1. The idlebench item stays as written (user-side repro pending;
       this host's numbers below move the baseline).
    2. **The late-window profile ran (`PROF_DELAY=115`, v≈132–209, the
       poll-heavy phase) and killed the §4.7 premise**: MMIO dispatch
       is absent from the top in BOTH windows. vCPU self-time:
       `w64_tb_account` **9.1 %** (early window 8.3 % — the #1 real
       consumer in both), `cpu_exec_loop` 7.1 %,
       `helper_lookup_tb_ptr` 4.1 %, emscripten mailbox/futex-wake
       ~8 %, MMIO — nothing. **No MMIO fast-path work** — the
       playbook's rejected table already killed the memory.c-level
       version on TCI; now the whole lever is dead at current speed.
    3. **Slice 2 = the measurement's #1 target: the TB accounting is
       now emitted inline.** The prologue performs `wasm_tb_stats[0]++
       / [1]+=icount` (plain RMWs, exactly what the C compiles to)
       and the `icount2_advance` fast path (`i64.atomic.load`/`store`
       on `icount2_ticks` — matching the relaxed `qatomic_*` clang
       emits; opcodes pinned empirically: `fe 11` load / `fe 18`
       store) with imports only for the rare tails:
       `w64_icount2_sync_now()` (deadline crossed — BQL+`icount2_sync`,
       byte-equal to `icount2_advance`'s tail) and
       `w64_lockstep_account(icount)` behind an `i32.load` of
       `w64_ls_on` (one load when the fold is off; the fold's lazy
       init moved from the first account call to `w64_init`).
       `W64_NOACCTINLINE=1` reverts to the old single import call
       (A/B knob + fallback). Wasm lesson: integer casts of addresses
       are NOT static-initializer constants — `w64_acct_addr[]` is
       filled lazily at the first translation (which precedes the
       first exec).
       - **Gates**: op-suite 1156/1156 (plain + `W64_NOACCTINLINE` +
         `W64_BATCH_N=4` knob runs); lockstep 20M + 250M clean
         (exact budget stop both legs, HARD SRAM digests identical);
         full 2.5e9 one-insn-per-tb gate — see the progress log.
       - **Perf (bootbench, 2×2 interleaved, pair-wise dominant)**:
         v=2..7 window **36.6/37.1 s → 30.7/30.9 s (−16 %)**;
         finalV@110 s 90.1/90.2 → 105.8/108.6. **idlebench (the
         human metric, 9+9 interleaved runs)**: /dist 74.4–76.4 s
         (median 76.4) vs /dist-jit 74.4–76.5 s (median 76.4) — **the
         wasm64 backend is now statistically indistinguishable from
         TCI on boot-to-idle** (was +8–10 % behind), both reaching
         identical guest state (v@idle ≈51, insns ≈1.35e9, tbs ≈246M;
         the metric saturates its 2 s sample grid once the gap drops
         below ~2 s). Phase-3's "idle < 90 s" gate is met with
         margin.
       - Remaining slice-3 candidates by the same profiles:
         `helper_lookup_tb_ptr` (3.7–4.1 %) via direct import /
         `lookup_tb_ref`, and the `cpu_exec_loop`+
         `tcg_qemu_tb_exec` dispatch slice (6–7 % + 2.5 %) — the
         classic next backend lever.  Weigh them against the tcgbench
         finding below: compute ceiling ≈562 MIPS ≈10× boot throughput
         — the device/icount tax now dominates end-to-end.
  - **Status 2026-09-11 (latest): tcgbench landed — fast-iteration A/B
     + the device/icount tax priced; the phase-3 gate honestly
     re-scoped.**  [tests/tcgbench/](../tests/tcgbench/) +
     `tools/tcgbench.mjs` (see the tooling line above) — the iteration
     loop from here on is **tcgbench → op-suite → lockstep windows →
     idlebench + full 2.5e9 gate at slice close**; phone boots are
     final gates only.  Findings that reframed the remaining work:
    1. **Compute ceiling: 562 MIPS sustained, 7.4× the TCI page** —
       the 5.3G-insn bench: native JIT 4.4 s, wasm64 13.7 s, TCI page
       101.0 s (per-phase wasm64-vs-TCI: alu 18×, mul/ldrd 11.7×, ldst
       10×, branch 6.9×, mix 10.3× — the original verdict's "compute
       3–10× TCI" hit the top of its range).  But **mmiopoll is 1.07×
       and mmiow 1.2×** — the MMIO dispatch tax is shared qemu-core
       cost, identical across wasm backends; the phone boot (device-
       bound) therefore sees parity while sitting on a ~10× compute
       reserve it cannot spend.  The knob A/B that validated the
       bench: `W64_NOACCTINLINE=1` → 3.05× slower (the pre-slice-2
       import call cost ~25 ns × 665M TB entries), `W64_NOTLB=1` →
       ldst/ldrd 13–17× slower — both exactly the slices that landed,
       with clean phase attribution.
    2. **Device dispatch tax, measured** (instruction-shape mirror
       phases over SRAM vs 4 inert MMIO regs, verified in disassembly):
       **590 ns/access wasm64 vs 224 native JIT vs 632 TCI page** (the
       2.6× vs native is the emscripten/qemu-core path — shared by both
       wasm backends, hence the 1.07× wasm64-vs-TCI on mmiopoll; RAM
       4.7 vs 1.5 vs 52.8 ns; MMIO write 379/166/454).  A qemu-core
       lever with a clean before/after metric now (see §4.7) — but not
       next, per the boot profiles.
    3. **icount shift=3 is FREE on short-TB workloads post-slice-2**
       (390 → 405 MIPS, within noise; TB sizes uncapped far from
       deadlines; v-clock sanity check confirms the model engages) —
       the stock timing model costs nothing measurable outside timer
       storms, which this workload can't generate (no guest timers
       armed on versatilepb — that slice of the boot tax still needs
       wprof on real firmware).
    4. **Phase-3 gate, honest status**: "S75 idle < 90 s" is met
       (median 76.4 s, = TCI parity); "≥3× end-to-end vs the TCI dist"
       is **not achievable by backend work alone** — the backend is
       already at TCI parity on the human metric while holding a ~10×
       compute reserve the boot can't spend.  Remaining end-to-end
       levers sit in qemu-core (device dispatch path, timer storms,
       main-loop/BQL overheads — the wprof mailbox/futex-wake ~8 %)
       where they help every backend; the emitter-side slices
       (`lookup_tb_ref`, dispatch loop) are now tail work by
       comparison.  Re-scope: phase 3 closes on the parity + gate-green
       + tooling above; the “≥3× end-to-end” ambition moves to a new
       qemu-core workstream with tcgbench/wprof as its meters.
- **Phase 4 — robustness.** SMC invalidation storms (flash unlock/write
  cycles), LG no-icount path, table-index recycling over 10⁶ translations,
  deterministic module lifecycle (no FinalizationRegistry), Chrome + Firefox
  parity. ~3–5 days.
- **Phase 5 (optional) — AOT cache.** Persist translated batches (keyed by
  fullflash hash + guest PC ranges) in Cache API/IndexedDB; preset
  fullflashes boot with zero translation cost on second visit.

Total: **~4–6 focused weeks** (phase 0a ≈ 2–4 days, 0b ≈ 3–5 days). The
dominant risk is emitter correctness (phases 0a/0b exist precisely to
contain it), not the wasm platform.

## 6. Risks / open questions

- Emitter value bugs on rare op combinations — the old divergence class.
  Mitigation: phase 0a (op-suite catches them at development time, in
  seconds) + phase 0b (lockstep over full boots) + keep TCI as permanent
  fallback tier + optional runtime sampling shadow-execution mode
  (`?jit=shadow`).
- V8 module/instance limits and compile-queue behavior under our
  translation rate (~10–20k TBs early boot) — batch-size tuning; measure
  with `wprof2`.
- Tail-call throughput through `call_indirect` on JSC/SpiderMonkey (we
  mostly care about V8/Chrome; the page already effectively targets
  Chromium-class browsers for wasm64+threads).
- Asyncify interaction: TB modules are never asyncified; the vCPU thread
  yields only via return-code exits → the 0009 futex wait path stays in C.
- End-to-end ceiling: originally feared "MMIO-bound at ~2x"; now
  measured (2026-09-11) — MMIO dispatch is absent from the top of both
  boot-window profiles, the per-access tax is 586 ns (2.6× native JIT,
  §4.7), and the boot rate (~55 MIPS) sits ~10× under the backend's
  compute ceiling (562 MIPS).  The ceiling is the device-model + icount
  machinery in qemu-core; fixing it helps every backend and has a clean
  meter (tcgbench mirrors + wprof), but it is separate work from this
  backend plan.

## 7. Non-goals

- Resurrecting ktock's dispatch design as-is (measured ceiling, §1).
- MTTCG (single-core target).
- Waiting for in-wasm JIT APIs; the browser `WebAssembly` API is the
  compiler, full stop.
