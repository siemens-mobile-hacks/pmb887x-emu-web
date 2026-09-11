# Optimization sessions — narratives, forensics, isolation study

Companion to [optimization-playbook.md](optimization-playbook.md) (the
live method + tables).  This file is append-only history: what each
session measured, the traps it hit, and the patch-isolation study.
Numbers here are of their day and host — never quote them as current.

## Patch-isolation testing (2026-09-09 session — is every patch required?)

Question: with the series at 0001–0015, is each patch actually load-bearing,
or is some of it dead weight?  Harness: `scripts/switch-test.sh` — resets
build/qemu to the pinned rev, applies `patches/*.patch` minus the target
(`MINUS:NNNN`), or applies all and reverse-applies the target plus its
dependents (`REVERT:N1,N2,...` — needed when later patches touch the same
hunks), then incremental rebuild + deploy, then `tools/bootbench.mjs 110`
×2 (vs ≥2 same-day baseline runs; both removal runs must be worse than
all baselines to prove a patch matters, and vice versa).

Dependency structure found (why some patches can only be group-tested):
0004/0007 build on 0002's icount2 accounting; 0008/0012/0014/0015 all
modify regions first touched by 0003/0007/0011 — a stack without them
cannot be expressed without rewriting later patches.

| Removed | Method | window (v=2→7 s) vs baseline 25.1–28.5 | Verdict |
|---|---|---|---|
| 0002 (condvar/futex half only — files surgically reverted to pristine, rest of stack intact) | surgical | 25.1–25.8 + serialwatch soak to v=166 with LCD updates growing, no EXIT | **redundant now** — 0009's futex wake path removed the livelock precondition (doc/livelock-postmortem.md no longer applies as written); the icount2 half of 0002 stays (0004/0007 require it), so the patch stays | 
| 0003 (+ its dependents 0008/0011/0012/0014/0015) | REVERT group | boot collapses ~25× (finalV 4.7/6.4 after 110 s) | required |
| 0007 (+ dependents 0008/0011/0012/0014/0015) | REVERT group | 33.3–33.6, finalV 78–118 | required |
| 0008 | MINUS | 29.9–32.3 (worse than every baseline run), finalV down | required | 
| 0009 | MINUS | 29.3–31.7, finalV halved (busy-spinning main loop starves the vCPU worker) | required |
| 0011 (+ dependents 0012/0014/0015) | REVERT group | 32.5–34.8, finalV 84–100 | required (also structurally: 0012 can't exist without it) |
| 0013 | MINUS | 34.6–41.2 — largest single regression | required |
| 0015 | MINUS | 25.8/25.9/25.8 (one 31.8 outlier under host load); no tool consumes its counters; junk whitespace hunk | **dropped** (see attic/README.md) |

Bottom line: the perf series is tight — every TCI/longjmp patch is
empirically required; the only removable surface was 0015.  0002's
threading half is a documented-redundant insurance policy (kept only
because the patch cannot be split without rebasing 0004/0007/0009).

Follow-up (2026-09-09, upstream-branch prep): building the series
natively surfaced a latent link error the wasm build can't see —
`wasm_diag_stat` was defined in `tcg/tci.c` (only compiled under
`--enable-tcg-interpreter`) but referenced from always-compiled
`cputlb.c`/`tlb_helper.c`, so every native build of the series since
0012 failed to link.  Fixed by moving the definition to `cputlb.c`
(see [upstream-branch.md](upstream-branch.md)); native suite now
passes 4/4 on the branch binary.

Follow-up (2026-09-09, slow-host re-verification): 0002's icount2
`MIN_FREQUENCY 1000` floor was retested (fast hosts: controller
converges 3–17 MHz, floor never binds, A/B identical).  Under 16x
CPU starvation (~2.5 kHz sustained — a phone, amplified) the floor is
decisive: 1 kHz → v=377 @420 s, slow-motion boot, no crash; stock
1 MHz → frequency pinned at 1.000 MHz, virtual clock frozen at
v=0.88 @420 s, boot dead.  Kept for slow devices; only the opt-in
precise-clocks mode is affected (the default stock-icount model has
no controller).  Numbers in [upstream-branch.md](upstream-branch.md).

## Session log: 2026-09-08 (patches 0010–0011, upstream review follow-up)

Started from the 0009-era build (v-window ~40–43 s on a quiet host).  Two
patches landed, several hypotheses measured and rejected.  **The host is
shared: loadavg is not namespaced — always interleave A/B pairs against
saved binaries (cp the dist aside) and distrust absolute numbers across
time.**  A profiler self-time of ≥1% in a leaf symbol whose caller stacks
look insane (wav_enable_out under qemu_coroutine_new etc.) is symbol-map
garbage; verify with counters before acting.  Note for diagnostics:
`fprintf(stderr)` does NOT reach the page console — use
`emscripten_console_error()` (and remember to click `#btn-start` in any
hand-rolled playwright script; an unbooted page measures zero of
everything).

### Landed

- **0010 wasm: skip the io-recompile rewind under stock icount** — the
  0004 skip was icount2-gated, but the default timing model is stock
  `-icount shift=3`: every mid-TB MMIO access still paid the ~150 µs
  emscripten longjmp (wprof: 46.6% of vCPU in __emscripten_throw_longjmp,
  callers cpu_io_recompile ← tci_qemu_ld).  Fix: commit the
  pre-decremented TB budget (icount_update) + re-open the clock window
  (can_do_io) instead of rewinding — the callback sees a clock at most
  one TB ahead, the same deviation chained-icount2 accepts.  Measured:
  v-window 51.5/53.4 → 42.3/41.8 s (interleaved, −19%); insns@110s
  +102% (811M → 1.64G); 180 s soak v=168 @2.38B insns.
- **0011 tci: inline TLB fast path in the interpreter loop** — the 0003
  probe lived behind a per-access call to tci_qemu_ld/st; now
  tci_ld_fast/tci_st_fast (QEMU_ALWAYS_INLINE) run at the four
  interpreter call sites with the helper path as fallback.  Measured
  (interleaved vs 0010): 41.2/41.5 → 38.5/36.5 s (−10–12%).

### Measured and rejected (do not retry blind)

- **Link-time binaryen -O3** (`-O3` in c_link_args): consistent
  regression (41.4/40.9 vs 38.9/37.3 interleaved) — binaryen's rewrites
  beat V8's own codegen.  Kept: no link -O flag.
- **Single-call tbhdr accounting + icount2_advance fast-out** (one call
  per TB instead of two, early-out when !use_icount2): no win (42.5/38.5
  vs 41.4/36.6) — V8 already makes the uncontended atomics nearly free.
- **wasm-EH longjmp** (`-sSUPPORT_LONGJMP=wasm` + `-mexception-handling`):
  the linker never provides `emscripten_longjmp` while `-sASYNCIFY=1` is
  on (JS-mode setjmp objects from the prebuilt sysroot want
  `_emscripten_throw_longjmp`), and emscripten 4.0.10 has no
  SUPPORT_LONGJMP=mixed.  Blocked by the asyncify requirement of
  coroutine-wasm (emscripten/fiber.h).  Measured longjmp load: 12.8k
  cpu_loop_exit/s (~9.4k guest SWIs + 1.6k interrupt exits, ~17% of
  vCPU) — the prize stays behind the fiber/asyncify dependency.
- **gthread coroutines + no asyncify**: no coroutine-gthread.c exists in
  this qemu (backend was removed upstream); resurrecting it is the
  prerequisite path for dropping asyncify.
- **Console-print cost**: 74 console messages in 30 s — printing is a
  non-issue (the unknown-reg warnings are rate-benign).
- **Diagnostics that measured ZERO** (all real, via counters):
  transaction-failed aborts, unaligned aborts, coroutine creations
  (<1024/30 s).  The `emscripten_fiber_init`/`mtree_expand_owner`/
  `qht_reset_size` profile entries are symbolization ghosts.

### Measured facts for the next session

- TCI op mix (histogram via interpreter counter, 2.55G ops sample):
  st32 19.4%, tci_movi 12.7%, ld32u 12.3%, tci_add_ri 9.0%, brcond
  6.2%, st8 6.0%, extract 4.9%, tci_setcond32_ri 4.0% … — **~31% of all
  ops are register↔stack traffic** (middle-end spills + env-relative
  globals) and tci_movi feeds stores.
- TCI register budget: 16 regs − TMP − CALL_STACK = 14 allocatable; the
  ARM frontend alone needs ~20 (cpu_R[16] + flags) → structural spills.
- **5-bit register fields do not fit the 32-bit TCI word** (qemu_ld needs
  op8+r0+r1+memop16 = 32 bits exactly).  Reducing the spill traffic
  therefore requires the **64-bit TCI encoding** (8-byte insn units:
  generous uniform fields, 32 regs, room for wider immediates and fused
  brcond-vs-imm).  Estimated win: 8–15% (spills mostly vanish; decode
  gets cheaper as a side effect).  Touches every tcg_out_op_* emitter /
  tci_args_* decoder (~50+66 sites), tcg_insn_unit, code_gen buffer
  sizing, pool alignment; invalidates the 0005 wasm32 draft's emitter
  assumptions.  Effort ~2–4 h, best done as its own session with the
  histogram + interleaved-bootbench loop from this one.

### Register-file expansion experiment (measured, rejected — 2026-09-08)

Motivated by the op-mix (~31% of TCI ops are register↔stack traffic with
only 14 allocatable registers vs ~20 ARM globals), a full 5-bit register
encoding was implemented and measured: 32 virtual registers (28
allocatable), all decoders/emitters re-laid-out (uniform reg slots at
bits 8/13/18/23), 19-bit labels, 24-bit bare-label/payload forms,
`qemu_ld/st`/`deposit`/5-reg ops taking a trailing word for the fields
that no longer fit, immediate forms narrowed S16→S14 / S12→S10.

Mechanically it worked (built, booted, no crash).  Measured
(interleaved, headless Chromium):

  v=2..7 window   0011: 36.5 s   +28regs: 43.2 / 43.6 s  (~+18% worse)
  @110 s          0011: v=92, 1670M insns   +28regs: v=48, 1616M insns
  @50 s           both nearly identical (127M vs 130M TBs, 502M vs 516M
                  insns, v 4.3 vs 4.4) — no TB-size change, spills were
                  NOT the bottleneck

Conclusions: (a) the env/stack ld/st ops are already single-memory-op
cheap — register pressure is not the limiter on this workload;
(b) the 2-word `qemu_ld/st` encoding cost (~30% of ops) plus
whole-TB-icount timing drift (the v-stall at ~48 suggests a longer
firmware busy phase from shifted MMIO-in-TB positions) makes the
encoding change a net loss as implemented.  A 64-bit single-word
encoding would avoid (b)'s word-count overhead, but given (a) the
expected upside is small.  Patch preserved at
`/tmp/regfile-expansion-attempt.diff` (574 lines) if anyone wants to
re-try with the 64-bit word form.

Tooling note: `capture-patch.sh`'s verify only compares files that
appear in `git status` of build/qemu — a file reverted to pristine HEAD
silently escapes detection (bit us once; always also cmp the
backend/*.h.inc files against the stack when doing surgery there).

## Session log: 2026-09-08 evening (page-side session — delivery path)

Picked remaining-opportunity #4 (V8 tier-up warm-up) and measured it
properly (bootbench grew `JS_FLAGS` for browser flags + `RATES=1` for
per-sample insns/s):

- `--no-wasm-lazy-compilation`: window 33.9 vs 34.2/34.2 baseline.
- `--wasm-tiering-budget=100000` (default 13M): 34.1.
- both: 34.1.  Plumbing verified with `--no-liftoff --no-wasm-dynamic-tiering`
  (finalV 3.1 @45 s — eager TurboFan of the whole module dominates).
- Conclusion: V8 compilation tiers are NOT a factor in the v-window on this
  host (streaming Liftoff of the 45 MB module: 80 ms).  Closed as #4 above.

Pivoted to the page-side delivery path, where real wall-clock sits for the
README's phone/LAN use case.  New tool `tools/loadbench.mjs`: a
time-to-guest-work benchmark (t_module / t_v05 / t_v2 from page load,
resource timing for the wasm, `instantiateStreaming` timing via an
init-script wrapper, `PROFILE=` persistent browser profile for cache
experiments, `NET=`/`LAT_MS=` CDP network emulation).  Primary page metric:
**t_v05** (wall s until guest v crosses 0.5).

Landed (serve.mjs + site/app.js, no qemu changes → no patch in the series):

- **serve.mjs: strong ETag + 304 revalidation, and a lazily (re)generated
  `qemu-system-arm.wasm.gz` sidecar** (44.8 MB → 11.2 MB, ~1.2 s to build,
  `GZIP=0` disables, tmp+rename so a partial sidecar is never served,
  auto-refreshed when the wasm is newer — ninja-fast already `rm -f`s it on
  deploy).  `no-cache` kept: every visit revalidates, so redeploys are
  always picked up, but unchanged files come back from the HTTP cache (and
  stay eligible for Chromium's wasm code cache — which did not measurably
  engage in headless; the measured warm win is HTTP-cache only).
- **site/app.js: slow-link device-inference race fixed.**  `loadBoards()`
  populates the `<select>` asynchronously; a fullflash picked before
  boards.tar arrived silently lost device inference → booted
  generic-pmb8875 → qemu hardware-error abort ("Invalid fullflash
  size").  Found by loadbench under NET=20 emulation (localhost is too
  fast to ever hit it).  Fix: deferred `pendingDevice` applied when the
  options exist + `boot()` awaits `boardsReady` (also removes a latent
  `boardsBuf` null-deref in preRun).

Measured (loadbench, S75, 2 runs each, all within ±0.3 s):

| visit | t_v05 localhost | t_v05 @20 Mbps+30 ms | t_v2 @20 Mbps | wasm transfer |
|---|---|---|---|---|
| before (raw, no validators) | 7.0–7.2 | 26.2 | 35.0 | 44.8 MB |
| after, cold (gz) | 7.0–7.2 | 12.1–12.4 | 21.2 | 11.2 MB |
| after, warm (304) | **6.2** | **6.3** | **15.1–15.3** | **300 B** |

i.e. −54 % time-to-first-guest-work for a cold visit on wifi, −76 % for a
revisit (revisits become link-independent), zero cold-visit regression, and
the v-window is untouched (34.3 vs 34.2).  Boot soak after the app.js fix:
v 1.2→4.7 over 40 s, LCD updates growing, ex=[0,0,0,0], no `>>EXIT<<`.

## Session log: 2026-09-09 (patch 0012 — interpreter memory ops, counters)

Target chosen by the playbook loop (profile → counters → ONE patch).
Findings worth keeping:

- **The page main thread is 98.5 % idle during emulation** (wprof2 now
  profiles it too — page session first in its list).  Client-side
  main-thread work (LCD repaint, serial poll, console) is irrelevant for
  emulation speed on a many-core host; the "client-side" levers all live
  in the wasm the client executes.
- **Symbol-map ghosts re-confirmed**: `tci_qemu_ld` showed 45 % vCPU
  self-time, but counters proved the slow path runs only ~20k calls/s
  (MMIO/unmapped ≈ 2k/s, tlb_fill ≈ 20k/s in-window).  The 45 % was the
  *inlined* fast-path code (tci_ld_fast/tci_st_fast inside the
  interpreter) mislabeled — and it is genuinely the hot path:
  ~5.9M loads + ~2.4M stores per wall second.  Always verify ≥1 % leaf
  self-time with counters (the 0010/0011 sessions' rule holds).
- **tci_qemu_ld/st re-probe was dead code** — the inline fast path probes
  with identical inputs one call earlier; 1.1M+ calls, 0 second-probe
  hits.  Removed in 0012.
- **mop reality on this target**: every plain data access is
  `MO_ALIGN|MO_ATOM_NONE|size|sign` (ARMv5 requires alignment, so
  `memop` never fits the old 16-bit rrm stream word — that is why the
  0011-era `oi & ~0xffff` fallback exists).  This is what makes
  exact-mop specialization (0012) work: the opcode reconstructs the
  whole mop, the stream word only carries mmu_idx.
- **Benchmark discipline**: interleave against a *rebuilt* baseline
  (cp the dist aside, one server per dist — a scoped server per run
  survives the sandbox: see `/tmp/ab-one.sh` pattern in this session's
  shell history).  Baseline windows are bimodal under shared-host load
  (34.4–42.3 s); the candidate stayed 33.6–35.4 s across 6 runs and won
  every pair.  finalV@110s (+18–25 % guest-seconds, all pairs) is the
  most stable cross-check; insns@110s stays ~equal because the window
  metric only covers v=2..7 while the big gains sit in later,
  memory-op-dense phases.
- **capture-patch.sh new-file handling was broken** (its sed mapped a new
  file's `+++` line to `/dev/null`; first exercised by 0012's new header
  file).  Fixed: the new/deleted branches now emit their own `---/+++`
  headers and keep the diff body from the first `@@`.
- **Lesson (cost ~30 min)**: the diagnostics enum and hard-coded indices
  drifted apart twice while iterating — one round of "rejections" was
  actually reading the wrong counter, which briefly pointed at a
  big-endian-guest theory (wrong: the guest is LE; the mops carry
  MO_ALIGN).  When adding counter slots mid-enum, re-check every consumer
  (JS tools included) or use named indices everywhere (0012 ships
  include/qemu/wasm-diag.h with named enum entries for exactly this).

0012 measured headers are in `patches/0012-tci-size-specialized-ldst.patch`;
correctness bar: native suite PASS ×4 (s75/el71/c81/ke800), wasm soak to
v=245 with growing LCD updates, idle-screen screenshot verified (wallpaper,
clock, «Поиск сети»), no `>>EXIT<<` anywhere.

## Session log: 2026-09-09 evening (patches 0013–0015 — killing the longjmp tax)

Followed the loop strictly: baseline → profile → counters → ONE patch →
interleaved A/B → keep/revert → capture with measured header → native
suite + soak.  Two landed, one tiny diagnostics patch, two measured-flat
reverts.  Net: **v-window 34.3–34.6 → 24.5–25.4 s (−26 %), finalV@110 s
97–126 → 164 (+30–77 %), idle screen (v=245) at ~185 s, 2.82G insns
@190 s, no `>>EXIT<<` anywhere, native suite PASS ×4.**

### Landed

- **0013 wasm: SVC inline exception exit** (−26 % window, the big one).
  wprof2 caller stacks showed 79 % of `__emscripten_throw_longjmp` under
  `helper_exception_with_syndrome(_el)` — guest SWIs.  Instead of
  fighting the asyncify/wasm-EH blockage (rejected table), the ARM
  frontend now emits the exception state stores + `exit_tb(0)` for
  translate-time-fully-known exceptions on EL2/EL3-less cores; a new
  early-return in `cpu_handle_interrupt` delivers a pending
  exception_index before running or chaining any other TB.  Key
  equivalence arguments (all verified in code before writing the patch):
  the helper only writes exception_index/syndrome/target_el; the
  longjmp lands in the same `cpu_handle_exception` → `do_interrupt`;
  icount budget for the SVC TB is spent identically (whole-TB at TB
  start, either path); the early-return also *prevents* `tb_add_jump`
  from chaining the SVC TB (the interpreter would otherwise execute the
  post-SVC PC — that check is what makes the whole scheme correct);
  IRQ-vs-exception ordering preserved (exception first, like the
  longjmp); `ss_active` single-step keeps the helper path.
- **0014 wasm: io barriers.**  Counter ioRewind proved the remaining
  longjmps were the recurring ROM-flash io_recompile (1.67k/s): the
  unsplit cached TB re-rewinds every poll iteration.  On rewind we now
  record the faulting insn pc and invalidate the TB; the translator
  gives barrier insns single-insn TBs, where `can_do_io` is true
  throughout → no rewind, identical 1-insn clock precision.  (The direct
  no-unwind conversion of io_recompile itself was REJECTED before
  implementation: cpu_io_recompile runs *before* the access completes, so
  returning normally would double-execute non-idempotent flash program
  commands; the barrier keeps stock semantics for the one recording
  occurrence.)
- **0015 wasm: diagnostics counters** (txnF/tbGen/tbFlush/ioRewind/
  lookupTB) — zero-cost, cold paths only.  (Dropped again on 2026-09-09:
  isolation testing showed no consumer and no measurable effect — see
  § Patch-isolation testing; the counter *infrastructure* from 0012/0014
  stays.)

### Measured and rejected this session (do not retry blind)

- **MMIO dispatch fast path** (memory.c direct-call for exact-size
  aligned accesses): window consistently 0.1–0.7 s WORSE on a quiet host
  (4/4 pairs); the saved ~3 non-inlined calls ≈ the added condition
  chain at 90k dispatches/s.  Reverted.
- **TLB table-base caching in the TCI interpreter** (table/mask cached
  per mmu_idx, dropped on helper calls + ldst fallbacks): flat on both
  the v=2..7 window (±0.1 s) and a late LO=30 HI=60 window; finalInsns
  won 4/4 (+1…5.7 %) but is inside its run-to-run spread at 200 s
  (finalV varies ±45 v between identical builds).  Reverted.  The
  memory-op fast path is done — only big levers remain.

### wprof2 ghost catalogue (verified by counters, never trust these
frames again without a counter)

- `io_failed ← cpu_io_recompile` stacks: **txnF = 0.00M/60 s** — no
  transaction failures exist; the frames are mislabeled.
- `helper_lookup_tb_ptr` 3 % self-time: **lookupTB = 0 calls** — the
  symbol covers inlined `tb_lookup` in cpu_exec_loop + tb_gen bits.
- `emscripten_fiber_init_from_current_context` on parked workers
  (82–98 %): actually `emscripten_futex_wait`.
- `qemu_mutex_lock_ramlist` self-time: real, but the repeated
  same-symbol caller frames are inflate — the stack shape
  (`flash_io_read → address_space_set_flatview`) is what matters.

### Facts for the next session

- Post-0013/0014 vCPU profile: interpreter ~57 % (tci_qemu_ld/st ghost),
  romd churn ~4–5 % (ramlist + flatview_translate + mtree ghosts),
  tb_gen ~3 % (2k new TBs/s while boot explores code, tbFlush = 0),
  MMIO dispatch ~2–4 %, BQL waits 0.8 %, futex/idle ~8 %.
- MMIO dispatch rate measured 48–66k/s early, ~94k/s (4.3M ioLd + 4.2M
  ioSt per 90 s) in later phases.
- The romd fix sketch (not attempted this session, too big for the
  remaining budget): stash the last ~4 generated FlatViews per root with
  their (non-romd-generation, romd-signature) tags; `generate_memory_topology`
  reuses a stashed view when the tag matches, skipping render + dispatch
  rebuild.  Needs: a global generation counter bumped only by non-romd
  commits (a `romd_only_pending` flag beside `memory_region_update_pending`),
  a romd-MR registry for the signature, and RCU-safe stash eviction
  (~100–150 lines in system/memory.c).
- Tools added: `tools/compare-lcd.mjs` (pixel-diff of the live LCD vs
  `tools/final-lcd.png` with a 16×16 block map; note the live canvas is
  132×176 vs the reference's 133×177 — the comparison now tolerates ±2 px
  and crops to the overlap).  A/B harness pattern: `/tmp/ab-one.sh`
  (scoped server per dist, alternating runs; recreate as needed).

## Session log: 2026-09-10 (patch 0016 — romd FlatView variants, range-scoped TLB flush)

Target chosen by the loop (profile → counters → patch → interleave), but
this session's main lessons are about **measurement traps** — the patch
measured "flat" twice before a methodology bug was found and it won 8/8.

### What was measured first (counters, not profile shares)

- wprof2 (45 s) showed ~4.5 % of vCPU in generate_memory_topology stacks
  under flash command writes (`flash_lock_command` is an adjacent-symbol
  ghost for `flash_io_write`).
- New cold counters (wasm-diag.h): **romdFlip = 18–20k flips per boot**,
  all inside v≈2.5–4.4 (the v-window's burst phase); topoCommit ≈ flip.
- Temporary ns-accumulator (since removed — it cost ~10 µs × 2 clock
  reads per commit ≈ 0.36 s per boot!): **3857 ms of wall time inside
  topology commits** for the baseline vs **421 ms** with the variant
  stash.
- TLB fills: 1.48M→2.14M across the burst (**~33 fills per flip**) —
  each flip's full tlb_flush() nuked the running code's translations
  (S75 = 8×8 MB flash parts; the polled part's own page churn is
  semantically required, the *code-page* churn was not).

### The three-way interaction (why the patch has two mechanisms)

1. Stash alone (views recycled): commit time −89 %, but the v-window
   measured FLAT — the refill storm remained (stock full flush per
   commit).
2. Selective flush by FlatView identity: wrong tool — entries installed
   against the *other* variant are still dropped every flip (the code
   pages refill regardless), and identity alone cannot drop a stale
   mapping of a protected view.
3. The correct rule is **physical-range based**: the tcg listener's
   region_add/region_del callbacks give the exact changed sections, the
   flush drops only entries translating into them.  Entries outside the
   changed ranges translate to identical section content — including
   entries against a recycled variant — so they survive the toggle.
   Lifetime safety: every view reachable from TLB entries is current or
   stash-resident; eviction happens only inside a commit whose listener
   phase latches "variant evicted" and falls back to the full flush;
   the flush memsets entries and never dereferences their sections.

### Measurement traps that cost this session real time

- **Stale A/B baseline dists**: an early "baseline" site copy actually
  contained an intermediate build (verified via the topoReuse counter
  signature: a true baseline shows reuse=0, a stash build shows
  reuse>0 — always signature-check both ends before believing a flat
  result).  Two full A/B rounds were wasted on it.
- **Missing index.html in the site copy**: a copied site root without
  the page files still boots nothing but can produce plausible-looking
  console output from a previously-open page; curl the root and check
  #fullflash resolves before running benchmarks against a copied dist.
- **Host-load bimodality hides real wins**: the baseline's re-render
  bursts (0.2 ms × 180/s) are exactly the work that collapses under
  host contention — baseline windows spread 25.1–28.3 s while the
  candidate held 22.5–25.1 s.  A "flat" result on a noisy host can
  mean "the candidate removed the work that was making the baseline
  *unstable*", not "no improvement" — look at variance too.
- **Diag-counter overhead is not free at commit rates**: the temporary
  per-commit wall-clock accumulation (2 × g_get_monotonic_time, a JS
  roundtrip on wasm) cost ~0.4 s per boot and initially masked part of
  the win (24.8–25.1 → 22.5–23.2 after removing it).  Measurement
  scaffolding must be removed before the final A/B.

### Landed

- **0016 memory: romd FlatView variants + range-scoped tlb flush**
  (system/memory.c, system/physmem.c, accel/tcg/cputlb.c +
  headers): v-window 25.1–28.3 → 22.5–25.1 s (8/8 pairs; strict
  criterion "every candidate beats every baseline" holds), insns@110 s
  +4–9 %, idle screen (v=245) at ~160 s (was ~185 s), topo-commit
  time −89 %, native suite 4/4, wasm soak to v=827 no EXIT, LCD
  pixel-diff vs reference equal to the previous build (clock + auto
  keyboard-lock drift only).

### Rejected along the way (do not retry blind)

- **FlatView-identity TLB flush** (`full->section->fv != current`):
  implemented, then discarded on the whiteboard — keeps dropping the
  other variant's entries every flip (no refill win) and cannot
  invalidate a stale-but-protected mapping.  Range-based is the only
  correct granularity.
- **fv pointer cached in CPUTLBEntryFull for a deref-free identity
  flush**: also discarded with the above (kept entries would need the
  protected-set argument; ranges subsume it).

## Session log: 2026-09-11 device-path (patch 0018 — MMIO dispatch + victim TLB)

Slice 0 (attribute the ~590 ns) done first, and it rewrote the plan's
assumptions — two findings the profile+counters loop took to find:

- **wprof2 needed a suite-mode guard** (`query` containing `suite=`
  must skip the fullflash upload + `#btn-start` click — the suite
  auto-boots) and a one-purpose MMIO-only bench image
  (`/tmp`-built `mmiobench.bin` from the tcgbench sources: only the
  mmiopoll loop ×8) so a whole-run profile is pure dispatch path.
- **The vCPU is not always worker #0** — its index moves between runs;
  find it by its self-time shape (mttcg_cpu_thread_fn/interpreter
  frames), not by number.
- **Stale `.symbols` sidecars poison whole profiles**: wprof2 prefers
  `site/<dist>/qemu-system-arm.js.symbols` over the build dir's, and
  `build-qemu-wasm64.sh` deploys the wasm without refreshing the
  sidecar — one whole profile round was garbage (io_failed ghost at
  6.9 %).  Always `cp build/qemu-wasm64/qemu-system-arm.js.symbols
  site/dist-jit/` after a deploy.  (Fixed the deploy script.)

Slice-0 attribution (mmiobench, dist-jit): TLB-fill path (mmu_lookup →
arm_cpu_tlb_fill_align → get_phys_addr* → tlb_set_page_full) ≈ 40 % of
vCPU; generic dispatch chain (do_ld_mmio_beN → access_valid →
adjusted_size → accessor) ≈ 25 %.  Cold counters (per-page fill
counts, temporarily in `wasm_diag_pages`) then showed **2 of the 4
mirror pages refill on every single access** — the walk was not
incidental.

Root cause chain (three wrong theories died on the way):
1. "tiny-page TLB_INVALID refills" — wrong: ARMv5 has
   `TARGET_PAGE_BITS 10` (page-vary), so the 1K pages are *normal*
   TLB pages.  (A sub-page fill cache built on the lg<12 theory
   measured flat/none — removed.)
2. The real mechanism: sysctl 0x10000000 and VIC 0x10140000 **hash to
   the same TLB index** under 1K pages (both index 0) and evict each
   other every loop iteration; the victim TLB should absorb that, but
3. `victim_tlb_hit` compares `cmp == page` **unmasked** — every MMIO
   entry's addr_idx carries TLB_FORCE_SLOW above the page bits, so the
   victim TLB can *never* hit an MMIO entry → full page-table walk +
   tlb_set_page_full per access, on every backend, forever.  One-line
   fix: compare with `tlb_hit_page()` masking like the main probe.
   (Phone boot relevance: confirmed fills ≈ 50 % of ioLd on the
   versatilepb mirror; on the phone the same mechanism bites wherever
   firmware MMIO pages alias — finalV/insns improved on every pair.)

Landed as **0018** together with the plan's slice-1 headline (fill-time
`(callback, opaque, mask, swap, align, guard)` resolution in
`CPUTLBEntryFull`; zero per-access added checks — the mask bit is the
fast/slow discriminator; re-entrancy guard + endianness + accepts/
ioeventfd/with-attrs/impl-range cases all fall back to the stock path).
NOT the rejected memory.c runtime cache.

Measured (interleaved legs, RUNS=2-3, checksums identical everywhere):

  mmiopoll ns/access: dist 606→252, dist-jit 534→202 (native 223; the
                      ≤300 intermediate gate is passed at ~parity)
  mmiow ns/access:    dist 454→378, dist-jit 305→227
  bootbench:          finalV/insns@110 s up on every pair both dists
                      (v-window pairs 32.2→28.9 / flat-flat under host
                      load — windows too noisy on this shared host to
                      satisfy the strict pairwise rule, mirrors decide)
  gates: op-suite 1156/1156 byte-identical ×3; native suite 4/4 on the
         branch binary (qemu-upstream + 0018); lockstep 20e6 + 250e6 +
         the FULL 2.5e9 gate clean; idlebench medians (n=3, both dists
         improved): dist 76.5→74.4 s, dist-jit 72.4→70.4 s — the
         remaining gap to the ≤55–60 s goal is slice 3 (timer storms /
         main-loop wakeups), not the dispatch path.

Measurement notes: keep A/B legs to `dist,dist-jit` pairs when the host
is loaded (the 4-leg RUNS=2 sweep took 15 min and was bimodal); save
baseline dists as `site/dist-base`/`site/dist-jit-base` legs before the
first candidate deploy — reconstructing a baseline later costs two
rebuilds.

## Session log: 2026-09-11 (benchmark audit — why "parity" was wrong and the loop was slow)

User report: manual boots to the idle screen take **86 s on /dist-jit
vs 78 s on /dist**, while every agent-run idlebench said "parity,
median 76.4 s both".  Audit of `tests/results/idlebench-*.json`
(the tool records the full sample series since the rewrite) and two
fresh runs on a quiet host:

- **tIdle is real-time paced, not speed.**  Per-second MIPS along the
  boot shows three phases: v 0→4.7 (compute + translation, JIT 3–10
  MIPS vs TCI 11–20 in the v 2→3.5 flash-command stretch), v 4.7→23.5
  (both engines idle at ~3 MIPS while v warps 2 v/s — device timers
  on `QEMU_CLOCK_REALTIME`/`HOST` pace it), v 23.5→39 (compute: TCI
  45 MIPS for 16.5 s, JIT 120 MIPS for 5 s).  Both end within 0.1 s:
  the JIT's 9 s early deficit is cancelled by its 11 s late win.
  Sequential run, quiet host (loadavg ~1):

  | dist | tIdle | window 2..7 | t0.25G | t0.5G | t0.75G | t1.0G | t1.3G |
  |---|---|---|---|---|---|---|---|
  | /dist (TCI) | 65.8 | 20.7 | 19.0 | 33.8 | 50.1 | 55.8 | 63.3 |
  | /dist-jit (wasm64) | 65.9 | 27.1 | 21.8 | 43.0 | 59.1 | 61.2 | 63.9 |
  | ratio | +0 % | **+31 %** | +15 % | **+27 %** | +18 % | +10 % | +1 % |

  The same +30 % window sat in every parallel-run JSON of the day
  (23.5/24.4/22.0/23.6 vs 30.9/29.7/28.0/30.8) and in the backend
  plan ("0.78× TCI") — it was reported, then overruled by tIdle.
  The user's machine has a different phase balance, so the deficit
  surfaces there as 86 vs 78 s.  Nothing about the JIT's late-phase compute
  (2.7× TCI) is wrong; the early boot is translation-bound (~2k new
  TBs/s, batched wasm module instantiation) and flash-command-bound,
  and that is the phase the next backend slice must target — meter:
  `t0.25G`/`t0.5G` and the window, on `--quick` runs.
- **Why the loop was slow**: idlebench defaulted to 3 runs × 1500 s
  cap × LCD compare, and the 2026-09-11 rewrite made it parallel to
  save time (which coupled the dists).  New defaults: sequential
  interleaved; `--quick` = 1 run, 60 s, no LCD (~1 min per dist,
  reports window + t0.1G/t0.25G/t0.5G); 1 s samples before the floor,
  0.5 s after; instruction milestones + A/B ratios + baseline
  regression verdict printed at the end.  A candidate-vs-saved-baseline
  `--quick` pair is ~2 min; a full `--runs 2` gate ~5 min.
- **Environment note**: this sandbox had no Chromium at all
  (`npx playwright install chromium-headless-shell` +
  `sudo npx playwright install-deps chromium-headless-shell` fixed
  it); the `package.json` pin to playwright-core 1.63 wants build
  1243.  A tool that cannot launch a browser must fail loudly — it
  does (uncaught launch error), which is fine.
- **Control run**: `EXTRA_Q=env=W64_NOACCTINLINE=1` (JIT ~5 % slower
  at every milestone) → tIdle 65.9→69.9 s, t1.3G 63.9→67.6; the new
  baseline check flagged it REGRESSION at every milestone ≥5 %.  So
  tIdle tracks t1.3G + ~2 s and the /dist vs /dist-jit equality is
  phase cancellation, not a floor.  (`JS_FLAGS=--no-wasm-tier-up` did
  nothing measurable — V8 tiers remain a non-factor.)
- **Open**: the ~9 s v 4.7→23.5 stretch at ~3 MIPS is paid identically
  by both engines and is real-time paced (dif/ssc/dmac transfer timers
  on `QEMU_CLOCK_REALTIME` are the candidates) — a slice-3 target that
  would help every backend; and the JIT's early-phase deficit
  (translation + flash-command bursts, where the wasm64 backend is
  behind TCI) is the next backend target, metered by `t0.25G`/`t0.5G`.

## Session log: 2026-09-11 (patch 0019 — wasm64: speculative successor translation, compile-once batching, compaction; Firefox OOM)

User report: `/dist-jit` runs out of memory in Firefox; goal = shorter
time-to-idle on the JIT dist with no browser console errors.

Reproduced in 10 s with a Playwright Firefox driver (`tools/ffboot.mjs`,
BROWSER=firefox|chromium; samples vclock/insns/RSS + the diag counters and
captures console errors): `WebAssembly module validated with warning:
failed to allocate executable memory for module` → `W64BATCHFAIL ...
InternalError: out of memory`.  Two Firefox facts measured with a
standalone probe (`tools/ffmodtest*.mjs`):

- SpiderMonkey gives every live wasm module its own 64 KB executable
  page out of a ~1 GB process budget: **~16.3k live modules is the
  ceiling, independent of module size** (2 KB modules die at 16,349).
- A module's code memory is not GC pressure.  On the main thread dropped
  modules get collected in time; in a **worker that never yields** (the
  vCPU pthread) a 6000-module FIFO still OOMs at 16.3k *created*.  ~80 KB
  of ordinary allocation per module (a throwaway 32 MB ArrayBuffer every
  256 instantiations) is enough to keep them collected.
- Per-module fixed cost dominates compile time: 20k×2 KB modules 553 ms
  vs 312×129 KB modules 75 ms in V8 (same bytes); Firefox ~120–150 µs per
  small module, ~85 MB/s for large ones.

The backend compiled one throwaway module per TB at first execution
(`w64_instantiate`) and a batch module per 128 TBs — ~1–2k modules/s in
the early boot, 21 % of vCPU self-time in `Module` (wprof2, PROF_DELAY=8)
— that is the early-boot deficit noted in the playbook's § Remaining #1.

### What landed (0019)

1. **Speculative successor translation** (`accel/tcg/cpu-exec.c`
   `w64_speculate`, CONFIG_TCG_WASM64 only): `translator_use_goto_tb`
   records each TB's goto_tb destinations (`tb->w64_succ[2]`); on a lookup
   miss the root's successors are translated breadth-first (through
   already-translated TBs too; `W64_SPEC_N`, default 16, max 64) so they
   join the open batch before anything runs.  Guards: plain cflags only
   (no one-shot io-recompile/icount requests), non-faulting
   `probe_access_full_mmu` on the target page AND the next page before
   any lookup (see the bug below), never within 1 MB of the code-buffer
   highwater (a flush would free the root under the caller; a flush is
   also detected via `tb_flush_count` → the caller re-looks-up).
2. **Compile once, on first execution** (`tcg_qemu_tb_exec`): a TB still
   staged in the open batch closes the batch (one module for the miss TB
   + its speculated successors) instead of getting a temp module; the temp
   path remains the fallback for a skipped (corrupt) batch or
   `W64_NOBATCH`.  A/B knob: `W64_NOCLOSEEXEC=1`.
3. **Landed-batch records + FIFO cap + re-ensure**: every landed batch
   keeps compact copies of its member/fixup/union tables (the staged
   bodies stay in the code buffer until tb_flush), so an evicted batch is
   re-assembled on demand (`w64_batch_ensure`) — the goto_tb `fidx == 0`
   brake makes evicted chains fall through to the dispatcher.  Live cap
   `W64_LIVE_MAX` (default 6144).
4. **Compaction** (`w64_compact`): every 256 live small batches (or 1024
   members) are merged into one module — union tables rebuilt, the
   members' 2-byte call-fixup LEBs remapped, identical bodies compiled
   once more at bulk rate — and the small modules dropped.  Live modules
   ≈ members/1024 + ≤256 smalls (measured: 162 live after 25 s vs 6144 at
   the cap; 0 re-ensures vs 7168 with the FIFO cap alone).
5. The GC nudge in `w64_batch_instantiate` (Firefox worker, above).
6. Diagnostics exports in `ui/wasm.c`: `wasm_pc`, `wasm_reg(gdb idx)`,
   `wasm_irq_pending`, `wasm_peek(addr)`; `W64_TBLOG=1` logs every
   translated TB (pc size icount cflags S/-); `W64_DEBUG=1` adds per-miss
   speculation counters and compaction lines.

### The bug that cost the session (do not repeat)

The first speculative build booted 12× slower into a watchdog-service
halt loop and exited with `Prefetch_Abort! At address: 0xA01AA618`.
Chain of evidence: memory digests identical to 100 M insns (E-line
register digests differ from epoch 1 but that is the known timing-race
softness), flash trace identical up to the second block unlock, the guest
spinning with CPSR I=1 reading STM_TIM0 from an SRAM routine (the firmware
"halt + kick watchdog" loop), TPU IRQs raised but never taken.  A
one-line print in `arm_deliver_fault` gave it away: **an alignment fault
on a fetch of 0xa0d07db2** — `blx <imm>` (ARM→Thumb) uses goto_tb, so its
2-byte-aligned Thumb target was recorded as a successor; `tb_htable_lookup`
calls the *faulting* `get_page_addr_code`, and ARM's tlb_fill flags a
fetch of a `pc & 3` address in ARM mode as an alignment fault → delivered
to the guest as a prefetch abort at the miss pc.  The same faulting
lookup would abort on any never-taken branch target the guest's MMU does
not map.  Fix: non-faulting probes (target + next page) *before* the
hash lookup; a probe miss skips the target.  Speculating with the root's
flags is otherwise harmless: a wrong-mode/wrong-condexec TB is keyed by
those flags and never used (TBLOG showed the guest re-translating those
pcs; all guest-translated shapes identical to the non-speculative run).

Tools that made the diagnosis: `tools/ffboot.mjs` (pc/regs/irq sampling
via the new exports), `tools/peek.mjs` (dump guest memory → objdump),
`tools/iotrace.mjs` (now takes DIST= and EXTRA_Q=; TRACE=flash), the
multi-insn lockstep leg (`LS_QARGS=` override in lockstep-wasm.mjs: wasm
vs wasm digests without one-insn-per-tb).

## Session log: 2026-09-11 (patches 0020, 0021 — successor hints; the wait fixes behind the display-DMA stretch)

**0020** (backend): the 0019 batch histogram said 60 % of misses had
every goto_tb successor already translated (avg 2.6 members).  Two more
successor sources — the return address after `bl`/`blx`
(`translator_note_succ`, an empty hook outside CONFIG_TCG_WASM64) and the
literal of the firmware's `ldr pc, [pc, #-4]` call thunks (read through
the non-faulting probe's host pointer) — plus `W64_SPEC_N` 32: batches
29.5k → 11.3k per 25 s (3.1 → 12.7 members), misses −60 %, t0.5G −5..−8 %
in both orders.  A 16/32/64 budget sweep was inside noise.

**0021** (both dists).  The ~12 s stretch (v 4.6→23.5 at 2–4 MIPS) is
~12k single-word DMA transfers to the display, one IRQ + halt per word.
Three theories died in order, each with a number:

1. *REALTIME completion timers* (dmac +1 ns, dif/ssc `timer_mod(…, 0)`)
   → switched to QEMU_CLOCK_VIRTUAL: tIdle flat (66→65 / 70.5→71.9).
   Reverted (REJECTED row).
2. *eventfd wake*: `qemu_clock_notify → event_notifier_set → write()`
   is a proxied syscall (~1 ms) per icount deadline — the atomic-flag
   replacement alone was also flat at tIdle (63.1→62.2 / 71.3→69.8),
   because the vCPU was not the one waiting.
3. *The halt wait never waited*: `qemu_cond_wait_impl` handed
   `emscripten_futex_wait` a 0 ms timeout = "return now, timed out", so
   `rr_wait_io_event` spun lock/unlock on the BQL (HALTLAT counters:
   4–10 iterations per halt) and the main loop's `bql_lock` queued
   behind it through emscripten's whole-ms mutex wait (2.5 s of a 10 s
   stretch profile).  INFINITY.  With both fixes: dist-jit 66→62.6 /
   68→58.9 s, dist 76→73 / 73.5→64.7 s (both orders).

Profiling notes: `tools/wprof2.mjs` now prefers the queried dist's
symbol map (it silently used `/dist`'s for dist-jit runs) and takes
`PROF_WORKER=<n>|main` to restrict `PROF_FN` caller stacks to one worker
(stacks aggregated across workers pointed at the io-dump thread's spin,
not the vCPU).  Per-worker self-time of the stretch: vCPU 36 % in futex
waits + 11 % waking the main loop, main loop 92 % idle — i.e. handoff
latency, not work.

## Session log: 2026-09-11 (patch 0022 — the goto_ptr handoff slot; two rejections)

Temporary exit-kind counters in `tcg_qemu_tb_exec` (W64_DEBUG) over a
30 s boot: 16.8M dispatcher exits, **14.9M goto_ptr "misses", 0 hits**
— the in-wasm indirect-jump fast path had never worked.  `tcg_out_goto_ptr`
stores the next descriptor at `[sp-8]` with `sp = frame+16` (frame+8);
the dispatcher read frame+0, which is always 0 (the layout comment even
says so).  Every `bx lr`/`pop {pc}`/`ldr pc` therefore returned to
`cpu_exec_loop` for a second lookup.  Fix: read frame+8, treat
`tcg_code_gen_epilogue` as the miss value.  Early-phase vCPU profile:
`cpu_exec_loop` 8.2 % → 2.2 %; idlebench quick both orders window
−8..−10 %, t0.5G −4 %.

Rejected the same afternoon (numbers in the playbook): TB jump cache
4k → 32k entries on wasm (pairs disagree, +4..+9 %/flat), compaction
threshold 256 → 16 (single-run sweep said −8 %, interleaved pairs said
+3 % both orders — on this host only interleaved pairs decide).
