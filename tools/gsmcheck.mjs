// GSM network check: boot a phone on a wasm dist with the GSM option on and
// watch it register (doc/gsm-network.md).
//
//   PORT=8090 node tools/gsmcheck.mjs [--dist dist-jit] [--flash <image>] [--secs 240]
//       [--gsm 1|0] [--ref <png>] [--saveref <png>] [--rows 0,20]
//       [--hold 60] [--keys 75:right_soft,82:left_soft]
//
// The image is the usual test fullflash (TESTFLASH or
// tools/testflash.local.json) unless --flash names one; --keys is for an
// image that starts with first-boot dialogs.
//
// The network is qemu's built-in cell. Nothing outside the guest tells that
// the phone registered, so the tool reads it off the LCD: the left half of
// the status-icon rows (--rows) must match a reference picture of the
// registered idle screen (--ref; tools/test_targets/el71v41_gsm_idle.png for
// the EL71 test image, none for other images: the check is then skipped and
// said so). --saveref writes the LCD the run ends on. --gsm 0 unticks the
// page's GSM option, the negative control: the registration check must fail.
//
// --hold seconds after the registration the "1" key still brings up the
// dialler. A firmware that went to deep sleep and did not come back
// (doc/gsm-network.md) fails here.
// PASS = all of the above that could be read, no socket opened by the page,
// no firmware ">>EXIT<<" and no page error. The LCD is saved to
// tests/results/gsmcheck-<dist>-<flash>.png.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 ? argv[i + 1] : d;
};

const DIST = opt("dist", "dist-jit");
const SECS = Number(opt("secs", 240));
const PORT = process.env.PORT || "8080";
const GSM = opt("gsm", "1");
const QUERY = [opt("query", ""), process.env.EXTRA_Q || ""].filter(Boolean).join("&");

const HOLD = Number(opt("hold", 60));
// [seconds after start, page key name]
const KEYS = opt("keys", "").split(",").filter(Boolean).map((k) => {
  const [at, name] = k.split(":");
  return [Number(at), name];
});
const file = opt("flash", "") || (await import("./testflash.mjs")).fullflash;
if (!fs.existsSync(file)) throw new Error(`fullflash not found: ${file}`);
const id = "gsm";
const REFS = { "EL71v41lg91.bin": "el71v41_gsm_idle.png" };
const refFile = opt("ref", "") ||
  (REFS[path.basename(file)] ? path.join(ROOT, "tools", "test_targets", REFS[path.basename(file)]) : "");
const ref = refFile && fs.existsSync(refFile) ? PNG.sync.read(fs.readFileSync(refFile)) : null;
const ROWS = opt("rows", "0,20").split(",").map(Number);
const SAVEREF = opt("saveref", "");

