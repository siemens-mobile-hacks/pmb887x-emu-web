# SMS, USSD and calls for the GSM cell (`gsm-bts relay=`)

qemu's own cell (`gsm-bts`, doc/gsm-network.md) registers a phone and carries
GPRS, but it rejects every CM service request: no SMS, no calls. With the
option `relay=<chardev>` the cell gets a network behind it. An external
**relay server** at the other end of the chardev does the switching, the SMS
centre and the services, and the cell gives the phone:

- a network name: MM INFORMATION after the location update, so the idle
  screen shows the relay's name (e.g. "Virtual Network") instead of
  "CC 001 NC 01";
- SMS both ways;
- USSD (`*100#` and the like, answered by the relay);
- calls, mobile originated and terminated, on a TCH/F with speech both ways.

Every emulator (and anything else that speaks the protocol below) connected
to one relay is a phone of the same network: they text and call each other
by number. The relay itself is a separate program, in the `gsmrelay/`
submodule (github.com/siemens-mobile-hacks/gsmrelay): `gsmrelay/smsrelay/relay.py`
is the server (its options and wire protocol are in its docstring),
`gsmrelay/clip/` the sound clips it plays. This repository has the cell's side
and the page's link to it.

Without the option nothing changes: every new path in `gsm-bts.c` is behind
`bts->relay_core`, which only the option creates.

## Running it

### Natively

```
git submodule update --init gsmrelay
python3 gsmrelay/smsrelay/relay.py --port 4725   # --help for the options
```

```
GSM_RELAY=127.0.0.1:4725 BOARD=siemens-el71 scripts/run-native.sh <fullflash>
```

`GSM_RELAY=host:port` (scripts/run-native.sh) adds

```
-machine pmb887x,gsm-network=gsm0
-chardev socket,id=gsmrelay,host=<host>,port=<port>,reconnect-ms=2000
-object gsm-bts,id=gsm0,relay=gsmrelay
```

Any chardev works for `relay=`; a TCP client socket is the usual one. The
relay may start before or after qemu and may restart: the chardev reconnects
every 2 s and the cell says hello again.

The SIM is the default virtual one (`gsm-sim`). The relay knows the phone by
its IMSI; give each emulator its own IMSI
(`SIM=none` + `-device gsm-sim,operator=00101,imsi=...`) when several run
against one relay.

`GSM_RELAY_DEBUG=1` in qemu's environment prints the cell's MT SMS and paging
decisions.

### In the browser

The page has no TCP, so the cell's chardev is the page itself and the bytes
go over a WebSocket to the server, which pipes them to the relay:

```
qemu cell (hw/gsm/gsm-relay.c) --chardev wasm-gsm--> ui/wasm.c byte rings
   --> site/gsm-relay.js --WebSocket /gsmrelay--> serve.mjs --TCP--> relay
```

```
GSM_RELAY=127.0.0.1:4725 node serve.mjs
```

- `serve.mjs`: `GSM_RELAY=host:port` turns `/gsmrelay` on; unset, `GET
  /gsmrelay` answers `{"relay": false}` and the upgrade 404. It is the
  WebSocket server itself (RFC 6455 binary frames, ping, close) and pipes to
  the relay with backpressure both ways; the same Origin rule as `/gprs`
  (403 otherwise). A relay that is down = 502 on the upgrade; the page
  retries. At most 8 relay WebSockets per client address (429 above):
  the relay sees every page as this host's loopback, which its own
  per-address limit (`MAX_PER_IP`) exempts.
- `site/gsm-relay.js`: `GsmRelay` pumps the bytes
  every 20 ms (and on every
  message, as background tabs throttle timers), redials with a 1-30 s
  backoff, closes and redials when the emulator has not taken 256 KB of
  relay bytes (stalled), and reads the relay's `N` frame (the phone's
  number). `relayOffered()` asks `GET /gsmrelay`. `simImsi(operator)`: the
  page's IMSI = the operator + 10 random digits kept in localStorage, each
  held by its tab with a Web Lock, so a reload keeps the number and a second
  tab takes another IMSI. Without Web Locks (plain http on the LAN) each
  tab keeps its own IMSI in sessionStorage: a reload keeps it, a new tab
  gets a new one.
- `site/app.js` / `index.html`: Advanced ▸ "Online GSM network (SMS, calls,
  USSD)", shown only when the server offers a relay, on by default there;
  greyed out unless the GSM network option is on and the SIM is not "none". The run then gets
  `-chardev wasm-gsm,id=gsmrelay`, `gsm-bts,...,relay=gsmrelay` and
  `gsm-sim,...,imsi=<page IMSI>`. The number shows in the pill's network
  line ("Registered (emu.example.org) · 8440"; "(local)" without the relay). Unticked, or a server
  without a relay: the run's arguments are exactly as before.
- `qemu/ui/wasm.c` (WASM PORT, removable): chardev type `wasm-gsm`, two
  64 KB byte rings, exports `_wasm_gsmrelay_ready/buf/take/put/open`. The
  cell is told OPENED / CLOSED when the WebSocket opens / closes.
