# Test suite

Boot + benchmark tests for the pmb887x emulator (native build), run over
the fullflashes that currently work: **s75, el71, c81, ke800**
(`fullflashes/`). The LG ke800 flash carries its EEPROM in the NOR flash
EFA block — its `KE800-v11b.bin.cfi-efa` sidecar must sit next to the
fullflash (the emulator picks it up automatically).

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
written to `tests/results/<label>-<timestamp>.json`; exit code is non-zero
if any test fails.

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
  tree headers: `gcc -O2 -fPIC -shared -I <qemu-src>/include
  $(pkg-config --cflags glib-2.0) tests/insncount.c -o tests/insncount.so`).
- **MIPS** — executed instructions per second over the `--bench-secs`
  window (plugin's own monotonic clock; comparable across builds,
  independent of guest-visible milestones).
- **milestone timings** — seconds to first serial byte / LCD lit / LCD
  content. Boot is deterministic, so these track emulation speed too
  (adaptive icount2 makes the phone wait real-time during idle windows;
  the instruction window is the pure-CPU measure).

The suite stops each instance ~10 s after the benchmark window once all
verdicts are in (fast path); the `--timeout` deadline is the worst case.

## Notes

- The three instances run in parallel on a ≥ 4-core host; ~35 cores are
  plenty. Under heavy contention a phone may miss a firmware deadline
  (`>>EXIT<<`) — rerun or reduce parallelism if a flake is suspected.
- `lit` = non-black pixels of the qemu console screendump (240×320 frame
  containing the phone LCD); `col` = saturated-pixel count.
