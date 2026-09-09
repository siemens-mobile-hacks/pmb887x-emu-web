# A real WASM TCG backend — feasibility verdict and plan

Status: **in progress** (2026-09-09: phase 0 started — the guest op-suite
below is specified and its loading path is smoke-verified on native
JIT/TCI; supersedes the "port a native wasm TCG backend" idea in
[performance-handoff.md](performance-handoff.md) §1 with what was learned
from actually trying it).

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
7. **MMIO fast-path follow-up** (separate from the backend): at ≥4x guest
   speed the ~1–2 µs/access device dispatch becomes ~30–40% of the profile
   (this firmware polls constantly). Per-region callback caching in the
   FlatView, in the spirit of 0016, is the next lever after the backend
   lands.

## 5. Plan — phases, gates, effort

Tooling: `tools/bootbench.mjs` (A/B windows), `tools/rawspeed.mjs`,
`tools/wprof2.mjs` (CPU profiles), `tools/tracediff.mjs` (PC traces), plus
the op-suite runner (`tools/tcgisa.mjs` + `scripts/run-tcg-isa.sh`, below)
and the lockstep harness. Every phase ends boot-clean on S75 *and*
LG (no-icount).

- **Phase 0a — guest op-suite (quick per-op debugging; the lesson of the
  failed attempt made cheap).** A bare-metal ARM926EJ-S test image,
  compiled with `arm-none-eabi-gcc`, that exercises the guest instruction
  classes mapping onto TCG ops and prints TAP + raw computed values over a
  UART. One common harness for all tests; one test file per op class;
  every case asserts hand/oracle-computed `(value, NZCV)` pairs *and* dumps
  them for byte-exact cross-backend diffing. This is the "bisect by op"
  tool from phase 0 of the old plan — and the future wasm64 backend's
  per-op unit tests.
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
- **Phase 1 — backend skeleton.** `tcg/wasm64/` target files (reg model =
  abstract locals, constraints modeled on ktock's but i64-addressed),
  conservative emitters for all ops (rare ops may call a C helper — e.g.
  128-bit moves), single-TB modules, **no chaining** (every TB returns to
  C). *Gate: lockstep-clean full boot; expect ≈TCI speed (dispatch still
  via C) — correctness only.* ~1–1.5 weeks.
- **Phase 2 — chaining, batching, tiering.** Shared table + chain slots +
  tail calls; batched async compilation; TCI as the cold tier.
  *Gate: ≥2x TCI on the v=2..7 window; live modules < 100; vCPU never
  stalls > 5 ms on a batch compile.* ~1 week.
- **Phase 3 — hot-path tuning.** Inline TLB probe, size-specialized
  loads/stores, direct imports for top helpers (ld/st mmu, `lookup_tb_ref`,
  ARM div/rem). *Gate: ≥3x end-to-end vs the current TCI dist — target
  ~45–60M insns/s sustained, S75 idle screen < 90 s.* ~1 week.
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
- End-to-end ceiling may be MMIO-bound at ~2x if phase-3 MMIO fast-path
  work doesn't land — keep it in scope as the immediate follow-up.

## 7. Non-goals

- Resurrecting ktock's dispatch design as-is (measured ceiling, §1).
- MTTCG (single-core target).
- Waiting for in-wasm JIT APIs; the browser `WebAssembly` API is the
  compiler, full stop.
