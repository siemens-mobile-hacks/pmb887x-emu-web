# tools/perf

Measurement and analysis tooling for the wasm performance workstream.
These are the scripts `doc/performance.md`, `doc/optimization-playbook.md`
and `doc/lessons.md` cite by name; they live here so those citations
resolve.

This is **not** a general dumping ground. It was one — thirty-odd rounds
of ad-hoc probes accumulated in a session temp directory — and the old
perf hand-off spent that whole time referencing files that were deleted
when the session ended. What is here is the subset the docs argue from,
plus the raw evidence for rounds whose numbers are still quoted.

Most of the September 2026 tooling below no longer runs as-is: the
2026-09-22 review (qemu `b9971ade2e`) removed every `W64_*` env knob
except the lockstep ones and every `wasm_memstat` counter, the
real-time cap (`rt=`, `RT=`) went on 2026-10-29, and the shell drivers
hard-code `/workspace` as the repository root, which it no longer is.
They are kept as the record of how the quoted numbers were made.

## Current A/B

| file | what it does |
|---|---|
| `swab.sh` | Paired free-run A/B, all pairs at once: each pair runs leg A and leg B of `tools/scenebench.mjs` together on pinned SMT core sets, sides alternating between pairs, with V8 explicit bounds checks on (as on Android). `swab.sh <scene> <distA> <distB> [pairs 1-4] [measure s]`; env `BFLAGS=0` drops the bounds checks, `ARGS_A`/`ARGS_B` add chrome args per leg, `METRIC` (default `vratio`), `OUT`, `PORT_A`/`PORT_B`. Prints per-pair B/A and the mean with its standard error. |
| `freerun.diff` | Bench-only qemu patch both swab dists must be built with: adds `wasm_free_run()`, which makes the vt clock's host reading run 1000× wall speed, so the guest never waits for real time. Apply with `git -C qemu apply`, revert with `git apply -R` before gating or committing. |
| `v8tick.py` | Resolves a V8 `--prof` log of the vCPU isolate into self-time buckets (main-module functions named from the `.symbols` sidecar, TB modules, V8 builtins, Chrome C++). The self-time instrument for effects below the A/B's noise. |
| `wasmgrab.mjs` | Profiles a running page's vCPU worker and saves its hottest TB modules' bytes, so their TurboFan x64 can be read offline. |
| `wasm-bhint.mjs` | Adds a branch-hint section to a captured module, to test a codegen hypothesis offline before building it. |
| `modcap.mjs` | Saves every batch module a boot compiled; needs a dist built with `doc/attic/modcap-round49.diff`. |
| `hostmon.sh` | Samples host memory pressure next to every leg (writes to `$PERF_LOGS`); `clean.py` reads it. |

## Analysis

These read leg logs, not live runs, so they still reproduce the numbers
of the rounds they were written for.

| file | what it decides |
|---|---|
| `square.py` | Fits the A/B sweep as the Latin square it is: arm + round + position on `log(ms/Mi)`, standard errors from (X′X)⁻¹, F-tests via a pure-Python incomplete beta. **Use this, not `ratios.py`.** |
| `ratios.py` | Within-round ratios against each round's own base. Superseded: it removes the round effect but is blind to position, which cost round 35 a false `ft4` result. Kept because round-35 numbers were quoted from it. |
| `clean.py` | Decides which legs ran while the host was busy, from `hostmon.tsv` alone — before looking at any result. Reports coverage first; a window it did not watch comes back "unknown", never "clean". |
| `entryfit.py` | Prices a TB entry by fitting `ms/Mi = a + b/len` with a per-round intercept. |
| `envfit.py`, `verdict.py`, `runner-duty.py` | Earlier-round fits. |
| `mech.py` | Reads the deterministic guest counters per arm instead of wall, for effects too small for wall to resolve. Needs the `wasm_memstat` counters in the leg logs (round 35 has them; current builds print none). |
| `addrsrc.py` | Sizes the wasm32 migration: classifies every `w64_memarg` site in the backend by which expression pushes its *address*, modelling the store shape so the wrap does not land on the value. Reads the source, not a measurement. |

