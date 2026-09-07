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
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  let path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) { res.writeHead(403); res.end(); return; }
  if (url.pathname === "/") path = join(root, "index.html");
  if (!existsSync(path) || statSync(path).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  const headers = {
    "content-type": MIME[extname(path)] || "application/octet-stream",
    // require-corp (not credentialless): Safari supports only require-corp,
    // and this page loads same-origin resources exclusively.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cache-control": "no-cache",
  };

  // Prefer the pre-gzip'd sidecar if present (qemu-system-arm.wasm.gz)
  const gz = path + ".gz";
  if ((req.headers["accept-encoding"] || "").includes("gzip") && existsSync(gz)) {
    headers["content-encoding"] = "gzip";
    res.writeHead(200, headers);
    createReadStream(gz).pipe(res);
    return;
  }

  headers["content-length"] = statSync(path).size;
  res.writeHead(200, headers);
  createReadStream(path).pipe(res);
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
