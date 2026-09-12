# doc — documentation index

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | How the browser emulator works: the two wasm engines (wasm64-backend dist-jit = default, TCI dist), the build pipeline from the `qemu/` submodule, the series' structural commits, the page, native reference builds, the testing ladder |
| [upstream-branch.md](upstream-branch.md) | The qemu series branch (`wasm-browser-port` / `origin/wasm-patches`, = the `qemu/` submodule): how to work on it and bump the pin, the 43-commit list with scope, safety properties for a native merge, the standalone RTC fix branch |
| [performance-handoff.md](performance-handoff.md) | Status per session (newest first) with the numbers, then the device-path workstream's baseline, targets, plan and constraints |
| [optimization-playbook.md](optimization-playbook.md) | The live perf method: the iteration ladder (cheapest reject first, per-step costs), A/B rules, measurement traps, profiling recipe, landed/rejected/remaining tables, the final gates |
| [optimization-sessions.md](optimization-sessions.md) | Append-only history of the perf sessions (2026-09-07 →): per-session narratives, measurement forensics, the patch-isolation study, open investigations |
| [diagnostics.md](diagnostics.md) | The tooling: page URL params, wasm exports, the headless-browser scripts that matter, native trace runs |
| [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md) | Feasibility verdict + phased plan for the wasm64 TCG backend (tail-call chaining, locals, batched modules) — landed; kept as the design record with per-phase gates |
| [wasm-tcg-backend-progress.md](wasm-tcg-backend-progress.md) | The wasm64 backend's implementation session log (phase 1 → 3: skeleton, chaining, batching, inline TLB, inline accounting, tcgbench) + build/run cheat-sheet |
| [livelock-postmortem.md](livelock-postmortem.md) | Full debugging story of the WASM boot livelock: symptoms, root causes, fixes, evidence — ending in the stock-icount timing model (`shift=3,sleep=off`) that replaced every fork-specific clock patch |
| [early-crash-postmortem.md](early-crash-postmortem.md) | The 0004 io-recompile-skip boot regression (bisect, GPTU SRC7 divergence, resolution) |
| [wasm-threads-audit.md](wasm-threads-audit.md) | Evidence that the browser build really runs multi-threaded (5 pthread workers), the thread census (1 vCPU + futex-parked waiters), the two profiling traps that faked a "syscall spin", and the no-symbols hand-symbolization recipe |
| [serial-cross-tab.md](serial-cross-tab.md) | Exposing the emulator's serial port to another tab: what the browser allows (Web Serial can't be published; socat ptys invisible to Chrome), the tab-link design and the wasm chardev prerequisite |
| [wasm32-port-status.md](wasm32-port-status.md) | The wasm32 runtime-JIT TCG backend port (old patch 0005, ktock design) — CLOSED/discarded 2026-09-09: architecture, bring-up bugs, measured ~1.3–2.3× ceiling, why it died |
| [upstream-analysis.md](upstream-analysis.md) | The 2026-09-08 per-patch review of 0001–0009 for upstreaming: which are really wasm-only vs generic (0003 de-gated), bug fixes found, native/wasm measurements |
