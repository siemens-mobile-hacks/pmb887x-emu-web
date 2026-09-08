# Livelock post-mortem (WASM boot)

Symptom chain as observed, root causes found, and what was fixed. All
evidence reproducible with the tools in `tools/` (see
[diagnostics.md](diagnostics.md)).

## Symptom

WASM-mode boots the machine, then the guest stalls: virtual clock advances
forever, the LCD never initialises, and the phone's firmware eventually
prints `>>EXIT<< … FILE: l1bbcsg ExitCode: 0x000B` on serial — per the
emulator author, **any `>>EXIT<<` in serial means the phone crashed; do not
wait for recovery**. The L1 (GSM baseband) task times out waiting for the
DSP and kills the OS.

Natively (same pinned revision, same fullflash, same env) the phone boots to
its idle screen in seconds.

## Root causes (in fix order)

### 1. Asyncify breaks pthread_cond wakeups between web workers

Emscripten compiles the module with Asyncify (qemu's wasm coroutine backend
needs it). With Asyncify, `pthread_cond_signal`/`broadcast` fired from one
worker is **not delivered** to a waiter in another worker — the waiter only
ever returns via timeout (verified with a 20-line emcc reproducer: signals
return `r=73` timeouts, never `r=0` wakes; without `-sASYNCIFY` signals work
fine).

qemu's `QemuCond` is a pthread_cond wrapper and `HAVE_FUTEX` is undefined on
emscripten, so **every** cross-thread wakeup (the pmb887x DSP worker's
enable/kick/background waits, `QemuEvent`, semaphores) silently degenerated
to timeout-only wakeups. The DSP worker slept through its boot-command
kicks → the ARM's `COM_SET` flag was never cleared → L1 timeout → crash.

Fix: futex-based `QemuCond` on emscripten (`util/qemu-thread-posix.c`,
seq+waiters scheme on `emscripten_futex_wait/wake`, which is Asyncify-safe)
and an emscripten branch in `include/qemu/futex.h` (also switches QemuEvent
to its futex fast path). Verified in-browser: after the fix the DSP clears
flag 0 for every `COM_SET` (`[pmb887x-dsp]: DSP_CFR: … cleared=0001`), and
head-host MMIO wiring matches the native trace.

### 2. Wild TranslationBlock pointer → unaligned atomic trap

First attempt to speed things up batched the icount2 accounting per TB and
made TCI's `goto_tb` return the chained target to `cpu_exec`. TCI's
`goto_tb` slot holds a **code pointer** (`&tb->jmp_target_addr[n]` →
`tb_next->tc.ptr`), not a `TranslationBlock *`; returning it made
`tb_add_jump` do `qatomic_cmpxchg(&tb->jmp_dest[n], …)` on bytecode-buffer
memory → `RuntimeError: operation does not support unaligned accesses`
(the i64 cmpxchg at `base+idx*8+136`, symbolised via
`--emit-symbol-map` → `cpu_exec_loop` → inlined `tb_add_jump`). The worker
died at TB #6.

Fix: don't generate chained `goto_tb` at all on emscripten —
`tcg_out_goto_tb` emits `exit_tb(tb | idx)` (`tcg/tci/tcg-target.c.inc`),
terminating the TB with a *real* TB pointer so the cpu loop keeps chaining
correctly. (Additionally `itb->icount` is snapshotted *before* executing
the TB — it can be freed by io-recompile/self-modifying-code while the
interpreter runs.)

### 3. icount2 ("precise clocks") mis-locking on a slow host

The fork's `precise-clocks=on` (icount2) derives guest virtual time from
executed cycles and **adapts its frequency to keep virtual ≈ real time**,
clamped to [1 MHz, 500 MHz]. On wasm-TCI the interpreter sustains far less
than the 1 MHz floor, so:

- virtual time ran ahead of executed instructions (~0.6× wall at best),
- every firmware timing budget shrank proportionally (the emulator author's
  "судя по пику он проебал precise clocks" — it missed precise clocks),
- guest timer deadlines arrived "early" tens of TBs at a time and the
  `icount2_sync()`/`run_timers` work triggered by each deadline made the
  interpreter *slower still* (a vicious cycle measured at 51k insns/s).

