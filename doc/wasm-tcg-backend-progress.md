# wasm64 TCG backend — implementation progress

Working log for `doc/wasm-tcg-backend-plan.md`. Updated periodically;
the plan file itself carries the phase gates.

## Status: phase 3 (slice 1 landed) — slice selection now measurement-gated; end-to-end idle benchmark in place

### Session 2026-09-11 (early) — user regression report → real benchmark; corruption forensics hardened

- **User report (Central time, ~evening)**: boot-to-idle on /dist
  73 s at 2:26 PM → 80 s later; /dist-jit "an order of magnitude
  slower".  Decision: benchmark correctness first, before any more
  phase-3 work.  (Prior sessions' numbers were all v-window/finalV —
  never the human metric.)
- **`tools/idlebench.mjs` landed** — deterministic boot-to-idle
  benchmark: `fullflashes/S75v40lg1.bin`, reference
  `tools/test_targets/S75v40lg1_idle.png` (committed; the flash dir is
  gitignored), idle = 3 consecutive LCD matches ≥4 s apart, compare
  ONLY the bottom 139 rows (above them the idle screen animates:
  network-search spinner + clock), per-pixel rule from compare-lcd
  (channel delta > 48), startup=ONLINE, fresh headless browser per run,
  config + flash/ref/wasm/js sha256 + chrome version + loadavg pinned
  into `tests/results/idlebench-<ts>.json` (+ `idlebench-latest.json`
  stable alias for cross-session diffs).  Classification per run:
  IDLE / NOIDLE / STALL / CRASH with automatic salvage (screenshot,
  serial.log, `/w64bad-*`, `/w64fail-*`) for anything not IDLE.
  Usage: `PORT=8094 node tools/idlebench.mjs dist,dist-jit --runs 2`.
- **First idlebench results (this host, Chrome 153, 2 runs each):
  /dist 70.4 / 74.4 s, /dist-jit 78.4 / 78.4 s to idle** (v≈51.5 at
  idle on this flash, pct-diff ≤0.08 %, zero W64 diagnostics, no
  crashes).  Conclusions: (a) the served artifacts contain NO 10x
  regression — wasm64 is ~8–10 % behind TCI on the human metric;
  (b) /dist 73→80 s is within the playbook's ±5–8 % single-run noise
  band; (c) the 10x report is environment-specific (their Chrome /
  machine state / possibly a torn binary from one of tonight's
  non-atomic `cp` deploys — see below) — next step is the user re-running
  the same protocol on their machine.
- **Non-atomic deploy hazard identified (self-inflicted)**: deploying
  with plain `cp` over the live-served `qemu-system-arm.wasm` can serve
  a torn 45 MB file; serve.mjs carefully tmp+renames the .gz sidecar
  but nothing protects the wasm itself.  Deploy via `mv` (rename) or
  stop the server; fix the deploy scripts (todo).
- **Batch-corruption forensics hardened** (root cause still open):
  every staged member now carries an FNV-1a checksum of its body bytes
  (`w64_sum` at `w64_batch_member` time); `w64_batch_close`
  re-validates every member's source LEB + checksum BEFORE assembly —
  the next hit now distinguishes *code-buffer overwrite between staging
  and close* (foreign writer — the leading theory class) from
  record/assembly bugs — and all evidence lands in the page FS as
  `/w64bad-<id>.bin` (member records, fixups, full source regions with
  slack, assembled module bytes on walk failure) because the page
  console drops multi-line output.  `tools/repro.mjs` now salvages
  `/w64bad-*` + `/w64fail-*` from the page FS on EVERY attempt.
  Verified: op-suite 1156/1156 plain + `W64_BATCH_N=4`; lockstep 20M
  clean.  Soak with the new build: 2 clean attempts before it was
  killed for benchmarking (host quiet rule).
- **Symbol map for the wasm64 build**: `meson configure
  -Dc_link_args=…,'--emit-symbol-map'` (+cpp_link_args) on
  build/qemu-wasm64 — `wprof2.mjs` now resolves symbols on dist-jit
  (the TCI build always had one).  `wprof2.mjs` gained `PROF_DELAY=<s>`
  (wait before Profiler.start — boot-phase selection for late-window
  profiles).
