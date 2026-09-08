// Count console.error volume per worker + identify which syscalls burn CPU.
// Usage: node tools/syscallprobe.mjs [secs]
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
import WebSocket from "ws";

const secs = Number(process.argv[2] || 10);
const dbgPort = 9558;
const server = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${dbgPort}`] });
try {
  const page = await server.newPage();
  await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
  await page.setInputFiles("#fullflash", fullflash);
  await page.click("#btn-start");

  const devtools = await (await fetch(`http://127.0.0.1:${dbgPort}/json/version`)).json();
  const ws = new WebSocket(devtools.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let nextId = 1;
  const handlers = new Map();
  const attached = [];
  const consoleBySession = new Map();
  const send = (method, params = {}, sessionId, ms = 5000) => {
    const id = nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return Promise.race([
      new Promise((res) => handlers.set(id, res)),
      new Promise((res) => setTimeout(() => { handlers.delete(id); res(null); }, ms)),
    ]);
  };
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id !== undefined && handlers.has(m.id)) { handlers.get(m.id)(m); handlers.delete(m.id); }
    else if (m.method === "Target.attachedToTarget") attached.push(m.params);
    else if (m.method === "Runtime.consoleAPICalled") {
      const c = consoleBySession.get(m.sessionId) || { n: 0, texts: new Map() };
      c.n++;
      const t = (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 70);
      c.texts.set(t, (c.texts.get(t) || 0) + 1);
      consoleBySession.set(m.sessionId, c);
    }
  });
  await send("Target.setDiscoverTargets", { discover: true });
  await new Promise((r) => setTimeout(r, 12000));
  const gt = await send("Target.getTargets");
  const pageT = gt.result.targetInfos.find((t) => t.type === "page" && t.url.includes("127.0.0.1"));
  const pageSession = (await send("Target.attachToTarget", { targetId: pageT.targetId, flatten: true })).result.sessionId;
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSession);
  await new Promise((r) => setTimeout(r, 1500));

  const workers = attached.filter((a) => a.targetInfo.type === "worker");
  for (let i = 0; i < workers.length; i++) {
    const sid = workers[i].sessionId;
    await send("Runtime.enable", {}, sid);
    await send("Profiler.enable", {}, sid);
    await send("Profiler.setSamplingInterval", { interval: 200 }, sid);
    const ok = await send("Profiler.start", {}, sid);
    if (!ok) continue;
    workers[i].sid = sid;
    workers[i].tag = i;
  }
  console.log(`listening ${secs}s on ${workers.length} workers...`);
  await new Promise((r) => setTimeout(r, secs * 1000));

  for (const w of workers) {
    if (!w.sid) continue;
    const st = await send("Profiler.stop", {}, w.sid, 8000);
    const p = st?.result?.profile;
    const c = consoleBySession.get(w.sid);
    let hot = "";
    if (p) {
      const byId = new Map(p.nodes.map((n) => [n.id, n]));
      const self = new Map();
      for (const id of p.samples) self.set(id, (self.get(id) || 0) + 1);
      const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([id, n]) => `${((n / p.samples.length) * 100).toFixed(0)}% ${byId.get(id)?.callFrame.functionName || "?"}`);
      hot = top.join(" | ");
    }
    const msgs = c ? [...c.texts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
    console.log(`worker ${w.tag}: console=${c ? c.n : 0} msgs; hot: ${hot}`);
    for (const [t, n] of msgs) console.log(`    ${String(n).padStart(7)}  ${t}`);
  }
} catch (e) {
  console.error("PROBE ERROR:", e);
} finally {
  console.log("__DONE__");
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
}
