# Cross-tab serial: exposing the emulator's serial port to another browser tab

**Question investigated:** can the emulator's serial port (the phone's USART,
currently `-serial file:/serial.log`) be exposed *as a Web Serial device* so
that another browser tab can consume it — ideally with the
[Web Serial API](https://wicg.github.io/serial/) (`navigator.serial`)?

## TL;DR

| Question | Answer |
|---|---|
| Can a web page **publish** a virtual serial port that another tab opens via `navigator.serial`? | **No.** Web Serial is a *consumer-only* API: it can open host serial devices, but has no server/expose side. Same for WebUSB and Web Bluetooth — no device-publishing API exists on the web platform today. |
| Can another tab *use the serial stream* of the emulator? | **Yes — two ways.** (A) Pure-web: a same-origin tab link via `BroadcastChannel`, wrapped in a Web-Serial-shaped shim so client code reads/writes streams exactly like `navigator.serial`. (B) True Web Serial: a native helper creates an OS-level *null-modem* pair (`tty0tty` on Linux, `com0com` on Windows) and bridges one end to the emulator over WebSocket; the consumer tab then opens the other end with the real `navigator.serial` API. |
| Does the wasm emulator support this today? | **Half.** Output exists (`/serial.log` tail). Input (guest RX) is not wired at all — `chardev:file` is write-only. A small `chardev/wasm.c` backend (same SPSC-ring + bottom-half pattern as `ui/wasm.c` in patch 0001) is needed for a clean bidirectional link. |

## Evidence: why "publish a Web Serial device" is impossible in pure browser JS

* The Web Serial spec/chrome docs only define *connecting to* serial devices
  (`requestPort()` → user picks an enumerated host device → `open()`/`readable`/`writable`).
  There is no `SerialServer`, no way to inject a port into the browser's
  enumeration, and no way to transfer a `SerialPort` object between documents
  (Web Locks semantics: while one document holds a port open, another
  document's `open()` on it rejects).
* A page cannot register a fake device with the OS (no raw TCP/USB from JS),
  so it can't even smuggle one in behind the browser's back.
* WebUSB/Web Bluetooth share the same one-sided design — none of them help.

## Evidence: which *OS-level* virtual ports Chrome actually lists

Chrome on Linux enumerates serial ports from udev but **only accepts TTYs
whose driver registers as type `serial` in `/proc/tty/drivers`**
(`services/device/serial/serial_device_enumerator_linux.cc`, `OnDeviceAdded`
→ `ReadSerialDriverInfo()`, with the comment *"We only care about drivers
that provide the `serial` type. The rest are things like pseudoterminals."*).

On this dev container:

```
$ cat /proc/tty/drivers
usbserial            /dev/ttyUSB   188 0-511 serial     ← listed
serial_8250          /dev/ttyS       4 64-95 serial      ← listed
pty_slave            /dev/pts      136 0-1048575 pty:slave  ← NOT listed
```

Consequences:

* `socat pty,raw,echo=0 pty,raw,echo=0` (the quick Linux null-modem) is
  **invisible** to Web Serial — ptys are excluded by type.
* [`tty0tty`](https://github.com/freemed/tty0tty) (kernel module, `/dev/tntN`
  pairs) sets `TTY_DRIVER_TYPE_SERIAL` (`module/tty0tty.c:723`), so its ports
  **do** appear in Chrome's port chooser on Linux. Requires building/loading
  a DKMS module (fine in this container, heavier for end users).
* Windows: `com0com` virtual COM pairs are confirmed to appear and work with
  Chrome Web Serial (see [SO: virtual serial ports via Web Serial API](https://stackoverflow.com/questions/65607259/), answer by urish).
* macOS: same consumer-only limitation; virtual drivers (e.g. `socat` PTYs)
  don't show up — a `com0com`-equivalent driver would be needed there too.

So "a *real* Web Serial device" is reachable, but **only through a native
helper that installs an OS virtual serial driver** — never from the page alone.

## Option A (recommended default): same-origin tab link + Web-Serial-shaped shim

No native helper, no driver, works in every browser (not just Chrome), and the
consumer tab can be any page we host next to the emulator.

```
┌──────────── emulator tab ────────────┐        ┌──────── consumer tab ────────┐
│ qemu.wasm  chardev "wasm"            │        │ client code                  │
│   guest TX ──► wasm_serial_tx() ────┼──BC────► shim.readable (ReadableStream)│
│   guest RX ◄─ wasm_serial_rx() <────┼──BC───── shim.writable (WritableStream)│
│ (SPSC rings + bottom halves, like   │        │ navigator.serial look-alike  │
│  ui/wasm.c keys)                    │        │ (getPorts/requestPort/open)  │
└──────────────────────────────────────┘        └──────────────────────────────┘
              BroadcastChannel("pmb887x-serial") — same origin, COOP/COEP-safe
```

* **Transport:** `BroadcastChannel` (simple, event-driven) or a
  `SharedWorker` (better if multiple consumers need arbitration/backpressure).
  Both are unaffected by the page's COOP/COEP cross-origin isolation (they
  are same-origin primitives; `serve.mjs` already sends the right headers to
  both pages). Zero-copy is unnecessary at serial byte rates.
* **Shim:** expose a `SerialPort`-compatible object (`getInfo()`,
  `open({baudRate})`, `readable`, `writable`, signals, `getSignals()`/`setSignals()`
  mapped to DTR/RTS virtual lines) plus `navigator.serial`-style
  `requestPort()`/`getPorts()` with a picker UI. Client code written against
  Web Serial then runs unmodified; where `navigator.serial` is absent or
  should be shadowed, `Object.defineProperty(navigator, 'serial', …)` installs
  the shim (that works — `serial` lives on `Navigator.prototype`).
* **Exclusivity semantics:** a real serial port serves one reader at a time;
  the emulator tab should grant the port to one consumer tab (handshake on
  the channel, subsequent requesters get a "busy" rejection), or mux like a
  passive tap if sniffing is wanted (BroadcastChannel makes a *monitor* tab
  trivial — every byte visible to all, with the owner allowed to write).
* **Backpressure:** credit-based (consumer acks every N bytes) so a slow tab
  can't balloon a ring in wasm heap. At 115200 baud even the current
  slow-motion boot produces trivial data rates, but a flashing tool bursts.

### QEMU-side prerequisite: a `wasm` chardev backend (new patch, e.g. `0007`)

Today's `-serial file:/serial.log` is write-only, so guest RX (typing into the
phone, x73/loadtool upload) is impossible regardless of transport. Follow the
proven `ui/wasm.c` (patch 0001) pattern:

* `chardev/char-wasm.c` compiled only for `host_os == 'emscripten'`:
  * `chr_write` → SPSC ring in wasm heap; JS drains it via an
    `EMSCRIPTEN_KEEPALIVE wasm_serial_take_tx()` (or a `EM_ASM` notify hook).
  * `wasm_serial_rx(const uint8_t *buf, int len)` (JS, main thread) → second
    ring → bottom half on the main loop → `qemu_chr_be_write()`, with
    `chr_can_read` respected — exactly like the keyboard ring in `ui/wasm.c`.
  * Register the `wasm` backend in `chardev/char.c` (+ qapi `ChardevBackend`
    variant; `board.c` already binds `serial_hd(0)`/`(1)` so
    `-serial wasm` needs no machine changes).
* `site/app.js`: `-serial wasm` (keep `file:` as fallback / `?serial=log`),
  pipe the tx ring into the `BroadcastChannel` and feed rx back.
* The pmb887x USART model already emulates baud-rate timing via the
  chardev serial params (`hw/arm/pmb887x/usart.c`, `usart_get_baud_rate`),
  so the shim's `baudRate` argument can simply be forwarded — timing stays
  faithful even over the virtual link.
* Native build is unaffected (`run-native.sh SERIAL=path|...` keeps working).

**Interim zero-patch hack:** the consumer tab can already tail `/serial.log`
(read-only) via `BroadcastChannel` messages from `app.js`'s existing poll loop
(`site/app.js:352`). Good enough to demo a cross-tab *monitor*; not enough
for interactive tools.

## Option B: a *real* `navigator.serial` device via a native bridge

For consumers that must use the actual Web Serial API — e.g. an existing
unmodified serial terminal/flashing web app — in any tab of any origin:

1. Native helper (small Node/Go program) creates a null-modem pair:
   Linux `tty0tty` (`/dev/tnt0` ↔ `/dev/tnt1`), Windows `com0com`
   (`COM3 ↔ COM4`). Only this end needs a driver (see evidence above).
2. Helper opens one end (`/dev/tnt0`) and speaks WebSocket
   (`wss://…` or `ws://localhost…`) with a tiny framing protocol.
3. Emulator tab (Option A's shim, minus the SerialPort façade) connects to
   the helper instead of/next to a BroadcastChannel consumer.
4. Any other tab does `navigator.serial.requestPort()` → user picks
   `tty0tty`/`com0com` port → `open({baudRate:115200})` → real
   `readable`/`writable` streams against the emulated phone.

Costs/limits: secure context (we already serve https), user gesture per
consumer, Chrome/Edge only (no Firefox/Safari), a helper binary + driver
install, and RTT = browser ↔ helper loop (sub-millisecond locally, but a
real process hop). Verdict: keep as an optional add-on for "works with any
off-the-shelf Web Serial app"; Option A covers everything we host ourselves.

Variant for the native emulator: `scripts/run-native.sh` already accepts
`SERIAL=path`; `-serial telnet:…,server=on` works there, and the same helper
can attach a real socket — trivial extension if the native build is ever
driven from a browser page.

## Rejected / non-viable

| Idea | Why not |
|---|---|
| Share one `navigator.serial` port across tabs | Spec-level exclusivity: while a document holds a port open, another `open()` rejects. (And we'd need a *host* port to begin with.) |
| WebUSB virtual CDC-ACM device | WebUSB is consumer-only too; publishing a USB device from a page is impossible without usbip+UDC hardware — far heavier than Option B. |
| `-serial telnet:`/`socket:` straight from the wasm build | Emscripten sockets require a WS proxy + `PROXY_TO_PTHREAD`; the wasm QEMU runs main()-on-worker with ASYNCIFY — plumbing a second network stack in is strictly more work than the `wasm` chardev. |
| `postMessage` between tabs | Needs a window handle / opener relationship; BroadcastChannel is strictly simpler. |
| `localStorage` events | String-only, slow, clunky backpressure. |

## Recommended sequencing

1. **Patch 0007** (`chardev/wasm.c` + app.js wiring) — unlocks *any* serious
   serial use, cross-tab or not (today you can't even type into the phone).
   Moderate, well-precedented work (~a day, pattern is proven twice already:
   keyboard input and fb blit in `ui/wasm.c`).
2. **BroadcastChannel protocol + `serial.html`** demo tab (terminal/x73
   client) with the Web-Serial-shaped shim — small once (1) exists.
3. Optionally, the **Option B helper** behind a flag for interop with
   off-the-shelf Web Serial tools.
