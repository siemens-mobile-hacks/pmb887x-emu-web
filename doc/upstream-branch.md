# The qemu series branch: `wasm-browser-port` / `wasm-patches`

The whole wasm/TCI/perf series lives as commits on a branch of
[Azq2/qemu-pmb887x](https://github.com/Azq2/qemu-pmb887x) — the QEMU
fork that [pmb887x-emu](https://github.com/siemens-mobile-hacks/pmb887x-emu)
embeds as its `qemu` submodule. Since 2026-09-12 that branch **is** this
repo's qemu source tree: the `qemu/` root submodule, pinned in
`versions.env`. There is no separate clone, worktree or patch-apply step
any more.

```
submodule:  qemu/                 (Azq2/qemu-pmb887x)
branch:     wasm-browser-port     local name; tracks origin/wasm-patches
pin:        debfa3d6f5            QEMU_PMB887X_REV in versions.env
base:       8b9d485bc2            qemu-pmb887x master at the time of the switch
companion:  pmb887x-emu/          the meta-repo, branch wasm-patches, whose
                                  qemu submodule pin is the same revision
```

`origin/wasm-browser-port` (e0bcfe04b6) on the same remote is the older
14-commit series from the patch-file era; it is superseded by
`origin/wasm-patches` and kept only as history.

## Working on the tree

```bash
scripts/fetch-qemu.sh                  # init the submodule, check out the pin
# edit qemu/**, then:
bash scripts/ninja-fast.sh             # incremental wasm64 rebuild + deploy
git -C qemu commit -a                  # one mechanism per commit, measured header
git -C qemu push origin wasm-browser-port:wasm-patches
# bump QEMU_PMB887X_REV in versions.env to the new tip, commit both here
```

`scripts/fetch-qemu.sh` resets the checkout to `QEMU_PMB887X_REV`
whenever HEAD differs from it, so a commit that is not yet pinned is
lost from the working checkout (not from the repo) on the next full
build — pin before rebuilding with `build-qemu.sh`. `ninja-fast.sh`
does not touch the tree.

Rebase note: the series sits on qemu-pmb887x master plus the AFE/DSP
fix from alula's `dsp-stuff` (the commit master lacks; see versions.env).
Once that lands upstream, rebase onto master; expect only trivial
conflicts (the series touches tcg/tci, tcg/wasm64, accel/tcg, util/,
target/arm/tcg, hw/arm/pmb887x, ui/, configs/meson/).

## Series contents (43 commits on master, in order)

Patch numbers are the ones the docs use (the `patches/NNNN-*.patch`
mirror keeps the same numbering; 0005/0006/0015 are attic'd and 0033
was folded into the pinned rev as its top commit).

| # | Commit | Scope |
|---|---|---|
| 0001 | ui: add wasm display/input backend for emscripten builds | browser display/input + link flags |
| 0002 | wasm: Asyncify-safe futex/condvar + skip the per-insn icount2 helper | emscripten-only threading + icount2 |
| 0003 | tci: inline TLB probe + direct helper dispatch | generic TCI (native + wasm) |
| 0004 | wasm: io-recompile MMIO boundary accounting | emscripten + icount2 |
| 0007 | wasm: account icount2 per TB inside the TCI interpreter (TB header op) | TCI + icount2 |
| 0008 | tci: immediate-form ALU/setcond ops | generic TCI |
| 0009 | wasm: replace the main-loop poll() with a futex wait | emscripten-only |
| 0010 | wasm: skip the io-recompile rewind under stock icount too | emscripten-only |
| 0011 | tci: run the TLB fast path inline in the interpreter loop | generic TCI |
| 0012 | tci: size-specialized guest memory ops | generic TCI + cold-path counters |
| 0013 | wasm: take SVC exceptions without the cpu_loop_exit longjmp | emscripten + ARM frontend |
| 0014 | wasm: io barriers | emscripten + translator/cputlb |
| 0016 | memory: romd FlatView variants + range-scoped tlb flush | generic core |
| 0017 | tcg wasm64 backend | `tcg/wasm64/` + hooks, emscripten-only |
| 0018 | io fast dispatch victim tlb | generic core (cputlb) |
| 0019 | wasm64 speculative batching | wasm64 |
| 0020 | wasm64 successor hints | wasm64 + ARM translator notes |
| 0021 | wasm wait fixes | emscripten-only |
| 0022 | wasm64 goto ptr handoff | wasm64 |
| 0023 | idle warp on vcpu thread | icount rr (all builds) |
| 0024 | device timers virtual clock | pmb887x devices |
| 0025 | wasm halt path costs | emscripten-only |
| 0026 | wasm64 goto ptr tailcall | wasm64 |
| 0027 | arm cpsr write goto ptr | ARM frontend |
| 0028 | icount timer notify budget | icount (all builds) |
| 0029 | wasm64 no icount2 prologue | wasm64 |
| 0030 | wasm64 spec explored flag | wasm64 |
| 0031 | wasm64 asyncify onlylist | emscripten build config + flash BH |
| 0032 | icount realtime cap | icount (default on only under emscripten) |
| 0034 | wasm64 retaddr getpc adj | wasm64 |
| 0035 | wasm mainloop virtual deadlines without icount | emscripten-only |
| 0036 | wasm io barrier split before insn | emscripten translator |
| 0037 | wasm vcpu virtual timers without icount | emscripten-only |
| 0038 | wasm64 spec narrow successor addresses | wasm64 |
| 0039 | pmb887x display path per word | pmb887x devices |
| 0040 | cputlb fill time growth | generic core |
| 0041 | wasm diag lookup fill halt counters | cold counters |
| 0042 | wasm diag warp module counters | cold counters + knobs |
| 0043 | cputlb phys range summary | generic core |
| 0044 | tb lookup devirtualise | emscripten-only |
| 0045 | arm cpsr hflags skip | ARM frontend |
| — | pmb887x: hacky AFE (LLE+HLE) implementation | cherry-pick from alula/dsp-stuff |
| 0033 | pmb887x: seed the RTC counter in the layout the firmware expects | pmb887x RTC, per-board `[rtc] format` |

The commits from 0001 to 0016 and 0018 carry the full rationale plus
measured effect in their messages; the later ones carry the patch title
only — their rationale and numbers live in
[optimization-playbook.md](optimization-playbook.md) § What landed and
in [optimization-sessions.md](optimization-sessions.md).

## Safety properties (why a merge is low-risk for native users)

Everything that changes semantics under native builds is either
`__EMSCRIPTEN__`-gated (inert code on native) or confined to the TCI
interpreter (not the default backend; native TCG codegen is untouched).
The generic-core commits are semantics-preserving by construction:

- 0016: a FlatView is reused only when the MR tree is bit-identical up
  to romd flags; the TLB flush is only ever strictly smaller than
  stock's; any recycle/eviction path falls back to the stock full flush.
- 0018: the iotlb-entry dispatch resolution produces exactly what the
  generic path resolves per access (special cases fall back to stock).
- 0023/0028: icount-rr scheduling only; the virtual clock advances to
  the same deadlines.
- 0040/0043: TLB sizing and flush-victim selection; conservative masks,
  entries dropped identical to the full walk (measured 22,007 = 22,007).
- 0045: skips `arm_rebuild_hflags` only when `uncached_cpsr` is
  unchanged; verified 2.1 M skips, 0 mismatches against a
  recompute-and-compare build.
- 0027: the ARM frontend ends CPSR-write TBs with goto_ptr; the interrupt
  check is requested exactly when one is pending.
- 0033: RTC `CNT` layout selected by the board config, default = the
  Siemens (linear) layout; LG boards opt into the packed one.

Native suite (`tests/run.mjs`) 4/4 and the op-suite byte-identical
across native JIT / native TCI / wasm are the gates; both are green on
the pinned rev (see [performance-handoff.md](performance-handoff.md)).

### Bug found while preparing the series (2026-09-09)

Preparing the native build surfaced a latent native-link error the
wasm build could never see: `wasm_diag_stat` was defined in
`tcg/tci.c`, which only compiles under `--enable-tcg-interpreter`,
while the always-compiled `accel/tcg/cputlb.c` and
`target/arm/tcg/tlb_helper.c` reference the counters — every native
softmmu build of the series since patch 0012 failed to link. The
definition lives in `accel/tcg/cputlb.c`.

### icount2 MIN_FREQUENCY floor (re-verified 2026-09-09)

Patch 0002's `ICOUNT2_MIN_FREQUENCY 1000` (emscripten-only; stock is
1 MHz) was re-tested after the TCI speedups made the original
rationale ("TCI sustains <1 MHz on wasm") stale on fast hosts:

| Scenario | floor 1 kHz | floor 1 MHz (stock) |
|---|---|---|
| fast host, icount2 mode | controller converges 3–17 MHz — floor never binds; boot normal | identical — floor never binds |
| 16× CPU-starved (browser + 15 hogs on one core, sustained ~2.5 kHz) | frequency converges to the real rate; boots in slow motion, no crash | frequency pins at 1.000 MHz; virtual clock frozen — boot dead |

Verdict: kept — inert on fast hosts, but it is what keeps the opt-in
`?icount=precise-clocks=on` mode alive on slow devices. The default
timing model (stock `-icount shift=3,sleep=off`) has no frequency
controller and is unaffected either way.

## The RTC fix upstream branch: `rtc-cnt-format`

0033 is independent of the wasm series and fixes native too, so it also
exists as a standalone branch for a separate upstream PR:
`origin/rtc-cnt-format` (22e23cfb5b, one commit that applies to Azq2
master), with a companion pmb887x-dev change (`lg-ke800`/`lg-ke970`
`[rtc] format = "calendar"`) that is already in the pinned bsp rev
`e6e73d1`. The qemu commit defaults `[rtc] format` to `unix` (Siemens),
so the pmb887x-dev change is what keeps the LG boards on the packed
calendar — submit both, qemu first. Once it lands, drop the top commit
of the series on the next rebase.
