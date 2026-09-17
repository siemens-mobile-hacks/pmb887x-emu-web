// diagall's page flow with every console line, page error and worker
// lifetime printed, and a 2 s liveness poll of the main thread.  Reach for
// it when a knob makes a meter go silent: the poll separates "the guest
// died" from "the main thread wedged" from "the meter raced the close".
//
// It must click through the same start flow diagall does.  A harness that
// only navigates never boots a guest, and then reports the same failure on
// the knob leg and the control leg -- which reads like a broken knob.
//
//   EXTRA_Q=env=W64_LSM%3D2 node tools/pagedbg.mjs [secs]
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
import { NAMES } from "./diagnames.mjs";

const secs = Number(process.argv[2] || 20);
const extraQ = process.env.EXTRA_Q || "";
const port = process.env.PORT || "8080";

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on("console", (m) => console.log("[c]", m.text().slice(0, 500)));
p.on("pageerror", (e) => console.log("[E]", String(e.stack || e).slice(0, 1500)));
p.on("worker", (w) => {
  console.log("[w+]", w.url().slice(-50));
  w.on("close", () => console.log("[w-]", w.url().slice(-50)));
});
const url = `http://127.0.0.1:${port}/?dist=dist-jit&rt=off${extraQ ? "&" + extraQ : ""}`;
console.log("url:", url);
await p.goto(url, { waitUntil: "domcontentloaded" });
await p.addScriptTag({ content: `
  window.__t0 = performance.now();
  window.__diag = setInterval(() => {
    const m = window.__qemu;
    if (!m || !m._wasm_memstat) { console.log("POLL no __qemu"); return; }
    console.log("POLL t=" + ((performance.now() - window.__t0) / 1000).toFixed(1) +
                " insns=" + Number(m._wasm_insns()) +
                " c0=" + Number(m._wasm_memstat(0)));
  }, 2000);
` });
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await new Promise((r) => setTimeout(r, secs * 1000));
await b.close();