- The nginx deployment (`deploy/nginx`) has no `serve.mjs`: there the relay
  is the WebSocket server itself (`relay.py --ws-port`, in the
  `pmb887x-gsmrelay` container, `deploy/gsmrelay/README.md`), and
  `site.conf` passes `/gsmrelay` to it, plain GET and upgrade alike:

  ```
  site/gsm-relay.js --wss /gsmrelay--> nginx-proxy --> pmb887x-web (site.conf)
     --> relay.py's WebSocket (deploy/gsmrelay)
  ```

  The relay answers the plain GET with `{"relay": true}`, checks Origin,
  and counts each page by its address in `X-Forwarded-For`
  (`--trusted-proxies`), so its own per-address limit applies to the real
  client instead of a proxy. Without the container `/gsmrelay` is a 502
  and the option stays hidden.

### Microphone in the browser

A mic button next to the sound button, offered before Start too (every board's DSP takes the input); pressed
before Start, it goes to the run once the phone is live, and the end of a run turns it off.
Pressed, the page asks for the microphone (getUserMedia: https or localhost
only), captures it at 8 kHz (`site/mic.js`) and hands 16-bit samples to
`_wasm_mic_put` (`qemu/ui/wasm.c`). The AFE model
(`hw/arm/pmb887x/dsp/peripheral/afe.c`, `pmb887x_afe_mic_push`) takes them
as the microphone ADC input: a ring of at most 2000 samples (0.25 s, newer
ones dropped when full, so a slow guest cannot build up a delay). No mic,
denied, or button off = silence as before.

Natively, `PMB887X_MIC_FILE=<raw s16le mono at the ADC rate>` feeds the
microphone from a file (a test aid).

## The relay protocol

A byte stream both ways (TCP natively), frames `[type u8][len u8][payload]`.

| type | direction | payload |
|---|---|---|
| `H` | cell → relay | hello: the IMSI as a mobile identity LV (as in the LU); sent on every (re)connect once the phone has registered |
| `N` | relay → cell | the phone's number, ASCII digits (shown by the page) |
| `S` | cell → relay | an SMS-SUBMIT TPDU as the phone sent it |
| `D` | relay → cell | `[oa len][oa address field][TPDU]`: an SMS for the phone. The TPDU is an SMS-DELIVER (passed as is) or an SMS-SUBMIT (converted, the host's time as the time stamp); oa = digit count, TOA, BCD |
| `R` | cell → relay | `[state]` result of the last `D`: 2 delivered, 3 failed |
| `C` | both | call event `[ev][cause][digits]`: ev 1 SETUP (cell → relay: the called number; relay → cell: the calling number), 2 ALERT, 3 CONNECT, 4 DISC (cause = GSM 04.08 cause: 16 normal, 17 busy, 21 rejected, ...) |
| `U` | cell → relay | 20 ms of the phone's speech: one 33-byte GSM-FR frame, libgsm/RTP format |
| `V` | relay → cell | 20 ms of far-end speech: one 33-byte GSM-FR frame in TCH/FS d-bit order (GSM 05.03 table 2), 50 a second |
| `Q` | cell → relay | USSD request, the text the user typed |
| `q` | relay → cell | USSD answer, UCS2 big-endian |
| `T` | cell → relay | trace entry `[kind][data]` for the relay's log: `U`/`D` layer 3 from/to the phone, `R` RACH, `A` phone on the TCH, `E` channel end |
| `P` | both | keepalive, empty |

One call per phone. The relay paces `V` by wall-clock time; the cell plays
50 frames a second of guest time (see Limits).

Without a relay connected (the link down, or the relay restarting) the
phone is told the network is out of order: an SMS fails with RP-ERROR cause
38, a call is released with cause 38, USSD gets an empty RELEASE COMPLETE.
Only the cell's own test number 100 still answers (it hangs up after 1 s).
Until 2026-11-27 the cell answered itself (the SMS came back to its sender,
the call was answered with silence), which looked like a delivered SMS.

An MT call while the phone's channel is up for something else (an SMS, a
location update) is paged once that ends, not answered busy; the user dialling
out while paged ends the page (the caller hears busy). The SMS queued in the
cell for the phone stay across a new link: the relay sends each SMS once and
does not resend it.

The relay gives each IMSI the number of its last digits, or the next free
one, and keeps it in `numbers.json` for 30 days after the phone was last
seen: a phone that is away does not lose its number to another IMSI with the
same digits. A link that says hello with a second IMSI is dropped; a
reconnect with the same IMSI replaces the old link (its call ends). The
balances (`balances.json`) and numbers are written at most once a second,
atomically; a balances file that cannot be read stops the relay instead of
starting everyone from scratch.

## How it is built

- `hw/gsm/gsm-relay.c` (new):
  - The network side (`VNet`, `vn_*`): LAPDm SAPI 0/3 on SDCCH/4 sub 0,
    LOCATION UPDATING ACCEPT + MM INFORMATION, CM SERVICE for SMS / SS /
    calls, SMS CP/RP both ways with paging by IMSI, USSD as RELEASE COMPLETE
    returnResult (UCS2), call control MO/MT with ASSIGNMENT COMMAND to the
    TCH.
  - The relay link (`Bridge`, `br_*`): frames to and from the chardev; the
    queues between the two (`VnBox`).
  - The TCH/F on timeslot `GSM_RELAY_TCH_TS` = 2 of the BCCH carrier, TSC 0,
    speech full rate v1: 26-multiframe, SACCH/T at frame 12 (gsm-bts's own
    SI5/SI6), idle 25. Downlink blocks every 4 TCH frames: FACCH/F (LAPDm
    gets a turn every 8th block, ~160 ms) or a TCH/FS frame from the `V`
    ring (empty = an all-zero block = the receiver's bad frame = silence),
    block-diagonal interleaving over 8 bursts, stealing flags. Uplink: the
    same deinterleaving; stolen blocks → FACCH → LAPDm, the others → TCH/FS
    decode (class 1a CRC) → `U`.
  - Clock: gsm-bts codes a block only when the phone asks for one of its
    bursts, so the network's timers (paging, CC guard timers, USSD wait, the
    link) run from a QEMU_CLOCK_VIRTUAL timer at 13 Hz. A dedicated channel
    whose blocks the phone has not asked for in 1 s is ended, and a TCH
    without uplink for 6 s too.
- `gsm-bts.c` hooks (each `if (bts->relay_core)`): RACH → new dedicated
  channel; CCCH → paging for the phone's IMSI when nothing else is queued;
  SDCCH downlink and uplink → gsm-relay.c's LAPDm instead of gsm-bts's;
  the bursts of TS 2 while a call is on the TCH. The registration bit of
  `ms-state` (the page's badge) is kept on the relay path too.
  `gsm_bts_sacch_transmit` is no longer static.
- `gsm-coding.c`: four exported helpers for the channel coding without the
  burst mapping (`gsm_xcch_code_bits`, `gsm_xcch_decode_bits`,
  `gsm_tchfs_code_bits`, `gsm_tchfs_decode_bits`).
- `qapi/qom.json`: the `relay` property of `GsmBtsProperties`.
- `chardev/char-socket.c`: a qemu bug fixed. Since "chardev: Consolidate yank
  registration" (5c102ac9f1) the yank function is registered only for a
  connected client, but a failed connect still unregistered it, which
  aborts: every failed client connect with `reconnect-ms` killed qemu (a
  relay not up yet, or restarted). The unregister on that path is removed.
- `scripts/run-native.sh`: `GSM=1` (the cell alone), `GSM_RELAY=host:port`.
- `scripts/build-deps.sh`: glib with `-Dlibelf=disabled` (the host's libelf
  leaked into the cross build).

## Verified

EL71 (the page's vcpu-timers clock), natively and in headless Chromium:

| what | result |
|---|---|
| registration + name | LU, MM INFORMATION, the relay's network name on the idle screen |
| SMS | MO to a service number and its 2-part answer (paging, delivery OK, Inbox); page to page |
| USSD | `*100#`: the answer in the phone's USSD window |
| MO / MT calls | ASSIGNMENT, ALERTING, CONNECT, release from either side; MT rings with the caller's number |
| downlink speech | a melody from the relay: the speaker's pitch follows it note for note (natively and in the page's audio) |
| uplink speech | a microphone file / fake browser microphone: the relay's recording correlates 0.81-0.87 (50 ms RMS envelope) with it |
| two pages | own IMSIs and numbers; SMS and calls between them |
| relay restart | reconnects, the same number (checked when the cell still answered itself meanwhile; the refusal since 2026-11-27 is not checked on a phone) |
| option off | "CC 001 NC 01", `ms-state` as before |

## Limits

- One phone per cell, one transaction at a time: one dedicated channel
  (SDCCH/4 sub 0) and one TCH, as gsm-bts.
- No authentication, ciphering or TMSI; the LU always carries the IMSI.
- Speech pacing: the relay sends `V` by wall clock, the cell plays 50 a
  second of guest time. A guest slower than real time fills the ring; above
  48 frames (0.96 s) the oldest is dropped, so the delay stays bounded.
  relay.py keeps up to 40 frames ahead (SP_PREFILL + SP_BATCH_AHEAD); the
  cell's SP_HIGH must stay above that or every clip loses its start. The
  other direction (a slow guest sends fewer `U` frames) gives the far end
  gaps.
- The page's vcpu-timers clock was used for every check; under
  `-icount shift=3`, the scripts' default then, EL71 stopped at the boot
  logo with the cell (doc/gsm-network.md).
- A public relay is a shared service: whoever reaches it can claim any IMSI.
  Access control is the relay's business.
