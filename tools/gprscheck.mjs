// GPRS check: boot EL71 with the built-in cell, open a page on the host in
// the phone's browser, and watch it arrive (doc/gsm-network.md).
//
//   node tools/gprscheck.mjs --flash <EL71v41lg91.bin> [--secs 300] [--keep] [--trace]
//   PORT=8080 node tools/gprscheck.mjs --web [--dist dist-jit] --flash <EL71v41lg91.bin> ...
//
// Native (default): qemu with a slirp netdev; the page is served by
// tools/gprs-host.mjs and the phone opens http://10.0.2.2:<port>. Needs a
// native qemu with slirp (scripts/build-native.sh, libslirp-dev); QEMU_BIN
// and BOARDS_DIR override the binary and board configs as for
// scripts/run-native.sh. The flash is copied and the copy booted writable.
// --web: the page on PORT boots the flash with its GSM option, and the
// phone's IP goes to the page's own stack (site/gprs-net.js); the phone
// opens http://10.0.2.2/, which the page fetches from its own origin,
// where this tool answers it (a Playwright route).
//
// The phone's browser profile goes through the operator's WAP gateway, so
// the check first points the WAP browser at the connection "MTS
// Internet-GPRS" with no proxy (Settings > Connectivity > Online settings),
// then types the URL into Internet > Enter URL. The key sequences and the
// reference pictures (tools/test_targets/el71v41_gprs_*.png,
// el71v41_gsm_idle.png) are this image's: another firmware needs its own.
// PASS = the phone registers, the host gets the browser's GET (uplink) and
// the page shows on the LCD (downlink). The LCD is saved to
// tests/results/gprscheck[-web].png; --keep keeps the run directory,
// --trace also saves the LCD after every key press there.
import { PNG } from "pngjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_PAGE_MARKER, HOST_PAGE_TITLE, startHostPage } from "./gprs-host.mjs";
import { ppmFileToPng } from "./ppm2png.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 ? argv[i + 1] : d;
};

const WEB = argv.includes("--web");
const FLASH = opt("flash", "");
const SECS = Number(opt("secs", 300));
const TRACE = argv.includes("--trace");
const KEEP = TRACE || argv.includes("--keep");
if (!FLASH || !fs.existsSync(FLASH)) throw new Error(`usage: --flash <EL71v41lg91.bin> (got "${FLASH}")`);

const ref = (name) => PNG.sync.read(fs.readFileSync(path.join(ROOT, "tools", "test_targets", name)));
// [reference, rows from, to, columns from, to]: the status icons left of the
// clock, the "Go online" question (its Yes/No soft keys: the text names the
// connection and the box grows with it), the page's title bar and text
const REGISTERED = [ref("el71v41_gsm_idle.png"), 0, 20, 0, 120];
const PROMPT = [ref("el71v41_gprs_prompt.png"), 292, 320, 0, 240];
const PAGE = [ref("el71v41_gprs_page.png"), 26, 110, 0, 240];

