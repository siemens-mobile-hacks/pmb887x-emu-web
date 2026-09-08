// Classify the real threads of the wasm qemu build: synchronized CPU profiles
// per worker + call-tree fingerprints + duty cycles (timeDeltas).
// Usage: node tools/threadmap.mjs [sampleSecs] [query]
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
import WebSocket from "ws";
import fs from "node:fs";

const secs = Number(process.argv[2] || 12);
const query = process.argv[3] || "";
const port = process.env.PORT || "8080";
const dbgPort = 9556;

const server = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${dbgPort}`] });
try {
  const page = await server.newPage();
  await page.goto(`http://127.0.0.1:${port}/${query ? "?" + query : ""}`, { waitUntil: "networkidle" });
  await page.setInputFiles("#fullflash", fullflash);
  await page.click("#btn-start");

  const devtools = await (await fetch(`http://127.0.0.1:${dbgPort}/json/version`)).json();
  const ws = new WebSocket(devtools.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let nextId = 1;
  const handlers = new Map();
  const attached = [];
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
  });
  await send("Target.setDiscoverTargets", { discover: true });
  await new Promise((r) => setTimeout(r, 12000)); // let workers spawn

  const gt = await send("Target.getTargets");
  const all = gt.result.targetInfos;
  console.log(`CDP targets (${all.length}): ` + all.map((t) => `[${t.type}]`).join(" "));

  const pageT = all.find((t) => t.type === "page" && t.url.includes("127.0.0.1"));
  const pageSession = (await send("Target.attachToTarget", { targetId: pageT.targetId, flatten: true })).result.sessionId;
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSession);
  await new Promise((r) => setTimeout(r, 2000));

  const workers = attached.filter((a) => a.targetInfo.type === "worker");
  console.log(`workers: ${workers.length}`);

  const insnsBefore = await send("Runtime.evaluate", {
    expression: "Number(window.__qemu._wasm_insns ? window.__qemu._wasm_insns() : 0)", returnByValue: true,
  }, pageSession);

  const sessions = [];
  for (const w of workers) {
    const sid = w.sessionId;
    await send("Profiler.enable", {}, sid);
    await send("Profiler.setSamplingInterval", { interval: 200 }, sid);
    const started = await send("Profiler.start", {}, sid);
    if (started) sessions.push({ sid, t0: Date.now() });
  }
  console.log(`profiling ${sessions.length} workers for ${secs}s...`);
  await new Promise((r) => setTimeout(r, secs * 1000));
  for (const s of sessions) s.t1 = Date.now();

  const insnsAfter = await send("Runtime.evaluate", {
    expression: "Number(window.__qemu._wasm_insns ? window.__qemu._wasm_insns() : 0)", returnByValue: true,
  }, pageSession);
  const insns = (insnsAfter?.result?.result?.value || 0) - (insnsBefore?.result?.result?.value || 0);
  console.log(`guest executed ${(insns / 1e6).toFixed(0)}M insns during the window`);

  sessions.forEach((s, i) => {
    s.i = i;
    send("Profiler.stop", {}, s.sid, 8000).then((st) => {
      const p = st?.result?.profile;
      if (p) fs.writeFileSync(`/tmp/prof-${i}.json`, JSON.stringify(p));
    });
  });
  await new Promise((r) => setTimeout(r, 5000));
} finally {
  process.exit(0); // server.close() can hang on busy workers
}
