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

`logs/` is run output and is gitignored.
