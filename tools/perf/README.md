# tools/perf

Measurement and analysis tooling for the wasm performance workstream.
These are the scripts `doc/performance-handoff.md` and `doc/lessons.md`
cite by name; they live here so those citations resolve.

This is **not** a general dumping ground. It was one — thirty-odd rounds
of ad-hoc probes accumulated in a session temp directory — and the
handoff spent that whole time referencing files that were deleted when
the session ended. What is here is the subset the docs actually argue
from, plus the raw evidence for the round whose numbers are still live.

## Analysis

| file | what it decides |
|---|---|
| `square.py` | Fits the A/B sweep as the Latin square it is: arm + round + position on `log(ms/Mi)`, standard errors from (X′X)⁻¹, F-tests via a pure-Python incomplete beta. **Use this, not `ratios.py`.** |
| `ratios.py` | Within-round ratios against each round's own base. Superseded: it removes the round effect but is blind to position, which cost round 35 a false `ft4` result. Kept because the handoff quotes its numbers. |
| `clean.py` | Decides which legs ran while the host was busy, from `hostmon.tsv` alone — before looking at any result. Reports coverage first; a window it did not watch comes back "unknown", never "clean". |
| `entryfit.py` | Prices a TB entry by fitting `ms/Mi = a + b/len` with a per-round intercept. |
| `envfit.py`, `verdict.py`, `runner-duty.py` | Earlier-round fits, cited by the handoff. |
| `mech.py` | Reads the deterministic guest counters per arm instead of wall, for effects too small for wall to resolve. |
| `addrsrc.py` | Sizes the wasm32 migration: classifies every `w64_memarg` site in the backend by which expression pushes its *address*, modelling the store shape so the wrap does not land on the value. Reads the source, not a measurement. |

## Drivers

`ftsweep2.sh` is the sweep template (rotating arm order — hence the Latin
square). `hostmon.sh` samples host pressure alongside it and is what
`clean.py` reads; **run it whenever a sweep runs**, because a leg with no
pressure sample cannot be defended or convicted afterwards. `after.sh`,
`postsweep.sh`, `census.sh`, `gsync.sh`, `lgab.sh` chain the follow-up
measurements; `waitrun.sh` gates them.

## Native A/B

The browser sweeps above measure the wasm build. These measure two
*native* `qemu-system-arm` binaries against each other, which is what an
upstream-bound change needs:

| file | what it does |
|---|---|
| `bench.mjs` | Fixed guest work, wall time between instruction milestones from the `insncount` plugin. Same guest stretch on both binaries, so the difference is pure host speed. Everything below drives it. |
| `bench-ab2.sh` | ABBA order, CPU-pinned. Both matter: this host's powersave governor drifts, and pinning plus alternating order cancels the position bias — the same bias `square.py` exists to model. A serial unpinned predecessor was dropped for measuring that drift instead of the code. |
| `vg-ab.sh` | Host instructions retired (callgrind `Ir`) rather than wall, on disjoint core pairs. Immune to frequency and contention drift, so it resolves effects wall cannot. `vg.sh` is the wrapper it injects as `QEMU_BIN`. |
| `vg-ab2.sh` | `vg-ab.sh` with the B leg's binary taken from `$BINB`, for comparing something other than base-vs-fix. |
| `build-rev.sh` | Builds one qemu rev into `build/qemu-native-build`. |
| `test-commit.sh` | `build-rev.sh` on the `pmb887x-upstream` tip, then the 4-phone boot suite — the per-commit gate named in `upstream-split-plan.md`. |
| `cxboot.mjs`, `cxshot.sh` | CX70 (SGOLD / `dif_v1`) boot harness: milestones, a MIPS window once the idle screen settles, and periodic screendumps. |

`upstream-split-plan.md` is the live two-branch upstreaming plan these
serve.

## Output

Sweep drivers write to `$S`, which defaults to `logs/` here and can be
pointed elsewhere with `PERF_LOGS`. That directory is gitignored: it is
run output, not evidence. Committed evidence goes in `round35/`.

Every driver used to hard-code `$S` to a *session* temp directory, which
is why the handoff spent thirty rounds citing files that no longer
existed. Keep `$S` inside the repo.

## Evidence

`round35/` holds the 24 leg logs, `hostmon.tsv`, and the `bcprobe`
pair (`bc-on.log` / `bc-off.log`) behind the bound-check finding. The
analysis scripts read leg logs as `k<round>_<arm>.log`, so point them at
that directory to reproduce any number in the round-35 sections of the
handoff.

`round53/` is the other kind: the levers round fifty-three built and did
not get to measure (patches against the pinned qemu, draft commit
messages, and `run-lever.sh` / `gate-lever.sh` / `build-arm.sh` to A/B,
gate and commit them). The handoff's first open item is the order.

`xcensus.out` is the same kind of committed evidence — the executed-mean
TB size that `lessons.md` and the handoff cite — kept with its generator
`xcensus.sh` beside it.