const probe = () => {
  const m = window.__qemu;
  let ser = "";
  try { ser = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log")); } catch {}
  return {
    insns: m?._wasm_insns ? Number(m._wasm_insns()) : 0,
    fb: m?._wasm_fb_updates ? Number(m._wasm_fb_updates()) : 0,
    exit: (ser.match(/>>EXIT<<[^\x00]{0,120}/) || [""])[0],
  };
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("crash", () => errors.push("page crashed"));
page.on("console", (m) => {
  const t = m.text();
  if (/Aborted\(|Assertion failed|RuntimeError/.test(t)) errors.push(t.slice(0, 200));
});
// The network is all inside the page: no WebSocket may appear.
const cdp = await page.context().newCDPSession(page);
await cdp.send("Network.enable");
const sockets = [];
cdp.on("Network.webSocketCreated", (e) => sockets.push(e.url));

const q = `dist=${DIST}${QUERY ? "&" + QUERY : ""}`;
await page.goto(`http://127.0.0.1:${PORT}/?${q}`, { waitUntil: "domcontentloaded" });
if (GSM === "0") await page.evaluate(() => {
  const gsm = document.querySelector("#gsm");
  gsm.checked = false;
  for (const type of ["input", "change"]) gsm.dispatchEvent(new Event(type, { bubbles: true }));
});
await page.selectOption("#startup", "ONLINE");
await page.click("#ff-mode-own");
// an LG image goes in with the EFA block that sits next to it
await page.setInputFiles("#fullflash", [file, file + ".cfi-efa"].filter((f) => fs.existsSync(f)));
await page.click("#btn-start");

// linux keycodes, as the page's own keypad sends them
const KEYCODE = { left_soft: 59, right_soft: 60, end: 62, 1: 2 };
const press = (key) => page.evaluate(async (code) => {
  window.__qemu._wasm_send_key(code, 1);
  await new Promise((r) => setTimeout(r, 200));
  window.__qemu._wasm_send_key(code, 0);
}, KEYCODE[key]);

const lcdPixels = () => page.evaluate(() => {
  const c = document.querySelector("#lcd");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  return { width: d.width, height: d.height, data: Array.from(d.data) };
});
// % of the pixels in the left half of ROWS with any channel off by > 48
const statusDiff = (live) => {
  if (live.width !== ref.width || live.height !== ref.height) return 100;
  let diff = 0, n = 0;
  for (let y = ROWS[0]; y < ROWS[1]; y++) for (let x = 0; x < live.width / 2; x++, n++) {
    const i = (y * live.width + x) * 4;
    if ([0, 1, 2].some((c) => Math.abs(live.data[i + c] - ref.data[i + c]) > 48)) diff++;
  }
  return (100 * diff) / n;
};

const keys = [...KEYS];
const t0 = Date.now();
let last = { insns: 0, exit: "" };
let registered = null;
while ((Date.now() - t0) / 1000 < SECS && !last.exit && !errors.length) {
  await new Promise((r) => setTimeout(r, 5000));
  const t = (Date.now() - t0) / 1000;
  while (keys.length && t >= keys[0][0]) await press(keys.shift()[1]);
  const mx = await Promise.race([
    page.evaluate(probe).catch((e) => ({ err: String(e).slice(0, 120) })),
    new Promise((r) => setTimeout(() => r({ err: "page unresponsive" }), 20000)),
  ]);
  if (mx.err) { errors.push(mx.err); break; }
  last = mx;
  let status = null;
  if (ref) {
    status = statusDiff(await lcdPixels());
    if (registered == null && status <= 2) registered = Math.round(t);
  }
  console.log(`[${id}] t=${t.toFixed(0)}s insns=${(mx.insns / 1e6).toFixed(0)}M fb=${mx.fb}` +
    (ref ? ` status icons off by ${status.toFixed(1)} %${registered != null ? " registered" : ""}` : ""));
  if (registered != null && t - registered > HOLD) break;
}

const shot = path.join(ROOT, "tests", "results", `gsmcheck-${DIST}-${path.basename(file).replace(/\W+/g, "_")}.png`);
fs.mkdirSync(path.dirname(shot), { recursive: true });
const lcd = await page.$("#lcd");
if (lcd) await lcd.screenshot({ path: shot }).catch(() => {});
if (SAVEREF && lcd) {
  const live = await lcdPixels();
  const png = new PNG({ width: live.width, height: live.height });
  png.data.set(live.data);
  fs.writeFileSync(SAVEREF, PNG.sync.write(png));
}

// Is the firmware still there? A digit on the idle screen opens the
// dialler, which repaints a good part of the panel (the idle screen's own repaints
// change a clock digit), and the end key leaves it again.
const pixels = async () => Array.from(new Uint32Array(Uint8Array.from((await lcdPixels()).data).buffer));
let changed = 0;
if (!last.exit && !errors.length) {
  const before = await pixels();
  await press("1");
  await new Promise((r) => setTimeout(r, 3000));
  const after = await pixels();
  changed = after.filter((px, i) => px !== before[i]).length / after.length;
  await press("end");
}

// Thread list: every emscripten pthread is a dedicated worker of the page.
const workers = page.workers().length;
await browser.close();

const checks = [
  ["no firmware exit", !last.exit, last.exit.replace(/[\x00-\x1f\xfe\xff]/g, " ")],
  ["no page error", !errors.length, errors[0] ?? ""],
  ["no socket", !sockets.length, `${sockets.length} opened`],
];
if (ref) checks.push(["registered (status icons match the reference)", registered != null,
  registered != null ? `at ${registered} s` : path.basename(refFile)]);
else console.log(`[${id}] no reference picture for ${path.basename(file)}: registration not checked, look at the screenshot`);
checks.push(["a key press changes the screen", changed > 0.05, `${(changed * 100).toFixed(0)} % of the LCD`]);

console.log(`\n${DIST}, ${workers} workers, screenshot ${shot}`);
for (const [name, ok, note] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
