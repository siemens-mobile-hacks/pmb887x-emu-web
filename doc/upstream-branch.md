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
branch:     wasm-browser-port     local name; tracks origin/wasm-browser-port
                                  (was origin/wasm-patches; the two tips
                                  moved together in 2026-09-18's push)
pin:        9146059e35            QEMU_PMB887X_REV in versions.env
                                  (2026-09-20: the review pass + audio +
                                  the merged sgold-regression-fix and
                                  usart-rx-pacing topic branches;
                                  149 commits ahead of master)
base:       8b9d485bc2            qemu-pmb887x master at the time of the switch
companion:  pmb887x-emu/          the meta-repo @ master (eb53c78). Its qemu
                                  submodule is not used — the root qemu/
                                  submodule is the build source — but the repo
                                  is where the page's Siemens module comes
                                  from: the siemensfw library (src/siemens)
                                  that scripts/build-recalc-wasm.sh compiles
                                  (key recalc, ESN recovery, and the Siemens
                                  half of device detection, probeFullflash)
```

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

## Series contents (101 commits on master, in order)

Patch numbers are the ones the docs use (the numbering has gaps where
patches were dropped; 0033 sits at the top of the series).

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
| 0046 | inline next-TB lookup cache on wasm64 goto_ptr exits (+ 0044 switched on) | ARM translator + accel/tcg, `CONFIG_TCG_WASM64`-only |
| 0047 | pmb887x: DIF v2 lazy mux tables, DMAC in-callback re-arm, one-bit DMA acks | pmb887x devices, all backends |
| 0048 | pmb887x: DMAC translation windows, VIC parent-line cache, memory topology generation | pmb887x devices + one exported counter in system/memory.c |
| 0049 | pmb887x: GPTU T0/T1 timer armed for observable overflows only | pmb887x GPTU model, all backends |
| 0050 | pmb887x: no 16 KB zero-fill per DMA word (`QEMU_UNINITIALIZED`), no checked QOM casts per LCD byte | pmb887x DMAC + LCD models, `hw/ssi/ssi.c` (`ssi_transfer`), all backends |
| 0051 | pmb887x: DIF pin rebuild skipped on unchanged inputs, FIFO index without modulo, no checked bus cast per SSI transfer | pmb887x DIF v2 + `fifo.h`, `hw/ssi/ssi.c`, all backends |
| 0052 | tcg/wasm64: labels as nested blocks instead of the dispatch loop | `tcg/wasm64/tcg-target.c.inc`, wasm64 backend only |
| 0053 | tcg/wasm64: open the batch at TB start (Firefox module budget; regression since the prologue cleanup) | `tcg/wasm64/`, wasm64 backend only |
| 0054 | memory/pmb887x: MMIO write dispatch decision cached per DMAC window | `system/memory.c` + `include/system/memory.h` (two new entry points), `hw/arm/pmb887x/dmac.c` |
| 0055 | tcg/wasm64: `local.tee` for set+get pairs, no scratch local in the TLB probe | `tcg/wasm64/`, wasm64 backend only |
| 0056 | accel/tcg: stop the wasm io-barrier set from thrashing | `accel/tcg`, `include/qemu`; wasm-gated |
| 0057 | accel/tcg, memory: resolve subpage MMIO dispatch at TLB fill time | `accel/tcg`, `include/hw`, `include/system`, `system/physmem.c` |
| — | pmb887x: fix dsp crash on Siemens SGOLD phones | merge from qemu-pmb887x master |
| 0058 | accel/tcg, system: stop paying the icount seqlock twice per MMIO access | `accel/tcg`, `system/cpus.c` |
| 0059 | accel/tcg: fuse the single-piece MMIO load path | `accel/tcg`, `include/qemu` |
| 0060 | cpu-timers: give `timers_state.qemu_icount` its own cache line | `include/system` |
| 0061 | accel/tcg: fuse the single-piece MMIO store path too | `accel/tcg`, `include/qemu` |
| 0062 | hw/pmb887x: stop the TPU re-arming its QEMU timer on every register write | pmb887x TPU model |
| 0063 | system/cpus, accel/tcg: a lean BQL pair for the MMIO dispatch path | `accel/tcg`, `system/cpus.c` |
| 0064 | util/qemu-timer: read the icount clock without the `cpus_accel` frame | `util/qemu-timer.c`, `stubs/icount.c` |
| 0065 | accel/tcg: one clock notify per idle round, not two | `accel/tcg`, `include/exec`, `stubs/icount.c` |
| 0066 | hw/pmb887x: do not advance the TPU twice per register write | pmb887x TPU model |
| 0067 | util/qemu-timer: no virtual-clock notify for an empty timerlist | `util/qemu-timer.c`, `util/main-loop.c` |
| 0068 | hw/pmb887x: no TPU advance for an event-RAM write that cannot move the deadline | pmb887x TPU model |
| 0069 | target/arm: do not rebuild hflags twice per CPSR write | `target/arm`, all backends |
| 0070 | accel/tcg/icount: read the virtual clock without the wasm fence pair | `accel/tcg`, wasm-gated |
| 0071 | target/arm: a short hflags rebuild for a pre-v6 A-profile CPU | `target/arm`, `include/qemu` |
| 0072 | wasm: four fixed costs the profile named, on the per-access and per-TB paths | `accel/tcg`, pmb887x, `include/hw` |
| 0073 | system/cpus: do not give the BQL back after every device access | `accel/tcg`, `system/cpus.c` |
| 0074 | wasm: trim the Asyncify onlylist to the frames a switch can reach | `configs/meson/asyncify-only.txt`, wasm64 build only |
| 0075 | accel/tcg: fold the MMIO fast path into its callers, one bswap | `accel/tcg` |
| 0076 | wasm-diag: gate the counters that ended up on hot paths | `accel/tcg`, `include/qemu`, `target/arm` |
| — | switch to `rt=off` mode 30 s after boot | real-time cap default |
| — | SGOLD dsp mask-ROM version fix; alula/dsp-stuff resolved to ours | merges from upstream |
| 0078 | pmb887x: give DIF v1 the two things v2 already does | pmb887x DIF v1 model |
| 0079 | pmb887x: run DIF v1 transfers where they are asked for, not from a timer | pmb887x DIF v1 model |
| 0080 | wasm-diag: counters that price speculation, the jump cache and hflags | `accel/tcg`, `include/qemu`, `target/arm` |
| 0081 | ui/wasm: a key event before the display exists must not trap the module | `ui/wasm.c` |
| 0082 | wasm-diag: phase timers, and delete a heuristic that never ran | `accel/tcg`, `include/qemu`, `tcg/wasm64` |
| 0083 | memory: a readonly flip is a view variant, not a topology change | `system/memory.c`, `accel/tcg`, pmb887x |
| 0084 | accel/tcg: size the jump cache for the wasm64 lookup path | `accel/tcg`, `include/qemu`, `target/arm` |
| 0085 | target/arm: rebuild hflags only when a CPSR write moves an hflags input | `target/arm`, all backends |
| 0086 | wasm-diag: split the topology commit, and decompose a module compile | `system/memory.c`, `tcg/wasm64`, `include/qemu` |
| 0087 | tcg/wasm64: the module-GC nudge is a Firefox workaround, so only do it there | `tcg/wasm64/`, wasm64 backend only |
| 0088 | tcg/wasm64: stop rebuilding heap views and copying the module twice | `tcg/wasm64/`, `include/qemu` |
| — | pmb887x: hacky AFE (LLE+HLE) implementation | cherry-pick from alula/dsp-stuff |
| 0033 | pmb887x: seed the RTC counter in the layout the firmware expects | pmb887x RTC, per-board `[rtc] format` |

The commits from 0001 to 0016 and 0018 carry the full rationale plus
measured effect in their messages; the later ones carry the patch title
only — their rationale and numbers live in
[optimization-playbook.md](optimization-playbook.md) § What landed.

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
`[rtc] format = "calendar"`) — that was PR#6 of
siemens-mobile-hacks/pmb887x-dev (`e6e73d1`, branch `rtc-calendar-format`);
**it landed in bsp master as `e8d490e` (2026-09-20), which retired
`PMB887X_BSP_FIX_REV` and the merge scripts/sync-bsp.sh used to recreate**.
The qemu commit defaults `[rtc] format` to `unix` (Siemens),
so the pmb887x-dev change is what keeps the LG boards on the packed
calendar. The qemu half (0033 / `origin/rtc-cnt-format`) is still to go
upstream separately.