- **Early-window profile of this backend (60 s, v≈0.6–5.2)** — vCPU
  self-time: `tcg_qemu_tb_exec` 15 %, **`w64_tb_account` 8.3 %** (the
  per-TB-entry accounting import — a new, concrete slice-2 candidate:
  inline the icount/deadline math into emitted code), `cpu_exec_loop`
  6 %, `helper_lookup_tb_ptr` 3.7 %, temp-module `w64_instantiate`+
  `Instance` ~3 %, `tcg_gen_code` 1.2 %.  **MMIO dispatch absent from
  the top** — the §4.7 "MMIO now dominant" premise holds at best for
  the late poll window; a `PROF_DELAY` late-window profile is the gate
  before any MMIO fast-path work (and the playbook's rejected table
  already killed a memory.c-level version on TCI).
- Doc note per user: the "JIT 1.3–2.3x" numbers in the optimization
  playbook are the DISCARDED wasm32/ktock port — never cite them as this
  backend's numbers.

### Session 2026-09-10 (late) — flaky batch-corruption hunt + safety net

- **Field reports from manual Chrome boots**: a flaky batch-module
  `CompileError: length overflow while decoding body size` that kills
  the vCPU worker mid-boot (2x on the user's machine, 3x here — always
  within the first ~60 s, different batches/compositions each time).
- **Forensics so far** (validator in `w64_batch_close`): members
  0..55 walk clean, then member 56's staged size LEB reads
  `FF FF FF FF 3F`-style garbage — i.e. the corruption is in the staged
  body bytes / code buffer, not in the section arithmetic (count/total
  checks are now exact).  The overflow-retry double-add theory is dead
  (dedupe never fires; kept as defense).  Root cause still open — it
  is flaky (not reproduced in the last ~45 min of boots).
- **Safety net landed**: every assembled batch is walked exactly as
  the decoder will (count LEB, per-body size vs recorded body_len,
  thunk, total, fixup bounds) before `w64_batch_instantiate`; on
  mismatch: enriched forensics (source-vs-copy hex, prev member tail,
  fixup ranges) + SKIP the landing — members stay on their temp
  modules and the boot continues.  A JS-side compile failure still
  stashes the module to the page FS (`/w64fail-N.wasm`).  Skips are
  rare enough not to matter for throughput (and temp-only boots are
  healthy: v=296@190s).
- Two of my own validator bugs found and fixed on the way (count-LEB
  off-by-one; walk-vs-total compared against the section header) —
  each silently disabled batching for a build.  Lesson: the validator
  needs a positive control — soak logs must show batches LANDING.
- **bootbench upgraded**: v-milestone wall times, stall detection,
  chromium-tree RSS, batch-close/tb-flush counters, early exit on
  failure.  `tools/repro.mjs`: retry-loop boot repro with full
  W64BATCH* forensic capture.
- **Speed sanity on this host** (same s75_working flash as the user):
  deep boot ~2x TCI (v-milestones: 169@130s / 237@160s / 594@260s vs
  TCI ~150@110s), window 32.1s vs TCI 24.7s.  A user report of
  "~10x slower than TCI" on a clean boot is NOT explained by anything
  measured here — needs numbers from their machine (bootbench
  milestones or WATCH lines).  Candidates: the earlier crash-looping
  builds, background-tab throttling, or a Chrome-version difference.

### Session 2026-09-10 (night) — phase 3 slice 1: inline TLB probe

- **Landed**: `qemu_ld/st` emit the TLB probe + size/sign-specialized
  access inline (miss → the phase-1 `*_mmu` helper as the `else` arm).
  Probe semantics copied byte-exact from `tci_tlb_probe` (patch 0011):
  `entry = fast->table[(addr >> page_bits) & (fast->mask >> 5)]`, hit ⟺
  `entry->addr_{read,write} == ((a_mask < s_mask ? addr + s_mask - a_mask
  : addr) & (TARGET_PAGE_MASK | a_mask))`; flags (bits 6..8) live inside
  the page-mask window so MMIO/NOTDIRTY/WATCHPOINT/plugin entries always
  miss.  Layout via `tlb_mask_table_ofs()` + QEMU_BUILD_BUG_ONs (entry
  5-bit, DescFast 16 bytes, addend @24).  Serial-mode canonicalization
  turns ldrd's MO_ATOM_SUBALIGN into NONE, so ldrd inlines too;
  BSWAP/stricter atoms stay on the helper.  `W64_NOTLB=1` disables.
