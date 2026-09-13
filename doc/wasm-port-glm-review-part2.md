# Wasm port review, part 2 — `tcg/wasm64` (the TCG backend)

Scope: **only** `tcg/wasm64/` in the `qemu` submodule (`wasm-browser-port` vs
`origin/master`, 43 commits).  Everything outside that directory is reviewed by
another agent (part 1).  Cross-file contracts (cpu-exec.c, tb-maint.c,
translate-all.c, getpc.h, icount2.c, wasm-diag.h, ui/wasm.c, tcg/tcg.c,
tcg/meson.build, meson.build) were read only to the extent needed to check the
backend's side of each contract.

Files reviewed (5,152 lines):

| file | lines | role |
|---|---|---|
| `tcg/wasm64/tcg-target.h` | 184 | target definition, TCG_TARGET_HAS_* |
| `tcg/wasm64/tcg-target-has.h` | 24 | extr/tst/extract-validity |
| `tcg/wasm64/tcg-target-con-set.h` / `-con-str.h` | 20/13 | constraints |
| `tcg/wasm64/tcg-target-mo.h` | 12 | memory ordering |
| `tcg/wasm64/tcg-target-opc.h.inc` | 4 | (no backend opcodes) |
| `tcg/wasm64/tcg-target.c.inc` | 2,752 | emitter + temp-module assembler |
| `tcg/wasm64/wasm64.h` | 173 | descriptor/batch layout |
| `tcg/wasm64/wasm64.c` | 1,970 | runtime: dispatcher, batching, lockstep |

Context established from the tree (used in severity calls below):

* The shipping build (`scripts/build-qemu-wasm64.sh`, verified in
  `build/qemu-wasm64/config-host.h`) has `#undef CONFIG_DEBUG_TCG`.  In that
  configuration `tcg_debug_assert(x)` compiles to `__builtin_unreachable()` on
  the false path — **it is not a guard**.  Every capacity check in the backend
  that uses `tcg_debug_assert` is therefore *unchecked in production*, and
  overflowing it is undefined behavior, not a clean abort.
* The guest is ARMv5TEJ (ARM926EJ‑S, pmb887x): no BFI/BFC (ARMv6T2), no PKH
  in ARM mode (`ENABLE_ARCH_6` gate, `target/arm/tcg/translate.c:4662`),
  no Thumb‑2 IT blocks.  This matters for reachability of several findings.
* Emscripten `addFunction` internals were read from the vendored emsdk
  (`src/lib/libaddfunction.js`) to confirm behavior of the sig strings and
  index reuse (see A5/B12).

---

## A. Bugs

### A1. `tgen_deposit` / `tgen_depositi`: wrong scratch local for `i32` — emits an invalid wasm module

`tcg/wasm64/tcg-target.c.inc:1871-1911`.  Both functions stage the shifted
field into the **type-matched** scratch (`w64_scr(t)` = `$scr32` for
`TCG_TYPE_I32`, `$scr0` for `TCG_TYPE_I64`) but then read it back from the
**i64** local `W64_L_SCR0` unconditionally:

```c
    w64_deposit_field(s, t, a2, 0, false, ofs, len);
    w64_local_set(s, w64_scr(t));          /* i32 -> $scr32 (local 68) */
    w64_get(s, a1, t);
    w64_const(s, t, ~(tcg_target_long)mask);
    w64_u8(s, t == TCG_TYPE_I32 ? 0x71 : 0x83);   /* i32.and */
    w64_local_get(s, W64_L_SCR0);          /* WRONG for i32: $scr0 is local 69, an i64 */
    w64_u8(s, t == TCG_TYPE_I32 ? 0x72 : 0x84);   /* i32.or */
```

For `t == TCG_TYPE_I32` this pushes an `i64` value onto a stack whose top is
`i32` and then emits `i32.or` — a **type mismatch**.  Any TB containing an
`INDEX_op_deposit` with type i32 produces a module that fails
`WebAssembly.Module` validation; `w64_instantiate` (wasm64.c:130) dumps it as
`W64DUMPC` lines and rethrows — the vCPU worker dies on first execution of that
TB.  The i64 path is correct (`w64_scr(I64)` *is* `W64_L_SCR0`).

Meanwhile `tcg-target.h` advertises `TCG_TARGET_HAS_deposit_i32 1` and
`TCG_TARGET_deposit_valid` returns 1 for every `ofs+len <= 32`
(`tcg-target-has.h:20`), so the middle-end and optimizer are free to produce
the op.

