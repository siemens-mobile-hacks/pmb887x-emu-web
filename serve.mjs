// Static file server for the qemu-pmb887x wasm emulator page.
//
// Cross-origin isolation headers (COOP+COEP) are mandatory: the emulator is
// built with pthreads (SharedArrayBuffer). Browsers only honor those headers
// on secure contexts, so besides plain http (fine for 127.0.0.1/localhost)
// an https server is started for access from other devices (e.g. a phone on
// the LAN) — non-loopback http requests are redirected there.
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync,
  statSync, writeFileSync,
} from "node:fs";
import { rename, stat as statP } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = resolve(process.env.WEB_DIST_DIR || (dirname(fileURLToPath(import.meta.url)) + "/dist"));
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

const isLoopback = (addr) => !addr || /^(127\.|::1$|::ffff:127\.)/.test(addr);

// The 45 MB wasm dominates page-load time on slow links (phone/LAN use), so
// keep a pre-gzip'd sidecar next to it (~4x smaller) and regenerate it when
// the source changes (ninja-fast redeploys). One compressor per file,
// shared by concurrent requests. GZIP=0 disables.
const gzInflight = new Map();
async function gzSidecar(path) {
  if (process.env.GZIP === "0") return null;
  const gz = path + ".gz";
  const fresh = async () => {
    try {
      const [src, side] = await Promise.all([statP(path), statP(gz)]);
      return side.mtimeMs >= src.mtimeMs;
    } catch {
      return false;
    }
  };
  if (await fresh()) return gz;
  let done = gzInflight.get(gz);
  if (!done) {
    done = pipeline(
      createReadStream(path),
      createGzip({ level: 6 }),
      // tmp+rename so a partial sidecar is never served
      createWriteStream(gz + ".tmp"),
    )
      .then(() => rename(gz + ".tmp", gz))
      .catch(() => null);
    gzInflight.set(gz, done);
    await done;
    gzInflight.delete(gz);
  } else {
    await done;
  }
  return (await fresh()) ? gz : null;
}

async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  let path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) { res.writeHead(403); res.end(); return; }
  if (url.pathname === "/") path = join(root, "index.html");
  if (!existsSync(path) || statSync(path).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  // Prefer the pre-gzip'd sidecar for the wasm (see gzSidecar above).
  let servePath = path;
  if (extname(path) === ".wasm" && (req.headers["accept-encoding"] || "").includes("gzip"))
    servePath = (await gzSidecar(path)) || path;

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
    // compile of the 45 MB module — and the cached code includes whatever
    // TurboFan had tiered up, i.e. the V8 warm-up too.
    "cache-control": "no-cache",
    etag: etagOf(servePath),
  };
  if (extname(path) === ".wasm") headers["vary"] = "accept-encoding";
  if (req.headers["if-none-match"] === headers.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (servePath !== path) headers["content-encoding"] = "gzip";
  headers["content-length"] = statSync(servePath).size;
  res.writeHead(200, headers);
  createReadStream(servePath).pipe(res);
}

function etagOf(p) {
  const st = statSync(p);
  return `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

const redirectNonLoopbackToHttps = (req, res) => {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (host && !isLoopback(req.socket.remoteAddress) && !isLoopback(host)) {
    res.writeHead(302, { location: `https://${host}:${httpsPort}${req.url}` });
    res.end();
    return true;
  }
  return false;
};

const cert = httpsEnabled ? ensureCert() : null;

const httpServer = http.createServer((req, res) => {
  if (httpsEnabled && redirectNonLoopbackToHttps(req, res)) return;
  handler(req, res);
});
httpServer.listen(port, "0.0.0.0");

if (httpsEnabled) {
  const httpsServer = https.createServer({ key: cert.key, cert: cert.cert }, handler);
  httpsServer.listen(httpsPort, "0.0.0.0");
}

const urls = lanIPs().map((ip) => `https://${ip}:${httpsPort}`).join("  ");
console.log(`qemu-pmb887x web: http://127.0.0.1:${port}  (serving ${root})`);
if (httpsEnabled)
  console.log(
    `  from other devices (phone/LAN): ${urls || `https://<lan-ip>:${httpsPort}`}` +
      ` — self-signed cert, accept the browser warning once`,
  );
