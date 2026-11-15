# GSM network

The page puts the emulated phone on a GSM network: qemu's own cell,
`gsm-bts` (upstream, `qemu/hw/gsm/gsm-bts*.c`), which runs in the page with
nothing outside it. The option is Advanced ▸ GSM network, **on by default**,
and it does something on the boards whose config has a radio, which since
bsp 191612c (2026-11-13) is every phone here. A run with the box unticked has
no network object at all (upstream removed the default beacon cell in 23d7df3200), no
extra thread and no extra work.

The box is the only control. The benchmarks (`scenebench.mjs`,
`bootbench.mjs`, `idlebench.mjs`) untick it, so their scenes are the ones
the numbers before the option were taken on.

Verified in Chromium on the wasm64 dist, qemu d992a03bf8 (smh 3403936c99),
bsp 191612c (2026-11-13). Upstream's cell now defaults to DCS1800 ARFCN 512
(it was ARFCN 5); the page passes no channel and takes the default.

| board | with the option |
|---|---|
| EL71 | finds the cell (001-01), registers 17 s after Start, shows operator, signal and the GPRS icon; keys answered (`gsmcheck.mjs`, `EL71v41lg91.bin`) |
| S75 | registers: "CC 001 NC 01" on the idle screen; keys answered |
| CX70 | boots, no firmware EXIT in 24 runs of 240 s; at 150 s it is in its first-boot "Phone Pilot" (registration not read) |
| KE800, KE970 | boot (bootcheck); registration not read this time. On 2026-11-11 (qemu 47d1ff26aa) both stayed on "No network", native build included |

## The built-in network

Nothing to start: press Start. About 23 s later (EL71,
this host) the idle screen shows "CC 001 NC 01", the signal bars and the GPRS
icon. `tools/gsmcheck.mjs` boots a phone with the option and checks that it
registers (the status icons against `tools/test_targets/el71v41_gsm_idle.png`),
that the page opened no socket but its GPRS relay, and that the phone still
answers keys a minute later.

What the cell does is upstream's model, unchanged: BCCH (system information
1-4 and 13), FCCH/SCH, random access and immediate assignment of an SDCCH,
LAPDm, Location Updating Accept, and GPRS on timeslot 7 (attach, routing area
update, PDP context). It rejects CM service requests, so there are **no calls
and no SMS**. Its IP side needs a qemu netdev: natively that is slirp, in
the browser a slirp on a server the page relays to (both below).

### The phone's Internet in the browser

