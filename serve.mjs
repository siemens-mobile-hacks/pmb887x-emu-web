#!/usr/bin/env node
// Static file server for the qemu-pmb887x wasm emulator page.
//
// Cross-origin isolation headers (COOP+COEP) are mandatory: the emulator is
// built with pthreads (SharedArrayBuffer). Browsers only honor those headers
// on secure contexts, so besides plain http (fine for 127.0.0.1/localhost)
// an https server is started for access from other devices (e.g. a phone on
// the LAN) — non-loopback http requests are redirected there.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { open, rename, stat as statP, unlink, utimes } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { extname, join, normalize, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

// The whole page lives under site/ — editable static files at the top,
// build artifacts (qemu wasm/js, boards.tar) in site/dist/ — so files can
// be edited in place and served as-is, no build/copy step for them.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.WEB_SITE_DIR || here + "/site");
const port = Number(process.env.PORT || 8080);
const httpsPort = Number(process.env.HTTPS_PORT || 6808);
for (const [name, p] of [["PORT", port], ["HTTPS_PORT", httpsPort]]) {
  if (!Number.isInteger(p) || p < 0 || p > 65535)
    throw new Error(`${name} must be 0..65535 (TCP ports cap at 65535), got ${p}`);
}
const httpsEnabled = process.env.HTTPS !== "0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".webp": "image/webp",
  ".tar": "application/x-tar",
  ".json": "application/json",
};

function lanIPs() {
  return [
    ...new Set(
      Object.values(os.networkInterfaces())
        .flat()
        .filter((i) => i && i.family === "IPv4" && !i.internal)
        .map((i) => i.address),
    ),
  ];
}

// Self-signed cert covering every current LAN IP; regenerated when the
// machine's addresses change (docker/dhcp). Browsers will show a warning
// that must be accepted once — that still yields a secure context.
function ensureCert() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), ".serve-cert");
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const ips = ["127.0.0.1", ...lanIPs()];
  const covers = () => {
    if (!existsSync(keyPath) || !existsSync(certPath)) return false;
    const text = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-text"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return ips.every((ip) => text.includes(`IP Address:${ip}`));
  };
  if (!covers()) {
    mkdirSync(dir, { recursive: true });
    const san = ips.map((ip) => `IP:${ip}`).concat("DNS:localhost").join(",");
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
        "-keyout", keyPath, "-out", certPath,
        "-subj", "/CN=qemu-pmb887x-dev",
        "-addext", `subjectAltName=${san}`,
      ],
      { stdio: "ignore" },
    );
    writeFileSync(join(dir, "README.txt"), "throwaway self-signed cert for LAN https — safe to delete\n");
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

const isLoopbackAddr = (addr) => !addr || /^(127\.|::1$|::ffff:127\.)/.test(addr);
// A Host the browser treats as a secure context over plain http: localhost,
// its subdomains, 127/8 and [::1]. Behind a port mapping (Docker) the
// socket's peer is the bridge, so the name the browser used is what counts.
function isLoopbackHost(host) {
  const name = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return name === "localhost" || name.endsWith(".localhost") || /^127\./.test(name) || name === "::1";
}

// The ~12 MB wasm dominates page-load time on slow links (phone/LAN use),
// so keep a pre-gzip'd sidecar next to it (~4 MB, ~3x smaller) and
// regenerate it when the source changes (ninja-fast redeploys). One
// compressor per file, shared by concurrent requests. GZIP=0 disables.
//
// A sidecar is fresh when its mtime equals its source's: the compressor
// stamps it with the mtime of the file it read, so a source deployed while
// it ran never matches it, and one replaced since is caught by a re-stat
// before the rename. Equal to the millisecond, as utimes() rounds.
const sameMtime = (a, b) => Math.abs(a.mtimeMs - b.mtimeMs) < 1;
const gzInflight = new Map();

async function compressSidecar(path, gz) {
  // per process: another serve.mjs on the same site dir compresses too
  const tmp = `${gz}.${process.pid}.tmp`;
  let src = null;
  try {
    src = await open(path, "r");
    const st = await src.stat();
    // tmp+rename so a partial sidecar is never served
    await pipeline(src.createReadStream({ autoClose: false }), createGzip({ level: 6 }),
      createWriteStream(tmp));
    await utimes(tmp, st.atime, st.mtimeMs / 1000);
    const now = await statP(path);
    if (now.ino !== st.ino || now.size !== st.size || !sameMtime(now, st)) {
      await unlink(tmp);   // the source changed under the compressor
      return;
    }
    await rename(tmp, gz);
  } catch {
    await unlink(tmp).catch(() => {});
  } finally {
    await src?.close().catch(() => {});
  }
}

