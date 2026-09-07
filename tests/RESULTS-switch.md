# Switch test results: pmb887x-emu latest (2026-09-07)

`tests/run.mjs` (see README.md) run **before** and **after** the revision
switch, all three working fullflashes in parallel, 45 s benchmark window.
All verdicts PASS in both runs (boot-init / boot-progress / no-exit).

| config | qemu-pmb887x | pmb887x-dev (BSP) | board TOMLs |
|---|---|---|---|
| before | 2735ce4e | 9277046 | upstream as-is |
| after  | b31b98fe1e (alula `dsp-stuff`) | 49b0130 | + patches/bsp/0001 (hd155153np → pmb6272) |

## Benchmarks (native, TCG plugin insn counter)

| flash | MIPS before → after | LCD content before → after | insns/45 s before → after |
|---|---|---|---|
| s75  | 34.3 → 37.3 | 27.9 s → 32.3 s | 1.54G → 1.43G |
| el71 | 28.7 → 29.4 | 5.9 s → 5.9 s | 1.26G → 1.42G |
| c81  | 19.3 → 19.1 | 5.9 s → 5.9 s | 0.94G → 0.93G |

Same ballpark on every flash — no performance regression from the switch.
(The new DSP core is far more CPU-efficient per guest instruction: host
CPU time per 57 s run dropped from ~80 s to ~26 s for c81, i.e. the
emulator threads idle instead of busy-waiting.)

## What was found while switching

1. **BSP main branch references an undefined device** — board includes
   `siemens-sg2-x75.toml` / `siemens-sg2-elka.toml` define
   `[peripheral.RF] type = "hd155153np"`; the emulator's device table has
   no such device (only the `pmb6272` RF stub) → every s75/c81/el71 boot
   dies with `hardware error: Unknown device: hd155153np`.
   Workaround: `patches/bsp/0001` re-points both at `pmb6272`
   (results: `intermediate-dsp-stuff-{old,new}-bsp.json` — with the fix
   both BSP revisions behave identically).
2. **qemu master regresses the Siemens phones** — with master
   1f7fc803bf all three fullflashes abort during L1 GSM frame handling
   (`>>EXIT<< FILE: l1bbcsg / CepName: H_GSMFR`, 26–32 s; s75 never even
   lights the LCD). Fixed by the single commit on alula's `dsp-stuff`
   branch ("pmb887x: hacky AFE (LLE+HLE) implementation") — the AFE
   LLE+HLE hybrid is required for the L1↔DSP handshake. Hence the pin.
   (`intermediate-master-1f7fc80-no-afe-FAIL.json` documents the failure.)
3. **wasm patch chain** — 0002/0004/0006 rebased onto the new tree
   (context drift); 0001/0003 apply unchanged; 0005 (wasm32 draft)
   skipped, as before. Web dist rebuilt and verified: the s75 fullflash
   boots in the browser to the idle screen (~16M insns/s sustained,
   ~1.2G insns in 200 s, no `>>EXIT<<`).
