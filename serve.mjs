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
// An upgrade listener that throws ends the process (an upgrade to "//" did):
// whatever goes wrong here only drops that connection.
const proxyGprs = (req, socket, head) => {
  try {
    if (new URL(req.url, "http://x").pathname !== "/gprs") return socket.destroy();
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

const httpServer = http.createServer((req, res) => {
  if (cert && redirectNonLoopbackToHttps(req, res)) return;
  serve(req, res);
});
httpServer.on("upgrade", proxyGprs);
httpServer.listen(port, "0.0.0.0");

if (cert) {
  const httpsServer = https.createServer({ key: cert.key, cert: cert.cert }, serve);
  httpsServer.on("upgrade", proxyGprs);
  httpsServer.listen(httpsPort, "0.0.0.0");
}

const urls = lanIPs().map((ip) => `https://${ip}:${httpsPort}`).join("  ");
console.log(`qemu-pmb887x web: http://127.0.0.1:${port}  (serving ${root})`);
if (cert)
  console.log(
    `  from other devices (phone/LAN): ${urls || `https://<lan-ip>:${httpsPort}`}` +
      ` — self-signed cert, accept the browser warning once`,
  );