Reachability on the current guest: **latent** — ARMv5 has no BFI/BFC and no
PKH, and the ARM translator is the only in-tree producer of
`tcg_gen_deposit_i32`; the optimizer's extract2→deposit folding
(`tcg/optimize.c:1991`) needs an `extract2` op in the stream, which the ARMv5
translator never emits.  It becomes a live crash the moment any ARMv6+ code
runs (PKHBT/PKHTB), any other guest uses the backend, or any middle-end path
starts emitting extract2/deposit for i32 (e.g. an unlinked `tcg_gen_rotr_i32`
path — currently avoided because `rot_i32` is advertised).

Fix (one line each): read back `w64_scr(t)` instead of `W64_L_SCR0` in both
`tgen_deposit` and `tgen_depositi` (i.e. store `int scr_ = w64_scr(t);` and
use it for both `local.set` and `local.get`, the same pattern
`tgen_sextract`/`tgen_bswap16` already use).  Alternatively set
`TCG_TARGET_HAS_deposit_i32/_i64` to 0 — but that costs real code quality for
ARMv6+ guests and the fix is trivial.  **Recommended: fix the local.**

### A2. Temp-module prelude assembler: fixed 256-byte prelude + 1-byte section-size slots — overflow family

`tcg/wasm64/tcg-target.c.inc:2433-2611` (`tcg_out_tb_finalize`) assembles the
temp module's type/import/function/export sections into `struct w64_buf
w` (`uint8_t b[W64_PRELUDE + 16]`, i.e. 272 bytes, on the **stack**) and
requires the total to fit exactly into `W64_PRELUDE` (256) bytes minus the
7-byte code-section trailer (`target = 249`).  Three distinct failure modes,
verified by exact byte math (simulation of the emitted sizes):

1. **Import section > 127 bytes** (lines 2544-2551): the section size is
   stored in a *single* byte (`w.b[start-1] = w.n - start;`).  With the two
   fixed imports (memory=12 B, table=8 B), the count byte, and ~7 B per helper
   import, the import section exceeds 127 at **~15 helper imports**.  The
   stored byte then has bit 7 set, i.e. it is a "continue" LEB nibble, and the
   decoder consumes the first content byte as the size continuation — the
   module is garbage, `WebAssembly.Module` throws at first execution of the
   TB, and (unlike the batch path) there is no fallback: vCPU death.
   `tcg_debug_assert(w.n - start < 128)` would catch this in a debug build
   only.
2. **Prelude exhaustion** (~18-24 imports depending on type count, or ~14
   imports with 12 types): `w.n > target` makes `room = target - w.n`
   (line 2575, `unsigned`) **underflow**; the custom-section filler then runs
   `while (room--) wb_u8(&w, 0);` (line 2606) writing ~4·10⁹ bytes through a
   272-byte stack buffer.  Stack smash in **both** debug and release builds
   (the only debug assert on this path fires after the loop, line 2610).
3. **Off-by-one/two fill** (lines 2588-2607): if the fixed sections land at
   exactly `target-1` or `target-2` bytes, the filler math breaks: `room==2`
   takes the `room-2 <= 127` branch (content 0) but then unconditionally
   writes the name-length byte and does `room -= 3` → unsigned wrap → same
   unbounded fill loop; `room==1` takes the else branch with
   `content = room-3` wrapping to ~4·10⁹.  Also fatal in all build types.

Compounding this, the per-TB import/type tables that feed the section builder
are themselves only guarded by `tcg_debug_assert`:

* `w64_import_idx` (line 340-350): `W.imp[W64_MAX_IMPORTS=24]` — a 25th
  distinct helper import in one TB writes past `imp[]` **into `n_imp` and the
  block stack** of the `W` struct (release build).
* `w64_add_type` (line 325-336): `W.type[12]`, same class.
* `w64_callidx`'s `p[8]` in `tcg_out_call` (guarded by
  `tcg_debug_assert(np <= 8)`), `W64_MAX_FIXUPS` (line 794): same class.

Assessment of reachability: a TB needs ~15-25 *distinct* (fptr, type) helper
imports.  Typical TBs have 3-8 (ld/st widths + 2 accounting imports).  A
helper-dense TB mixing many load/store widths and several different helper
calls can plausibly reach 15+; 25 is a stretch but not impossible.  This is a
**real, low-probability, catastrophic-when-hit crash** in the production
build, and it is the *only* unbounded-input path in an otherwise very
defensively-written backend.

Recommended fix (keeps the fixed-offset prelude, which `gen_insn_end_off` /
retaddr finality depend on):

* Give the type and import section sizes fixed-width 2-byte LEB slots (like
  the 5-byte slots already used for the body/code sizes), and reserve, say,
  `W64_PRELUDE = 512`.
* Convert the four capacity checks above from `tcg_debug_assert` to a real,
  always-on guard with a *graceful* failure: if a TB would exceed
  `W64_MAX_IMPORTS`/types, fall back to the phase-1 helper-only ld/st path for
  the remaining accesses (`w64_tlb_setup` already provides the pattern), or
  simply fail the batch for that TB and let the temp module carry it — but the
  section assembler must then also hard-fail cleanly rather than smearing.
* Alternatively (smaller change): keep 1-byte size slots but clamp
  `W64_MAX_IMPORTS` to the largest count that provably fits the prelude with
  worst-case types (≈13) and make `w64_import_idx`/`w64_add_type` return a
  "table full" indicator handled by degrading to helper calls.

### A3. `W.n_labels` is `uint8_t` but `W64_MAX_LABELS` is 1024 — label index wraps at 256 labels per TB

`tcg/wasm64/tcg-target.c.inc:40` declares `uint8_t n_labels;` inside the
per-TB state, while `label_idx[]` is `uint16_t[1024]`.  `tcg_out_set_label`
(line 386-387) does:

```c
    tcg_debug_assert(W.n_labels < 0xffff);      /* can never fail: n_labels is uint8_t */
    W.label_idx[l->id] = ++W.n_labels;          /* wraps 255 -> 0 */
