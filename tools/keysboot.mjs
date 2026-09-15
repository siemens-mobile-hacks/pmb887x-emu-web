// Boots one fullflash through each Advanced ▸ Siemens keys mode and reports
// what the firmware made of it — the browser half of tools/recalc-check.mjs.
//
//   node tools/keysboot.mjs [--flash path] [--device siemens-s75]
//                           [--modes recalc,recover-esn,as-is] [--secs 60]
//
// A mode PASSes when the LCD drew something and the guest kept executing
// without the firmware's own ">>EXIT<<", and the exit status is 0 iff every
// mode did. Read the table, not just the status, on a fullflash built for
// another phone: "as-is" FAILing there is the whole point of the other two
// modes, so a run over such an image is expected to come back non-zero.
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : dflt;
};

const PORT = process.env.PORT || "8080";
const flash = arg("flash", fullflash);
const device = arg("device", "");
const modes = arg("modes", "recalc,recover-esn,as-is").split(",");
const secs = Number(arg("secs", 60));

const probe = () => {
  const m = window.__qemu;
  let ser = "";
  try { ser = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log")); } catch {}
  return {
    fb: m?._wasm_fb_updates ? Number(m._wasm_fb_updates()) : 0,
    insns: m?._wasm_insns ? Number(m._wasm_insns()) : 0,
    exit: (ser.match(/>>EXIT<<[^\x00]{0,120}/) || [""])[0],
  };
};

const browser = await chromium.launch({ headless: true });
let fails = 0;

for (const mode of modes) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });

  await page.click("#ff-mode-own");
  await page.setInputFiles("#fullflash", flash);
  await page.waitForTimeout(400);
  if (device) await page.selectOption("#device", device);
  await page.waitForTimeout(200);

  const dev = await page.$eval("#device", (e) => e.value);
  if (!dev.startsWith("siemens-")) {
    console.log(`SKIP ${mode}: ${dev} is not a Siemens board`);
    await page.close();
    continue;
  }
  await page.check(`input[name="siemens-mode"][value="${mode}"]`);

  const t0 = Date.now();
  await page.click("#btn-start");

  let last = { fb: 0, insns: 0, exit: "" }, pillSeen = "";
  const deadline = Date.now() + secs * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const pill = await page.$eval("#status-text", (e) => e.textContent);
    if (pill.startsWith("Recovering")) pillSeen = pill;
    const ov = await page.$eval("#ov-msg", (e) => e.textContent).catch(() => "");
    if (ov === "Failed") break;
    last = await page.evaluate(probe);
    if (last.exit) break;
    // same bar as tools/bootcheck.mjs: the LCD drew and the guest is still
    // executing. A key check the firmware fails ends in ">>EXIT<<", which is
    // what the modes are here to avoid — not in a dark screen.
    if (last.fb > 0 && last.insns > 5e8) break;
  }

  const ovMsg = await page.$eval("#ov-msg", (e) => e.textContent).catch(() => "");
  const ovSub = await page.$eval("#ov-sub", (e) => e.textContent).catch(() => "");
  const esn = await page.$eval("#esn", (e) => e.value);
  const pass = !last.exit && last.fb > 0 && last.insns > 5e8 && ovMsg !== "Failed";
  const took = ((Date.now() - t0) / 1000).toFixed(0);

  console.log(`${pass ? "PASS" : "FAIL"} ${mode.padEnd(11)} ` +
    `esn=${esn} fb=${last.fb} insns=${(last.insns / 1e9).toFixed(2)}G ` +
    `${took}s` + (last.exit ? `  ${last.exit.split("\n")[0].slice(0, 60)}` : "") +
    (pillSeen ? `  [${pillSeen}]` : "") +
    (ovMsg === "Failed" ? `  — ${ovSub}` : ""));
  if (errs.length) { console.log("  pageerrors:", errs.join(" | ")); fails++; }
  if (!pass) fails++;
  await page.close();
}

await browser.close();
process.exit(fails ? 1 : 0);
