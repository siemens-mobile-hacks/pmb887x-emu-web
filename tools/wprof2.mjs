// Profile the wasm worker(s): launch a persistent chromium server, drive the
// page via playwright, and speak raw flat CDP over the devtools websocket to
// attach Profiler to emscripten's module workers.
// Usage: node wprof2.mjs [seconds] [query] [sampleIntervalUs]
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

// wasm-function[N] -> C symbol map (emcc --emit-symbol-map sidecar; the
// wasm binary carries no name section). Looked up next to the wasm being
// served (site/dist/ or site/dist-jit/) and in the build dirs.
const qDist = (/(?:^|&)dist=([^&]+)/.exec(process.argv[3] || "") || [])[1] || process.env.PROF_DIST;
const symPaths = [
  ...(qDist ? [`../site/${qDist}/qemu-system-arm.js.symbols`] : []),
  "../site/dist/qemu-system-arm.js.symbols",
  "../site/dist-jit/qemu-system-arm.js.symbols",
  "../build/qemu-wasm/qemu-system-arm.js.symbols",
  "../build/qemu-wasm32/qemu-system-arm.js.symbols",
];
const fnSyms = new Map();
for (const p of symPaths) {
  try {
    for (const l of fs.readFileSync(new URL(p, import.meta.url), "utf8").split("\n")) {
      const m = l.match(/^(\d+):(.*)$/);
      if (m) fnSyms.set(m[1], m[2]);
    }
    console.log(`symbols: ${path.basename(path.dirname(p))} (${fnSyms.size} fns)`);
    break;
  } catch {}
}
const symOf = (name) => {
  const m = /wasm-function\[(\d+)\]/.exec(name || "");
  return m ? fnSyms.get(m[1]) || name : name;
};

const secs = Number(process.argv[2] || 40);
const query = process.argv[3] || "";
const sampleUs = Number(process.argv[4] || 100);
const delayS = Number(process.env.PROF_DELAY || 0);   // wait before Profiler.start (boot phase selection)