```

A TB with **more than 255 placed labels** wraps: label 256 gets region index
0, which is also the *unplaced* sentinel in `label_idx`, so forward branches
to it are emitted as unpatched placeholders; `tcg_out_tb_finalize`'s
`tcg_debug_assert(W.n_fixup == 0)` (line 2479) fires in debug builds, and in
release the branch's `i32.const` stays 0 → the branch jumps to **region 0**
(wrong guest control flow, silent misexecution).

Reachability: every conditionally-executed ARM instruction generates one
`gen_set_label` (`arm_skip_unless`).  TBs run up to `CF_COUNT_MASK` (~512)
insns without an unconditional branch, so a long run of conditional insns
(e.g. a block of `ldreq/streq/cmp`-guarded code, or compiler-emitted
predication) can exceed 255 labels in a single TB.  Uncommon, but firmly
within real-firmware behavior — this is a silent-wrong-answer bug when hit.

Fix: `uint16_t n_labels;` (the `0xffff` assert then becomes meaningful) or
clamp `W64_MAX_LABELS` to 256 and fail translation loudly.  One-line change;
no perf impact.

### A4. `tcg_code_gen_epilogue` is never set — the NULL sentinel works only by coincidence

`tcg/wasm64/tcg-target.c.inc`'s `tcg_target_qemu_prologue` is empty and never
assigns `tcg_code_gen_epilogue`, so it stays `NULL`
(`tcg/tcg.c:250`).  Consequences:

* `tcg/tcg.c:1926` — `tcg_debug_assert(tcg_code_gen_epilogue != NULL);` in
  `tcg_prologue_init()` is compiled for wasm64 (guard is only
  `#ifndef CONFIG_TCG_INTERPRETER`) and **fires in any debug-tcg build**.  In
  release it is `__builtin_unreachable()`.
* Runtime behavior relies on `NULL == 0`: `helper_lookup_tb_ptr`'s miss return
  (`cpu-exec.c:449`) becomes `$scr0 == 0`, which the goto_ptr guard matches
  against `tcg_code_gen_epilogue` (=0), and the dispatcher separately checks
  `next == 0`.  It works, but it is an undocumented invariant shared across
  three files, and the debug assert contradicts it.

Fix: either set `tcg_code_gen_epilogue = (void *)8;` (or any small non-code
sentinel) in the wasm64 prologue, or extend the assert guard with
`&& !defined(CONFIG_TCG_WASM64)` and document the NULL sentinel in
`tcg-target.h`.  Prefer the former: it keeps cpu-exec's `== epilogue` checks
honest.