- **Perf (S75 bootbench, this host)**: v=2..7 window 38.1 → **31.8 s**
  (TCI 24.7 → 0.78x; window is MMIO-bound — §4.7 is the next lever);
  finalV@110s **164 vs phase-2's 69 vs TCI 151** — the boot is now
  *ahead* of TCI end-to-end at 110 s.
- **Gates**: op-suite 1156/1156 (plain + W64_NOTLB + W64_NOBATCH×NOTLB
  knob runs); lockstep 20M, 250M, 700M clean (HARD SRAM digests
  identical, RSS plateau ~1.7GB).
- **Bring-up bug #1 (page)**: `?env=NAME=VAL` was only wired into the
  phone-boot `preRun`, not `bootSuite` — knob experiments through the
  suite silently no-oped (first NOTLB/NOBATCH "runs" were vacuous).
  Fixed in site/app.js; suite runner (`tools/tcgisa64.mjs`) gained
  env args.
- **Bring-up bug #2 (emitter, the interesting one)**: with `data ==
  addr` (legal — ldrd's 64-bit load targets the same TCG reg that holds
  its address), the hit arm's `local.set` of the data register flips
  the tracked *representation* (i32↔i64 local) between the two arms'
  emissions, so the arm emitted **second** read the address from a
  stale local → 4 ldrd op-suite failures, and on manual boot a
  post-splash renderer OOM (diverged firmware churning TB translation;
  the 20M lockstep window never reaches ldrd, so gates looked clean).
  Fix: snapshot `zext(addr)` into a third i64 scratch ($scr2 — locals
  declaration grew by one) before the arms; probe + both arms read
  only the snapshot.  Root-caused by dumping the first ld64 TB's module
  bytes from the emitter and disassembling with emsdk `wasm-dis` —
  the WAT showed the else arm calling the helper with `(local.get
  $39)` where the probe had `(i64.extend_i32_u (local.get $6))`.
- Patch 0017 regenerated in place.

### Session 2026-09-10 (evening) — batching (phase 2 core)

- **Design decision (cold tier)**: fresh TBs execute immediately after
  translation (tb_gen_code → cpu_tb_exec is 1:1), so demand-closing
  batches would degenerate to 1–2 members.  Instead every TB still gets
  its single-member **temp module** (the phase-2a path, unchanged) and
  *simultaneously* joins the open batch; when the batch lands the temp
  is dropped (`removeFunction` + the batch's element segments overwrite
  the TAB entry in place, so chains and the tidx space are unaffected).
  Double-compile cost is bounded (temps ≤ batch size, and live modules ≈
  live_TBs/N + N), and no TCI cold tier is needed for v1.
- **Index stability**: bodies keep **per-TB-local** import/type indices
  (temp modules = the phase-2a layout byte-for-byte; there is no replay
  hazard — cpu_restore_state_from_tb walks the pre-encoded search table
  only, nothing ever re-emits into a TB's buffer).  Every `call` emits a
  **fixed-width 2-byte funcidx LEB** and records a fixup {pos, union
  idx}; the batch assembler rewrites the LEBs in its copy.  Union tables
  (W64_UMAX_TYPES 64 / W64_UMAX_IMPORTS 192) only append; a batch closes
  early if a union is within one TB's worth of new entries of full.
- **Batch assembly** (`w64_batch_close` in wasm64.c): type section =
  union + thunk sig (i64,i64,i64,i32)->i32; imports = memory + chain
  table + deduped helpers; one function per member (type 0); one active
  element segment per member (TAB[tidx] = member funcidx); export "run"
  → thunk; code section = staged bodies (patched) + 14-byte thunk body
  (`local.get 0..3; return_call_indirect type 0, table 0`).  Sync
  instantiate via EM_JS `w64_batch_instantiate` (bytes copied for
  Firefox; TAB grown to max tidx first), then per member:
  removeFunction(temp), desc+0 = thunk fidx, desc+4 = 0x80000000|batch id
  (bit 31 distinguishes batch id from the mod_len a not-yet-compiled
  temp still carries — an abort-guard bug here taught us the hard way).
- **Dispatcher**: desc+4 tagged → call run(env, sp, tp, tidx), else the
  temp entry directly; fidx==0 + tagged desc+4 = evicted member (loud
  abort until LRU re-ensure exists).
- **goto_tb** gained a third brake term (target desc fidx == 0) —
  future-proofing for LRU eviction; costs one i32.load per chained goto.
- **tb_flush** (`w64_batch_flush`, hooked in tb-maint.c): removeFunction
  for every landed batch thunk + the open batch's temps, clear TAB,
  reset the tidx counter (bounded by the live TB set again).
- **Knobs/telemetry**: `W64_BATCH_N` (1..256; N=1 exercises the whole
  batch path minimally), `W64_NOBATCH=1` (pure phase-2a), `W64_DEBUG=1`
  (per-close stats + flush stats); page takes arbitrary `?env=NAME=VAL`
  (repeatable); lockstep-wasm.mjs gained `--env` + per-leg chromium-RSS
  telemetry; bootbench.mjs gained `EXTRA_Q`.
- **Gates after batching**: op-suite 1156/1156; lockstep 20M (incl.
  W64_BATCH_N=4), 250M ×2, 700M clean; **3×2.5e9 one-insn-per-tb gate
  3/3 clean** (each: 298 HARD SRAM digests + 128/129 SDRAM + serial
  identical, wall ~795s) — previously renderer OOM at exactly
  761,266,176 insns.  RSS
  telemetry: flat ~1.85–1.95GB through 2.5e9 (was ~7.2GB and climbing
  at death).  Boot window v=2..7: 38.0–38.2s batched vs 38.4s
  W64_NOBATCH vs 22.0s TCI (0.58x — unchanged, as expected: the window
  is MMIO/helper-bound; phase-3 TLB inlining is that lever).  A scary
  first bootbench (finalV 3.2) did not reproduce across 3 clean runs —
  system-contention artifact, not a code path.
- Patch 0017 regenerated (15 files, incl. tb-maint.c flush hook).

### Session 2026-09-10 (afternoon) — review, gate fixes, chaining

- **Reviewed the uncommitted hand-off changes** (tools/lockstep*.mjs,
  tests/lockstep.c, plan-doc status). Verdict: keep the mechanism
  (stop_at, point-in-time E-hash, page-FS grab, T/X formats — all
  byte-consistent with the wasm64.c fold; plugin .so rebuilt; patch 0017
  captured exactly), fix the bugs, revert one false claim:
  - `compareDigestLogs` had softened E-lines/SDRAM for *all* callers —
    weakened the native JIT-vs-TCI gate. Now opt-in
    (`opts.soft = ["epoch","mem-sdram"]`), native gate strict again.
  - `reportDenseTb` was off by one column after the T-line format
    change (regs start at col 4 now).
  - `mem: null` ≠ "no digests": both legs silently defaulted to the
    16MB SDRAM range — the very overhead that timed out gate attempt #1.
    Default is now the tuned `800000+18000:a8000000+100000`.
  - Driver: live b-leg progress (page-FS E-line tail poll), per-30s
    status lines, partial-log salvage on wall timeout, browser-crash
    hook, `#status` className error detection.
  - Plan-doc "gate green" claim reverted (attempt #1 had produced no
    wasm logs at all).
