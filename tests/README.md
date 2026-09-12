# Test suite

Boot + benchmark tests for the pmb887x emulator (native build), run over
the fullflashes that currently work: **s75, el71, c81, ke800**
(`fullflashes/`). The LG ke800 flash carries its EEPROM in the NOR flash
EFA block — its `KE800-v11b.bin.cfi-efa` sidecar must sit next to the
fullflash (the emulator picks it up automatically).

Sibling suites in this directory (each with its own README): `tcg-isa/`
(the guest op-suite, gate `scripts/run-tcg-isa.sh`) and `tcgbench/` (the
versatilepb perf bench + device-tax mirrors, `tools/tcgbench.mjs`). The
lockstep harness is documented below.

## Running

```bash
scripts/build-native.sh          # build/qemu-native-build/qemu-system-arm
bash scripts/sync-bsp.sh         # build/bsp @ pinned rev + patches/bsp/*

node tests/run.mjs               # ~1 min (see defaults below)
node tests/run.mjs --label after --timeout 150 --bench-secs 45
```

Useful options:

| flag | default | meaning |
|---|---|---|
| `--label NAME` | `run` | labels results JSON + tmp dirs |
| `--timeout SECS` | 180 | per-flash hard deadline |
| `--bench-secs SECS` | 45 | benchmark window (see below) |
| `--flash a,b` | all | subset of `s75,el71,c81,ke800` |
| `--keep` | – | keep per-run dirs under `/tmp` for inspection |

Env overrides `QEMU_BIN` / `BOARDS_DIR` select the emulator binary and
board-config directory (forwarded to `scripts/run-native.sh`). Results are
written to `tests/results/<label>-<timestamp>.json` together with a PNG
screenshot per flash — `<label>-<stamp>-<flash>-boot.png` (first shot with
LCD content, the boot-progress proof) and `<label>-<stamp>-<flash>.png`
(final state); the JSON records the paths under `screenshots`. Exit code
is non-zero if any test fails.

## What is tested

Every fullflash boots **in parallel** with the exact `run-native.sh`
recipe (`-icount shift=3,sleep=off` — omitted for LG boards — OTP
words derived from IMEI/ESN,
virtual SIM, ONLINE startup). The harness drives the HMP monitor
(screendump, `info registers`) and reads the serial log + the
instruction-count plugin.

1. **boot-init** (15 s) — board config parses, no `hardware error:` on
   stderr, guest executes ≥ 10M instructions, monitor answers.
2. **boot-progress** (deadline) — LCD lights up **and** shows content
   (≥ 300 saturated pixels in screendumps — splash/menu), or serial
   output; no firmware `>>EXIT<<` abort.
3. **no-exit** — no `>>EXIT<<` / hw_error / early process death during
   the whole observation window (catches regressions that only abort
   after early milestones).

## Benchmarks

- `tests/insncount.c` — TCG plugin that counts executed guest
  instructions (compiled to `tests/insncount.so`, needs the qemu source
  tree headers: `gcc -O2 -fPIC -shared -I qemu/include
  $(pkg-config --cflags glib-2.0) tests/insncount.c -o tests/insncount.so`).
- **MIPS** — executed instructions per second over the `--bench-secs`
  window (plugin's own monotonic clock; comparable across builds,
  independent of guest-visible milestones).
- **milestone timings** — seconds to first serial byte / LCD lit / LCD
  content. Boot is deterministic under `-icount shift=3,sleep=off`, so
  these track emulation speed too (the native build has no real-time
  cap, so idle warps are free; the instruction window is the pure-CPU
  measure).

The suite stops each instance ~10 s after the benchmark window once all
verdicts are in (fast path); the `--timeout` deadline is the worst case.

## Lockstep (phase 0b — cross-backend value equality)

Whole-boot, value-level comparison of guest state between two TCG
backends — the containment net the wasm64 backend was built under
([doc/wasm-tcg-backend-plan.md](../doc/wasm-tcg-backend-plan.md) §5);
`tools/lockstep-wasm.mjs` runs the same comparison against the wasm page.
Caveat learned on 2026-09-12: the gate forces `one-insn-per-tb`, so it
cannot see multi-insn-TB bugs (0034 slipped through it) —
`tools/bootcheck.mjs` covers those.

```bash
scripts/build-native.sh          # a-side: reference JIT
scripts/build-native-tci.sh      # b-side: TCI, plugins force-enabled
bash scripts/sync-bsp.sh

scripts/run-lockstep.sh                  # the gate: 3 full S75 boots
RUNS=1 INSNS=300e6 scripts/run-lockstep.sh   # quick smoke
SELF=1 scripts/run-lockstep.sh           # harness self-check (JIT vs JIT)
node tools/lockstep.mjs --corrupt 67108864 --insns 100e6   # positive control
```

- **Plugin** `tests/lockstep.c` (built to `tests/lockstep.so`): folds
  the r0–pc + CPSR vector (sampled every 2^16 executed guest insns, via
  an inline per-insn counter + conditional callback) and SRAM/SDRAM
  digests into a tiny text log — one E-line per 2^20 insns, one M-line
  per 2^23. Sampling is keyed on *executed guest instructions*, not TB
  boundaries (TB partitioning is TCG-internal — see the plugin header
  for the three qemu properties this design owes to).
- **Driver** `tools/lockstep.mjs`: boots the fullflash on both binaries
  under `-accel tcg,one-insn-per-tb=on -rtc base=2000-01-01T00:00:00,
  clock=vm` until both sides reach `--insns`, quits via the HMP monitor,
  byte-diffs the digest streams (+ serial logs), and saves both sides'
  final screendump next to the results JSON
  (`lockstep-<label>-<stamp>-run<N>-{a,b}.png`; the wasm gate
  `tools/lockstep-wasm.mjs` adds the browser page + LCD crops as
  `-b.png`/`-b-lcd.png`). On divergence it
  re-runs both sides with a dense per-insn dump window over the
  divergent epoch and reports the exact first differing insn + register
  vector — hand that to the phase-0a suite (`tests/tcg-isa`) to bisect
  by op.
- **Positive control**: `--corrupt N` flips one bit of r0 at insn N on
  the b-side only; the gate must flag the containing epoch and the
  dense rerun must pinpoint insn N (verified 2026-09-10).

Gate (2026-09-10, JIT vs TCI, S75, 3 × 2.5G guest insns ≈ full boot
through idle): **0 divergences** — 2385+ register-digest epochs and 298
SRAM+SDRAM digests identical per run, serial byte-identical, ~6 min
wall for all three runs in parallel. el71 smoke + `--self` clean too.
Note: lockstep requires the icount timing model (boards where
`run-native.sh` omits `-icount` — LG — run on the host realtime clock
and are not guest-deterministic enough for digest comparison).

## Notes

- The four instances run in parallel on a ≥ 4-core host; ~35 cores are
  plenty. Under heavy contention a phone may miss a firmware deadline
  (`>>EXIT<<`) — rerun or reduce parallelism if a flake is suspected.
- `lit` = non-black pixels of the qemu console screendump (240×320 frame
  containing the phone LCD); `col` = saturated-pixel count.