### A5. Wrong `addFunction` signature strings (benign today, latent)

`tcg/wasm64/wasm64.c:193` and `:885`:

```js
    return addFunction(inst.exports.tb, 'jjji');     /* should be 'ijjj'  */
    const __r = addFunction(inst.exports.run, 'jjjii');  /* should be 'ijjji' */
```

Emscripten's signature convention is **return type first** (verified in the
vendored `libaddfunction.js`: `sigRet = sig.slice(0, 1)`).  `'jjji'` claims a
function returning i64 taking (i64,i64,i32); the TB entry actually takes
(i64,i64,i64) and returns i32.  The strings are *not used* when the passed
function is a raw WebAssembly export (`setWasmTableEntry` succeeds, the
wrapper path is skipped), and C-side calls go through `call_indirect` whose
runtime check uses the function's *real* type — hence it works today.  But an
ASSERTIONS build, or any future path that routes these through the JS wrapper,
would produce ABI-mangled calls.  Fix the strings to `'ijjj'` / `'ijjji'`.

### A6. All capacity/error checks are debug-only (systemic)

Every internal bound in the backend is a `tcg_debug_assert`
(`W.n_imp`, `W.n_types`, `W.n_fixup`, `W.n_labels`, `W.n_blk`,
`W.n_member`, `thunk != 0`, section sizes…).  In the production build
(CONFIG_DEBUG_TCG undefined — verified) these are `__builtin_unreachable()`,
so each is either UB-on-overflow (A2/A3) or a silent no-op.  For a backend
whose input is arbitrary guest code, the ones that guard **memory writes**
(`imp[]`, `type[]`, `fixup[]`, `member[]`, the prelude buffer) must be
always-on.  Suggest an explicit `w64_check(cond)` (plain `assert` or a
graceful failure) for exactly the write-guard set, and keep
`tcg_debug_assert` for invariant documentation.  (Related: the batch side
already learned this lesson — `w64_batch_close` validates its input at close
time and degrades to temp modules instead of asserting.)

### A7. Minor robustness items (low severity)

* **Batch walk OOB read**: `w64_assemble_instantiate`'s validation walk
  (wasm64.c ~lines 1050-1120) reads `mod.b[k]` past `mod.n` if a member's
  declared body length is inconsistent (the final total check catches it only
  after the reads).  Cheap fix: bound `k` by `mod.n` in the loops.  Heap
  over-read of a few bytes in a path that then rejects the batch.
* **`w64_union_import` assumes the batch is open** (wasm64.c:625): it does not
  check `B.id == 0` (unlike `w64_union_type`, which opens the batch).  Every
  current caller pairs it with a preceding `w64_union_type` in the same
  statement group, so it holds today, but a future call-order change writes
  into a closed/zeroed batch silently.  Make it open-or-assert.
* **tidx leak on TB-overflow retry**: `tcg_out_tb_start` allocates a fresh
  `w64_alloc_tidx()` on each attempt; the aborted attempt's tidx is never
  returned.  Bounded by retries and reset at `tb_flush` — cosmetic.
* **`w64_landed_by_id` never shrinks and `w64_next_batch_id` never resets**
  across tb_flush cycles: the pointer array persists at the high-water mark
  (ids are also consumed by every compaction merge).  A very long session
  with many flushes grows it monotonically; entries are freed, only the array
  spine (8 B/id) stays.  Acceptable; worth a comment.
* **`w64_batch_mode` treats empty `W64_NOBATCH=` as unset** (`*e` check) while
  every other env knob treats presence as set.  Inconsistent; pick one
  convention.

### A8. `deposit`-adjacent: none further

`tgen_deposit_zr`, `tgen_extract`, `tgen_sextract`, `tgen_bswap16/32/64`,
`W64_CNTOP` (clz/ctz), `tgen_movcond`, mul2/mulh families were each traced
byte-by-byte and are type-correct (all use the type-matched scratch or no
scratch at all).

---

## B. Things that can be removed / simplified to get closer to upstream

None of these cost performance; most shrink the diff or remove dead state.

1. **`w64_out_desc_u32` is dead code** (`tcg-target.c.inc:358-361`).  Defined,
   never called (`tcg_out_tb_start`/`_finalize` use `stl_p` directly).
   Delete.
