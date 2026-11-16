# The GPRS gateway container

The page relays the phone's GPRS (its Ethernet frames, one per WebSocket
message) to `/gprs`. Behind that path runs bts-emulator's GPRS gateway,
`gprs-gw/server.mjs`: every connection gets its own `slirp-pipe` helper
(libslirp, QEMU's `-netdev user`: phone 10.0.2.15, DNS 10.0.2.3) that opens
ordinary TCP and UDP sockets to the Internet. `doc/gsm-network.md` describes
the whole path. `tools/gprs-gateway.mjs` in this repository is not a second
gateway: it only builds and starts the same `server.mjs` for the checks.

This image runs the gateway on its own, without bts-emulator's Osmocom
stack, next to the page's nginx (`deploy/nginx`), which passes `/gprs` to it.

| file | what it is |
|---|---|
| `Dockerfile` | `node:24.22.1-trixie-slim` (pinned by digest), libslirp 4.9.7 built from its release tarball (sha256-checked), `slirp-pipe` linked against it, `ws` from `package-lock.json`; runs as `node` (uid 1000) |
| `bts-emulator/` | submodule, branch `gprs-gw`; the image uses only `gprs-gw/server.mjs` and `gprs-gw/slirp-pipe.c` |
| `package.json`, `package-lock.json` | `ws` 8.21.3, the version the repository's own gateway checks run with |
| `healthcheck.mjs` | `HEALTHCHECK`: a plain GET, which the gateway answers with 426 (not logged, not counted) |
| `../nginx/docker-compose.yml` | the `pmb887x-gprs-gw` service |
| `../nginx/site.conf` | `location = /gprs`, the WebSocket proxy |

## Where the source comes from

The gateway lives on branch `gprs-gw` of bts-emulator (`55c911a`, three
commits on top of `1a124e7`); upstream `main`, and the `pmb887x-emu/bts`
submodule that pins it (`01955ac`), have no `gprs-gw/`. `bts-emulator/` here
is a submodule pinned to a commit of that branch, inside the image's build
context, so a plain build (compose v1 or v2, or `docker build`) finds the
two files without a named build context. Nothing else from the submodule is
used.

```sh
git submodule update --init deploy/gprs-gw/bts-emulator
```

Without it the build stops at `COPY bts-emulator/gprs-gw/...`.

When the gateway changes, move the submodule to the new commit and commit
that:

```sh
git -C deploy/gprs-gw/bts-emulator fetch origin gprs-gw
git -C deploy/gprs-gw/bts-emulator checkout <commit>
git add deploy/gprs-gw/bts-emulator
```

`slirp-pipe.c` needs libslirp 4.9 or newer (`slirp_pollfds_fill_socket`,
`slirp_os_socket`). Debian 13 ships 4.8.0, which fails to compile it, so the
image builds libslirp 4.9.7 statically from the upstream release
(2026-10-30, several security fixes over 4.9.1). bts-emulator's own
`Dockerfile` (Debian 13 plus the Osmocom repository, which has no libslirp)
builds `slirp-pipe` against that 4.8.0; compiled that way here, it fails
(`unknown type name 'slirp_os_socket'`).

Debian package versions are pinned. When Debian replaces one of them (a
point or security release) the old version leaves the mirror and the build
fails at `apt-get install`; bump the pin to the new version then.

## Build and run

With the page, behind the perk11/nginx-proxy front (`deploy/nginx/README.md`),
in `deploy/nginx/.env`:

```sh
VIRTUAL_HOST=emu.example.org
LETSENCRYPT_HOST=emu.example.org
LETSENCRYPT_EMAIL=you@example.org
```

```sh
git submodule update --init deploy/gprs-gw/bts-emulator
cd deploy/nginx
docker compose up -d --build
docker compose ps          # pmb887x-gprs-gw should become "healthy"
docker compose logs -f pmb887x-gprs-gw
```

The gateway joins only the stack's own `gprs` network, shared with
`pmb887x-web`; it publishes no port and is not on the `nginx-proxy`
network. The stack always builds and starts it, so it needs the
submodule. nginx looks the gateway's name up per request, so the
order containers start in does not matter, and while the gateway is down
`/gprs` answers 502: the phone has no Internet, the page still works.

On its own, for `serve.mjs` on the same host (it passes `/gprs` to
`GPRS_GW`, default `127.0.0.1:5751`, adding one `X-Forwarded-For` hop):

```sh
git submodule update --init deploy/gprs-gw/bts-emulator
docker build -t pmb887x-gprs-gw deploy/gprs-gw
docker run -d --name pmb887x-gprs-gw --init --read-only --cap-drop ALL \
  --security-opt no-new-privileges -p 127.0.0.1:5751:5751 \
  -v pmb887x-gprs-gw-state:/var/lib/gprs-gw \
  -e GPRS_GW_TRUSTED_PROXIES=1 -e GPRS_GW_ORIGINS=https://emu.example.org \
  pmb887x-gprs-gw
```

## Configuration

All settings are environment variables. In compose they come from
`deploy/nginx/.env`; an empty or unset one keeps the gateway's default.

| variable | default | meaning |
|---|---|---|
| `GPRS_GW_LISTEN` | `0.0.0.0:5751` | listen address in the container (nginx expects port 5751) |
| `GPRS_GW_ORIGINS` | compose: `https://$VIRTUAL_HOST` (`GPRS_GW_PAGE_ORIGIN`), LAN mode: empty; gateway: empty = any | page origins allowed to connect, comma separated; others are closed with 4009, which the page takes as final. Set it explicitly when `VIRTUAL_HOST` lists several names |
| `GPRS_GW_TRUSTED_PROXIES` | compose: `2`; gateway: `0` | proxies in front that each append to `X-Forwarded-For` (below) |
| `GPRS_GW_PER_IP` | `2` | connections at once per client address (IPv6: per /64) |
| `GPRS_GW_MAX_SESSIONS` | `100` | connections at once in total (raise `pids_limit` and `mem_limit` with it) |
| `GPRS_GW_ATTEMPTS` | `20` | connection attempts per client address and minute |
| `GPRS_GW_DAILY_BYTES` | `50000000` | bytes per client address and day, both directions |
| `GPRS_GW_DOWN_RATE`, `GPRS_GW_DOWN_BURST` | `10240`, `81920` | downlink bytes/s and burst per connection; more is dropped |
| `GPRS_GW_BAN_RATE`, `GPRS_GW_BAN_FRAMES` | `20480`, `300` | an uplink above this many bytes/s or frames/s over 10 s bans the address... |
| `GPRS_GW_BAN_DAYS` | `182` | ...for this many days |
| `GPRS_GW_IDLE` | `900` | seconds without traffic before a connection is closed (nginx's `/gprs` timeouts are 960 s) |
| `GPRS_GW_TCP_PORTS` | `*` | TCP ports a phone may reach, or a list such as `80,443,8080` |
| `GPRS_GW_NEW_FLOWS`, `GPRS_GW_HOSTS` | `120`, `200` | new flows per phone and minute, distinct hosts per phone and hour |

Fixed in the image: `GPRS_GW_HELPER=/usr/local/bin/slirp-pipe`,
`GPRS_GW_STATE=/var/lib/gprs-gw/state.json`. `GPRS_GW_HELPER_UID` does
nothing here: the gateway only switches the helper's user when it runs as
root, and it runs as `node`. Never set `SLIRP_HOST_LOOPBACK`: it is for the
local checks and lets phones reach the container's loopback.

**Trusted proxies.** The gateway counts a client as the address that many
hops back in `X-Forwarded-For`. Every nginx in the path appends one hop:

| path | value |
|---|---|
| front (nginx-proxy) → `pmb887x-web` → gateway (this compose) | `2` |
| `pmb887x-web` published directly → gateway | `1` |
| `serve.mjs` → gateway | `1` |
| browser → gateway directly | `0` |

nginx-proxy appends the client's address (with `TRUST_DOWNSTREAM_PROXY=false`
it sends that address alone), so either way the client is its last entry.
Too low and every phone counts as the proxy's address, so all of them
share `PER_IP` connections and one day's quota. Too high and a client can
choose its own address with a forged `X-Forwarded-For`, which evades bans.
A front with a CDN in front of it adds one more.

**State.** Bans and the day's per-address byte counts are kept in
`/var/lib/gprs-gw/state.json`, on the `gprs-gw-state` volume (owned by uid
1000). They are written every 30 s, on every ban and on `SIGTERM`. To lift a
ban, stop the container, delete the address from `bans` in that file, and
start it again.

## Networking

- **Outbound:** the container needs Internet access over IPv4 (TCP to any
  port but mail submission, UDP 53 and 9200-9203, ICMP echo). The compose
  `gprs` network is an ordinary bridge with Docker's NAT.
- **Inbound:** only TCP 5751 from `pmb887x-web`, nothing published.
- **No privileges:** slirp is a userspace TCP/IP stack. It turns the phone's
  packets into ordinary sockets of the helper process, so the gateway needs
  no `NET_ADMIN`, no `/dev/net/tun`, no raw sockets and no capabilities at
  all (`cap_drop: [ALL]`). Ping uses unprivileged ICMP datagram sockets
  (`net.ipv4.ping_group_range`, which Docker opens in containers); where it
  is closed, only ping fails.
- **DNS:** the phone's DNS (10.0.2.3) is forwarded to the container's
  resolver, Docker's `127.0.0.11`, and from there to the host's resolvers.
- **Not provided:** bts-emulator's full stack also redirects the phone's DNS,
  WAP (UDP 9200/9201), operator proxies and MMSCs to its own dnsmasq,
  Kannel, squid and MMSC with nftables. Without it the firmware's
  WAP-gateway profiles (proxies at private addresses such as
  192.168.192.168) are refused as private destinations; profiles that go
  straight to the Internet (such as "MTS Internet-GPRS",
  `doc/gsm-network.md`) work.

## Security posture

The gateway gives anonymous web visitors a NATed exit from the server's
address, so its filters are the whole point:

- **Frame filter, always on.** `refusal()` in `server.mjs` checks every
  frame from a phone before slirp sees it: ARP and IPv4 only (no IPv6, no
  fragments); no private, loopback, link-local, CGNAT, documentation or
  multicast destination (which includes the Docker networks, the host's
  LAN and cloud metadata at 169.254.169.254); no SMTP submission (25, 465,
  587, 2525) whatever `TCP_PORTS` says; UDP only to DNS and WAP; ICMP only
  echo. It has no switch, and this deployment must not patch one in.
- **slirp's host loopback is off** (10.0.2.2 reaches nothing).
- **Helpers:** each `slirp-pipe` has 64 sockets, 256 MB of address space, no
  core dumps, `no_new_privs`, and cannot fork.
- **Abuse limits:** per-address connections, attempts, daily bytes,
  downlink rate, per-phone flows and hosts, and long bans for anything
  sending faster than an emulated phone can (see the table).
- **Origin:** set `GPRS_GW_ORIGINS`, so other sites' pages cannot use
  visitors' browsers to reach the gateway. A non-browser client can forge
  `Origin`; the limits above are what holds against those.
- **Container:** non-root, read-only root filesystem, all capabilities
  dropped, `no-new-privileges`, `pids_limit` and `mem_limit`, not reachable
  from the `nginx-proxy` network.
- **Single layer:** in bts-emulator the same rules exist twice (the
  gateway and `nat.nft`). Here the gateway's filter is the only one. A host
  firewall rule that drops traffic from the `gprs` network to private
  ranges (the `DOCKER-USER` chain) would restore a second layer.
- **Logs** hold client addresses (connections, refusals, bans); the compose
  file rotates them at 5 × 10 MB.

## Before going live

- The domain, DNS and TLS are the front's (`deploy/nginx/README.md`); the
  page must be `https://` for cross-origin isolation, and so the gateway
  sees `Origin: https://<host>`.
- The front must keep idle WebSockets for longer than nginx's default 60 s,
  or an idle `/gprs` drops the phone's open TCP connections in that slirp.
  perk11/nginx-proxy does it for containers with the
  `com.github.perk11.nginx-proxy.proxy-timeout` label, which
  `deploy/nginx/docker-compose.yml` sets to 960 s on `pmb887x-web`; rebuild
  the front if its image predates the label. A stock nginx-proxy or another
  front ignores the label and needs the timeout raised its own way
  (`deploy/nginx/README.md`, "What the front is").
- Do not also run bts-emulator's `compose.web.yaml` for the same host: its
  `VIRTUAL_PATH=/gprs` makes the front send `/gprs` to that stack instead.
  Use one or the other. That stack keeps the operator services, this one
  needs nothing but this repository and the two gateway files.
- The server's address is where the phones' traffic comes from: expect
  abuse reports to reach it, keep the limits, and consider the egress
  firewall rule above.
