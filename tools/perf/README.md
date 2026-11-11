# tools/perf

Measurement tooling for the wasm performance work. The method is in
[doc/performance.md](../../doc/performance.md); this lists what each file
is.

## Current

| file | what it does |
|---|---|
| `swab.sh` | Paired free-run A/B, all pairs at once: each pair runs leg A and leg B of `tools/scenebench.mjs` together on pinned SMT core sets, sides alternating between pairs, with V8 explicit bounds checks on (as on Android). `swab.sh <scene> <distA> <distB> [pairs 1-4] [measure s]`; env `BFLAGS=0` drops the bounds checks, `ARGS_A`/`ARGS_B` add chrome args per leg, `METRIC` (default `vratio`), `OUT`, `PORT_A`/`PORT_B`. Prints per-pair B/A and the mean with its standard error. |
| `freerun.diff` | Bench-only qemu patch both swab dists must be built with: adds `wasm_free_run()`, which makes the vt clock's host reading run 1000× wall speed, so the guest never waits for real time. Apply with `git -C qemu apply`, revert with `git apply -R` before gating or committing. |
| `bootab.sh` | Paired boot A/B of two dists with `tools/bootbench.mjs`, paced as on the page: `bootab.sh <phone> <distA> <distB> [pairs]`; env `SPAN=<v0>,<v1>` (guest-time span timed, default 6,12), `ARGS_A`/`ARGS_B`, `PORT_A`/`PORT_B`. Fetches both wasm files first, so neither leg waits for the server's gzip. |
| `v8tick.py` | Resolves a V8 `--prof` log of the vCPU isolate into self-time buckets (main-module functions named from the `.symbols` sidecar, TB modules, V8 builtins, Chrome C++). The self-time instrument for effects below the A/B's noise. |
| `wasmgrab.mjs` | Profiles a running page's vCPU worker and saves its hottest TB modules' bytes, so their TurboFan x64 can be read offline. |
| `wasm-bhint.mjs` | Adds a branch-hint section to a captured module, to test a codegen hypothesis offline before building it. |
| `hostmon.sh` | Samples host memory pressure every 10 s (writes to `$PERF_LOGS`). |
| `reap.py` | Runs a command as a child subreaper, so the Chromium processes it orphans are reaped instead of staying zombies. |
| `busdigest.py` | Patches a temporary digest of the DSP peripheral bus into a qemu tree: every register access, interrupt flag and I2S word, hashed with the bus cycle count and printed as `BUSHASH` lines. Two native builds with the same bus timing print the same lines on a deterministic boot. The check for the bus deferral (wasm-fast-paths.md D12); usage in the file's header. |
| `adbtun.mjs` | Reaches a phone through an adb server on another machine (the Docker host): `adbtun.mjs listen 9222 localabstract:chrome_devtools_remote` gives this machine the phone Chrome's DevTools port, and `adbtun.mjs raw 'reverse:forward:tcp:8080;tcp:<this container>:8080'` makes the page server the phone's `127.0.0.1:8080`, which the adb client refuses to ask for. Setup in doc/performance.md, "On a phone". |
| `a64code.sh` | Prints the arm64 code V8's optimizing tier makes of a wasm module that `wasmgrab.mjs` saved, with explicit bounds checks as on Android, from an arm64 Node under qemu-user (fetched on first use; `A64_NODE` picks the release whose V8 is the phone's Chrome's). `a64code.sh <module.wasm> [out]`. |
| `wasmtrace.mjs` | Records V8's wasm compile events of a running Chromium over DevTools and sums them per event and thread: lazy baseline compiles on the vCPU thread, TurboFan compiles in the background, their counts per second and durations. `wasmtrace.mjs [seconds] [devtools port]`; works on a phone through `adbtun.mjs`. Tells whether the optimizing tier keeps up, which the CPU profiler cannot. |
| `profsplit.py` | Splits the vCPU thread of a saved DevTools profile (`PROF_SAVE` of `tools/wprof2.mjs`) into ARM TBs, DSP blocks, C under the DSP's functions and the rest of the C module, by the call chain above each sample. `profsplit.py <cpuprofile> site/<dist>/qemu-system-arm.js.symbols` |
| `phonethreads.sh` | Per-thread CPU of the busiest Chrome renderer on the attached phone over an interval, from `/proc/<pid>/task/*/stat` through adb (Android's `top` hides app threads from the shell). The vCPU is the worker near 100 %; less than that with the guest behind real time is waiting. `phonethreads.sh [seconds]` |
| `paintbench.mjs` | Times the page's LCD paint step, the version before 2026-11-11 and the current one, in a page of its own at both panel sizes. `paintbench.mjs [cdp-url]` (no argument: a local headless Chromium) |

`logs/` is run output and is gitignored.
