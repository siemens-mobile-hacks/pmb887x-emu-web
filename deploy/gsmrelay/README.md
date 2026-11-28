# The virtual network's relay as a container

`gsmrelay/smsrelay/relay.py` (the `gsmrelay` submodule at the repository
root) is the switch, SMS centre and service numbers behind the emulator's
GSM cell: SMS, calls and USSD between every page connected to it
(`doc/gsm-relay.md`). This image runs it with its own WebSocket, so the page's
`/gsmrelay` needs no `serve.mjs`:

```
page --wss /gsmrelay--> nginx-proxy front --> pmb887x-web (site.conf)
     --> pmb887x-gsmrelay:4726 (relay.py --ws-port)
```

`deploy/nginx/docker-compose.yml` builds and starts it with the page
(`deploy/nginx/README.md`, "The virtual network"). On its own:

```bash
git submodule update --init gsmrelay
docker build -f deploy/gsmrelay/Dockerfile -t pmb887x-gsmrelay .
```

## What it serves

One port, 4726, plain HTTP for a proxy to pass to:

| request to `/gsmrelay` | answer |
|---|---|
| `GET` without `Upgrade` | `200 {"relay": true}`: the page's "is there a relay?" (also the health check) |
| WebSocket upgrade | `101`, then the relay's byte protocol in binary messages; `403` for another origin, `503` past the limits below |
| any other path / method | `404` / `405` |

The relay's raw TCP port for phones (4725) is off (`--port 0`). The picture
server of the SMS service 7777 still listens on 8089 inside the container;
nothing routes to it, so the "5" (picture) answer's link does not open for
pages.

## Settings

| variable | default in compose | meaning |
|---|---|---|
| `GSMRELAY_ORIGINS` | empty | page origins allowed to connect, comma separated (exact, e.g. `https://emu.example.org`) |
| `GSMRELAY_PAGE_ORIGIN` | `https://$VIRTUAL_HOST`; LAN mode: empty | used when `GSMRELAY_ORIGINS` is empty. Both empty: the page's own origin, as the `Host` header names it (port included) |
| `GSMRELAY_TRUSTED_PROXIES` | `2`; LAN mode: `1` | proxies in front that each append to `X-Forwarded-For`, counted as for the GPRS gateway (`deploy/gprs-gw/README.md`, "Trusted proxies"): front + `pmb887x-web` = 2. Too low and every page counts as the proxy's address, so all of them share `GSMRELAY_PER_IP`; too high and a client can choose its own address with a forged header |
| `GSMRELAY_MAX_PHONES` | `64` | phones connected at once. Every open tab with the option on is one, idle or not. At most 900 (the relay's `select()`) |
| `GSMRELAY_PER_IP` | `8` | phones from one address |

Arguments after the image name (compose: `command:`) are appended to
relay.py's flags (`relay.py --help`), e.g. `--record` or `--play <file>`.

## Limits and floods

- Per address: `GSMRELAY_PER_IP` phones and 30 new connections a minute
  (`503`). Per connection, a token bucket per frame type: SMS, calls and
  USSD 20 a minute, hello 10, speech (`U`) 100 a second sustained (a call
  sends 50), trace 50 a second, every other type 5 a second, WebSocket
  messages 250 a second. Past one the phone is dropped (the page redials
  after its backoff).
- Measured on one core (relay.py, 20 s per case): 8 calls 5%, 32 calls (64
  phones, the default maximum) 17%, about 30 MB. A page flooding speech
  frames as fast as the socket takes them was dropped after 33 ms; 8 calls
  running meanwhile lost no frame.
- Handshakes: at most 64 under way, 10 s each, 8 KB of request head.

## State and logs

`/var/lib/gsmrelay` (the `gsmrelay-state` volume, owned by uid 1000) holds
`balances.json` (the SieCoin balances, by IMSI) and `numbers.json` (each
IMSI's number, kept 30 days while the phone is away). Both are written at
most once a second after a change, and on `docker stop` (SIGTERM).

The log goes to stdout only (`docker logs pmb887x-gsmrelay`; compose keeps
5 × 10 MB). It has every phone's IMSI and number, and the text of every SMS
and USSD request: treat it as personal data, and tell the people using the
site.

## Security notes

- The relay authenticates nobody: whoever reaches `/gsmrelay` can claim any
  IMSI, and with it that IMSI's number and balance. A page's IMSI has 10
  random digits, so guessing one is impractical; but a number is first
  offered by the IMSI's last 4 digits, so someone can pick an IMSI that
  ends in a number nobody holds yet, or one whose 30-day reservation in
  `numbers.json` has lapsed.
- The Origin check keeps other sites' pages out; any non-browser client can
  send whatever Origin it likes.
- The container runs read-only as uid 1000 with no capabilities, on an
  internal network with `pmb887x-web` only: no `VIRTUAL_HOST`, no published
  port, no way out to the Internet.