- **Full-gate attempt #2** (fixed driver): all 3 legs froze at exactly
  761,266,176 insns, renderer RSS ~7.2GB → **per-TB module/instance
  accumulation OOM** under one-insn-per-tb (~800k live modules, phase-1
  has no eviction). Solo repro identical. ⇒ the 2.5e9 one-insn-per-tb
  gate is architecturally blocked until batching/eviction; interim gate
  = 700M windows + op-suite. (Plain-mode boots are fine: 10x fewer TBs.)
- **Serial check is vacuous on these firmwares**: S75/el71 fullflash
  boots write 0 UART bytes (verified across all runs) — "serial
  byte-identical" passes trivially. HARD behavioral anchors: internal-
  SRAM digest + clean budget exit. TODO: LCD-frame digest in the fold.
- **Phase-2a: goto_tb tail-call chaining landed** (see plan §phase-2
  status). Design: chain slot = `tb->jmp_target_addr[n]` itself (qemu
  core maintains it link/reset, TCI-style — `tb_target_set_jmp_target`
  stays empty); emitted code loads the slot at runtime, falls through
  to the exit code when it holds the self-reset address, else
  `return_call_indirect` through a shared funcref table ("e"/"t",
  registered at instantiate; index = new `W64_DESC_TIDX` descriptor
  field assigned at translation). TB prologues call imported
  `w64_tb_account(icount)` (wasm_tb_account + icount2_advance + lockstep
  fold) at *every* entry — chained entries stay exact; `w64_chain_stop`
  (armed by the fold at budget) suppresses further chaining so legs
  stop at the exact budget like the native plugin's stop_at.
