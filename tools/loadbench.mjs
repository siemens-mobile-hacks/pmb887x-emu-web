// Startup-path benchmark for the wasm page (the "page-side" complement to
// bootbench's in-window v-window metric):
//
//   t_page    page load (goto domcontentloaded) done
//   t_module  window.__qemu appears (fetch+compile+instantiate+runtime init)
//   t_v05/2   wall secs from page load until guest virtual time crosses
//             0.5 / 2.0 — time-to-first-guest-work, the user-facing number
//   wasm      resource-timing for qemu-system-arm.wasm (transferSize,
//             encodedBodySize, fetch duration) — shows 304/cache reuse
//
// Env:
//   PORT     server (default 8080)
//   PROFILE  persistent user-data-dir (repeat with the same PROFILE to
//            measure warm HTTP/wasm-code cache effects; default: throwaway)
//   NET      downlink Mbps emulation (default: none) — e.g. NET=20 for wifi
//   LAT_MS   added round-trip latency ms (default 0)
//   SECS     run length (default 60; argv[2] overrides)
//
// Usage:
//   PORT=8081 PROFILE=/tmp/lb-cand node tools/loadbench.mjs 60   # cold
//   PORT=8081 PROFILE=/tmp/lb-cand node tools/loadbench.mjs 60   # warm

import { chromium } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullflash } from "./testflash.mjs";

const secs = Number(process.argv[2] || process.env.SECS || 60);
const port = process.env.PORT || "8080";
const profile =
  process.env.PROFILE || mkdtempSync(join(tmpdir(), "loadbench-"));
const net = Number(process.env.NET || 0);
const lat = Number(process.env.LAT_MS || 0);

const ctx = await chromium.launchPersistentContext(profile, { headless: true });
const p = await ctx.newPage();
let instantiateSecs = null;
p.on("console", (m) => {
  const match = m.text().match(/^WB_INSTANTIATE ([\d.]+)$/);
  if (match) instantiateSecs = Number(match[1]);
});
// time the streaming compile+instantiate of the big module precisely —
// this is where Chromium's wasm code cache (warm visits) shows up
await p.addInitScript(() => {
  const orig = WebAssembly.instantiateStreaming.bind(WebAssembly);
  WebAssembly.instantiateStreaming = async (resp, imports) => {
    const t0 = performance.now();
    const r = await orig(resp, imports);
    console.log("WB_INSTANTIATE " + ((performance.now() - t0) / 1000).toFixed(2));
    return r;
  };
});
if (net || lat) {
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: lat,
    downloadThroughput: (net * 1024 * 1024) / 8,
    uploadThroughput: (1024 * 1024) / 8,
  });
}

const t0 = Date.now();
let tPage = null, tModule = null, tV05 = null, tV2 = null, lastV = null;
let lastStatus = "";
await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
tPage = (Date.now() - t0) / 1000;
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");

while ((Date.now() - t0) / 1000 < secs) {
  const v = await p
    .evaluate(() => {
      const m = window.__qemu;
      if (!m) return null;
      try { return Number(m._wasm_vclock()) / 1e9; } catch { return null; }
    })
    .catch(() => null);
  if (v !== null) lastV = v;
  lastStatus = await p
    .evaluate(() => document.querySelector("#status")?.textContent || "")
    .catch(() => lastStatus);
  const t = (Date.now() - t0) / 1000;
  if (v !== null && tModule === null) tModule = t;
  if (v !== null && v >= 0.5 && tV05 === null) tV05 = t;
  if (v !== null && v >= 2 && tV2 === null) tV2 = t;
  if (tV2 !== null) break;
  await new Promise((r) => setTimeout(r, 250));
}

const wasm = await p
  .evaluate(() => {
    const e = performance
      .getEntriesByType("resource")
      .find((r) => r.name.endsWith("qemu-system-arm.wasm"));
    return e
      ? {
          transferSize: e.transferSize,
          encodedBodySize: e.encodedBodySize,
          fetchMs: Math.round(e.duration),
        }
      : null;
  })
  .catch(() => null);

const f = (x) => (x === null ? null : +x.toFixed(1));
console.log(
  `LOADBENCH ${JSON.stringify({
    profile: process.env.PROFILE ? "persistent" : "throwaway",
    net: net || null,
    t_page: f(tPage),
    t_module: f(tModule),
    t_v05: f(tV05),
    t_v2: f(tV2),
    lastV: lastV === null ? null : +lastV.toFixed(2),
    status: lastStatus || undefined,
    instantiate: instantiateSecs,
    wasm,
  })}`,
);
await ctx.close();