// -> { fh, st } of a sidecar fresh for a source with stat `srcSt`, or null
async function gzSidecar(path, srcSt) {
  if (process.env.GZIP === "0") return null;
  const gz = path + ".gz";
  const openFresh = async () => {
    let fh = null;
    try {
      fh = await open(gz, "r");
      const st = await fh.stat();
      if (st.isFile() && sameMtime(st, srcSt)) return { fh, st };
    } catch { /* no sidecar */ }
    await fh?.close().catch(() => {});
    return null;
  };
  const hit = await openFresh();
  if (hit) return hit;
  let done = gzInflight.get(gz);
  if (!done) {
    done = compressSidecar(path, gz).finally(() => gzInflight.delete(gz));
    gzInflight.set(gz, done);
  }
  await done;
  return openFresh();
}

const notFound = (res) => {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
};

async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  let path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  if (url.pathname === "/") path = join(root, "index.html");
  // the page asks whether this server has a GSM relay (site/gsm-relay.js)
  if (url.pathname === "/gsmrelay") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ relay: !!gsmRelay }));
    return;
  }

  // Everything below reads the one file it opened here (or the sidecar it
  // opened instead): a deploy that replaces the file mid-request cannot
  // make the headers and the body disagree.
  let fh, st;
  try {
    fh = await open(path, "r");
    st = await fh.stat();
  } catch {
    await fh?.close();
    return notFound(res);
  }
  if (!st.isFile()) { await fh.close(); return notFound(res); }

  // Prefer the pre-gzip'd sidecar for the wasm (see gzSidecar above).
  let gzipped = false;
  if (extname(path) === ".wasm" && (req.headers["accept-encoding"] || "").includes("gzip")) {
    const side = await gzSidecar(path, st).catch(() => null);
    if (side) {
      await fh.close();
      ({ fh, st } = side);
      gzipped = true;
    }
  }

  const headers = {
    "content-type": MIME[extname(path)] || "application/octet-stream",
    // require-corp (not credentialless): Safari supports only require-corp,
    // and this page loads same-origin resources exclusively.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    // no-cache + a strong ETag: every visit revalidates (dev-friendly — a
    // redeployed dist is always picked up), and unchanged files come back
    // as 304s served from the HTTP cache. That also lets Chromium keep and
    // reuse its wasm code cache for qemu-system-arm.wasm on repeat visits
    // (streaming-compiled modules only), skipping the multi-second Liftoff
    // compile of the ~12 MB module — and the cached code includes whatever
    // TurboFan had tiered up, i.e. the V8 warm-up too.
    "cache-control": "no-cache",
    etag: etagOf(st),
  };
  if (extname(path) === ".wasm") headers["vary"] = "accept-encoding";
  if (req.headers["if-none-match"] === headers.etag) {
    await fh.close();
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (gzipped) headers["content-encoding"] = "gzip";
  headers["content-length"] = st.size;
  res.writeHead(200, headers);
  // headers are out by now: a read that fails mid-request can only cut the
  // response short; a client that goes away closes the file
  pipeline(fh.createReadStream({ start: 0 }), res).catch(() => {});
}

// A rejected handler would otherwise be an unhandled rejection, which ends
// the process: one malformed URL took the whole server down.
function serve(req, res) {
  handler(req, res).catch((e) => {
    const bad = e instanceof URIError || e?.code === "ERR_INVALID_URL";
    if (!res.headersSent) res.writeHead(bad ? 400 : 500);
    res.end();
  });
}

function etagOf(st) {
  return `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

const redirectNonLoopbackToHttps = (req, res) => {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (host && !isLoopbackAddr(req.socket.remoteAddress) && !isLoopbackHost(host)) {
    res.writeHead(302, { location: `https://${host}:${httpsPort}${req.url}` });
    res.end();
    return true;
  }
  return false;
};

let cert = null;
if (httpsEnabled) {
  try {
    cert = ensureCert();
  } catch (e) {
    console.warn(`https disabled, serving http only: ${e.code === "ENOENT" ? "openssl not found" : e.message}`);
  }
}

// The phone's GPRS goes to a GPRS gateway (bts-emulator's gprs-gw) over a
// WebSocket at /gprs, as nginx passes it in the deployment.
const [gwHost, gwPort] = (process.env.GPRS_GW || "127.0.0.1:5751").split(":");

