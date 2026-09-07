// Run both builds with -d exec,nochain; diff the TB pc sequences.
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
async function run(port) {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  await p.goto(`http://127.0.0.1:${port}/?qargs=-d exec,nochain -D /e.log`, { waitUntil: "domcontentloaded" });
  await p.setInputFiles("#fullflash", fullflash);
  await p.click("#btn-start");
  await new Promise((r) => setTimeout(r, port === "8082" ? 9000 : 14000));
  const lines = await p.evaluate(() => {
    const m = window.__qemu;
    const log = new TextDecoder("latin1").decode(m.FS.readFile("/e.log"));
    return log.split("\n").filter((l) => l.startsWith("Trace 0"));
  });
  await b.close();
  return lines;
}
const jit = await run("8082");
const tci = await run("8080");
console.log("jit lines:", jit.length, "tci lines:", tci.length);
const pc = (l) => l.split('[')[1]?.trim();
let i = 0;
while (i < Math.min(jit.length, tci.length) && pc(jit[i]) === pc(tci[i])) i++;
console.log("first divergence at trace index", i);
for (let k = Math.max(0, i - 6); k < i + 4; k++) {
  console.log(k === i ? ">>jit " + (jit[k] || "").slice(0, 90) : " jit  " + (jit[k] || "").slice(0, 90));
  console.log(k === i ? ">>tci " + (tci[k] || "").slice(0, 90) : " tci  " + (tci[k] || "").slice(0, 90));
}
