# WASM threading audit — what the browser's threads actually do

Status: **investigation complete, no defect found.** The emulator really does
run multi-threaded in the browser, the pthread stack is healthy, idle threads
park in real futex waits (no spin), and the syscall-stub "spin" initially
suspected during this audit turned out to be two measurement artifacts.
This document records the evidence, the false lead (and exactly why it was
wrong — those traps will bite the next profiler too), the corrected reading,
and the tooling + hand-decoding recipes used, so none of it has to be
re-derived.

Trigger: the question *"is the browser actually using WASM multi-threading,
and would more of it help performance?"* — after the earlier analysis
([performance-handoff.md](performance-handoff.md)) had concluded from build
flags that pthreads are compiled in.

Audited build: `dist/` (TCI, patches 0001–0009), `qemu-system-arm.wasm`
44,787,255 bytes, no symbol map, 100 imported functions, served via
`serve.mjs` on :8080, headless Chromium (playwright-core 1.63 bundled
headless shell) on a 32-core container, s75 fullflash, profiled ~30–60 s
into boot.

## 1. Yes — it is genuinely multi-threaded, verified at three independent layers

1. **CDP target census** (`tools/threadmap.mjs`): the page reports
   `crossOriginIsolated: true` (SharedArrayBuffer available — the COOP/COEP
   headers in `serve.mjs` are doing their job), and the browser exposes
   **5 dedicated worker targets** loading `qemu-system-arm.js`, plus the
   page itself. Worker indices are not stable across boots; only
   fingerprints are (see §3).
2. **Synchronized CPU profiles** (CDP `Profiler.start`/`stop` on every
   worker in the same 12 s window): all five workers produced full-rate
   sample streams concurrently (~45k samples each at 200 µs) — none were
   dead or stalled.
3. **OS-level CPU** (`/proc/<renderer-pid>/task/*/stat` deltas over a 10 s
   window): the renderer process (page + all workers) used **≈2.74 cores**
   during boot, split across three busy `DedicatedWorker` OS threads
   (~14–17 CPU-seconds each over the ~45 s since start, ≈35 % average),
   one nearly-idle worker, the page thread, and Chromium/V8 pool threads.
   This is the number that later falsified the spin theory: three threads
   spinning at 100 % would show ≥4 cores.

## 2. The false lead, preserved on purpose

The first profiling pass looked alarming: 3–4 of the 5 workers showed
**60–100 % of samples self-timed in a single leaf**, `wasm-function[25875]`,
and hand-decoding that function in the disassembly produced
*"warning: unsupported syscall: `__syscall_pipe2`" → return -52 (-ENOSYS)*.
Conclusion-at-the-time: *"threads are tight-looping an unimplemented syscall
stub, millions of calls/s"* — a spectacular, actionable perf bug.

It was wrong, for two independent reasons. Both are generic traps:

### Trap A — profiler sample counts are not CPU time for parked threads

The hot leaf was actually `emscripten_futex_wait` (see §3), whose body
contains exactly one `memory.atomic.wait32` — i.e. the thread is **parked
in wasm**.
V8's sampling profiler nevertheless emits samples at full wall-clock rate
for a thread parked in a wasm atomic-wait, with the wait function as the
leaf. So "100 % of samples in X" can mean "thread is asleep inside X".
Duty-cycle math from `timeDeltas` cannot detect this either (deltas stay
uniform). **Only OS-level CPU (`/proc/.../stat`, `ps`) distinguishes
spin from park.** Symptom that gave it away: zero console output — the
pipe2 stub calls `emscripten_err` → `err()` → `console.error` on *every*
invocation (it is not a no-op in this release build), so a hot pipe2 stub
would have flooded the console; a 20 s boot produced exactly **4** console
warnings, all one-time init calls (`prlimit64`, `mprotect`, `pipe`,
`madvise`).

### Trap B — V8 function indices include imports (off-by-100 here)