const run = fs.mkdtempSync(path.join(os.tmpdir(), "gprscheck-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s) => console.log(`[gprs] t=${((Date.now() - t0) / 1000).toFixed(0)}s ${s}`);

// A backend boots the phone and gives: press(key, holdMs), lcd() as
// { width, height, data (RGBA) }, url (what the phone opens), request()
// (the phone browser's GET as the host saw it, or null), exited(),
// serial() and close(). Key names are HMP's.
async function nativeBackend() {
  const QEMU = process.env.QEMU_BIN || path.join(ROOT, "build", "qemu-native-build", "qemu-system-arm");
  const BOARDS = process.env.BOARDS_DIR || path.join(ROOT, "build", "bsp", "lib", "data", "board");
  if (!/^user$/m.test(spawnSync(QEMU, ["-machine", "pmb887x", "-netdev", "help"], { encoding: "utf8" }).stdout ?? ""))
    throw new Error(`${QEMU} has no slirp (-netdev user): install libslirp-dev, rebuild with scripts/build-native.sh`);

  // The ELKA include still carries the radio commented out on the pinned
  // bsp; the same overlay site/app.js boots for a GSM run.
  const boards = path.join(run, "board");
  fs.cpSync(BOARDS, boards, { recursive: true });
  const elka = fs.readFileSync(path.join(boards, "include", "siemens-sg2-elka.toml"), "utf8");
  const rf = elka.match(/^#\[peripheral\.RF\]\n(?:#.*\n)+/m);
  let board = "siemens-el71";
  if (rf) {
    board = "siemens-el71-gsm";
    fs.writeFileSync(path.join(boards, `${board}.toml`),
      `[board]\nextends = "siemens-el71.toml"\n\n${rf[0].replace(/^#/gm, "")}`);
  }

  const flash = path.join(run, "flash.bin");
  fs.copyFileSync(FLASH, flash);
  const host = await startHostPage();
  const monitor = path.join(run, "monitor.sock");
  const qemu = spawn("bash", [path.join(ROOT, "scripts", "run-native.sh"), flash,
    "-netdev", "user,id=net0",
    "-object", "gsm-bts,id=gsm0,netdev=net0",
    "-machine", "pmb887x,gsm-network=gsm0"], {
    env: { ...process.env, QEMU_BIN: QEMU, BOARDS_DIR: boards, BOARD: board, RW: "1", ICOUNT: "vt",
      MONITOR: `unix:${monitor}`, SERIAL: path.join(run, "serial.log") },
    stdio: ["ignore", fs.openSync(path.join(run, "qemu.log"), "w"), "inherit"],
  });
  let exited = false;
  qemu.on("exit", () => { exited = true; });

  while (!fs.existsSync(monitor) && !exited) await sleep(200);
  const sock = net.connect(monitor);
  let out = "";
  let waiter = null;
  sock.on("data", (d) => {
    out += d;
    if (waiter && out.includes("(qemu) ")) { waiter(); waiter = null; }
  });
  const hmp = (line) => new Promise((resolve) => {
    out = "";
    waiter = resolve;
    if (line) sock.write(line + "\n");
  });
  await hmp("");

  return {
    url: `10.0.2.2:${host.port}`,
    press: (name, hold) => hmp(`sendkey ${name} ${hold}`),
    lcd: async () => {
      const file = path.join(run, "lcd.ppm");
      await hmp(`screendump ${file}`);
      return PNG.sync.read(ppmFileToPng(file));
    },
    request: async () => {
      const r = host.requests.find((q) => q.method === "GET" && /UP\.Browser/.test(q.headers["user-agent"] ?? ""));
      return r ? { url: r.url, userAgent: r.headers["user-agent"] } : null;
    },
    exited: () => exited,
    serial: () => fs.readFileSync(path.join(run, "serial.log"), "latin1"),
    close: async () => {
      sock.destroy();
      qemu.kill();
      await host.close();
    },
  };
}

async function webBackend() {
  const { chromium } = await import("playwright-core");
  const PORT = process.env.PORT || "8080";
  const DIST = opt("dist", "dist-jit");
  // HMP key names -> the linux keycodes the page's keypad sends
  const KEYCODE = { ret: 28, f1: 59, f2: 60, up: 103, down: 108, right: 106, kp_divide: 98,
    0: 11, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10 };

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("crash", () => errors.push("page crashed"));
  // what the page fetched on the phone's behalf
  const fetched = [];
  // 8 KB of comment: the response takes several TCP segments and windows
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">` +
    `<head><title>${HOST_PAGE_TITLE}</title></head>\n<!-- ${"0123456789abcdef".repeat(512)} -->\n` +
    `<body><p>${HOST_PAGE_MARKER}</p></body></html>\n`;
  await page.goto(`http://127.0.0.1:${PORT}/?dist=${DIST}`, { waitUntil: "domcontentloaded" });
  // the page itself is loaded: from now on "/" is the phone's
  await page.route((u) => u.pathname === "/", (route) => {
    fetched.push(route.request().url());
    route.fulfill({ status: 200, contentType: "application/xhtml+xml; charset=utf-8", body });
  });
  if (!(await page.evaluate(() => document.querySelector("#gsm")?.checked)))
    throw new Error("the page's GSM option is not ticked");
  await page.selectOption("#startup", "ONLINE");
  await page.click("#ff-mode-own");
  await page.setInputFiles("#fullflash", FLASH);
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__qemu?._wasm_fb_updates, null, { timeout: 120000 });
  if (!(await page.evaluate(() => !!window.__gprsNet)))
    throw new Error("the page started no network (a dist without _wasm_net_attach?)");

  const serial = () => page.evaluate(() => {
    try { return new TextDecoder("latin1").decode(window.__qemu.FS.readFile("/serial.log")); } catch { return ""; }
  });
  return {
    url: "10.0.2.2",
    press: (name, hold) => page.evaluate(async ([code, ms]) => {
      window.__qemu._wasm_send_key(code, 1);
      await new Promise((r) => setTimeout(r, ms));
      window.__qemu._wasm_send_key(code, 0);
    }, [KEYCODE[name], hold]),
    lcd: () => page.evaluate(() => {
      const c = document.querySelector("#lcd");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
      return { width: d.width, height: d.height, data: Array.from(d.data) };
    }),
    request: async () => {
      const r = (await page.evaluate(() => window.__gprsNet?.requests ?? []))
        .find((q) => q.method === "GET" && /UP\.Browser/.test(q.userAgent ?? "") && q.status === 200);
      return r && fetched.length ? { url: `${r.target} -> ${fetched[0]}`, userAgent: r.userAgent } : null;
    },
    exited: () => errors.length > 0,
    serial,
    // what the page's network saw, for a failed run
    report: () => page.evaluate(() => {
      const n = window.__gprsNet;
      return n && { frames: n.frames, connections: n.conns.size, requests: n.requests };
    }),
    close: () => browser.close(),
    errors,
  };
}

const phone = WEB ? await webBackend() : await nativeBackend();
const lcdPng = async () => {
  const l = await phone.lcd();
  const png = new PNG({ width: l.width, height: l.height });
  png.data.set(l.data);
  return png;
};

// hold: ms the key stays down; gap: ms to wait after it is released
let pressed = 0;
const key = async (name, hold = 100, gap = 1800) => {
  await phone.press(name, hold);
  await sleep(WEB ? gap : hold + gap);
  if (TRACE) fs.writeFileSync(path.join(run, `key${String(++pressed).padStart(3, "0")}-${name}.png`),
    PNG.sync.write(await lcdPng()));
};
const keys = async (list) => { for (const k of list) await key(...[k].flat()); };
// a long press types the digit; "0" is ". / :" in that order, and a short
// press stays open for the next press of "0" for about 2 s
const type = async (text) => {
  const zero = async (n) => {
    for (let i = 1; i < n; i++) await key("0", 100, 150);
    await key("0", 100, 3000);
  };
  for (const c of text) {
    if (/\d/.test(c)) await key(c, 1200, 600);
    else if (".:/".includes(c)) await zero({ ".": 1, "/": 2, ":": 3 }[c]);
    else throw new Error(`cannot type "${c}"`);
  }
};

// % of the pixels in the region with any channel off by > 48
const off = (live, [want, y0, y1, x0, x1]) => {
  if (live.width !== want.width || live.height !== want.height) return 100;
  let diff = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, n++) {
    const i = (y * live.width + x) * 4;
    if ([0, 1, 2].some((c) => Math.abs(live.data[i + c] - want.data[i + c]) > 48)) diff++;
  }
  return (100 * diff) / n;
};
const until = async (what, cond, secs) => {
  const end = Date.now() + secs * 1000;
  while (Date.now() < end && !phone.exited()) {
    if (await cond()) return true;
    await sleep(1000);
  }
  log(`no ${what} within ${secs}s`);
  return false;
};
const left = () => SECS - (Date.now() - t0) / 1000;

const checks = [];
let request = null;
let shown = false;
const registered = await until("registration", async () => off(await phone.lcd(), REGISTERED) <= 2, left());
checks.push(["registered (status icons match the reference)", registered]);
if (registered) {
  log("registered");
  await keys([
    // main menu, Settings, Connectivity, Online settings (second to last)
    "ret", "kp_divide", "6", "up", "up", "ret",
    // the active profile (MTS): Options > Edit, Applications tab, WAP browser
    "f1", "ret", "right", "f1",
    // its profile "MTS WAP": Options > Edit, Connect. list
    "f1", "ret", "down", "ret",
    // entry 01, the "MTS WAP" proxy: Options > Select conn. > MTS Internet-GPRS
    "f1", "down", "down", "ret", "down", "down", "down", "down", "down", "ret",
    // Options > Save the list, Options > Save the profile; a Back while
    // "Saved." still shows would only close that
    "f1", "ret", "f1", "down", ["ret", 100, 4000],
    // back to the main menu, Internet > Enter URL; "www." is selected
    "f2", "f2", "f2", "f2", "f2", "3", "2",
  ]);
  log(`typing ${phone.url}`);
  await type(phone.url);
  // Options > OK
  await keys(["ret", "ret"]);
  let answered = false;
  await until("page request", async () => {
    if ((request = await phone.request())) return true;
    // "GPRS: Go online using [...]?" Yes
    const now = answered ? null : await phone.lcd();
    if (now && off(now, PROMPT) <= 2) {
      log("going online");
      await key("f1");
      answered = true;
    }
    return false;
  }, Math.min(90, left()));
  if (request) {
    log(`GET ${request.url} from ${request.userAgent}`);
    shown = await until("page on the LCD", async () => off(await phone.lcd(), PAGE) <= 2, Math.min(60, left()));
  }
}
checks.push(["the host got the browser's GET (uplink)", !!request]);
checks.push(["the page shows on the LCD (downlink)", shown]);

const results = path.join(ROOT, "tests", "results");
fs.mkdirSync(results, { recursive: true });
if (!phone.exited())
  fs.writeFileSync(path.join(results, `gprscheck${WEB ? "-web" : ""}.png`), PNG.sync.write(await lcdPng()));
checks.push(["no firmware >>EXIT<<", !(await phone.serial()).includes(">>EXIT<<")]);
if (WEB) {
  checks.push(["no page error", !phone.errors.length]);
  log(`page network: ${JSON.stringify(await phone.report())}`);
}

await phone.close();
if (KEEP) console.log(`run directory: ${run}`);
else fs.rmSync(run, { recursive: true, force: true });

for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
const pass = checks.every(([, ok]) => ok);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
