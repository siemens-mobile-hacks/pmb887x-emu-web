# Deploying the emulator page behind perk11/nginx-proxy

The moving parts:

| piece | what it is |
|---|---|
| `scripts/bundle-dist.sh` | assembles the self-contained bundle in `<repo>/dist` (gitignored) |
| `Dockerfile` + `site.conf` | `nginx:stable-alpine` image serving that bundle with the same headers/contract as `serve.mjs` |
| `docker-compose.yml` | runs it on the external `nginx-proxy` network with `VIRTUAL_HOST` env, so the front (jwilder/nginx-proxy + letsencrypt companion) picks it up, the GPRS gateway (`../gprs-gw`) and the virtual network's relay (`../gsmrelay`) |
| `docker-compose.lan.yml` + `lan-tls.sh` | LAN mode instead of the front: https with a self-signed certificate on a published port (section 4) |

## 1. Bundle

```bash
scripts/bundle-dist.sh          # → dist/ (see -- usage header for flags)
```

`./build.sh` runs it as its last step; after `scripts/ninja-fast.sh` or
another partial rebuild, run it yourself before deploying `dist/`.

Ships exactly what the page loads. The list is `page` and `images` at
the top of `scripts/bundle-dist.sh`, which refuses to bundle while a
tracked file under `site/` (outside `site/dist*`) is missing from it:
`index.html`, `style.css`, `app.js` and the modules it imports
(`boards.js`, `exit-report.js`, `otp.js`, `ua.js`, `keyboards.js`,
`fullflashes.js`, `siemensfw.js`, `recalc.js`, `gprs-net.js`,
`gsm-badge.js`),
`recalc-worker.js` (the ESN sweep's workers), `audio-worklet.js`
(drained by the AudioWorklet — leave it out and the page is silent) and
`img/ke970-wheel.webp`; then `dist/boards.tar` and the Siemens key module
`dist/siemens-recalc.{js,wasm}` (always fetched from `dist/`) and the
engine `dist/qemu-system-arm.{js,wasm}`. Every text and wasm file
gets a `.gz` sidecar (the ~12 MB wasm ships as ~4 MB), and
`manifest.sha256` covers every file — `cd dist && sha256sum -c
manifest.sha256` verifies a copy/deploy.  Dev-only extras
(`.symbols` maps, tcgisa/tcgbench images) are excluded unless
`BUNDLE_SYMBOLS=1` / `BUNDLE_TESTS=1`.

## 2. Behind the proxy front

One-time on the front (from the [perk11/nginx-proxy](https://github.com/perk11/nginx-proxy)
README):

```bash
docker network create nginx-proxy
docker compose up -d            # in that repo (the proxy itself)
docker run -d --name nginx-letsencrypt --restart=always \
  -v /data/certificates:/etc/nginx/certs:rw \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --volumes-from nginx-proxy jrcs/letsencrypt-nginx-proxy-companion
```

Then check out the GPRS gateway's and the relay's submodules once
(`../gprs-gw/README.md`, "Where the source comes from") and, from
`deploy/nginx/` here:

```bash
git submodule update --init ../gprs-gw/bts-emulator ../../gsmrelay
VIRTUAL_HOST=emu.example.org \
LETSENCRYPT_HOST=emu.example.org \
LETSENCRYPT_EMAIL=you@example.org \
  docker compose up -d --build
```

(or put those in `deploy/nginx/.env`, which is gitignored).  TLS is
terminated at the front; http→https redirects appear automatically once
the cert is issued.

Both compose files and both Dockerfiles also work with the legacy
`docker-compose` v1 (1.27 or newer, for files without `version:`) and its
classic builder: no named build contexts, no `!reset`, no nested
`${A:-${B}}`, no BuildKit-only Dockerfile flags. Keep it that way.

### What the front is

perk11/nginx-proxy is not a fork of nginx-proxy's code. It is a compose
file whose image is upstream's release `jwilder/nginx-proxy:1.11.6-alpine`
plus one `conf.d` file (`client_max_body_size 100m`) and one container
label of its own, `com.github.perk11.nginx-proxy.proxy-timeout` (below),
with the Let's Encrypt companion (`jrcs/letsencrypt-nginx-proxy-companion`)
started next to it with `docker run --volumes-from nginx-proxy`. So the
template is upstream's `nginx.tmpl` with that label patched in. The points
below hold for upstream's template as of 2025-03 and 2026-11; the 2018
template differs only where noted.

- **Discovery:** docker-gen picks up `VIRTUAL_HOST` and `VIRTUAL_PORT`
  (80) from `pmb887x-web` and proxies to its address on the network it
  shares with the front, the external `nginx-proxy` network (`expose`,
  no published port). `VIRTUAL_PROTO` stays the default `http`. The gateway has no `VIRTUAL_HOST` and is on the stack's
  `gprs` network only, so the front never routes to it; the same goes for
  the relay and its `gsmrelay` network.
- **TLS:** `LETSENCRYPT_HOST` and `LETSENCRYPT_EMAIL` are read by the
  companion, not the proxy. The front then redirects http to https and
  adds `Strict-Transport-Security: max-age=31536000`.
- **Headers:** the front passes this nginx's response headers untouched,
  so COOP/COEP and the others arrive once. It does not compress (`gzip` is
  off in its `nginx.conf`; the template only sets `gzip_types`), so the
  `.gz` sidecars and their `Content-Length` arrive as sent. Towards this
  nginx it sends `Host` (the requested host), `Upgrade` and
  `Connection: upgrade` for WebSockets over HTTP/1.1, and appends the
  client to `X-Forwarded-For`, which is why the gateway counts two
  trusted proxies (`../gprs-gw/README.md`). It forwards client-supplied
  `X-Forwarded-Proto` and `X-Forwarded-Host` unchanged
  (`TRUST_DOWNSTREAM_PROXY`, default true, from 2022 on); nothing here
  reads them.
- **HTTP/2** is on at the front by default and serves the page and its
  downloads. nginx does not offer WebSockets over HTTP/2 (RFC 8441) or
  HTTP/3, so browsers open `wss://<host>/gprs` as an HTTP/1.1 connection
  of its own, which the front upgrades. `ENABLE_HTTP3=true` on the front
  changes nothing for this site.
- **Limits:** no request here has a body, so `client_max_body_size` does
  not matter. The front buffers responses (nginx's default; templates
  before 1.5.0 turned it off), which is harmless for the 4 MB wasm either
  way; upgraded WebSockets are never buffered.
- **Timeouts:** upstream's template sets none, so nginx's default 60 s
  `proxy_read_timeout` would close a `/gprs` link after a minute without
  traffic, dropping the phone's open TCP connections long before the
  gateway's own 15-minute idle close. So `docker-compose.yml` gives
  `pmb887x-web` the label `com.github.perk11.nginx-proxy.proxy-timeout:
  "960s"`, and perk11/nginx-proxy then sets `proxy_read_timeout` and
  `proxy_send_timeout` to 960 s in this container's location block, for
  whatever host name `VIRTUAL_HOST` gives it, and for no other site. The
  front ignores a value that is not a number with an optional `s`, `m` or
  `h`. Its image must be built from a version that has the label (rebuild
  it with `docker-compose up -d --build` in that repo); check with
  `docker exec nginx-proxy nginx -T 2>/dev/null | grep -n proxy_read_timeout`.

  A stock nginx-proxy, or any other front, ignores the label, and its idle
  `/gprs` links end after its own timeout (60 s for nginx-proxy). Raise
  it there for this host your own way: on nginx-proxy, a
  `vhost.d/<VIRTUAL_HOST>_location` file holding
  `proxy_read_timeout 960s;` and `proxy_send_timeout 960s;`, which docker-gen
  picks up when it next renders (for example after
  `docker restart pmb887x-web`).

### The phone's Internet

The page relays the phone's GPRS to `wss://<host>/gprs`, which `site.conf`
passes to bts-emulator's GPRS gateway in the `pmb887x-gprs-gw` container
(`deploy/gprs-gw`), which `docker compose up -d --build` builds and starts
with the page, from the `deploy/gprs-gw/bts-emulator` submodule (branch
`gprs-gw`). `deploy/gprs-gw/README.md`
has its settings (origins, trusted proxies, limits), networking and security
notes. While the gateway is down the emulator runs as before, only without
Internet on the phone (`/gprs` answers 502).

Do not also run bts-emulator's full stack with its `compose.web.yaml` for the
same host name: the front would then route `/gprs` there (`VIRTUAL_PATH`),
past this container.

### The virtual network

SMS, calls and USSD between the pages (`../../doc/gsm-relay.md`) go to
`wss://<host>/gsmrelay`, which `site.conf` passes to the relay in the
`pmb887x-gsmrelay` container (`deploy/gsmrelay`), built and started with the
page from the `gsmrelay` submodule. The relay serves that WebSocket itself
(no `serve.mjs` here) and answers the page's plain `GET /gsmrelay` with
`{"relay": true}`, which is what makes the page offer its "Online GSM
network" option. `deploy/gsmrelay/README.md` has its settings (origins,
trusted proxies, limits), state and security notes. While the relay is down
`/gsmrelay` answers 502 and the page leaves the option hidden; a page already
running redials every 1-30 s.

The relay is on the internal `gsmrelay` network with `pmb887x-web` only: no
`VIRTUAL_HOST`, no published port, no way out. Never give it a
`VIRTUAL_HOST`: the front would route to it directly, past `site.conf`, and
`GSMRELAY_TRUSTED_PROXIES=2` would then let a client choose its own address.

## 3. Standalone (no proxy mesh)

```bash
scripts/bundle-dist.sh
docker build -t pmb887x-web -f deploy/nginx/Dockerfile .
docker run --rm -p 8080:80 pmb887x-web     # http://localhost:8080
```

Same caveat as `serve.mjs`: browsers ignore COOP/COEP on plain http for
anything but localhost, so cross-origin isolation (and therefore the
emulator) only works via `http://localhost…` or via the front's TLS —
not over `http://<lan-ip>:8080`. For other machines use LAN mode (section 4).

## 4. LAN (no front, self-signed https)

The page, the GPRS gateway and the relay for the machines on your network,
without the front, a domain or Let's Encrypt:

```bash
scripts/bundle-dist.sh        # once: the image build copies dist/
git submodule update --init deploy/gprs-gw/bts-emulator gsmrelay
cd deploy/nginx
docker compose -f docker-compose.yml -f docker-compose.lan.yml up -d --build
# open https://<lan-ip>:8443 and accept the certificate warning once
```

To make it the default for this directory, put
`COMPOSE_FILE=docker-compose.yml:docker-compose.lan.yml` in `.env`; then a
plain `docker compose up -d --build` uses it.

`docker-compose.lan.yml` on top of the normal stack:

- publishes `pmb887x-web`'s port 443 on `LAN_ADDRESS:LAN_HTTPS_PORT`
  (default `0.0.0.0:8443`), and nothing on plain http;
- mounts `site/` read-only as the webroot instead of the image's bundle, so
  the page is always the latest build, as `serve.mjs` serves it: a rebuild
  shows on the next reload, without `bundle-dist.sh` or an image rebuild.
  `LAN_SITE_DIR` picks another directory (`../../dist` for the bundle).
  `gzip_static` is off, since `serve.mjs` only refreshes `site/`'s `.gz`
  sidecars when it serves them; nginx compresses on the fly instead. The
  image build still copies `dist/`, so it must exist once;
- sets `LAN_TLS=1`, so `lan-tls.sh` (run by the image's entrypoint) adds
  `listen 443 ssl` to `site.conf` with a self-signed certificate. The
  certificate is kept in the `lan-cert` volume and regenerated only when
  `LAN_HOSTS` changes, so browsers keep their exception across rebuilds.
  `LAN_HOSTS` (comma separated names and addresses, e.g.
  `192.168.1.10,emu.lan`) only adds them to the certificate; self-signed, it
  needs the browser's exception either way;
- replaces the external `nginx-proxy` network with an ordinary one
  (`pmb887x-web-lan`), and
  empties `VIRTUAL_HOST` and `LETSENCRYPT_HOST`, so a front running on the
  same Docker host ignores the container;
- runs the gateway with `GPRS_GW_TRUSTED_PROXIES=1` (only `pmb887x-web` in
  front) and `GPRS_GW_ORIGINS` empty (any origin, since the page's origin
  is whatever LAN address it is opened at). Set `GPRS_GW_ORIGINS` in `.env`
  to `https://<lan-ip>:8443` to restrict it;
- runs the relay with `GSMRELAY_TRUSTED_PROXIES=1` and `GSMRELAY_ORIGINS`
  empty, which for the relay means the page's own origin as its `Host`
  header names it, port included, whatever LAN address it is opened at.

Without `LAN_TLS`, `lan-tls.sh` does nothing and the image is the
front's plain port-80 server as before.

Anyone who can reach the port gets the page and, through the gateway, a
NATed way out to the Internet from this host (`../gprs-gw/README.md`).
Set `LAN_ADDRESS` to one interface's address, or firewall the port, if the
host is on more than the LAN.

## What `site.conf` sends, and why

| header | value | why |
|---|---|---|
| `Cross-Origin-Opener-Policy` | `same-origin` | cross-origin isolation for SharedArrayBuffer/pthreads — mandatory for the emulator |
| `Cross-Origin-Embedder-Policy` | `require-corp` | as above; `require-corp` (not `credentialless`) because Safari supports only that, and this page loads same-origin resources exclusively |
| `Cross-Origin-Resource-Policy` | `same-origin` | explicit; everything the page loads is same-origin |
| `Cache-Control` | `no-cache` | every visit revalidates: a redeployed bundle is picked up on the next reload, unchanged files stay 304-cached — and Chromium keeps its wasm code cache for `qemu-system-arm.wasm` (incl. TurboFan tier-up) |
| `ETag` | size+mtime (nginx default) | the revalidation anchor for the above |
| `Vary` | `Accept-Encoding` | identity vs `.gz` is chosen per request (one explicit header, sidecar or not) |
| `X-Content-Type-Options` | `nosniff` | hygiene |
| `X-Frame-Options` | `SAMEORIGIN` | hygiene |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | hygiene |

Plus mechanics: `gzip_static on` serves the bundle's `.gz` sidecars
(zero CPU at request time), `gzip on` as fallback; an explicit `types`
map keeps `.wasm` → `application/wasm` (required for streaming
compilation) and `.tar`/`.mjs` correct regardless of the base image;
`charset utf-8` for the text types; range requests on (default) for the
big downloads. `location = /gprs` proxies the WebSocket upgrade to
`pmb887x-gprs-gw:5751` (looked up per request through Docker's DNS, so
nginx starts without it), appends the peer to `X-Forwarded-For`, and keeps
an idle link for 960 s, past the gateway's own 15-minute idle close (the
front does the same, see "What the front is"). `location = /gsmrelay` does
the same for `pmb887x-gsmrelay:4726`, plain GET included, and passes
`Host` with its port (`$http_host`), which the relay's Origin check
compares.

## Re-deploys

Re-run `scripts/bundle-dist.sh`, then `docker compose up -d --build`.
The `COPY dist/` layer is rebuilt whenever the bundle changes; clients
revalidate (`no-cache` + ETag), so new content is live on the next
reload while unchanged files keep their caches.

The repo-root `.dockerignore` keeps the build context to `dist/`,
`deploy/nginx/`, `deploy/gsmrelay/`, and the relay's `relay.py` and
`clip/` — the qemu submodule and toolchains never reach the docker daemon,
nor a local relay run's `balances.json`, `numbers.json` or `relay.log`.
After changing `relay.py` (or updating the `gsmrelay` submodule), the same
`docker compose up -d --build` rebuilds the relay; its state stays in the
`gsmrelay-state` volume.
