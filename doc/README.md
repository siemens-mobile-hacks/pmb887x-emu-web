# doc — documentation index

**Doing performance work?** Read
[performance-handoff.md](performance-handoff.md) down to the end of
§ Open items, then [optimization-playbook.md](optimization-playbook.md)
§ The iteration ladder. Everything else is reference.

| Doc | What it covers |
|---|---|
| [performance-handoff.md](performance-handoff.md) | **Where the perf work stands**: the boot cost model from counters, the ranked open items, what binds, what is out of scope — then a round log of how it got there, newest first |
| [optimization-playbook.md](optimization-playbook.md) | **The method**: measure-vs-gate, the iteration ladder with costs, A/B rules and measurement traps, the profiling recipe, and the REJECTED / remaining tables (per-patch numbers live in the commit messages on the `qemu/` branch). **Check § REJECTED before starting anything** — dozens of experiments are recorded there and several ideas have been retried twice |
| [lessons.md](lessons.md) | Conclusions of the investigations that shaped the design, without the investigation records: the timing model, mid-TB MMIO accounting, emscripten runtime traps, backend design, measuring, gates, pmb887x facts |
| [diagnostics.md](diagnostics.md) | **The tooling**: page URL params, the full `?env=` knob inventory (A/B knobs vs measurement knobs vs verification knobs), wasm exports and the `wasm_memstat` counter ABI, which script does what, native trace runs |
| [architecture.md](architecture.md) | How the browser emulator works: the two wasm engines (wasm64-backend dist-jit = default, TCI dist), the build pipeline from the `qemu/` submodule, the series' structural commits, the page, native reference builds, the testing ladder |

## Scripts worth knowing

| Command | What it does |
|---|---|
| `scripts/ninja-fast.sh` | incremental rebuild + deploy to `site/dist-jit` (~8 s); `TCI=1` for `site/dist` |
| `scripts/gate.sh quick\|keep\|close` | every correctness gate, run concurrently, one verdict table (measured 152 s / 152 s / 719 s; 846 s and 2274 s if run serially) |
| `scripts/run-tcg-isa.sh` | the guest op-suite on every built backend, serial logs byte-compared |
| `scripts/run-lockstep.sh` | native JIT-vs-TCI value lockstep over full boots |
| `scripts/build-qemu-wasm64.sh` | the safe mid-session full rebuild (`build-qemu.sh` resets the submodule to the pin first) |
