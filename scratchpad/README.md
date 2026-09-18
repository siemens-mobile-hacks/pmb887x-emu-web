# scratchpad

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

## Evidence

`round35/` holds the 24 leg logs, `hostmon.tsv`, and the `bcprobe`
pair (`bc-on.log` / `bc-off.log`) behind the bound-check finding. The
analysis scripts read leg logs as `k<round>_<arm>.log`, so point them at
that directory to reproduce any number in the round-35 sections of the
handoff.