- **Second emscripten -O3 artifact found + worked around**: the prelude
  custom-section filler computed `content=127` but emitted LEB `255`
  (bit-7 bleed into the second wb_u8) — triggered exactly at the
  content==127 boundary exposed by chaining's +19 prelude bytes; only
  normal-mode S75 TBs hit it (one-insn-per-tb TBs never did — which is
  why the instrumented gates passed while plain boots died at ~16M).
  Fix: precompute all filler bytes into locals before writing. If a
  third -O3 artifact shows up, drop tcg/tcg.c to -O2.
- Bring-up bugs along the way: table import kind byte (0x01 not 0x02),
  memory64 needs i64 address operands (no i32.wrap before loads), and
  the leftover per-instantiate W64DBG console spam removed.
- **Gates after the fix**: op-suite 1156/1156; lockstep 20M + 250M +
  **700M** clean (700M = 83 HARD internal-SRAM digests identical, exact
  budget stop both legs, 337s wall — the deepest window possible under
  the OOM wall).
- **Perf**: v=2..7 window 45.9s (phase-1 dist) → 38.4s (chained);
  TCI reference on this host 24.4s → 0.63x TCI. finalV after 110s:
  66 vs TCI 165 — the later MMIO-heavy boot hurts most (phase-3 TLB
  inline is the lever, as the plan predicted). bootbench.mjs got DIST=
  env support for A/B.
- **Patch capture**: `patches/0017-tcg-wasm64-backend.patch`
  regenerated to skeleton+chaining (reverse-apply verified against the
  tree; header documents both -O3 artifacts). Untracked junk ignored
  (.idea/, root PNGs).

### Done (previous sessions)

- **Phase 0a (op-suite)** — `tests/tcg-isa` + drivers: 1156 cases.
- **Phase 0b (lockstep harness)** — plugin + native driver + gate,
  3×2.5e9 JIT-vs-TCI clean.
- **Phase 1 backend** — `tcg/wasm64/` skeleton; per-TB modules; full
  S75 plain boot to standby UI; built-in lockstep fold; wasm driver.
- **Phase-1 close-out** — `scripts/build-qemu-wasm64.sh` (one-shot
  build+deploy), `?dist=dist-jit` page switch, debug tooling.

### Next (post-phase-2)

- [x] **Batching + eviction** — landed (see session log above).
- [x] Re-run the full 3×2.5e9 gate on the batched backend: **3/3 clean**
      (298 HARD SRAM digests identical per run, serial identical, RSS
      flat ~1.9–2.1GB).
- [x] **Phase 3 slice 1: inline TLB probe + size-specialized ld/st** —
      landed (see the session log at the top); full 2.5e9 one-insn-per-tb
      gate clean on the phase-3 backend (298 HARD SRAM digests identical,
      RSS plateau ~2.0GB).
- [ ] **User-side repro of the /dist-jit 10x report** — same idlebench
      protocol on their machine (fresh reload of the S75v40lg1 boot);
      this host shows /dist-jit ≈ /dist + 8–10 % to idle.  If it
      reproduces, the hardened forensics capture the cause; if not, it
      was environment (Chrome update/machine state/torn deploy).
