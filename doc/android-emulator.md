# Android arm64 emulator

An attempt to profile the page in Android Chrome on ARM without a phone,
inside the rootless Ubuntu 26.04 development container (x86_64 Ryzen 9
5950X, no `/dev/kvm`, no privileged operations).

**Outcome (2026-11-10): it works, and it is too slow for profiling. A real
Pixel over adb is used instead.** The page ran about 80x slower than in
desktop Chromium on the same host. This file records what was built, what
was measured and what stopped where, so the attempt need not be repeated.

Everything is in `scripts/setup-android-emu.sh` and `build/android-emu/`
(7.1 GB, of which 1.3 GB are the pinned downloads).

## Choice

With no KVM, an arm64 guest on an x86_64 host is software emulation (TCG)
whatever the front end. Google's Android Emulator was chosen because it
ships a matching kernel, system image and adb plumbing and needs no root.
Only one old combination starts an arm64 guest on an x86_64 host:

| Part | Version |
|---|---|
| Emulator | Android Emulator 30.2.2 (build 6885378, 2020-10; a QEMU 2.12 fork) |
| System image | Android 10, API 29, `default`, arm64-v8a rev 8 (userdebug) |
| Browser | Chromium 157.0.8103.0, V8 15.7.112 (`ChromePublic.apk`, snapshot `Android_Arm64/1717351`; M157 was Android stable) |
| adb | platform-tools 37.0.1 |

Downloads are pinned by URL and SHA-256. The Google packages are fetched
directly, without `sdkmanager`, so nothing asks for the Android SDK licence;
using them is still subject to it.

What else was tried, with the message each attempt ended in:

| Attempt | Result |
|---|---|
| Emulator 37.2.13 (current), any arm64 image | `FATAL \| Avd's CPU Architecture 'arm64' is not supported by the QEMU2 emulator on x86_64 host.` |
| 37.2.13, 32.1.15, 31.1.4, 30.9.5, their qemu binary started directly | `PCI bus not available for hda` |
| 30.6.5, 30.3.5 | the same with API 30; `No 'PCI' bus found for device 'virtio_input_multi_touch_pci_1'` with API 29 |
| 30.2.2 with the API 30 image | `Can't get kernel version from the kernel image file` |
| Images below API 29 | Chromium 157 declares `minSdkVersion` 29 |
| Chromium 160.0.8155.0 (trunk, r1741244) | runs the page; a busy worker never answers `Profiler.enable`, so `tools/wprof2.mjs` hangs. Desktop Linux 160 does the same, 157 and 153 do not |

## What works

```bash
export ANDROID_EMU_CPUS=12-15,28-31          # taskset list; unset = not pinned
scripts/setup-android-emu.sh install
scripts/setup-android-emu.sh start
scripts/setup-android-emu.sh browser 'http://127.0.0.1:8080/?dist=dist-jit&suite=dist/tcgbench-quick.bin'
curl http://127.0.0.1:9222/json/version
PROF_ATTACH=9222 PROF_DIST=dist-jit node tools/wprof2.mjs 45 "" 10000
scripts/setup-android-emu.sh stop
```

- **The guest** is arm64-v8a Android 10 with 4 cores (a Cortex-A57: no LSE,
  PAC or BTI) and 4 GB.
- **DevTools is reachable from the container.** `/json/version` reports
  `"Android-Package": "org.chromium.chrome"`, `Chrome/157.0.8103.0`,
  `"V8-Version": "15.7.112"`, an Android 10 user agent.
- **The page loads cross-origin isolated** (`adb reverse` makes the host's
  server the guest's `127.0.0.1:8080`; `crossOriginIsolated` true,
  SharedArrayBuffer present, `navigator.platform` `Linux armv81`).
- **It computes correctly:** the six `tcgbench-quick` checksums printed
  (`alu` … `mix`) equal the desktop's.
- **`tools/wprof2.mjs` attaches** with `PROF_ATTACH=9222` and an interval of
  10000 us or more (~28 samples/s per thread). Two defects: the page's main
  thread usually misses wprof2's 5 s timeout, and the vCPU thread loses its
  call stacks (leaf frames hang under `js-to-wasm`). Cause not found.