// PROF_ATTACH=<devtools port>: profile an already-running page (e.g. the
// tools/session.mjs daemon started with SESSION_DEVTOOLS=<port>) instead
// of booting a fresh one — for states that take keypad navigation to
// reach (a running J2ME app).  [seconds] and [sampleUs] still apply.
const attachPort = Number(process.env.PROF_ATTACH || 0);
const devtoolsPort = attachPort || 9555;
const server = attachPort ? null : await chromium.launch({ headless: true, args: ["--remote-debugging-port=9555"] });
try {
  const browser = server;
  const page = attachPort ? null : await browser.newPage();
  if (attachPort) console.log("attaching to devtools port " + attachPort);
  else {
  page.on("console", (m) => { const t = m.text(); if (t.startsWith("WATCH") || t.includes("EXIT")) console.log("[page]", t.slice(0, 160)); });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
  await page.goto("http://127.0.0.1:" + (process.env.PORT || "8080") + "/" + (query ? "?" + query : ""), { waitUntil: "networkidle" });
  await page.addScriptTag({ content: `
    window.__watch = setInterval(() => {
      const m = window.__qemu; if (!m) return;
      let sl = -1; try { sl = m.FS.readFile("/serial.log").length; } catch {}
      console.log("WATCH v=" + (Number(m._wasm_vclock())/1e9).toFixed(1) +
        " u=" + Number(m._wasm_fb_updates()) + " serial=" + sl +
        " tbs=" + (m._wasm_tbs?Number(m._wasm_tbs()):0) +
        " insns=" + (m._wasm_insns?Number(m._wasm_insns()):0));
    }, 10000);
  `});
  if (!query.includes("suite=")) {
    await page.setInputFiles("#fullflash", fullflash);
    await page.click("#btn-start");
  }
  }

  // raw CDP on the devtools endpoint
  const devtools = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)).json();
  const ws = new WebSocket(devtools.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let nextId = 1;
  const handlers = new Map();
  const profiles = []; // one Profiler.stop result per worker session
  const attached = [];
  function send(method, params = {}, sessionId) {
    const id = nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((res) => handlers.set(id, res));
  }
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id !== undefined && handlers.has(m.id)) { handlers.get(m.id)(m); handlers.delete(m.id); }
    else if (m.method === "Target.attachedToTarget") attached.push(m.params);
  });
  await send("Target.setDiscoverTargets", { discover: true });
  // attach to the page target, then auto-attach to its workers from there
  const gt = await send("Target.getTargets"); const targets = (gt.result || gt).targetInfos;
  const pageT = targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1"));
  const pageSession = ((await send("Target.attachToTarget", { targetId: pageT.targetId, flatten: true })).result || {}).sessionId;
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSession);
  await new Promise((r) => setTimeout(r, attachPort ? 1500 : 8000)); // workers spawn during boot

  const workers = attached.filter((a) => a.targetInfo.type === "worker");
  console.log("attached workers:", workers.map((w) => w.targetInfo.url.slice(-46)).join(" | "));

  const sessions = [];
  if (delayS) {
    console.log("waiting " + delayS + "s before profiling...");
    await new Promise((r) => setTimeout(r, delayS * 1000));
  }
  // profile the page main thread too (the client-side glue: rAF LCD paint,
  // serial poll, console handlers) — it is the first session in the list
  const sendT = (cmd, params, sid) => Promise.race([
    send(cmd, params, sid), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))]);
  try {
    await sendT("Profiler.enable", {}, pageSession);
    await sendT("Profiler.setSamplingInterval", { interval: sampleUs }, pageSession);
    await sendT("Profiler.start", {}, pageSession);
    sessions.push(pageSession);
  } catch (e) { console.log("(page main thread unresponsive: " + e.message.slice(0,60) + ")"); }
  for (const w of workers) {
    const sid = w.sessionId;
    await send("Profiler.enable", {}, sid);
    await send("Profiler.setSamplingInterval", { interval: sampleUs }, sid);
    await send("Profiler.start", {}, sid);
    sessions.push(sid);
  }
  console.log("profiling " + sessions.length + " session(s) for " + secs + "s @ " + sampleUs + "us...");
  await new Promise((r) => setTimeout(r, secs * 1000));
  for (const sid of sessions) {
    const st = await send("Profiler.stop", {}, sid);
    if (st.result && st.result.profile) profiles.push(st.result.profile);
  }

  const totals = new Map();
  const perWorker = [];
  const throwStacks = new Map();
  let i = 0;
  for (const profile of profiles) {
    const nodes = profile.nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // build parent links
    const parent = new Map();
    for (const n of nodes) for (const c of n.children || []) parent.set(c, n.id);
    const wtotals = new Map();
    let wsum = 0;
    for (let j = 0; j < profile.samples.length; j++) {
      const node = byId.get(profile.samples[j]);
      if (!node) continue;
      const cf = node.callFrame;
      const key = symOf(cf.functionName) + " " + (cf.url || "").slice(-24);
      wtotals.set(key, (wtotals.get(key) || 0) + (profile.timeDeltas[j] || 0));
      wsum += profile.timeDeltas[j] || 0;
      if ((cf.functionName || "").includes("throw_longjmp")) {
        // walk ancestors
        const chain = [];
        let cur = parent.get(profile.samples[j]);
        while (cur !== undefined && chain.length < 9) {
          const anc = byId.get(cur);
          if (anc) chain.push(anc.callFrame.functionName || "?");
          cur = parent.get(cur);
        }
        const sk = chain.join(" <- ");
        throwStacks.set(sk, (throwStacks.get(sk) || 0) + (profile.timeDeltas[j] || 0));
      }
    }
    for (const [k, v] of wtotals) totals.set(k, (totals.get(k) || 0) + v);
    perWorker.push({ idx: i++, sum: wsum, totals: wtotals });
  }
  const topN = Number(process.env.PROF_TOP || 40);
  for (const w of perWorker) {
    const label = w.idx === 0 ? "page main thread" : "worker #" + (w.idx - 1);
    console.log("\n=== " + label + " self-time (total " + (w.sum / 1000).toFixed(0) + "ms) ===");
    for (const [k, v] of [...w.totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
      console.log((v / 1000).toFixed(0).padStart(8) + "ms", (100 * v / w.sum).toFixed(1).padStart(5) + "%", k);
    }
  }
  // inclusive time (self + everything called from it) per function, for
  // the busiest worker: answers "how much of the vCPU is translation /
  // module compile / lookup" without hunting through the self-time tail.
  // PROF_INCL=0 disables; PROF_WORKER selects the worker as above.
  if (process.env.PROF_INCL !== "0") {
    let pick = 1;
    if (process.env.PROF_WORKER !== undefined) pick = process.env.PROF_WORKER === "main" ? 0 : Number(process.env.PROF_WORKER) + 1;
    else {
      let best = 0;
      for (const w of perWorker) {
        const busy = w.sum - (w.totals.get("emscripten_futex_wait jit/qemu-system-arm.wasm") || 0) - (w.totals.get("(idle) ") || 0);
        if (busy > best) { best = busy; pick = w.idx; }
      }
    }
    const profile = profiles[pick];
    if (profile) {
      const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      const parent = new Map();
      for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
      const incl = new Map();
      let sum = 0;
      for (let j = 0; j < profile.samples.length; j++) {
        const dt = profile.timeDeltas[j] || 0;
        sum += dt;
        const seen = new Set();
        let cur = profile.samples[j];
        while (cur !== undefined) {
          const n = byId.get(cur);
          if (!n) break;
          const name = symOf(n.callFrame.functionName) || "?";
          if (!seen.has(name)) { seen.add(name); incl.set(name, (incl.get(name) || 0) + dt); }
          cur = parent.get(cur);
        }
      }
      const label = pick === 0 ? "page main thread" : "worker #" + (pick - 1);
      console.log("\n=== " + label + " INCLUSIVE time (total " + (sum / 1000).toFixed(0) + "ms) ===");
      for (const [k, v] of [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
        console.log((v / 1000).toFixed(0).padStart(8) + "ms", (100 * v / sum).toFixed(1).padStart(5) + "%", k);
      }
    }
  }
  if (process.env.PROF_SAVE) fs.writeFileSync(process.env.PROF_SAVE, JSON.stringify(profiles));
  console.log("\n=== caller stacks for a target fn (env PROF_FN) ===");
  const want = process.env.PROF_FN || "throw_longjmp";
  const tstacks = new Map();
  const wantWorker = process.env.PROF_WORKER;   // "0" = worker #0 (profiles[1]), "main" = page
  for (const [pi, profile] of profiles.entries()) {
    if (wantWorker !== undefined && (wantWorker === "main" ? pi !== 0 : pi !== Number(wantWorker) + 1)) continue;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    for (let j = 0; j < profile.samples.length; j++) {
      const node = byId.get(profile.samples[j]);
      if (!node || !symOf(node.callFrame.functionName).includes(want) && !(node.callFrame.functionName || "").includes(want)) continue;
      const chain = [];
      let cur = parent.get(profile.samples[j]);
      while (cur !== undefined && chain.length < 14) {
        const anc = byId.get(cur);
        if (anc) chain.push(symOf(anc.callFrame.functionName) || "?");
        cur = parent.get(cur);
      }
      const sk = chain.join(" <- ");
      tstacks.set(sk, (tstacks.get(sk) || 0) + (profile.timeDeltas[j] || 0));
    }
  }
  for (const [k, v] of [...tstacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log((v / 1000).toFixed(0).padStart(8) + "ms", k);
  }
  ws.close();
  if (browser) await browser.close();
} finally {
  try { if (server) await server.close(); } catch {}
}
