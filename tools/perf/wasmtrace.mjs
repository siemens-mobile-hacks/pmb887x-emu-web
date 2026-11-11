#!/usr/bin/env node
// Record V8's wasm compile events of a running Chromium for a while and sum
// them: how many functions each tier compiled, how long a compile took and
// on which thread.  The CPU profiler cannot tell the tiers apart; this
// shows whether the optimizing tier keeps up with the TBs the guest makes.
//
//   node tools/perf/wasmtrace.mjs [seconds] [devtools port]
//
// Works on a phone through tools/perf/adbtun.mjs.  Env: TRACE_SAVE=<file>
// keeps the raw events, TRACE_CATS replaces the categories.
import WebSocket from "ws";
import fs from "node:fs";

const secs = Number(process.argv[2] || 20);
const port = Number(process.argv[3] || 9222);
const cats = process.env.TRACE_CATS ||
  "v8.wasm,disabled-by-default-v8.wasm.detailed,disabled-by-default-v8.wasm.turbofan";

const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`),
  { perMessageDeflate: false, maxPayload: 1 << 30 });
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
let id = 0;
const pending = new Map(), events = [];
let done;
const finished = new Promise((r) => { done = r; });
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Tracing.dataCollected") events.push(...m.params.value);
  else if (m.method === "Tracing.tracingComplete") done();
});
const send = (method, params = {}) => new Promise((r) => {
  pending.set(++id, r);
  ws.send(JSON.stringify({ id, method, params }));
});

const st = await send("Tracing.start", { transferMode: "ReportEvents",
  traceConfig: { recordMode: "recordUntilFull", includedCategories: cats.split(",") } });
if (st.error) { console.error("Tracing.start:", st.error.message); process.exit(1); }
console.log(`tracing ${cats} for ${secs}s on ${ver.Browser}...`);
await new Promise((r) => setTimeout(r, secs * 1000));
await send("Tracing.end");
await finished;
ws.close();
if (process.env.TRACE_SAVE) fs.writeFileSync(process.env.TRACE_SAVE, JSON.stringify(events));

const threads = new Map();
for (const e of events) if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}/${e.tid}`, e.args.name);
// complete events (X) carry dur; B/E pairs are matched per thread
const rows = new Map(), open = new Map();
const add = (name, key, durUs) => {
  const k = `${name}\t${threads.get(key) || key}`;
  const r = rows.get(k) || { n: 0, us: 0, max: 0 };
  r.n++; r.us += durUs; r.max = Math.max(r.max, durUs);
  rows.set(k, r);
};
for (const e of events.filter((x) => x.ph !== "M").sort((a, b) => a.ts - b.ts)) {
  const key = `${e.pid}/${e.tid}`;
  if (e.ph === "X") add(e.name, key, e.dur || 0);
  else if (e.ph === "B") { if (!open.has(key)) open.set(key, []); open.get(key).push(e); }
  else if (e.ph === "E") { const b = (open.get(key) || []).pop(); if (b) add(b.name, key, e.ts - b.ts); }
  else if (e.ph === "I" || e.ph === "i") add(e.name, key, 0);
}
console.log(`${events.length} events\n` + "count".padStart(8) + "/s".padStart(8) + "total ms".padStart(10) +
  "mean us".padStart(9) + "max ms".padStart(8) + "  event (thread)");
for (const [k, r] of [...rows].sort((a, b) => b[1].us - a[1].us).slice(0, Number(process.env.TRACE_TOP || 40))) {
  const [name, thread] = k.split("\t");
  console.log(String(r.n).padStart(8) + (r.n / secs).toFixed(1).padStart(8) + (r.us / 1000).toFixed(0).padStart(10) +
    (r.us / r.n).toFixed(0).padStart(9) + (r.max / 1000).toFixed(1).padStart(8) + `  ${name} (${thread})`);
}