// Is the upgrade from a page of this server? Its Origin must name the host
// the request was sent to: the Host header, or X-Forwarded-Host behind a
// proxy that rewrites Host (a page can set neither on a WebSocket). The
// scheme is not compared: behind a TLS front the page is https and this
// listener http. A Host without a port means the origin scheme's default.
function sameOrigin(req) {
  let o;
  try { o = new URL(req.headers.origin); } catch { return false; }
  if (o.protocol !== "http:" && o.protocol !== "https:") return false;
  const port = o.port || (o.protocol === "https:" ? "443" : "80");
  const hosts = [req.headers.host, ...String(req.headers["x-forwarded-host"] ?? "").split(",")];
  return hosts.some((h) => {
    const m = String(h ?? "").trim().toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    return !!m && m[1] === o.hostname && (m[2] ?? port) === port;
  });
}

const isWebSocket = (req) => /^websocket$/i.test(String(req.headers.upgrade ?? "").trim());
const refuse = (socket, status) => socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);

// An upgrade listener that throws ends the process (an upgrade to "//" did):
// whatever goes wrong here only drops that connection.
const proxyGprs = (req, socket, head) => {
  try {
    // only reached by a non-WebSocket upgrade on a node without
    // shouldUpgradeCallback (below), which serves those as plain requests
    if (!isWebSocket(req)) return refuse(socket, "400 Bad Request");
    if (new URL(req.url, "http://x").pathname !== "/gprs") return refuse(socket, "404 Not Found");
    // another site's page must not use this host's gateway
    if (!sameOrigin(req)) return refuse(socket, "403 Forbidden");
    const gw = net.connect(Number(gwPort), gwHost, () => {
      const headers = { ...req.headers, "x-forwarded-for": req.socket.remoteAddress };
      gw.write(`GET /gprs HTTP/1.1\r\n` +
        Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n");
      gw.write(head);
      socket.pipe(gw).pipe(socket);
    });
    gw.on("error", () => socket.destroy());
    socket.on("error", () => gw.destroy());
  } catch {
    socket.destroy();
  }
};

// The virtual network's services (doc/gsm-relay.md): qemu's cell in the page
// talks the relay server's byte protocol, carried in binary WebSocket
// messages to /gsmrelay and piped here to the relay's TCP port
// (GSM_RELAY=host:port; unset = no relay, the page leaves the option off).
// The relay speaks plain TCP, so this end is the WebSocket server itself:
// RFC 6455 framing, binary/continuation, ping, close; no extensions.
const gsmRelay = (() => {
  if (!process.env.GSM_RELAY) return null;
  const m = process.env.GSM_RELAY.match(/^(?:\[([^\]]+)\]|([^:]*)):(\d{1,5})$/);
  if (!m || !(Number(m[3]) >= 1 && Number(m[3]) <= 65535)) {
    console.error(`serve.mjs: GSM_RELAY must be host:port or [ipv6]:port, not "${process.env.GSM_RELAY}"`);
    process.exit(2);
  }
  return { host: m[1] ?? (m[2] || "127.0.0.1"), port: Number(m[3]) };
})();
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_MAX = 1 << 20;   // a page sends a few KB at a time
const RELAY_CONNECT_MS = 10000;
// The relay sees every page as this host's loopback, which its own
// per-address limit exempts: the limit is kept here, by the page's address,
// or one client could take all of the relay's MAX_PHONES (64) connections.
const RELAY_PER_ADDR = 8;   // relay.py's MAX_PER_IP
const relayLinks = new Map();   // remote address -> open relay WebSockets

function wsFrame(op, data) {
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n])
    : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, data]);
}

