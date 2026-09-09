# wasm32 runtime-JIT rebase — verdict: DISCARDED (2026-09-09 session)

The 0005 DRAFT's unique payload (the ktock/qemu-wasm wasm32 TCG backend)
was fully rebased onto the current patch series (0001–0004 + 0007–0015),
built, boot-tested and benchmarked head-to-head against the TCI dist.
**The promised 10–100x gains are not real; the measured ceiling of this
architecture on this workload is ~1.3–2.3x, at a ~4200-line surface with
unresolved correctness bugs. The patch is discarded; the TCI series
stands as the shipping engine.**

## Measured results (tools/bootbench.mjs, S75 v=2..7 window)

| build | window (quiet host) | window (host load ~5) |
|---|---|---|
| TCI (0001–0015) | 24.8–28.3 s | 45–46 s |
| wasm32 JIT (rebased) | ~17–20 s (extrapolated; runs under load) | 18.7–20.1 s |

The JIT wins the early window ~1.3x quiet / ~2.3x under host load, but:

- sustained rate in its healthy phases ≈ 2x TCI at best — per-TB dispatch
  cost (wasm instance return → C dispatcher → indirect instance call per
  chained TB) eats the codegen gains on this 3–4 insn/TB branchy firmware;
- every new TB pays a JS-boundary WebAssembly.Module+Instance compile;
- instance lifecycle (15000-alive cap, FIFO eviction, FinalizationRegistry
  GC pressure) is a whole failure domain of its own.

## Correctness status at discard time

1. Guest execution has a deterministic **data-level divergence** vs TCI
   starting in the BROM boot: the poll loop at guest 0x4012a0
   (`ldr r0,[r1,#0x68]` on USART0 RIS, r1=0xf1000000) exits via timeout
   in TCI but loops forever in the JIT → the boot watchdog fires at
   v≈3.014 s → SCU_WDTRST recovery loop → the machine never boots past
   u=3 LCD updates (reproduced 100% deterministically; exec traces stay
   PC-identical for 470k+ TBs, so it is a value, not a path, divergence).
   Reproduction: `PORT=8082 node tools/iotrace.mjs 50` (TRACE=scu,dsp)
   vs 8080 — the JIT trace ends in `watchdog scheduled` spam.
2. The LG (KE800, no-icount) boot is completely dead in the JIT build
   (v=0 forever) — the non-CF_USE_ICOUNT TB prologue path breaks it.
3. The draft's ancient "TCI fallback crashes on first fallback TB" bug
   was root-caused and fixed during the rebase (see below) — the fallback
   interpreter now runs, but bugs 1–2 remain.

## Bugs found and fixed during the rebase (kept here for any future attempt)

1. **Emitter truncation (root cause of the draft's broken fallback):**
   the shared TCI emitters used `tcg_insn_unit insn = 0;` locals, but
   `tcg_insn_unit` is `uint8_t` in the wasm32 build
   (`TCG_TARGET_INSN_UNIT_SIZE 1`) — every `deposit32` truncated to 8
   bits, emitting bare opcodes with zeroed register/immediate fields.
   Fix: `uint32_t insn = 0;` in tcg/tci/tci-emitters.h.inc.
2. **Fallback dispatch protocol:** the draft's stock goto_tb/goto_ptr
   encodings cannot work in wasm32 TBs (a chained jmp slot holds the next
   TB's *prefix* pointer, not a TCI stream pointer). Added internal ops
   `tci_w32_next`/`tci_w32_next_r` that hand the next TB to the wasm32
   dispatcher via a thread-local context (tcg/tci.c, tcg/wasm32.c).
3. **tci.c split trap:** passing the interpreter stack in as a pointer
   (call_stack param) destroys LLVM's alias analysis in the interpreter
   loop — measured −60% v-window on the *TCI* build. The TCI stack is
   per-TB scratch; keep a single function with a local array and switch
   only the symbol name via #ifdef CONFIG_TCG_WASM32.
4. Emscripten TLS cannot hold dynamic initializers (`=&ctx`), and
   `emscripten_sleep` is unusable from the asyncify-removed dispatcher.

## Files

- `jit-rebase-worktree.diff` — full working-tree diff (rebase state at
  discard, including debug hooks used for the diagnosis).
- `wasm32.c`, `wasm32.h`, `tci-emitters.h.inc`, `tcg-target-dir/` — the
  rebased files (supersede the draft's copies).

## If anyone retries

The likely home of bug 1 is the wasm emitters' guest load/store or
setcond path under some op/width combination (the divergence is a VALUE
that never affects PC flow until the RIS poll branch). Binary-search by
forcing the fallback (`INSTANTIATE_NUM` high in wasm32.h) vs instances
per TB — with the emitter-truncation fix the fallback is now correct,
which isolates wasm-emitted TBs as the divergence source. Expect the
fix to lift correctness but not the ~2x ceiling.

## Design sketch: what "chaining inside one instance" would take

The structural lesson of this attempt: on a 3-4 insn/TB workload at
~4-5M TB entries/s, the ktock per-boundary protocol (wasm return -> C
dispatch loop -> call_indirect -> instance prologue, ~30-100ns) is the
dominant cost, and regs-as-wasm-globals (2+ memory ops per TCG value)
keeps the engine memory-bound like TCI. A design that actually moves
the needle needs both:

1. **Tail-call chaining** (`return_call_indirect`, wasm tail-call
   proposal - shipped in all major engines by ~2022-2023, verify
   targets): every TB is one function with signature `(ctx) -> i32`;
   goto_tb compiles to `return_call_indirect $tbsig (local.get $ctx)
   (i32.load CHAIN_SLOT)` - a true tail jump through a funcref table.
   Chaining = writing a table index into the TB's chain slot in linear
   memory (patching *data* dodges wasm code immutability); unchained/
   invalidated = slot points at a bailout trampoline that returns to C.
   tb_add_jump/tb_phys_invalidate map 1:1 onto slot writes. The C
   dispatcher shrinks to "enter first TB of a cluster, handle exits".
2. **TCG regs as wasm locals** (not globals): each TB body is one
   function, V8 SSA-register-allocates locals; spill to ctx only at TB
   boundaries and helper calls. Removes the per-op global.get/set
   memory traffic that kept this port at ~2x TCI.
3. **Batched instantiation + tiering**: many TBs per module (batch by
   translation window) so per-new-TB `WebAssembly.Module` compiles
   amortize; run fresh TBs on the (now correct) TCI fallback and
   promote hot ones into the next batch - one-shot boot code is never
   compiled.

Realistic ceiling: compute phases 3-10x TCI; end-to-end ~2-4x
(30-60M insns/s) - bounded by the device-model MMIO tax (~1-2us per
access, this firmware polls constantly; at 4x guest speed MMIO becomes
~30-40% of the profile). Enough to clear the >=50M insns/s bar, not a
100x. Before trusting any new emitter: build a per-op value-level
lockstep diff harness against TCI first - the divergence bug in this
rebase (see above) was invisible to PC-flow tracing.
