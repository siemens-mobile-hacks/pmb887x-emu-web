# doc — documentation index

**Doing performance work?** Read
[performance-handoff.md](performance-handoff.md) down to the end of
§ Open items, then [optimization-playbook.md](optimization-playbook.md)
§ The iteration ladder. Everything else is reference.

| Doc | What it covers |
|---|---|
| [performance-handoff.md](performance-handoff.md) | **Where the perf work stands**: the boot cost model from counters, the ranked open items, what binds, what is out of scope — then a round log of how it got there, newest first |
| [optimization-playbook.md](optimization-playbook.md) | **The method**: measure-vs-gate, the iteration ladder with costs, A/B rules and measurement traps, the profiling recipe, and the landed / REJECTED / remaining tables. **Check § REJECTED before starting anything** — it is 34 experiments deep and several ideas have been retried twice |
| [lessons.md](lessons.md) | Conclusions of the investigations that shaped the design, without the investigation records: the timing model, mid-TB MMIO accounting, emscripten runtime traps, backend design, measuring, gates, pmb887x facts |
| [diagnostics.md](diagnostics.md) | **The tooling**: page URL params, the full `?env=` knob inventory (A/B knobs vs measurement knobs vs verification knobs), wasm exports and the `wasm_memstat` counter ABI, which script does what, native trace runs |
| [architecture.md](architecture.md) | How the browser emulator works: the two wasm engines (wasm64-backend dist-jit = default, TCI dist), the build pipeline from the `qemu/` submodule, the series' structural commits, the page, native reference builds, the testing ladder |
| [upstream-branch.md](upstream-branch.md) | The qemu series branch (`wasm-browser-port` / `origin/wasm-patches`, = the `qemu/` submodule): how to work on it and bump the pin, the commit list with scope, safety properties for a native merge, the standalone RTC fix branch |
| [wasm-threads-audit.md](wasm-threads-audit.md) | Evidence that the browser build really runs multi-threaded (5 pthread workers), the thread census (1 vCPU + futex-parked waiters), the two profiling traps that faked a "syscall spin", and the no-symbols hand-symbolization recipe |
| [serial-cross-tab.md](serial-cross-tab.md) | Exposing the emulator's serial port to another tab: what the browser allows (Web Serial can't be published; socat ptys invisible to Chrome), the tab-link design and the wasm chardev prerequisite |

Reviews — all three were taken against the **43-commit** tree of
2026-09-12 and most of their findings have since been fixed; each
carries a status banner, and a finding in them means "was true then":

| Doc | What it covers |
|---|---|
| [wasm-port-review.md](wasm-port-review.md) | The critical review of the whole series against master: bugs found (wasm64 emitter, futex/main loop, generic cputlb/memory, TCI), what can be removed or gated to get closer to master without losing performance, dependency structure, knob inventory, per-file coverage |
| [wasm-port-glm-review-part1.md](wasm-port-glm-review-part1.md) | A second reviewer's pass over everything **outside** `tcg/wasm64` (~4,100 added lines across 65 files) |
| [wasm-port-glm-review-part2.md](wasm-port-glm-review-part2.md) | The same reviewer on `tcg/wasm64` itself (5,152 lines) |

## Scripts worth knowing

| Command | What it does |
|---|---|
| `scripts/ninja-fast.sh` | incremental rebuild + deploy to `site/dist-jit` (~8 s); `TCI=1` for `site/dist` |
| `scripts/gate.sh quick\|keep\|close` | every correctness gate, run concurrently, one verdict table (measured 152 s / 152 s / 719 s; 846 s and 2274 s if run serially) |
| `scripts/run-tcg-isa.sh` | the guest op-suite on every built backend, serial logs byte-compared |
| `scripts/run-lockstep.sh` | native JIT-vs-TCI value lockstep over full boots |
| `scripts/build-qemu-wasm64.sh` | the safe mid-session full rebuild (`build-qemu.sh` resets the submodule to the pin first) |
