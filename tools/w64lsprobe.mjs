// quick probe: boot the page with the lockstep params, report console
// errors, and after N seconds dump /lockstep.log head via window.__qemu.FS
import { chromium } from "playwright-core";

const port = process.argv[2] || "8094";
const dist = process.argv[3] || "dist-jit";
const secs = parseInt(process.argv[4] || "120", 10);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (/Error|error|lockstep|W64/.test(t)) console.log("[con]", t.slice(0, 300));
});
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto(
  `http://127.0.0.1:${port}/?dist=${dist}&lockstep=1&ls-insns=2000000` +
  `&qargs=` + encodeURIComponent("-accel tcg,one-insn-per-tb=on -rtc base=2000-01-01T00:00:00,clock=vm"),
  { waitUntil: "domcontentloaded", timeout: 60000 });
await page.setInputFiles("#fullflash", "/workspace/fullflashes/s75_working20060710172101.bin");
await page.click("#btn-start");
console.log("started");
for (let t = 0; t < secs; t += 10) {
  await new Promise((r) => setTimeout(r, 10000));
  const st = await page.evaluate(() => {
    const m = window.__qemu;
    let ls = null;
    try {
      ls = m && m.FS ? m.FS.readFile("/lockstep.log", { encoding: "utf8" }) : null;
    } catch (e) { ls = "n/a"; }
    return {
      status: document.querySelector("#status")?.textContent || "?",
      lsLines: ls ? ls.split("\n").length : 0,
      lsHead: ls ? ls.split("\n")[0] : null,
      lsTail: ls ? ls.split("\n").slice(-2, -1)[0] : null,
    };
  }).catch((e) => ({ err: String(e).slice(0, 200) }));
  console.log(`t=${t + 10}s`, JSON.stringify(st));
  if (st.status?.includes("exited")) break;
}
await browser.close();
