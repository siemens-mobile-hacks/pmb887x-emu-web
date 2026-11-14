// The GPRS gateway serve.mjs passes the page's /gprs WebSocket to
// (bts-emulator's gprs-gw, GPRS_GW in serve.mjs, 127.0.0.1:5751 by
// default), run on loopback for a test. Without it every phone's GPRS relay
// fails to connect, which Firefox reports as a JavaScript error.
//
//   const gw = await startGateway({ run });   ...   gw.close();
//
// dir is the gprs-gw checkout (default ../bts-emulator/gprs-gw next to this
// repository), run a directory for the helper build, log and state, and
// hostLoopback lets the phone's slirp reach this host's loopback, which the
// real gateway never allows (gprscheck's host page lives there). A gateway
// already listening on the address is used as it is and left running.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const GATEWAY_DIR = path.join(ROOT, "..", "bts-emulator", "gprs-gw");

const listening = (host, port) => new Promise((res) => {
  const s = net.connect(Number(port), host, () => { s.destroy(); res(true); });
  s.on("error", () => res(false));
});

export async function startGateway({ dir = GATEWAY_DIR, run, listen = "127.0.0.1:5751", hostLoopback = false }) {
  const [host, port] = listen.split(":");
  const log = path.join(run, "gateway.log");
  if (await listening(host, port)) {
    if (hostLoopback) throw new Error(`${listen} is taken, and this run needs a gateway that reaches the host's loopback`);
    fs.writeFileSync(log, `a gateway was already listening on ${listen}\n`);
    return { log, close() {} };
  }
  for (const f of ["slirp-pipe.c", "server.mjs"])
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`no gprs-gw checkout at ${dir} (${f} missing)`);
  const helper = path.join(run, "slirp-pipe");
  const cc = spawnSync("sh", ["-c", `cc -O2 -o "$1" "$2" $(pkg-config --cflags --libs slirp)`, "sh",
    helper, path.join(dir, "slirp-pipe.c")], { stdio: "inherit" });
  if (cc.status !== 0) throw new Error("cannot build slirp-pipe (gcc and libslirp-dev needed)");
  const gw = spawn(process.execPath, [path.join(dir, "server.mjs")], {
    env: { ...process.env, NODE_PATH: path.join(ROOT, "tools", "node_modules"),
      GPRS_GW_LISTEN: listen, GPRS_GW_HELPER: helper,
      GPRS_GW_STATE: path.join(run, "gateway-state.json"),
      ...(hostLoopback ? { SLIRP_HOST_LOOPBACK: "1" } : {}) },
    stdio: ["ignore", fs.openSync(log, "w"), fs.openSync(log, "a")],
  });
  // it goes with the tool however that ends: the tool may exit while it runs
  // (unref), and a signal becomes an exit, which takes it along
  const stop = () => gw.kill();
  process.on("exit", stop);
  for (const sig of ["SIGINT", "SIGTERM"]) if (!process.listenerCount(sig)) process.once(sig, () => process.exit(1));
  gw.unref();
  while (!fs.readFileSync(log, "utf8").includes("listening") && gw.exitCode == null)
    await new Promise((r) => setTimeout(r, 100));
  if (gw.exitCode != null) throw new Error(`the gateway exited: ${fs.readFileSync(log, "utf8")}`);
  return { log, close() { process.off("exit", stop); stop(); } };
}
