# web/doc — documentation index

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | How the two browser modes work, the build pipeline, the qemu patch set |
| [early-crash-postmortem.md](early-crash-postmortem.md) | The 0004 io-recompile-skip boot regression (bisect, GPTU SRC7 divergence, resolution) |
| [livelock-postmortem.md](livelock-postmortem.md) | Full debugging story of the WASM boot livelock: symptoms, root causes, fixes, evidence — including the fixed 104 MHz virtual-clock timing model |
| [performance-handoff.md](performance-handoff.md) | Performance analysis, targets and open next steps to cut boot wall-time (correctness no longer depends on speed) |
| [diagnostics.md](diagnostics.md) | The tooling built along the way: URL params, trace channels, headless-browser probes |