A browser gives slirp no sockets, and a page cannot fetch the web on the
phone's behalf (CORS), so the network is on a server: bts-emulator's GPRS
gateway, `gprs-gw` (branch `gprs-gw` of
[bts-emulator](https://github.com/siemens-mobile-hacks/bts-emulator)).

- **qemu.** The page boots the cell on a hub (`-netdev hubport,id=net0,hubid=0
  -object gsm-bts,id=gsm0,netdev=net0`); once the guest runs, the page adds
  itself as the hub's other port (`ui/wasm.c`, `wasm_net_*`, marked
  `WASM PORT (removable)`).
- **The page.** `site/gprs-net.js` relays the cell's Ethernet frames over a
  WebSocket to the page's own `/gprs`, one frame a message, both ways. It
  looks at none of them. Under Advanced ▸ GSM network a caption says why
  there is no Internet when the gateway refuses or cannot be reached. A
  link that closes (the gateway's 15-minute idle close, a restart) is
  dialled again when the phone next sends a frame, after a backoff of 1 s
  doubling to 30 s; after a refusal that may clear (4001, 4002, 4029) it
  waits a minute, and after one that will not (4003 banned, 4004 quota,
  4009 origin) it stays offline for the run.
- **The gateway.** Every connection gets a slirp of its own
  (`gprs-gw/slirp-pipe.c`, libslirp), QEMU's `-netdev user`: the phone is
  10.0.2.15, its DNS 10.0.2.3. It runs in bts-emulator's network namespace,
  where nftables sends its DNS, WAP (UDP 9200/9201), operator proxy and MMSC
  traffic to the same dnsmasq, Kannel, squid and MMSC the Osmocom phones use,
  so the firmware's own operator profiles work, and refuses every other
  private destination and mail port. Limits per client address: 2
  connections, 50 MB a day, 10 KB/s downlink. An emulator's GPRS sends about
  1 KB/s (one CS-1 timeslot); an uplink above 20 KB/s or 300 frames/s over
  10 s bans the address for 182 days (five times the GPRS figures, room for
  EDGE).
- **Hosting.** In the deployment the page's nginx passes `/gprs` to the
  gateway in its own container (`deploy/gprs-gw/README.md`), or nginx-proxy
  routes it to bts-emulator's full stack (its `compose.web.yaml`). The
  nginx-proxy front keeps an idle link for 960 s, past the gateway's own
  15-minute idle close: the page's container carries perk11/nginx-proxy's
  `com.github.perk11.nginx-proxy.proxy-timeout` label, which a stock
  nginx-proxy ignores (`deploy/nginx/README.md`, "What the front is").
  There the gateway itself checks `Origin`, against the list
  in `GPRS_GW_ORIGINS`, and not against `Host`. `serve.mjs` passes `/gprs`
  to `GPRS_GW` (default 127.0.0.1:5751), and only from its
  own pages: an upgrade whose `Origin` does not name the host it was sent
  to (`Host`, or `X-Forwarded-Host` behind a proxy that rewrites `Host`)
  gets a 403. The scheme is not compared, so a page served through a TLS
  front still gets through. `serve.mjs` sends the gateway its peer's
  address as `X-Forwarded-For` and connects from loopback itself, so a
  gateway behind it needs `GPRS_GW_TRUSTED_PROXIES=1`; without it every
  phone counts as 127.0.0.1 against the per-address limits above.

`node tools/gprscheck.mjs --web` checks it end to end: it builds the helper
and starts the gateway from a bts-emulator checkout next to this repository
(`--gateway`), lets that one slirp reach this host's loopback, which the
real gateway never does, and the phone fetches an 8 KB page from
`tools/gprs-host.mjs` (about 2 min 30 s), with the same profile change as
the native check below.

### GPRS data (native build)

With `-object gsm-bts,id=gsm0,netdev=net0` and a slirp netdev
(`-netdev user,id=net0`), the cell hands the phone's IP packets to qemu's
network: the phone gets 10.0.2.15, DNS 10.0.2.3, and reaches the host at
10.0.2.2. `tools/gprscheck.mjs` checks it end to end on EL71: it serves a
page on the host (`tools/gprs-host.mjs`), points the browser's online
profile at the bare GPRS connection, opens `http://10.0.2.2:<port>` from
Internet ▸ Enter URL, answers "Go online", and passes when the host gets the
browser's GET and the page shows on the LCD (about 2 min 15 s). It needs a
native qemu with slirp (`scripts/build-native.sh` enables it; package
`libslirp-dev`).

Two things the check had to get past:

- **The firmware's profile goes through a WAP gateway.** The active online
  profile (MTS) sends the browser to the "MTS WAP" proxy, 192.168.192.168
  port 9201 (WSP over UDP), which slirp forwards to the real address. The
  check selects the connection "MTS Internet-GPRS" in the WAP browser's
  connection list instead (Settings ▸ Connectivity ▸ Online settings ▸ MTS ▸
  Edit ▸ Applications ▸ WAP browser), so the browser speaks plain HTTP. It
  boots a writable copy of the flash for that.
- **Upstream lost every uplink packet over about 240 bytes** (fixed in the
  fork, `9bf917bb6e`): the uplink reassembled LLC frames in a 251-byte buffer,
  and the cell accepts the N201-U the phone proposes in XID (EL71: 1520), so
  every SNDCP segment of a 1500-byte packet was dropped. SYN and ACK went
  through; the browser's GET, sent as 1460 + 116 bytes, never arrived. To be
  offered upstream.

### How it is wired

- **qemu.** The page adds `-object gsm-bts,id=gsm0` and
  `-machine pmb887x,gsm-network=gsm0`. The fork's qemu has no GSM code of
  its own: `hw/gsm` is upstream's with one fix, the uplink LLC buffer (GPRS
  data, above).
- **The board.** A board gets the cell when its config chain has a
  transceiver of a type qemu models (`RADIO_TYPE_RE` in `site/app.js`:
  hd155153np, hd155155npeb, hd155165bp, pmb6270, pmb6272, bright-6pla). Since
  bsp 191612c every phone here has one, the ELKA include's included (the page
  used to boot an overlay that uncommented it; that is gone).
