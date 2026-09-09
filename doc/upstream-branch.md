# The upstream branch: `wasm-browser-port`

The 12-patch series lives as a git branch, ready to push/PR to
[Azq2/qemu-pmb887x](https://github.com/Azq2/qemu-pmb887x) — the QEMU
fork that [pmb887x-emu](https://github.com/siemens-mobile-hacks/pmb887x-emu)
embeds as its `qemu` submodule.

```
worktree:  build/qemu-upstream          (git worktree of build/qemu)
branch:    wasm-browser-port
base:      b31b98fe  (alula/dsp-stuff tip — the pinned rev in versions.env;
                      NOT yet in Azq2 master, which is behind it)
```

To publish (adjust remote/author to taste):

```bash
git -C build/qemu push <your-fork> wasm-browser-port:wasm-browser-port
# or from the worktree:
git -C build/qemu-upstream remote add <your-fork> git@github.com:you/qemu-pmb887x.git
git -C build/qemu-upstream push -u <your-fork> wasm-browser-port
```

Rebase note: the base is the dsp-stuff branch (it carries the AFE/DSP
fix the web build pins — see versions.env).  Once dsp-stuff merges to
master, rebase the branch onto master before the PR; expect only
trivial conflicts (the series touches tcg/tci, accel/tcg, util/,
target/arm/tcg/translate.c, ui/, configs/meson/emscripten.txt).

## Series contents (one commit per patch)

| # | Commit subject | Scope |
|---|---|---|
| 1 | ui: add wasm display/input backend for emscripten builds | browser display/input + link flags |
| 2 | wasm: Asyncify-safe futex/condvar + skip the per-insn icount2 helper | emscripten-only threading + icount2 |
| 3 | tci: inline TLB probe + direct helper dispatch | generic TCI (native + wasm) |
| 4 | wasm: io-recompile MMIO boundary accounting | emscripten + icount2 |
| 5 | wasm: account icount2 per TB inside the TCI interpreter (TB header op) | TCI + icount2 |
| 6 | tci: immediate-form ALU/setcond ops | generic TCI |
| 7 | wasm: replace the main-loop poll() with a futex wait | emscripten-only |
| 8 | wasm: skip the io-recompile rewind under stock icount too | emscripten-only |
| 9 | tci: run the TLB fast path inline in the interpreter loop | generic TCI |
| 10 | tci: size-specialized guest memory ops | generic TCI + cold-path counters |
| 11 | wasm: take SVC exceptions without the cpu_loop_exit longjmp | emscripten + ARM frontend |
| 12 | wasm: io barriers | emscripten + translator/cputlb |

Each commit message carries the full rationale ("why this change is
needed") plus the measured effect; the code hunks carry inline
comments at the non-obvious spots (TLB compare semantics, clock
accounting deviations, gating conditions, safety arguments for the
io-recompile skips).

Safety properties (why an upstream merge is low-risk for native
users): everything that changes semantics under native builds is
either `__EMSCRIPTEN__`-gated (patches 1, 2, 4, 5, 7, 8, 11, 12 —
inert code on native), or confined to the TCI interpreter (patches 3,
6, 9, 10 — TCI is not the default backend; native TCG codegen is
untouched).

## Relationship to `patches/*.patch`

`patches/NNNN-*.patch` are **generated from the branch commits**
(`git format-patch b31b98fe..wasm-browser-port`), so:

* `scripts/build-qemu.sh` (which `git apply`s `patches/*.patch` onto
  the pinned pristine rev) reproduces the branch tree exactly;
* the branch is the single place to edit — after changing it,
  regenerate the patch files (see below) and commit them in this repo.

Regenerate after branch edits:

```bash
cd build/qemu-upstream && git format-patch b31b98fe..HEAD -o /tmp/fp
# copy each file onto the matching patches/NNNN-<name>.patch name
# (order = commit order; the filenames keep the web repo's numbering,
#  including the 0005/0006 gaps for the attic'd patches)
```

## Verification status (2026-09-09)

Sanity gate after any git operation on the branch (an orphan rebase
once grafted an unrelated fork commit under the series — caught by
this check):

```bash
git -C build/qemu-upstream rev-list --count b31b98fe..HEAD   # must be 12
git -C build/qemu-upstream diff --name-only b31b98fe         # 25 files, no hw/arm/pmb887x/*
```

* branch tip ≡ pristine + patches/ (delta is comment lines only) — the
  inline "why" comments are the only difference vs the benchmarked
  stack, plus one real fix (below);
* wasm: rebuilt from the branch tree and re-benched — bootbench window
  28.2–29.4 s (full-stack same-day baseline 25.1–28.5 s, within
  run-to-run noise), soak to v=165 with growing LCD updates, no
  `>>EXIT<<`;
* native: configure + make (arm-softmmu, default TCG) from the branch
  tree builds cleanly, and the native suite (tests/run.mjs) passes
  4/4 devices (s75, el71, c81, ke800: boot-init, boot-progress,
  no-exit);
* per-patch: every patch was individually removal-tested (see
  [optimization-playbook.md](optimization-playbook.md) § Patch-isolation
  testing) — each one measurably improves the boot or is required by a
  later patch that does.

### Bug found and fixed while preparing the branch

Preparing the native build surfaced a latent native-link error the
wasm build could never see: `wasm_diag_stat` was defined in
`tcg/tci.c`, which only compiles under `--enable-tcg-interpreter`,
while the always-compiled `accel/tcg/cputlb.c` and
`target/arm/tcg/tlb_helper.c` reference the counters — every native
softmmu build of the series since patch 0012 failed to link.  The
definition now lives in `accel/tcg/cputlb.c` (compiled into every
softmmu build; see the comment there).

### Re-verified hunks: icount2 MIN_FREQUENCY floor (2026-09-09)

Patch 0002's `ICOUNT2_MIN_FREQUENCY 1000` (emscripten-only; stock is
1 MHz) was re-tested after the TCI speedups made the original
rationale ("TCI sustains <1 MHz on wasm") stale on fast hosts:

| Scenario | floor 1 kHz | floor 1 MHz (stock) |
|---|---|---|
| fast host, icount2 mode | controller converges 3–17 MHz — floor never binds; boot normal | identical — floor never binds |
| 16× CPU-starved (browser + 15 hogs on one core, sustained ~2.5 kHz — "phone" amplified) | frequency converges to the real rate; **v=377 after 420 s**, boots in slow motion, no crash | frequency pins at 1.000 MHz; **virtual clock frozen at v=0.88 after 420 s** — guest never sees its timers, boot dead |

Verdict: **kept** — inert on fast hosts, but it is exactly what keeps
the opt-in `?icount=precise-clocks=on` mode alive on slow devices
(phones).  The default timing model (stock `-icount shift=3,sleep=off`)
has no frequency controller and is unaffected either way.  The code
comment and the 0002 commit message now carry these numbers.