- **Android's wasm memory handling was confirmed** on this build: explicit
  `cmp`/`b.cs` bounds checks before loads in Liftoff code for 32-bit and
  64-bit memories (read from the renderer's JIT pages), and 200 small
  `WebAssembly.Memory` objects succeed where desktop Chromium fails at the
  122nd for lack of guard-region address space.

Not reached: booting a phone fullflash on it (only `?suite=` runs, which
need no file input); V8 `--prof` and `simpleperf`.

## Measured

Emulator pinned to four physical cores (8 threads).

| What | Result |
|---|---|
| `install` with downloads cached | 29 s |
| First boot of a new AVD to `sys.boot_completed` | 266 s |
| Later boots | 191–192 s (adbd answers after 91–99 s) |
| APK install (387 MB over adb) | 5.5–9 min, once per AVD |
| Chromium cold start until DevTools answers | 1.5–3.3 min |
| Page: navigation to first guest instruction | 4–5 min (2 min for the 12 MB wasm through the adb tunnel) |
| `tcgbench-quick` in the page | 0.5–0.9 M guest insns/s; 1.2 of 1.34 G insns in 26 min |
| Same suite, desktop Chromium 157, same cores | 50–65 M guest insns/s; 25 s in all |
| 8 guest cores (`ANDROID_EMU_CORES=8`) | booted in 361 s on a loaded host; page speed not reached |
| 1 guest core | Android unusable (ANRs, SystemUI and browser killed); measured before the TCG fix below |

Why it is this slow, from a small C benchmark (ms):

| | arithmetic | sequential memory | random memory | indirect calls |
|---|---|---|---|---|
| native x86_64 | 79 | 16 | 95 | 94 |
| arm64 under qemu-user 10.2 | 190 | 95 | 224 | 1293 |
| arm64 in the Android guest | 202 | 165 | 3331 | 2298 |

The emulator's QEMU 2.12 has a 256-entry software TLB and looks up every
indirect branch in a helper. Random memory access costs 35x and calls 24x.
The page's vCPU is one thread, so more cores do not help. None of this can
be tuned in a binary-only emulator.

## What the script works around

Each stopped the boot or the browser until handled.

1. **No input device.** The emulator's virtio input is PCI and the arm64
   board has none (`-feature -VirtioInput`). Without any input device the
   kernel creates no `/dev/input` and system_server aborts in a loop
   (`Could not register INotify for /dev/input`). `start` creates the
   directory as root as soon as adbd answers.
2. **One core.** `psci: no cpu_on method, not booting CPU1`. `start` dumps
   the device tree, adds a `/psci` node (`method = "smc"`), and passes
   `-smp`, `-accel tcg,thread=multi`, `-dtb`,
   `-global arm-cpu.psci-conduit=1`.
3. **A miscompiling TCG.** Guest processes died of SIGSEGV at random
   (`storaged`, `mediaswcodec`, Chromium's network thread), always after
   `dup vN.2d, xM`. The bug is in TCG's host-vector path, taken only when
   it detects AVX. `install` changes one byte of
   `qemu-system-aarch64-headless` (file offset 0x37b56, `jne` → `jmp`) so
   it detects none, and checks the bytes first. No tombstone in 67 min of
   uptime afterwards. The patched file stays in `build/`.
4. **OpenGL ES 2 only.** `GLES3 is unsupported and ES version fallback is
   disabled`, then `GPU process isn't usable. Goodbye.` Fixed by
   `-feature GLESDynamicVersion`.
5. **Chromium's startup timeouts.** `Timed out waiting for GPU channel.`
   The script passes `--disable-timeouts-for-profiling
   --disable-gpu-watchdog --disable-hang-monitor`.

## The faster substitute: Linux arm64 Chromium under qemu-user

Not Android, but the same V8 arm64 code generator: the Chrome for Testing
headless shell 157.0.8103.50 (V8 15.7.112.23, linux-arm64) under
`qemu-aarch64` 10.2.1, with the wasm trap handler switched off as on
Android. Still 10–30x slower than desktop.

```bash
scripts/setup-android-emu.sh linux-install
scripts/setup-android-emu.sh linux-browser 'http://127.0.0.1:8080/?dist=dist-jit&suite=dist/tcgbench-quick.bin'
PROF_ATTACH=9333 PROF_DIST=dist-jit node tools/wprof2.mjs 20 "" 1000
scripts/setup-android-emu.sh linux-stop
```

| What | Result |
|---|---|
| `linux-install` with the zip cached | 12 s |
| Browser start until DevTools answers | 3 s |
| Page: navigation to first guest instruction | 10–20 s |
| `tcgbench-quick`, trap handler off (the default here) | 2.0, 2.1 and 5.0 M guest insns/s in three runs |
| the same with `LINUX_TRAP_HANDLER=1` | 3.0–3.3 M/s in four runs, 5.6 M/s in one |
| Integer wasm loop / wasm memory loop | 22 ms / 10 ms, against 10–11 / 5 natively |

- **The spread between runs was not explained.** Rates are from the first
  minute of the suite; no run was taken to its end.
- **`tools/wprof2.mjs` works properly here:** all five sessions answer, a
  1000 us interval is fine, and the vCPU thread keeps its stacks
  (`cpu_tb_exec ← tcg_cpu_exec ← mttcg_cpu_thread_fn`). Checked with the
  trap handler on.
- **`--disable-features=WebAssemblyTrapHandler` is what makes it
  Android-like:** 400 small memories then succeed (124 without).
  `--js-flags=--no-wasm-trap-handler` does not do it.
- **Wasm needs a shim.** V8 moves its builtins with
  `mremap(MREMAP_DONTUNMAP)`; qemu-user then treats the old range as
  unmapped and the first wasm call dies with `SEGV_MAPERR` inside chrome's
  text. `linux-install` builds an `LD_PRELOAD` library that refuses that
  call, and V8 copies instead.
- **Emulation distorts costs.** Floating point is emulated in software: a
  JS loop that Maglev compiled with a float add ran 25x slower than
  natively while integer wasm ran 2x slower. Indirect calls cost about 14x.
  Shares in a profile are indications, not measurements.
- **It is desktop Chromium in other respects:** Linux scheduler and
  allocator, headless, no Android GPU stack; `navigator.platform` reads
  `Linux x86_64` (Chromium freezes it on Linux).

## What neither can tell

Absolute speed, real-time factors, whether sound keeps up, tier-up timing,
and anything about the phone's cores (big.LITTLE, caches, branch
prediction, LSE atomics). For those, measure on the device.