2. **`W64_DESC_ICOUNT` is dead** (`wasm64.h:78`, written at
   `tcg-target.c.inc:2291`).  Nothing reads it — the inline prologue embeds
   `s->gen_tb->icount` as an immediate and the fallback import receives it as
   a call argument; TCI's tbhdr does not go through this descriptor.  Remove
   the field and the store (keeps the descriptor 16 B, one store less per TB).
   *(If a future diag wants it, re-add then.)*
3. **Dead JS block in the link-failure probe** (`wasm64.c`, end of the
   `W64SIG` loop): `if (cands.length) { /* also dump the names the
   sig-printer can't: none */ }` — an empty if with a comment.  Delete.
4. **The ~90-line forensic decode in `w64_instantiate`'s catch**
   (`W64DEC`/`W64SIG`, wasm64.c:155-185) and the `W64DUMPC` base64 dumper are
   offline-debug aids on the failure path only (zero cost when healthy).
   They are exactly the kind of thing to strip or quarantine behind
   `#ifdef W64_FORENSICS` in an upstream submission; keep them in-tree while
   the port is stabilizing (they earned their keep during bring-up).
5. **Duplicate `TCG_TARGET_HAS_qemu_ldst_i128`** defined in both
   `tcg-target.h:184` and `tcg-target-has.h:9`.  Remove from tcg-target.h
   (tcg-has.h defaults cover it).
6. **`TCG_REG_R30` is dead**: it appears in `tcg_target_reg_alloc_order`
   (`tcg-target.c.inc:2659`) but `tcg_target_init` sets
   `tcg_target_available_regs = MAKE_64BIT_MASK(0, 28)` (R0-R27), so the
   allocator can never pick it (R28/R29/R31 are reserved via `reserved_regs`).
   Either drop it from the order, or — better for performance — enable it:
   `MAKE_64BIT_MASK(0, 29)` gives 29 allocatable TCG registers (+3.6%),
   which marginally reduces spilling; the local-indexing helpers
   (`W64_L32/L64`) already handle any r < 32.  (Worth an A/B before/after;
   expect ≤1% but free.)
7. **A/B-only env switches** — `W64_NOTLB`, `W64_NOACCTINLINE`,
   `W64_NOCLOSEEXEC`, `W64_NOBATCH` exist purely to A/B the corresponding
   feature (comments say so).  Each costs a getenv-once plus a branch.  For a
   leaner, upstream-shaped patch: fold the first three behind
   `#ifdef CONFIG_DEBUG_TCG`-style gating or drop them, and keep the
   genuinely operational knobs (`W64_BATCH_N`, `W64_LIVE_MAX`,
   `W64_COMPACT_*`, `W64_DEBUG`, lockstep vars) which field tuning needs.
8. **`W.blk[].kind` is write-only** (never read after push; the opcode choice
   is made in the push call).  Harmless, but it can go if you want minimal
   state.
9. **Redundant `= 0` HAS defines** in `tcg-target.h` (addco/addc1o/addci/
   addcio/subbo/subb1o/subbi/subbio, negsetcond…) duplicate the tcg-has.h
   defaults.  Upstream backends list them anyway for documentation, so this
   is taste; leaving them is fine, but trimming to the non-default set
   shrinks the file by ~40 lines.
10. **`memcpy(dst, NULL, 0)`** in `w64_add_type(0, NULL, …)` calls
    (`tcg_out_tb_start` sync-type): technically UB, practically fine; pass a
    dummy zero-length array or guard `np`.
11. **tcg/tcg.c wasm64 hunks** (already minimal, 16 lines): fine as-is.  If
    A4 is fixed by setting the epilogue sentinel, the
    `tcg_qemu_tb_exec`-decl hunk stays the only nontrivial one.
12. **Lockstep + forensics placement**: `w64_ls_*` (~300 lines: FNV, gdb
    register reads, mem digests, sampling, env parsing) is *test
    infrastructure* living inside the backend runtime.  It is env-gated,
    costs one `i32.load` + branch per TB entry when off, and is the port's
    correctness gate — keep it, but moving it to `tcg/wasm64/lockstep.c` (or
    `tests/`) would leave `wasm64.c` focused on dispatch/batching and reads
    better as a diff.  Same argument for `w64_bad_*` forensics.

---

## C. Performance assessment (against "best performance, minimal deviation")

Verified-good decisions worth keeping as-is:

