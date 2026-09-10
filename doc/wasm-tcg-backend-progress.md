# wasm64 TCG backend — implementation progress

Working log for `doc/wasm-tcg-backend-plan.md`. Updated periodically;
the plan file itself carries the phase gates.

## Status: phase 2 (chaining) landed; batching next

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
- **Gates after the fix**: op-suite 1156/1156; lockstep 20M + 250M
  clean (HARD SRAM digests identical); 700M window gate run recorded.
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

### Next (phase 2 continuation — split small, no 45-min waits)

- [ ] **Batching + eviction**: N TBs per module (shared deduped imports),
      staging arena for bodies (retaddrs stay code-buffer-keyed),
      finalize on batch-full or first-execution-need; module/instance
      teardown on tb_flush + LRU cap (live modules < 100) — kills the
      761M OOM wall and compile overhead.
- [ ] Re-run the full 3×2.5e9 gate on the batched backend (background).
- [ ] Async batch compile off the vCPU thread + TCI cold tier
      (TCI+wasm64 in one build) — phase-2 gate completion.
- [ ] LCD-frame digest in the fold (replace the vacuous serial check).
- [ ] Then phase 3: inline TLB probe, size-specialized ld/st, direct
      helper imports (the ≥2x-TCI lever).

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
# (2.5e9 blocked on batching: renderer OOM at ~761M under one-insn-per-tb)

# A/B boot bench (v=2..7 window; add DIST=dist-jit / dist-p1 / default=TCI)
PORT=8094 DIST=dist-jit node tools/bootbench.mjs 110

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
