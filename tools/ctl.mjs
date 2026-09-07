// Client for tools/session.mjs (the persistent wasm-qemu browser session).
//   node ctl.mjs <command> [args...]
// Prints the session's compact reply; nonzero exit on error.
// Commands: boot reload status status-json wait rate serial shot key keys eval quit
// (see tools/session.mjs header for details)
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), ".session.sock");
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: node ctl.mjs <command> [args...]  (boot|status|wait|rate|serial|shot|key|keys|eval|reload|quit)");
  process.exit(2);
}

const sock = net.connect(SOCK);
sock.on("error", (e) => {
  if (e.code === "ECONNREFUSED" || e.code === "ENOENT")
    console.error("session not running — start it with: node tools/session.mjs --daemon");
  else console.error(String(e));
  process.exit(1);
});
let buf = "";
sock.on("data", (d) => {
  buf += d;
  const i = buf.indexOf("\n");
  if (i < 0) return;
  const msg = JSON.parse(buf.slice(0, i));
  sock.destroy();
  if (msg.ok) {
    console.log(typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result));
    process.exit(0);
  } else {
    console.error("error:", msg.error);
    process.exit(1);
  }
});
sock.on("connect", () => sock.write([cmd, ...args].join(" ") + "\n"));
setTimeout(() => { console.error("ctl: timeout"); process.exit(1); }, 10 * 60 * 1000).unref();
