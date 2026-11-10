# doc — documentation index

**Doing performance work?** Read [performance.md](performance.md) (the
owner's rules, the A/B method, validation, where the time goes, and the
closed ideas to grep before trying anything), then
[wasm-fast-paths.md](wasm-fast-paths.md) for what the fork changes for
speed. Everything else is reference.

| Doc | What it covers |
|---|---|
| [performance.md](performance.md) | **Where the perf work stands**: target and binding rules, the timing model, scenebench scenes, the paired free-run A/B and the boot A/B, profiling, lockstep and checkers, the cost model, closed ideas, open issues, history since the DSP LLE |
| [wasm-fast-paths.md](wasm-fast-paths.md) | Every fork change in `qemu/` that exists only for speed: where it is, what it buys, how to remove it, and what was returned to upstream |
| [lessons.md](lessons.md) | Platform facts and traps: the timing model's reasons, the io-recompile rewind, the emscripten runtime, wasm and V8, backend and device design, measuring, gates, shell traps |
| [diagnostics.md](diagnostics.md) | **The tooling**: page URL params, the environment variables qemu reads, wasm exports, which script does what, native trace runs |
| [architecture.md](architecture.md) | How the browser emulator works: the wasm engine, the build pipeline from the `qemu/` submodule, what the fork adds, the page, native reference builds, the testing ladder |

## Scripts worth knowing

| Command | What it does |
|---|---|
| `scripts/ninja-fast.sh` | incremental rebuild + deploy to `site/dist-jit`, or to `$WEB_DIST` (absolute path) |
| `scripts/gate.sh quick\|keep\|close` | builds the native references from `qemu/` as checked out, then every correctness gate, run concurrently, one verdict table |
| `tools/perf/swab.sh` | paired free-run A/B of two dists built with `tools/perf/freerun.diff` |
| `tools/perf/bootab.sh` | paired boot A/B of two dists, paced as on the page |
| `tools/lockstep-wasm.mjs` | wasm vs native value lockstep; refuses a reference built from other sources |
| `scripts/run-tcg-isa.sh` | the guest op-suite on every built backend, serial logs byte-compared |
| `scripts/run-lockstep.sh` | native JIT-vs-TCI value lockstep over full boots |
| `scripts/build-qemu-wasm64.sh` | the safe mid-session full rebuild (`build-qemu.sh` resets the submodule to the pin first) |
