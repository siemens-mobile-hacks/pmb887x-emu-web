# doc — documentation index

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | How the browser emulator works: the two wasm engines (TCI dist + wasm64-backend dist-jit), the build pipeline, the qemu patch set, the page, native reference builds, the testing ladder |
| [early-crash-postmortem.md](early-crash-postmortem.md) | The 0004 io-recompile-skip boot regression (bisect, GPTU SRC7 divergence, resolution) |
| [livelock-postmortem.md](livelock-postmortem.md) | Full debugging story of the WASM boot livelock: symptoms, root causes, fixes, evidence — ending in the stock-icount timing model (`shift=3,sleep=off`) that replaced every fork-specific clock patch |
| [performance-handoff.md](performance-handoff.md) | The current workstream hand-off: the qemu-core device-path tax (MMIO dispatch, timer storms, main-loop wakeups), measured baseline, targets, plan, constraints |
| [optimization-playbook.md](optimization-playbook.md) | The working method of all perf sessions (2026-09-07 →): fast feedback loop, A/B benchmarking, profiling recipe, landed/rejected changes with numbers, per-session logs |
| [diagnostics.md](diagnostics.md) | The tooling built along the way: URL params, trace channels, headless-browser probes |
| [serial-cross-tab.md](serial-cross-tab.md) | Exposing the emulator's serial port to another tab: what the browser allows (Web Serial can't be published; socat ptys invisible to Chrome), the tab-link design and the wasm chardev prerequisite |
| [wasm-threads-audit.md](wasm-threads-audit.md) | Evidence that the browser build really runs multi-threaded (5 pthread workers), the thread census (1 vCPU + futex-parked waiters), the two profiling traps that faked a "syscall spin" (sample-count ≠ CPU for parked threads; V8 function indices include imports), and the no-symbols hand-symbolization recipe |
| [wasm32-port-status.md](wasm32-port-status.md) | The wasm32 runtime-JIT TCG backend port (old patch 0005, ktock design) — CLOSED/discarded 2026-09-09: architecture, bring-up bugs, measured ~1.3–2.3× ceiling, why it died |
| [wasm-tcg-backend-plan.md](wasm-tcg-backend-plan.md) | Feasibility verdict + phased plan for the redesigned wasm64 TCG backend (tail-call chaining, locals, batched modules) — with per-phase status and gates |
| [wasm-tcg-backend-progress.md](wasm-tcg-backend-progress.md) | The wasm64 backend's implementation session log (phase 1 → 3: skeleton, chaining, batching, inline TLB, inline accounting, tcgbench) |
| [upstream-branch.md](upstream-branch.md) | The `wasm-browser-port` git branch (one commit per patch, ready to PR): series contents, safety properties, how patches/*.patch are regenerated from it, verification status |
| [upstream-analysis.md](upstream-analysis.md) | The 2026-09-08 per-patch review for upstreaming: which patches are really wasm-only vs generic (0003 de-gated), bug fixes found, native/wasm measurements |
