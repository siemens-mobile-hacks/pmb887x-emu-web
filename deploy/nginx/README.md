# Deploying the emulator page behind perk11/nginx-proxy

Three moving parts:

| piece | what it is |
|---|---|
| `scripts/bundle-dist.sh` | assembles the self-contained bundle in `<repo>/dist` (gitignored) |
| `Dockerfile` + `site.conf` | `nginx:stable-alpine` image serving that bundle with the same headers/contract as `serve.mjs` |
| `docker-compose.yml` | runs it on the external `nginx-proxy` network with `VIRTUAL_HOST` env, so the front (jwilder/nginx-proxy + letsencrypt companion) picks it up; with profile `gprs`, also the GPRS gateway (`../gprs-gw`) |

## 1. Bundle

```bash
scripts/bundle-dist.sh          # → dist/ (see -- usage header for flags)
```

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
engine `dist-jit/qemu-system-arm.{js,wasm}`. Every text and wasm file
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

Then, from `deploy/nginx/` here:

```bash
VIRTUAL_HOST=emu.example.org \
LETSENCRYPT_HOST=emu.example.org \
LETSENCRYPT_EMAIL=you@example.org \
  docker compose up -d --build
```

(or put those in `deploy/nginx/.env`, which is gitignored).  TLS is
terminated at the front; http→https redirects appear automatically once
the cert is issued.

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
  `gprs` network only, so the front never routes to it.
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
(`deploy/gprs-gw`). It is the compose profile `gprs`: add
`COMPOSE_PROFILES=gprs` to `.env`, with a bts-emulator checkout of branch
`gprs-gw` next to this repository (or at `BTS_EMULATOR`), and
`docker compose up -d --build`. `deploy/gprs-gw/README.md` has its settings
(origins, trusted proxies, limits), networking and security notes.

The alternative is bts-emulator's full stack with its `compose.web.yaml` and
the same host name: the front then routes `/gprs` there (`VIRTUAL_PATH`),
past this container. Use one or the other. Without either the emulator runs
as before, only without Internet on the phone (`/gprs` answers 502).

## 3. Standalone (no proxy mesh)

```bash
scripts/bundle-dist.sh
docker build -t pmb887x-web -f deploy/nginx/Dockerfile .
docker run --rm -p 8080:80 pmb887x-web     # http://localhost:8080
```

Same caveat as `serve.mjs`: browsers ignore COOP/COEP on plain http for
anything but localhost, so cross-origin isolation (and therefore the
emulator) only works via `http://localhost…` or via the front's TLS —
not over `http://<lan-ip>:8080`.

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
front does the same, see "What the front is").

## Re-deploys

Re-run `scripts/bundle-dist.sh`, then `docker compose up -d --build`.
The `COPY dist/` layer is rebuilt whenever the bundle changes; clients
revalidate (`no-cache` + ETag), so new content is live on the next
reload while unchanged files keep their caches.

The repo-root `.dockerignore` keeps the build context to `dist/` +
`deploy/nginx/` — the qemu submodule and toolchains never reach the
docker daemon.