const proxyGsmRelay = (req, socket, head) => {
  if (!gsmRelay) return refuse(socket, "404 Not Found");
  if (!sameOrigin(req)) return refuse(socket, "403 Forbidden");
  const key = String(req.headers["sec-websocket-key"] ?? "");
  if (!key) return refuse(socket, "400 Bad Request");
  const addr = String(req.socket.remoteAddress);
  if ((relayLinks.get(addr) ?? 0) >= RELAY_PER_ADDR) return refuse(socket, "429 Too Many Requests");
  relayLinks.set(addr, (relayLinks.get(addr) ?? 0) + 1);
  socket.once("close", () => {
    const n = relayLinks.get(addr) - 1;
    if (n > 0) relayLinks.set(addr, n);
    else relayLinks.delete(addr);
  });
  const relay = net.connect(gsmRelay.port, gsmRelay.host);
  relay.setNoDelay(true);
  socket.setNoDelay(true);
  let rx = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  let up = false, closing = false;
  const close = () => { relay.destroy(); socket.destroy(); };
  // the page's frames wait in the paused socket until the relay answers
  socket.pause();
  const late = setTimeout(() => { relay.destroy(); refuse(socket, "504 Gateway Timeout"); }, RELAY_CONNECT_MS);
  relay.on("connect", () => {
    clearTimeout(late);
    up = true;
    socket.resume();
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (rx.length) onData(Buffer.alloc(0));
  });
  // Backpressure both ways, nothing buffered here without bound: a page that
  // does not read (a stalled tab) pauses the relay socket, and the relay's own
  // per-phone queue then drops late speech and, if it stays stuck, the phone;
  // a relay that does not read pauses the page.
  relay.on("data", (d) => { if (!socket.write(wsFrame(2, d))) relay.pause(); });
  socket.on("drain", () => relay.resume());
  relay.on("drain", () => socket.resume());
  relay.on("error", () => { clearTimeout(late); return up ? close() : refuse(socket, "502 Bad Gateway"); });
  // one close frame per side: the relay's end after the page's close is not another
  const endWith = (frame) => { if (!closing) { closing = true; socket.end(frame); } };
  relay.on("close", () => { if (up) endWith(wsFrame(8, Buffer.from([0x03, 0xe8]))); });
  socket.on("error", close);
  // the HTTP server's sockets are half-open: a page gone without a close
  // frame (a FIN only) would keep this socket and the relay's link open
  socket.on("end", close);
  socket.on("close", () => { clearTimeout(late); relay.destroy(); });
  const onData = (d) => {
    if (closing) return;
    rx = rx.length ? Buffer.concat([rx, d]) : d;
    for (;;) {
      if (rx.length < 2) return;
      const op = rx[0] & 15, masked = rx[1] & 128;
      let n = rx[1] & 127, at = 2;
      if (n === 126) { if (rx.length < 4) return; n = rx.readUInt16BE(2); at = 4; }
      else if (n === 127) { if (rx.length < 10) return; n = Number(rx.readBigUInt64BE(2)); at = 10; }
      if (!masked || n > WS_MAX) return close();
      if (rx.length < at + 4 + n) return;
      const mask = rx.subarray(at, at + 4);
      const data = Buffer.from(rx.subarray(at + 4, at + 4 + n));
      for (let i = 0; i < n; i++) data[i] ^= mask[i & 3];
      rx = rx.subarray(at + 4 + n);
      if (op === 0 || op === 2) { if (!relay.write(data)) socket.pause(); }
      else if (op === 8) { relay.end(); endWith(wsFrame(8, data.subarray(0, 2))); return; }
      else if (op === 9) socket.write(wsFrame(10, data));
    }
  };
  socket.on("data", onData);
};

const onUpgrade = (req, socket, head) => {
  // node takes its own error listener off an upgraded socket: without one a
  // reset (a page closed while refused or connecting) ends the process
  socket.on("error", () => socket.destroy());
  try {
    if (isWebSocket(req) && new URL(req.url, "http://x").pathname === "/gsmrelay") {
      return proxyGsmRelay(req, socket, head);
    }
  } catch {
    return socket.destroy();
  }
  proxyGprs(req, socket, head);
};

// Any other Upgrade (h2c) is ignored, as HTTP/1.1 allows: the request is
// answered as a plain one.
let httpsUp = false;   // the redirect needs an https listener to go to
const httpServer = http.createServer({ shouldUpgradeCallback: isWebSocket }, (req, res) => {
  if (httpsUp && redirectNonLoopbackToHttps(req, res)) return;
  serve(req, res);
});
httpServer.on("upgrade", onUpgrade);
httpServer.on("error", (e) => {
  console.error(`serve.mjs: cannot serve http on port ${port}: ${e.code === "EADDRINUSE" ? "the port is in use" : e.message}`);
  process.exit(1);
});
httpServer.listen(port, "0.0.0.0", () =>
  console.log(`qemu-pmb887x web: http://127.0.0.1:${port}  (serving ${root})`));

// https is for other devices only: a port that is taken (another serve.mjs
// runs) leaves this one serving http
if (cert) {
  const httpsServer = https.createServer(
    { key: cert.key, cert: cert.cert, shouldUpgradeCallback: isWebSocket }, serve);
  httpsServer.on("upgrade", onUpgrade);
  httpsServer.on("error", (e) => {
    console.warn(`https disabled, serving http only: port ${httpsPort}: ` +
      `${e.code === "EADDRINUSE" ? "in use (HTTPS_PORT picks another, HTTPS=0 turns https off)" : e.message}`);
  });
  httpsServer.listen(httpsPort, "0.0.0.0", () => {
    httpsUp = true;
    const urls = lanIPs().map((ip) => `https://${ip}:${httpsPort}`).join("  ");
    console.log(
      `  from other devices (phone/LAN): ${urls || `https://<lan-ip>:${httpsPort}`}` +
        ` — self-signed cert, accept the browser warning once`,
    );
  });
}