## Drivers (round-35 templates)

`ftsweep2.sh` is the sweep template (rotating arm order — hence the Latin
square). `after.sh`, `postsweep.sh`, `census.sh`, `gsync.sh`,
`xcensus.sh`, `lever-chain.sh`, `queue7.sh`, `queue43.sh`, `ke970-*.sh`,
`knob-abba.sh`, `j2abba.sh` and `mem32ab2.sh` chain the follow-up
measurements; `waitrun.sh` gates them. Most of them set removed `W64_*`
knobs, read removed counters or pass `RT=`, and they assume the
repository root is `/workspace`, so they document a method rather than
run one. Whatever replaces them should
keep two of their habits: rotate the arm order, and run `hostmon.sh`
whenever a sweep runs, because a leg with no pressure sample cannot be
defended or convicted afterwards.

## Native A/B

The browser A/B measures the wasm build. These measure two *native*
`qemu-system-arm` binaries against each other, which is what an
upstream-bound change needs. They hard-code `/workspace/build/...` and
`/workspace/qemu`; point them at this repository's `build/` and `qemu/`
before use.

| file | what it does |
|---|---|
| `bench.mjs` | Fixed guest work, wall time between instruction milestones from the `insncount` plugin. Same guest stretch on both binaries, so the difference is pure host speed. Everything below drives it. |
| `bench-ab2.sh` | ABBA order, CPU-pinned. Both matter: this host's powersave governor drifts, and pinning plus alternating order cancels the position bias — the same bias `square.py` exists to model. A serial unpinned predecessor was dropped for measuring that drift instead of the code. |
| `vg-ab.sh` | Host instructions retired (callgrind `Ir`) rather than wall, on disjoint core pairs. Immune to frequency and contention drift, so it resolves effects wall cannot. `vg.sh` is the wrapper it injects as `QEMU_BIN`. |
| `vg-ab2.sh` | `vg-ab.sh` with the B leg's binary taken from `$BINB`, for comparing something other than base-vs-fix. |
| `build-rev.sh` | Builds one qemu rev into `build/qemu-native-build`. |
| `test-commit.sh` | `build-rev.sh` on the `pmb887x-upstream` tip, then the 4-phone boot suite — the per-commit gate named in `upstream-split-plan.md`. |
| `cxboot.mjs`, `cxshot.sh` | CX70 (SGOLD / `dif_v1`) boot harness: milestones, a MIPS window once the idle screen settles, and periodic screendumps. |

`upstream-split-plan.md` is the September 2026 two-branch upstreaming
plan these served (base `5b24f7b50f`). The fork has merged `smh/master`
since; `doc/wasm-fast-paths.md` is the current list of what still
differs from upstream.

## Output

Drivers write to `$S`, which defaults to `/workspace/tools/perf/logs`
and can be pointed elsewhere with `PERF_LOGS`; set it to this
directory's `logs/`. That directory is gitignored: it is run output, not
evidence. Committed evidence goes in a `round<N>/` directory.

Every driver used to hard-code `$S` to a *session* temp directory, which
is why the hand-off spent thirty rounds citing files that no longer
existed. Keep `$S` inside the repo.

## Evidence

`round35/` holds the 24 leg logs, `hostmon.tsv`, and the `bcprobe`
pair (`bc-on.log` / `bc-off.log`) behind the bound-check finding. The
analysis scripts read leg logs as `k<round>_<arm>.log`, so point them at
that directory to reproduce any round-35 number.

`round53/` holds the levers round fifty-three built and did not get to
measure (patches against the then-pinned qemu, draft commit messages,
and `run-lever.sh` / `gate-lever.sh` / `build-arm.sh`). After the DSP
LLE merge F1m and M1 were re-measured and dropped, and T1 no longer
decodes against the batch encoder; none of them landed.

`xcensus.out` is the same kind of committed evidence — the executed-mean
TB size that `lessons.md` cites. Its generator `xcensus.sh` needs the
removed `W64_XCOUNT` knob.