`wasm-function[N]` in V8 profiles indexes the module's **function index
space, which counts imported functions first**. `wasm-dis` (binaryen) names
defined functions `$0, $1, …` *excluding* imports. This module has **100
imported functions** (plus 1 memory import), so `wasm-function[25875]` is
binaryen's `$25775`, not `$25875`. Decoding `$25875` produced a syscall
stub; the real `$25775` is `emscripten_futex_wait`.

The offset was proven by a caller-set cross-check: the statically observed
callers of `$25775` — `$23515, $23516, $23553, $26058, …` — match exactly
the sampled parent frames once corrected (V8 `23615/23616/23653/26158`),
across multiple workers with different stacks. Sampled stacks were
accurate all along; the decoding was not.

(Adjacent-index bonus: `$25774` = `emscripten_fiber_init_from_current_context`,
one below the hot leaf — index-adjacency is *not* evidence of identity.)

## 3. Corrected reading — the thread census

With the −100 correction, per-worker leaf attribution over the same 12 s
window (numbers from `tools/threadmap.mjs`'s saved `/tmp/prof-*.json`):

| worker | futex-parked (leaf `$25775`) | longjmp | dominant real leaf | interpretation |
|---|---|---|---|---|
| 0 | 100 % | 0 % | — | waiting thread (main loop / DSP / RCU / pool spare — see below) |
| 1 | 97 % | 0 % | — | waiting thread |
| 2 | **6 %** | **20 %** | `wasm-function[2704]` 38 % (presumed `tcg_qemu_tb_exec`) + MMIO dispatch | **the vCPU — the only thread executing guest code** |
| 3 | 82 % | 0 % | `?` 5.7 % bursts | waiting thread with periodic work |
| 4 | 98 % | 0 % | — | waiting thread |

Supporting identifications:

- `$25775` = **`emscripten_futex_wait`**: signature `(i64 addr, i32 expected,
  f64 maxWaitMs) → i32` is an exact match, body converts ms→ns
  (`×1e3`, `inf → -1`), single `memory.atomic.wait32`, then a call to
  `$26302(3, 1)` (unidentified post-wait helper). This is the wait that
  patch 0009 put the main loop on, and the one patch 0002's condvar fix
  relies on — **both visibly working**.
- The Asyncify JS frames (`doRewind` ← `finishContextSwitch` ← `trampoline`,
  from `libasync.js`'s Fibers) belong to QEMU's `--with-coroutine=wasm`
  backend (`util/coroutine-wasm.c`, emscripten Fibers). They show up on the
  coroutine-carrying thread(s) as expected.
- Worker *roles* shuffle between boots (the vCPU was worker 2 in one run,
  worker 1 in another); only the fingerprints above are stable.

Net answer to the original question, now with evidence: **one thread carries
essentially all guest execution; the other four spend 82–100 % of their
sampled time parked in futex waits and wake for their scheduled work**
(main-loop deadlines, DSP pacing/handshake, RCU, …). The pthread stack
costs nothing while idle. No additional threading opportunity exists in
this workload (single vCPU + deterministic icount — see
[performance-handoff.md](performance-handoff.md)); and, importantly, no
thread-related defect is stealing CPU today.

## 4. The unsupported-syscall stubs: real, benign, cold

Confirmed present in the wasm: ENOSYS stubs for `pipe2`, `socketpair`,
`shutdown`, `wait4` (each logs one `warning: unsupported syscall: …` line
via `emscripten_err` on first use and returns -52). Meanwhile `pipe()`
*does* work — the JS glue implements `___syscall_pipe` through
`PIPEFS.createPipe`, with `proxyToMainThread` for calls from workers.

Observed call volume during boot: the four one-time init warnings above;
nothing hot. `pipe2` never appeared in any sampled stack after the index
correction. The historical "aio eventfd wake never worked" symptom was
already root-caused and worked around by patch 0009's futex-based main-loop
wait; nothing suggests an active retry loop anywhere.

If a future change ever *does* need `pipe2` (e.g. an O_CLOEXEC-aware path
that doesn't fall back to `pipe`), the fix shape is: add a
`__syscall_pipe2` implementation to the link (mirror `___syscall_pipe`,
apply `O_NONBLOCK` via the existing fcntl path; `FD_CLOEXEC` is a no-op
without exec) — as a commit on the qemu branch touching the emscripten
link args, not a fork of emsdk. Not needed today.

## 5. Tooling added (kept, reusable)

- `tools/threadmap.mjs [secs] [query]` — boots the page with the test
  fullflash, enumerates CDP targets, attaches to every worker, takes
  synchronized CPU profiles, dumps them to `/tmp/prof-N.json` and prints
  guest-insn progress during the window. Analysis snippets for the dumps
  are in §6.
- `tools/syscallprobe.mjs [secs]` — same boot + attach, but counts
  `Runtime.consoleAPICalled` per worker session (how the "console is
  silent" fact was established) and prints per-worker top leaves.
- Operational quirks discovered (cost hours, written down so they don't
  again): `process.exit(0)` truncates piped stdout — flush + delay first
  (both tools do now); playwright's `browser.close()` can hang on busy
  workers — the tools `process.exit` instead; a stray background instance
  writing to the same log file produces mixed output — kill strays, use
  fresh log names; `serve.mjs` must be running (the tools assume :8080,
  `PORT` env to change); debug-port collisions need `pkill
  chrome-headless` between runs.

## 6. Recipe: hand-symbolizing `wasm-function[N]` without symbols

Used throughout §2–§4; kept here because it generalizes to any future
no-symbol investigation (the proper fix is rebuilding with
`--emit-symbol-map`, which `tools/wprof2.mjs` already knows how to read
from `dist/qemu-system-arm.js.symbols`).

1. `wasm-dis` the binary (emsdk ships binaryen:
   `build/deps/emsdk/upstream/bin/wasm-dis dist/qemu-system-arm.wasm -o q.wat`;
   ~2 min, ~475 MB wat for a 44 MB module).
2. **Apply the import offset**: real function = `wasm-function[N]` minus the
   number of *function* imports (`grep -c '(import ".*" ".*" (func'` → 100
   here; memory/table/global imports don't count).
3. Data segments are **passive** (addresses aren't in the segment headers):
   find the `(memory.init $k (i64.const BASE) …)` lines in the wat for each
   segment's runtime base (here seg1 → 66400, seg2 → 17378176, …).
4. String constants: `emscripten_err(ptr)` stubs reveal their syscall name;
   `__assert_fail(file, line, expr)` calls reveal C source location
   (e.g. `$23514` asserts on `../qemu/util/error-report.c:174`). Decode by
   parsing the wasm's data section (id 11) and slicing at `addr − BASE`.
5. Function identity via signature + body shape works surprisingly well:
   `emscripten_futex_wait` was pinned by its `(i64,i32,f64)→i32` signature
   + ms→ns conversion + single `memory.atomic.wait32`; accessor stubs that
   just `return global.get` are the memory64 stack/TLS getters.
6. **Cross-check statically**: `callers of $f` (grep `(call $f` in the wat)
   must include the sampled parent frames (after offset correction). A
   caller-set mismatch means your offset (or the samples) are wrong — this
   check is what exposed Trap B.

## 7. Open items (all minor)

- `$2604` (V8 `2704`, presumed `tcg_qemu_tb_exec` from the
  `js-to-wasm:lll:i` entry chain + 20 % `__emscripten_throw_longjmp` on the
  same thread) — confirm with a `--emit-symbol-map` rebuild if it ever
  matters.
- `$26302(3, 1)` — the helper `emscripten_futex_wait` calls after every
  wake; identify if wake-latency work ever happens.
- The four init-time `unsupported syscall` console lines are cosmetic
  noise; silence only if they ever confuse someone.
- If profiling parked threads becomes routine, teach `tools/wprof2.mjs` to
  label `emscripten_futex_wait`-leaved stacks as *parked* rather than hot,
  and to subtract `memory.atomic.wait` residence from CPU attribution
  (V8's own accounting does not).