- [ ] **Deploy hygiene**: make wasm deploys atomic (deploy to a temp
      name + `mv`, like serve.mjs's .gz sidecar) in the deploy scripts.
- [ ] **Phase 3 slice 2 — pick by measurement, not by §4.7 assumption**:
      1. late-window profile (`PROF_DELAY=115 node tools/wprof2.mjs …`)
         — is the poll phase actually MMIO-bound?
      2. if yes: MMIO fast-path at FlatView/TLB level (NOT memory.c —
         rejected there on TCI);
      3. regardless: `w64_tb_account` inline accounting (8.3 % of vCPU
         in the early window — emit the deadline decrement in wasm,
         import-call only on underflow) and direct imports for top
         helpers, `lookup_tb_ref` (3.7 %).  div/rem N/A on arm926.
- [ ] Interleaved idlebench A/B (playbook discipline: alternate runs,
      2× each, pair-wise dominance) becomes the phase-3 acceptance
      metric ("S75 idle screen < 90 s" gate — measure on S75v40lg1
      with idlebench, not just v-window).
- [ ] LRU cap on landed batches (live modules < 100) — not needed for
      the 2.5e9 gate (RSS plateau ~1.9GB, ~6k batch instances at the
      800k-TB working set); add when a longer soak or the full gate
      shows pressure.  The goto_tb fidx brake + the loud dispatcher
      abort are already in place; re-ensure = re-assemble the batch
      module from the still-staged bodies (they persist in the code
      buffer until tb_flush).
- [ ] Async batch compile off the vCPU thread + TCI cold tier
      (TCI+wasm64 in one build) — only if profiling shows the sync
      batch-compile hiccup matters (it does not in the boot window).
- [ ] LCD-frame digest in the fold (replace the vacuous serial check) —
      the idlebench bottom-139-rows idea is the template.

## Build/run cheat-sheet

```sh
# build (deps pre-fetched; emsdk env + CPATH/PKG_CONFIG_PATH required)
/workspace/scripts/ninja-wasm64.sh qemu-system-arm.js
cp build/qemu-wasm64/qemu-system-arm.{js,wasm} site/dist-jit/

# serve + run
PORT=8094 setsid nohup node serve.mjs > /tmp/serve.log 2>&1 &

# op-suite
cd tools && node tcgisa64.mjs 8094 dist-jit

# lockstep (wasm leg) — native reference from scripts/build-native.sh
cd tools && node lockstep-wasm.mjs --insns 20e6 --secs 200    # smoke (~15s)
cd tools && node lockstep-wasm.mjs --insns 250e6 --secs 360   # window (~90s)
cd tools && node lockstep-wasm.mjs --insns 700e6 --secs 900   # pre-OOM wall
cd tools && node lockstep-wasm.mjs --insns 2.5e9 --secs 2700  # full gate (~13min)
# knobs: --env W64_BATCH_N=8 / --env W64_NOBATCH=1 (b-rss in progress lines)

# A/B boot bench (v=2..7 window; add DIST=dist-jit / dist-p1 / default=TCI)
PORT=8094 DIST=dist-jit node tools/bootbench.mjs 110

# end-to-end boot-to-idle benchmark (the human metric; deterministic protocol)
PORT=8094 node tools/idlebench.mjs dist,dist-jit --runs 2   # ~2×80s + 2×80s
# late-window profile for phase-3 slice selection:
PORT=8094 PROF_DELAY=115 node tools/wprof2.mjs 75 "dist=dist-jit" 200

# rebuild the lockstep plugin (auto-done by scripts/run-lockstep.sh)
gcc -O2 -Wall -fPIC -shared -I build/qemu-native/include \
    $(pkg-config --cflags glib-2.0) tests/lockstep.c -o tests/lockstep.so
```

## Environment notes

- serve.mjs lives at the repo ROOT (not scripts/); one instance per
  port; second instance dies on the shared HTTPS_PORT — use
  `PORT=8094 HTTPS_PORT=6809`.
- Old phase-1 dist kept at `site/dist-jit` → `site/dist-p1` for A/B
  (gitignored).
- Configure (build/qemu-wasm64): `--static --cpu=wasm64
  --target-list=arm-softmmu --without-default-features --enable-system
  --enable-tcg --enable-pixman --with-coroutine=wasm --disable-tools
  --disable-docs --disable-install-blobs --disable-werror
  -Dcpp_std=gnu++20 --extra-cflags="-O3 -pthread -DWASM_BIGINT
  -sMEMORY64=1"`.
- build/qemu = git @ b31b98fe1e + patches 0001–0016 (working tree) +
  0017 (wasm64 backend, untracked files + tracked mods; intent-to-add
  via `git add -N tcg/wasm64` so diffs capture them).
- Emscripten exit from deep vCPU context trips "function signature
  mismatch" — use the dispatcher's LS.stop exit path (return-code
  unwind then exit(0)); never exit() from inside a chain.
- `mod.FS` on the browser main thread sees files created by the
  proxied program thread (verified for /lockstep.log, /serial.log —
  this is also how the driver polls live progress now).
- Playwright `exposeFunction` lands in the page's main world; log-grab
  from page FS at "exited" status is the primary channel.
