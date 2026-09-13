# doc — documentation index

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | How the browser emulator works: the two wasm engines (wasm64-backend dist-jit = default, TCI dist), the build pipeline from the `qemu/` submodule, the series' structural commits, the page, native reference builds, the testing ladder |
| [upstream-branch.md](upstream-branch.md) | The qemu series branch (`wasm-browser-port` / `origin/wasm-patches`, = the `qemu/` submodule): how to work on it and bump the pin, the 43-commit list with scope, safety properties for a native merge, the standalone RTC fix branch |
| [wasm-port-review.md](wasm-port-review.md) | The 2026-09-12 critical review of the whole series against master: bugs found (wasm64 emitter, futex/main loop, generic cputlb/memory, TCI), what can be removed or gated to get closer to master without losing performance, dependency structure, knob inventory, per-file coverage, recommended order of work |
| [performance-handoff.md](performance-handoff.md) | Where the perf work stands: current numbers, where a boot's time goes, ranked open items, constraints, non-goals |
| [optimization-playbook.md](optimization-playbook.md) | The live perf method: the iteration ladder (cheapest reject first, per-step costs), A/B rules, measurement traps, profiling recipe, landed/rejected/remaining tables, the final gates |
| [lessons.md](lessons.md) | Conclusions of the investigations that shaped the design, without the investigation records: the timing model, mid-TB MMIO accounting, emscripten runtime traps, backend design, measuring, gates, pmb887x facts |
| [diagnostics.md](diagnostics.md) | The tooling: page URL params, wasm exports, the headless-browser scripts that matter, native trace runs |
| [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md) | The wasm64 TCG backend's design record: what the first attempt proved, platform readiness, the tail-call/locals/batched-modules architecture, phases and gates |
| [wasm-threads-audit.md](wasm-threads-audit.md) | Evidence that the browser build really runs multi-threaded (5 pthread workers), the thread census (1 vCPU + futex-parked waiters), the two profiling traps that faked a "syscall spin", and the no-symbols hand-symbolization recipe |
| [serial-cross-tab.md](serial-cross-tab.md) | Exposing the emulator's serial port to another tab: what the browser allows (Web Serial can't be published; socat ptys invisible to Chrome), the tab-link design and the wasm chardev prerequisite |