* **Inline TB accounting** (prologue RMWs + icount2 fast path + conditional
  imports) exactly mirrors `wasm_tb_account` + `icount2_advance`
  (`system/icount2.c:115` compared instruction-by-instruction — including the
  `qatomic` semantics via `i64.atomic.load/store` on a shared memory) and is
  correctly *omitted* when `icount2_enabled()` is false (the default timing
  model) — the per-TB atomic RMW would otherwise run ~5M×/s for nothing.
  `w64_icount2_sync_now` reproduces the BQL+sync tail.
* **TLB probe** (`w64_tlb_probe`/`w64_tlb_haddr`) is a faithful inline of
  tcg.c's fast path: entry indexing via `mask & (addr >> (pagebits-5))`
  (equivalent to `(mask>>5) & (addr>>12)` since mask's low 5 bits are zero),
  `tlb_mask = TARGET_PAGE_MASK | a_mask`, the `s_mask - a_mask` adjust for
  `a_mask < s_mask`, flag bits (INVALID/NOTDIRTY/WATCHPOINT/MMIO at bits ≥6)
  failing the compare, and MO_BSWAP / non-NONE/IFALIGN atomics forced to the
  helper — the same policy as TCI.  Watchpoints and alignment (MO_ALIGN via
  a_mask) are correctly routed to the slow path.  `$scr2` address snapshot
  handles the `data == addr` (e.g. `ldrd`) aliasing case.
* **goto_tb chaining** through the shared table with `return_call_indirect`,
  guarded by slot==reset / `w64_chain_stop` / target-fidx==0 — TCI's
  "always-indirect" scheme done with one tail call; the three loads per
  chained jump are the honest minimum for unlink-safe semantics.
* **Batching** (union type/import dedup, fixed-width call LEBs rewritten in
  place, one `run` thunk, element segments re-registering members,
  compaction of small batches, FIFO eviction with re-assembly on demand,
  temp-module fallback on any validation failure) is sound; the descriptor
  lifecycle (stage → temp-instantiated → landed → evicted → re-ensured →
  flushed) was walked through all transitions and is consistent, including
  the retry-dedup in `w64_batch_member` and the batch-skip fallbacks.
* **Forensic checksums** are O(bytes) per close against a WebAssembly.Module
  compile of the same bytes — noise.  Keep.
* **GC nudge** (32 MB ArrayBuffer every 256 instantiations) is a
  SpiderMonkey-specific executable-memory pressure hack, documented with
  measurements; keep, but a comment pointer to the Firefox bug/limit would
  help future readers.

Known, accepted costs (documented in-tree; listed here so the next agent
doesn't re-litigate):

1. **Label-region dispatch is O(#labels) per taken branch**: each taken
   intra-TB branch re-enters the loop head and walks the `if (bp <= k)` chain.
   Worst case for a 255-label TB (see A3's fix) is ~255 compares per taken
   branch; typical TBs (<20 labels) pay <20.  The planned phase-2 `br_table`
   replaces the chain with one indirect branch — still the single biggest
   backend win available; do it before any micro-tuning.
   Also code-size: ~10 B per label (get bp, const, le_u, if, end) × labels.
2. **Helper-call frame round-trip**: with zero argument registers declared,
   every helper call stores args to `$sp` then reloads them as import
   parameters (2 memops per argument).  Helpers are rare in steady state
   (TLB inline covers loads/stores), so this is the right trade today; if a
   workload ever goes helper-hot, declaring real arg registers in the
   constraints (the wasm locals are already "registers") is the lever.
3. **`w64_ls_on` prologue load** runs on every TB entry even when lockstep is
   off (one i32.load + branch).  Alternative: emit the lockstep import call
   unconditionally behind a linker-trampolined flag, or drop the fold when
   `W64_LOCKSTEP` is unset at first translation (it is parsed before the
   first TB — `w64_init` runs before first exec, and `w64_ls_init` is eager).
   ~1-2% of prologue cost; only worth it after br_table.
4. **Batch close/compaction compile latency** happens on the translation
   thread inside `tcg_out_tb_finalize` (and speculation makes translation
   itself batch-friendly).  Compaction merges up to 1024 members (~1 MB
   module) synchronously — measured acceptable; keep the thresholds
   env-tunable as they are.
5. **Eviction FIFO (live_max 6144)** can churn hot code under adversarial
   TB-set sizes (>~780k live TBs); re-assembly is a full batch recompile.
   Fine for current workloads; a cheap future improvement is skipping
   eviction of batches whose members executed recently (needs a touch
   counter per landed batch).

---

## D. Explicitly verified correct (spot-check log)

So the next reader knows what was *checked*, not just flagged:

* Local/param numbering and the 4-run local declarations in
  `tcg_out_tb_start` (33×i32, 32×i64, 1×i32, 3×i64) match `W64_L32/L64/BP/
  SCR32/SCR0..2`; `$bp` zero-init gives region-0 entry; region fall-through
  semantics (`bp <= k` chain) implement TCG label semantics including
  adjacent labels and unreachable trailing regions.
* `w64_br_to_label` fixup positions (5-byte padded `i32.const`) and
  `w64_callidx` (2-byte padded call LEB, batch rewrite bounds-checked) are
  byte-exact; the batch assembler's rewrite stays within each member's body
  (`pos ∈ [BODY_OFF+5, BODY_OFF+body_len)`).
* `tcg_out_call`: ra store to `[$tp]` before arg reload; slot layout
  `sp + 8*i` matches the middle-end's frame stores (`TCG_TARGET_CALL_
  STACK_OFFSET 0`, empty `tcg_target_call_iarg_regs`); typemask→wasm type
  mapping (i32/s32→i32, i64/s64/ptr→i64); result rep tracking of R0;
  GETPC_ADJ(+2) bias consistent with `getpc.h`'s `GETPC() == w64_tb_ptr` and
  the unwind walk (the `af04376eb9` fix).
* `tgen_qemu_ld/st`: helper signatures `(env*, u64, u32, u64)->i64` and
  `(env*, u64, val, u32, u64)->void` with val width keyed on `MO_64`;
  fast-path opcode tables `[is64][MO_SSIZE/MO_SIZE]` all type-correct;
  `i32.wrap` on the ld helper's i64 result; else-arm arg order.
* `extrl` handling: with `TCG_TARGET_HAS_extr_i64_i32 0`, tcg.c treats
  `INDEX_op_extrl` as a plain move (`tcg.c:6651` path) and wasm64's
  `tcg_out_mov` handles i64→i32-rep sources via wrap — correct; the real
  `tcg_out_extrl_i64_i32` is present for the movext paths.  `extrh` lowering
  (`shr_u 32` + wrap) correct.
* Module frames: temp module import order (memory, table, helpers — memory/
  table do not consume funcidx), export `tb` at `n_imp`, batch `run` at
  `n_uimp + n_member`, thunk body bytes (14 B, size 13), element-segment
  encoding, 5-byte padded body/code size LEBs, custom-section filler math
  for `room ≥ 3` (exact fill to `target`).
* Dispatcher: batch-tag/fidx state machine, `w64_batch_close_pending` (closes
  on first member exec), GOTOPTR handoff (`[sp-8]` = frame+8, `next==0 ||
  next==epilogue` → 0), exit codes fit i32 (2 GB heap keeps bit 31 free for
  `W64_EXIT_GOTOPTR`), `LS.stop` exit path.
* addFunction/removeFunction pairing is alias-safe (emscripten reuses freed
  indexes LIFO, but no descriptor ever keeps a removed fidx: landing and
  eviction rewrite fidx synchronously, flush kills all descriptors).
* Emscripten/memory64 contracts: memory import flags 0x07 (64|shared|max)
  with 32768/32768 pages matches `-sTOTAL_MEMORY=2GB -pthread -sMEMORY64`;
  table imports min=1 vs grown TAB; `wasmTable.get(BigInt(fidx))` for the
  i64-indexed table.

---

## E. Prioritized action list

| # | item | severity | effort |
|---|---|---|---|
| 1 | A1 deposit i32 scratch fix | high (latent crash, one-liner) | trivial |
| 2 | A3 `n_labels` → uint16_t | high (silent misexec, one-liner) | trivial |
| 3 | A2 prelude/section-size hardening (+A6 write-guards) | high (crash when hit) | small |
| 4 | A4 epilogue sentinel or assert guard | medium (debug builds) | trivial |
| 5 | A5 addFunction sig strings | low | trivial |
| 6 | B1/B2/B3/B5/B8 dead code & dupes | cleanup | trivial |
| 7 | B6 R30 enable (perf A/B) | perf nickel | small |
| 8 | C1 br_table phase-2 | biggest remaining perf | medium |
| 9 | B7/B12 env-knob pruning + lockstep file split | upstream-shape | small |
