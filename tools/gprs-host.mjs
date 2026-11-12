// GPRS host page: a tiny HTTP server on the host that the emulated phone's
// WAP browser fetches over emulated GPRS (qemu slirp forwards the phone's
// connection here). Every request is recorded, so a test can prove the phone
// really fetched the page.
//
//   node tools/gprs-host.mjs [port]      (default 8471)
//
// From a test: const host = await startHostPage({ port: 0 });
//   ... await host.waitForRequest(60000); await host.close();
import http from "node:http";
import { pathToFileURL } from "node:url";

export const HOST_PAGE_MARKER = "GPRS-HOST-PAGE-7311";
export const HOST_PAGE_TITLE = "GPRS OK";

// padding: bytes of comment the phone does not show, to make the page span
// several TCP segments
const page = (padding) => Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE html PUBLIC "-//WAPFORUM//DTD XHTML Mobile 1.0//EN" "http://www.wapforum.org/DTD/xhtml-mobile10.dtd">\n' +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${HOST_PAGE_TITLE}</title></head>\n` +
    (padding ? `<!-- ${"x".repeat(padding)} -->\n` : "") +
    `<body><p>${HOST_PAGE_MARKER}</p></body></html>\n`,
  "utf8",
);

// req.url may be absolute when the phone goes through a proxy setting.
const isPageRequest = (r) => {
  if (r.method !== "GET") return false;
  let p;
  try {
    p = new URL(r.url, "http://host").pathname;
  } catch {
    return false;
  }
  return p === "/" || p === "/index.html";
};

export async function startHostPage({ port = 0, host = "127.0.0.1", padding = 0, onRequest } = {}) {
  const PAGE = page(padding);
  const requests = [];
  const waiters = new Set();
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const entry = { time: Date.now(), method: req.method, url: req.url, headers: req.headers };
    requests.push(entry);
    onRequest?.(entry);
    if (isPageRequest(entry)) {
      for (const w of waiters) w.resolve(entry);
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Length": 0, Connection: "close" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/xhtml+xml; charset=utf-8",
      "Content-Length": PAGE.length,
      "Cache-Control": "no-store",
      Connection: "close",
    });
    res.end(req.method === "HEAD" ? undefined : PAGE);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const waitForRequest = (timeoutMs) => {
    const seen = requests.find(isPageRequest);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = {
        resolve: (r) => {
          clearTimeout(w.timer);
          waiters.delete(w);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(w.timer);
          waiters.delete(w);
          reject(e);
        },
      };
      w.timer = setTimeout(
        () => w.reject(new Error(`gprs-host: no page request within ${timeoutMs} ms`)),
        timeoutMs,
      );
      waiters.add(w);
    });
  };

  const close = () =>
    new Promise((resolve) => {
      for (const w of waiters) w.reject(new Error("gprs-host: server closed"));
      server.close(() => resolve());
      for (const s of sockets) s.destroy();
    });

  return { port: server.address().port, requests, waitForRequest, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8471);
  const h = await startHostPage({
    port,
    onRequest: (r) => console.log(`${r.method} ${r.url} ${r.headers["user-agent"] ?? "-"}`),
  });
  console.log(`gprs-host: listening on 127.0.0.1:${h.port}`);
}
