# Deploying the emulator page behind perk11/nginx-proxy

Three moving parts:

| piece | what it is |
|---|---|
| `scripts/bundle-dist.sh` | assembles the self-contained bundle in `<repo>/dist` (gitignored) |
| `Dockerfile` + `site.conf` | `nginx:stable-alpine` image serving that bundle with the same headers/contract as `serve.mjs` |
| `docker-compose.yml` | runs it on the external `nginx-proxy` network with `VIRTUAL_HOST` env, so the front (jwilder/nginx-proxy + letsencrypt companion) picks it up |

## 1. Bundle

```bash
scripts/bundle-dist.sh          # → dist/ (see -- usage header for flags)
```

Ships exactly what the page loads (`site/app.js` knows the list):
`index.html`, `app.js`, `style.css`, `keyboards.js`, `fullflashes.js`,
`siemensfw.js`, `recalc.js`, `recalc-worker.js`, `audio-worklet.js`
(drained by the AudioWorklet — leave it out and the page is silent),
`dist/boards.tar` (always fetched from `dist/`), both engines
(`dist-jit/` — the page default — and `dist/` when a TCI build exists),
each with a `.gz` sidecar (the ~28 MB wasm ships as ~4 MB), plus
`manifest.sha256` covering every file — `cd dist && sha256sum -c
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
big downloads.

## Re-deploys

Re-run `scripts/bundle-dist.sh`, then `docker compose up -d --build`.
The `COPY dist/` layer is rebuilt whenever the bundle changes; clients
revalidate (`no-cache` + ETag), so new content is live on the next
reload while unchanged files keep their caches.

The repo-root `.dockerignore` keeps the build context to `dist/` +
`deploy/nginx/` — the qemu submodule and toolchains never reach the
docker daemon.
