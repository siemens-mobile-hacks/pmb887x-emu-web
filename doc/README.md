# web/doc — documentation index

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | How the two browser modes work, the build pipeline, the qemu patch set |
| [early-crash-postmortem.md](early-crash-postmortem.md) | The 0004 io-recompile-skip boot regression (bisect, GPTU SRC7 divergence, resolution) |
| [livelock-postmortem.md](livelock-postmortem.md) | Full debugging story of the WASM boot livelock: symptoms, root causes, fixes, evidence — including the fixed 104 MHz virtual-clock timing model |
| [performance-handoff.md](performance-handoff.md) | Performance analysis, targets and open next steps to cut boot wall-time (correctness no longer depends on speed) |
| [optimization-playbook.md](optimization-playbook.md) | The 0007–0009 session method: fast feedback loop, A/B benchmarking (tools/bootbench.mjs), profiling recipe, landed/rejected changes with numbers, remaining opportunities |
| [diagnostics.md](diagnostics.md) | The tooling built along the way: URL params, trace channels, headless-browser probes |
| [serial-cross-tab.md](serial-cross-tab.md) | Exposing the emulator's serial port to another tab: what the browser allows (Web Serial can't be published; socat ptys invisible to Chrome), the tab-link design and the wasm chardev prerequisite |