- **The accessory.** Every run boots with the board's default accessory, the
  data cable; see the deep-sleep entry below. Picking another accessory in
  the control still works and is the user's choice.

### Where it runs, and why not in a worker

`gsm-bts` is not a process with a clock of its own. It is a passive object
behind upstream's `GSMNetwork` interface, and the phone's baseband model
calls it on the vCPU thread: "which burst is on ARFCN a, frame f, timeslot
t?" each time the modelled receiver opens a window, and "the phone sent this
burst" each time it transmits. A four-burst block is channel-coded the first
time one of its bursts is asked for and kept; queued messages (an immediate
assignment, a LAPDm frame) are taken at that moment. It has no thread, no
timer, no lock, no allocation on that path and, without `gsmtap=` and
`netdev=`, no system call. A cell nobody listens to costs nothing.

Measured on EL71 (Chromium, this host, a dist of the same upstream
revision, 23d7df3200):

- **Per-thread CPU profile** (every worker, 100 µs sampling, 90 s starting
  14 s after Start, so cell search, registration and camping are inside). The
  vCPU worker spent **3.2 ms** in the network model (`gsm_bts_*`,
  `gsm_xcch_*`, `gsm_conv_*`, burst builders): 0.015 % of that thread's busy
  time. The worst ten seconds, around the registration, had 2.4 ms; camped
  it is 0.3 ms per ten seconds or less. The phone-side radio models
  (`gsm_air_*`, the DSP's signal level) took 39 ms. No other worker ran any
  GSM function, and the run has the same number of workers as one without
  the option.
- **`tools/scenebench.mjs`, option off against on, same dist, runs
  alternated** (browser CPU in host cores; vratio = guest seconds per wall
  second):

  | | off | off, data cable | on |
  |---|---|---|---|
  | idle, 4 runs: cpu | 0.156 (0.150-0.160) | | 0.077 (0.076-0.078) |
  | idle: guest MIPS | 3.8 | | 2.6 |
  | stopwatch, 4 runs: vratio | 1 | | 1 |
  | stopwatch: cpu | 0.662 (0.647-0.695) | | 0.591 (0.577-0.690) |
  | stopwatch: guest MIPS, fps | 137.6, 62.5 | | 136.5, 62.5 |
  | slow host, idle, 2 runs: cpu | 0.136, 0.149 | 0.142, 0.143 | 0.063, 0.066 |
  | slow host, stopwatch, 3 runs: vratio | 0.809 (0.794-0.826) | 0.811 (0.712-0.830) | 0.979 (0.948-0.988) |

  "Slow host" is `CORES=0-3 SPIN=2 tools/slowhost.sh`: the browser gets about
  a third of each of four cores. (CDP's `Emulation.setCPUThrottlingRate` was
  tried first; Chromium refuses it for workers, so it slows the page's main
  thread and not the vCPU: vratio stayed 1 in all three columns.)

The option does not cost the guest speed; a run with it is the cheaper one.
The reason is the guest, not the model: a phone that has no cell keeps
looking for one (the vCPU thread is busy 14 % of the time at the idle
screen), a camped phone sleeps between the blocks it has to read (5-6 %).
The "off, data cable" column is there because a GSM run boots with the data
cable (above): the cable is not what makes the difference.

It was asked whether the cell could run in a worker of its own. It can, but
only as a different network, and it would cost more than it saves:

- The interface is a synchronous question. A worker can answer it only by
  having the answer ready, so it would have to generate every block of every
  timeslot ahead of the phone's frame clock, into a shared table. That is on
  the order of a hundred channel-coded blocks a second (an estimate from the
  multiframe layout; it was not built), all the time, on a thread that wakes
  for each batch, where the in-place model codes only the blocks the phone
  actually listens to. The vCPU thread would still copy each burst out of
  the table, which is what it does today when the block is already built.
- Upstream's model relies on being asked: a queued downlink message goes into
  the next block the phone reads. Generated ahead, it goes into the next block
  on air, whether the phone is listening or sleeping between paging blocks,
  and the model does not repeat it. Uplink would be seen a block late. The
  wrapper would be fork code tied to the internals of an upstream file that
  is still moving.

So the built-in cell stays where upstream runs it.

## Not supported, known gaps

- **No SMS, no calls** (above).
- **Without a GPRS gateway** the browser build has no Internet: the phone
  attaches and gets an address, and nothing answers.
- **The operator profiles through the gateway are unverified.** The nftables
  rules that send WAP, proxy and MMSC traffic to bts-emulator's services
  could not be loaded in the container this was written in (no
  `NET_ADMIN`); the checks here use the MTS Internet-GPRS connection.
- **`-icount shift=3`.** Natively with the cell and the scripts' default
  clock (`-icount shift=3,sleep=on`), EL71 stopped at the boot logo with a
  firmware `>>EXIT<<` from `l1bbcsg` (layer 1); with the page's clock
  (`ICOUNT=vt`) it registers. Seen once on `d5421c70af`, not looked into.
- **LG boards**: KE800 and KE970 stayed on "No network" at qemu
  47d1ff26aa, native build included; not read again since.
- **Deep sleep.** With the radio enabled and an accessory that lets the
  firmware deep-sleep (music cable, or none) EL71 hangs about a minute after
  boot: the firmware waits for `SCCUCLKSTA.GSMCLK` to clear after writing
  `SLPCTRL.SLPEN`, and the SCCU model's sleep timer is still running from the
  sleep before, because the TPU model woke the CPU early and the firmware
  then skips `SLPSTP`. This is upstream's model, native build included
  (`-global accessory-connector.accessory=music-cable` reproduces it; seen at
  smh 55f765ae87, not looked at again after 23d7df3200), and is not fixed
  here. With the data cable the firmware never enters that sleep. Since the
  bsp pin moved past 15157fe ("enable RF transceiver on ELKA") the EL71
  hangs with the music cable GSM or not (seen 2026-11-13: halts frozen,
  the wizard never answers a key), so the page now boots every board with
  its default accessory; it used to prefer the music cable, and the stereo
  headset on SGOLD boards. The data cable plays sound too.

## A network on a server (dropped)

Before upstream had the built-in cell, the option was built against
[bts-emulator](https://github.com/siemens-mobile-hacks/bts-emulator), a stack
of native Osmocom daemons that has to run on a server: a WebSocket bridge in
`serve.mjs` to its TRX multiplexer and a qemu object with a link thread of its
own. With it EL71 and KE800 registered and received SMS. A port of those
daemons to WebAssembly was started too (all five built and linked, none
ran). Both were deleted on 2026-11-11 without being merged: the built-in
cell is enough for a phone that shows a network, and neither is in the
history of this repository or of the qemu fork. The GPRS gateway above is
not that: the cell stays in the page, only the phone's IP goes to a server.