Fixes: frequency floor 1 kHz on emscripten (let the controller converge on
the real rate) + the per-TB accounting above replacing the per-instruction
cycle helper (a TCI helper call costs a libffi → `ffi_call_js` → JS
roundtrip, ~1.7 µs — measured at 574k insns/s ceiling) +
`-sASYNCIFY_REMOVE=tcg_qemu_tb_exec` (the interpreter is reachable from the
asyncify import via libffi and ran fully instrumented — removing it doubled
the rate).

### 4. The remaining blocker: raw interpreter speed

**Update 2026-09-07: root cause found — it was not raw speed.**

The controller's raison d'être (virtual ≈ real time) is itself
wrong on a host ~130× slower than the guest: locking virtual time to
wall time *starves the guest of instructions per virtual second*, and
the L1↔DSP handshake — which has a firmware wall-clock budget — can
never fit.

**Update 2026-09-08: superseded — no fork-specific clock patch at all.**
The interim fix (`0006-wasm-icount2-fixed-104MHz-virtual-clock.patch`,
now in `patches/attic/`) ran icount2 at a hard-coded 104 MHz. A stock
upstream configuration does the same job better: **`-icount
shift=3,sleep=off`**. `shift=3` makes virtual time strictly
instruction-proportional (8 ns per guest insn — ≈ the phones' 104 MHz
ARM9 cycle budget, slightly looser than real hardware since an ARM9
sustains well under 1 insn/cycle), so every deadline arrives with the
full native instruction budget at any host speed. `sleep=off` — the
indispensable half — makes guest idle deterministic as well: virtual
time jumps straight to the next timer deadline instead of the vCPU
parking in realtime while the virtual clock catches up at 1×. With the
default `sleep=on`, the vCPU burns real wall time in every idle window
while execution runs at ~0.05×, and the half-host-paced L1↔DSP
handshake (the DSP worker's spin deadlines run on `QEMU_CLOCK_HOST`,
see `hw/arm/pmb887x/dsp.c`) desyncs — `shift=3` *and* `shift=4` with
`sleep=on` die with the very same `>>EXIT<< FILE: l1bbcsg`, both on
wasm and natively (`tools/bootmatrix.mjs`, `tests/run.mjs`), while
`shift=3,sleep=off` boots in the browser and natively. Raw speed now
only affects *how long* boot takes, not whether it completes.

LG firmware, notably, needs no icount at all: it boots to content on
the plain realtime clock (wasm + native) — the page and
`scripts/run-native.sh` omit `-icount` for `lg-*` boards.

(Patch 0004, whose skip-`cpu_io_recompile` shortcut caused the even
earlier `FILE: flash` abort, was dropped — see
[early-crash-postmortem.md](early-crash-postmortem.md).)

Historical analysis (why locking virtual to wall time crashed, kept for
context):

After all fixes the emulator is stable and deterministic: no traps, virtual
clock advances at wall rate, exit histogram clean (no interrupt storm —
`ex=[code0, code1, 0, ~25 requested]`), and the boot loader **does** draw
the splash (framebuffer update counts climb to ~1000) before the L1 task
eventually times out. The firmware's own serial then shows the crash.

But this firmware is a **busy-polling** monster: natively it burns on the
order of 10⁸–10⁹ instructions during the first 30 virtual seconds of boot
(SCU_UID2 poll loops ×800, DSP handshake polling). It effectively requires
a guest pace of tens of millions of instructions per second *when virtual
time is locked to wall time*. TCI-on-wasm sustains ~0.2–0.6×10⁶
(measurements in [performance-handoff.md](performance-handoff.md)) — 3
orders of magnitude short, so with icount2 locked to the real rate every
wall-clock-timeout protocol (L1 ↔ DSP handshake first among them) failed.
With the fixed 104 MHz clock that requirement disappears — correctness
holds at any speed because deadlines are instruction-proportional — and
what remains is a pure usability question of boot wall-time
([performance-handoff.md](performance-handoff.md)).

## What works / what doesn't today

| Item | State |
|---|---|
| qemu machine boots in-browser (board, BROM, flash loader) | ✅ |
| LCD framebuffer path (splash draws, canvas repaints) | ✅ |
| Keypad input path, quit path, serial, options | ✅ |
| Deterministic execution, no worker traps | ✅ |
| L1↔DSP handshake / no `>>EXIT<<` (stock icount `shift=3,sleep=off`) | ✅ slow-motion |
| S75 full boot to idle screen (WASM) | ⏳ slow motion — minutes to tens of minutes of wall time at current TCI speed |
| LG full boot without icount (`-icount` omitted) | ✅ wasm + native (LG firmware has no wall-clock-starved budgets) |
