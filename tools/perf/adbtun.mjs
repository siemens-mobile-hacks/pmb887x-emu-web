#!/usr/bin/env node
// Reach a phone through an adb server that runs on another machine (the
// Docker host), where `adb forward` would open its port on that machine and
// not here.  Speaks the adb smart-socket protocol to the server.
//
//   node tools/perf/adbtun.mjs listen <port> <device service>
//       listen on 127.0.0.1:<port> here; each connection is piped to the
//       service on the phone.  Chrome's DevTools:
//       adbtun.mjs listen 9222 localabstract:chrome_devtools_remote
//   node tools/perf/adbtun.mjs raw <service>
//       send one service request to the phone's adbd and print the answer
//       (e.g. "reverse:list-forward").
//
// Env: ADB_SERVER (host:port, default 172.17.0.1:5037), ANDROID_SERIAL.
import net from "node:net";

const [host, port] = (process.env.ADB_SERVER || "172.17.0.1:5037").split(":");
const serial = process.env.ANDROID_SERIAL;

function request(sock, payload) {
  sock.write(payload.length.toString(16).padStart(4, "0") + payload);
}

// Resolves with the socket once the phone's service is open; the bytes after
// the two OKAYs belong to the service.
export function open(service) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), host);
    let buf = Buffer.alloc(0), okays = 0;
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      while (okays < 2 && buf.length >= 4) {
        const status = buf.subarray(0, 4).toString("latin1");
        if (status === "FAIL") {
          sock.destroy();
          return reject(new Error(`adb: ${buf.subarray(8).toString()}`));
        }
        if (status !== "OKAY") {
          sock.destroy();
          return reject(new Error(`adb: unexpected ${JSON.stringify(status)}`));
        }
        buf = buf.subarray(4);
        if (++okays === 1) request(sock, service);
      }
      if (okays === 2) {
        sock.off("data", onData);
        sock.pause();
        if (buf.length) sock.unshift(buf);
        resolve(sock);
      }
    };
    sock.on("data", onData);
    sock.on("error", reject);
    sock.on("connect", () => request(sock, serial ? `host:transport:${serial}` : "host:transport-any"));
  });
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "listen") {
  net.createServer(async (c) => {
    c.on("error", () => {});
    try {
      const s = await open(b);
      s.on("error", () => c.destroy());
      c.pipe(s);
      s.pipe(c);
      s.resume();
    } catch (e) {
      console.error(String(e));
      c.destroy();
    }
  }).listen(Number(a), "127.0.0.1", () => console.log(`adbtun: 127.0.0.1:${a} -> ${b}`));
} else if (cmd === "raw") {
  try {
    const s = await open(a);
    s.on("data", (d) => process.stdout.write(d));
    s.on("end", () => process.stdout.write("\n"));
    s.resume();
    setTimeout(() => s.destroy(), 1500);
  } catch (e) {
    console.error(String(e));
    process.exit(1);
  }
} else if (cmd) {
  console.error("usage: adbtun.mjs listen <port> <service> | raw <service>");
  process.exit(2);
}
