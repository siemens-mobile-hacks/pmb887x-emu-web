// GPRS check: boot a phone with the built-in cell, open a page on the host in
// the phone's browser, and watch it arrive (doc/gsm-network.md).
//
//   node tools/gprscheck.mjs [--phone el71] --flash <EL71v41lg91.bin> [--secs 300] [--keep] [--trace]
//   PORT=8080 node tools/gprscheck.mjs --web [--dist dist] [--gateway <dir>] --flash ...
//       [--gateway-listen 127.0.0.1:5751] [--host-port 0] [--phone el71|s75|cx70|sl65] [--try]
//
// --phone picks the firmware whose menus the keys walk and whose LCD
// references the check compares (PHONES below: EL71v41lg91, S75v40lg1,
// CX70v56lg3, SL65v49lg1_TIM). A phone known not to get through in the
// emulator is a SKIP (exit 2) that says where it stops; --try runs it anyway.
// The phone opens http://10.0.2.2:<port>, an 8 KB page tools/gprs-host.mjs
// serves on this host's loopback, on --host-port (0: any free port).
// Native (default): qemu with a slirp netdev. Needs a native qemu with slirp
// (scripts/build-native.sh, libslirp-dev); QEMU_BIN and BOARDS_DIR override
// the binary and board configs as for scripts/run-native.sh. The flash is
// copied and the copy booted writable.
// --web: the page on PORT (serve.mjs) boots the flash with its GSM option and
// relays the phone's GPRS to /gprs, which serve.mjs passes to its GPRS_GW
// (default 127.0.0.1:5751). There the tool runs bts-emulator's GPRS gateway
// from --gateway (default ../bts-emulator/gprs-gw next to this repository)
// on --gateway-listen, which must be that GPRS_GW, with its slirp allowed
// onto this host's loopback, which the real gateway never is.
//
// The phone's browser profile goes through the operator's WAP gateway, so
// the check first moves the browser off it: on the x75 phones (EL71, S75)
// it points the WAP browser at the connection "MTS Internet-GPRS" with no
// proxy (Settings > Connectivity > Online settings), then types the URL into
// Internet > Enter URL; on the x65 phones (CX70, SL65) it sets a browser
// profile to HTTP with no proxy address (the browser's Options > Setup >
// Profiles: CX70 its active one, SL65 an empty one it then activates), then
// types the URL into Options > Go to. The key
// sequences and the reference pictures (tools/test_targets/<phone>_*.png)
// are those images': another firmware needs its own.
// PASS = the phone registers, the host gets the browser's GET (uplink) and
// the page shows on the LCD (downlink). The LCD is saved to
// tests/results/gprscheck[-web]-<phone>.png; --keep keeps the run directory,
// --trace also saves the LCD after every key press there.
import { PNG } from "pngjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway } from "./gprs-gateway.mjs";
import { startHostPage } from "./gprs-host.mjs";
import { ppmFileToPng } from "./ppm2png.mjs";
import { NATIVE_JIT_BIN } from "./lib/build-dirs.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 ? argv[i + 1] : d;
};

const WEB = argv.includes("--web");
const GATEWAY = path.resolve(opt("gateway", path.join(ROOT, "..", "bts-emulator", "gprs-gw")));
const GATEWAY_LISTEN = opt("gateway-listen", "127.0.0.1:5751");
const HOST_PORT = Number(opt("host-port", 0));
const FLASH = opt("flash", "");
const SECS = Number(opt("secs", 300));
const TRACE = argv.includes("--trace");
const KEEP = TRACE || argv.includes("--keep");
const TRY = argv.includes("--try");

const ref = (name) => PNG.sync.read(fs.readFileSync(path.join(ROOT, "tools", "test_targets", name)));

// The x75 phones (EL71, S75): the WAP browser's connection list in the active
// online profile (MTS) gets "MTS Internet-GPRS", which has no proxy, in place
// of the "MTS WAP" proxy; then Internet > Enter URL, where "www." is selected.
const X75_SETUP = [
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
  // back to the main menu, Internet > Enter URL
  "f2", "f2", "f2", "f2", "f2", "3", "2",
];
// The x65 phones (CX70, SL65) use a profile of the browser's own (Options >
// Setup > Profiles) set to HTTP with no proxy address. In its form a text
// field takes one Down to be selected, one per line to put the cursor in it,
// and one to leave. The "Profile saved." note stays 8-12 s, and an End while
// it shows only closes it.
const X65_BROWSER = [
  // main menu, Surf & fun, Internet: the browser's empty page
  "ret", "3", ["5", 100, 6000],
  // Options (wraps up to Setup), Setup > Profiles
  "f2", "up", "up", "up", "ret", "down", "ret",
];
const X65_GO_TO = ["f2", "down", "down", "ret"];
// CX70: its active profile, "UMC WAP" (WAP/WSP through 192.168.10.10:9201)
const CX70_SETUP = [
  ...X65_BROWSER,
  // Options > Edit
  "f2", "ret",
  // past the name (2) and the two-line homepage (3) to WAP/WSP, then HTTP
  "down", "down", "down", "down", "down", "down", "ret",
  // past the server ID (3) to the address, selected: Delete it, Save
  "down", "down", "down", "down", "f1", ["f2", 100, 13000],
  // back to the browser's page, Options > Go to...
  "f4", ...X65_GO_TO,
];
// SL65: its "TIM WAP" profiles are not editable, so the empty third one,
// whose connection profile is the same TIM WAP data account
const SL65_SETUP = [
  ...X65_BROWSER,
  // <Empty> 3, Options > Edit
  "down", "down", "f2", ["ret", 100, 2500],
  // past the empty name (2) to WAP/WSP, then HTTP
  "down", "down", "down", "ret",
  // past the server ID (3: its cursor starts at the front of "Profile 3")
  // to the address (0.0.0.0), selected: Delete it, Save
  "down", "down", "down", "down", "f1", ["f2", 100, 13000],
  // Activate, which goes back to the browser's page; Options > Go to...
  ["f1", 100, 2500], ...X65_GO_TO,
];
// Confirming the URL: x75 Options > OK, x65 the joystick's OK.
const X75_GO = ["ret", "ret"];
const X65_GO = [["ret", 100, 4000]];

// [reference, rows from, to, columns from, to] for: registered (EL71: the
// status icons left of the clock; the others: the network name line), the
// "Go online" question (EL71, S75: its Yes/No soft keys, as the text names
// the connection and the box grows with it; x65: the first line, "GPRS: You
// are", which tells it from the CSD question that follows a failed GPRS
// connection), and the page's title bar and text. pilot: the CX70's
// first-boot Phone Pilot, which End leaves for the idle screen.
// stops: where a phone that does not get through in the emulator stops
// (doc/gsm-network.md); it is a SKIP unless --try.
const PHONES = {
  el71: {
    board: "siemens-el71", setup: X75_SETUP, go: X75_GO,
    registered: ["el71v41_gsm_idle.png", 0, 20, 0, 120],
    prompt: ["el71v41_gprs_prompt.png", 292, 320, 0, 240],
    page: ["el71v41_gprs_page.png", 26, 110, 0, 240],
  },
  s75: {
    board: "siemens-s75", setup: X75_SETUP, go: X75_GO,
    registered: ["s75v40_gsm_idle.png", 42, 62, 0, 132],
    prompt: ["s75v40_gprs_prompt.png", 156, 176, 0, 132],
    page: ["s75v40_gprs_page.png", 0, 56, 24, 132],
  },
  cx70: {
    board: "siemens-cx70", setup: CX70_SETUP, go: X65_GO,
    registered: ["cx70v56_gsm_idle.png", 24, 40, 0, 132],
    prompt: ["cx70v56_gprs_prompt.png", 64, 78, 10, 132],
    pilot: ["cx70v56_phone_pilot.png", 0, 16, 0, 132],
    stops: "after Yes to \"GPRS: You are about to go online\" the cell accepts the PDP context, "
      + "but the phone sends no IP packet, deactivates the context 10-15 s later and asks "
      + "\"CSD: You are about to go online\" (with its stock WAP profile too)",
  },
  sl65: {
    board: "siemens-sl65", setup: SL65_SETUP, go: X65_GO,
    registered: ["sl65v49_gsm_idle.png", 22, 38, 0, 130],
    prompt: ["sl65v49_gprs_prompt.png", 41, 55, 10, 130],
    stops: "as the CX70: the PDP context is accepted, no IP packet follows, the context "
      + "is deactivated 10-15 s later and the phone asks to go online by CSD (with its stock "
      + "WAP profile too)",
  },
};
const PHONE = opt("phone", "el71");
const ph = PHONES[PHONE];
if (!ph) throw new Error(`--phone: one of ${Object.keys(PHONES).join(", ")} (got "${PHONE}")`);
if (!FLASH || !fs.existsSync(FLASH)) throw new Error(`usage: --flash <fullflash of the --phone> (got "${FLASH}")`);
if (ph.stops && !TRY) {
  console.log(`SKIP ${PHONE}: ${ph.stops} (doc/gsm-network.md; --try runs it anyway)`);
  process.exit(2);
}
const region = (r) => r && [ref(r[0]), ...r.slice(1)];
const REGISTERED = region(ph.registered);
const PROMPT = region(ph.prompt);
const PAGE = region(ph.page);
const PILOT = region(ph.pilot);

const run = fs.mkdtempSync(path.join(os.tmpdir(), "gprscheck-"));
// what a backend has started, stopped however the check ends: a throw, a
// timeout, or a signal (the gate's timeout sends TERM)
const cleanups = [];
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const f of cleanups.reverse()) { try { await f(); } catch {} }
  if (KEEP) console.log(`run directory: ${run}`);
  else fs.rmSync(run, { recursive: true, force: true });
}
for (const [sig, n] of [["SIGHUP", 1], ["SIGINT", 2], ["SIGTERM", 15]])
  process.on(sig, () => { cleanup().finally(() => process.exit(128 + n)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s) => console.log(`[gprs] t=${((Date.now() - t0) / 1000).toFixed(0)}s ${s}`);

// A backend boots the phone and gives: press(key, holdMs), lcd() as
// { width, height, data (RGBA) }, url (what the phone opens), request()
// (the phone browser's GET as the host saw it, or null), exited(),
// serial() and close(). Key names are HMP's.
async function nativeBackend() {
  const QEMU = process.env.QEMU_BIN || NATIVE_JIT_BIN;
  if (!/^user$/m.test(spawnSync(QEMU, ["-machine", "pmb887x", "-netdev", "help"], { encoding: "utf8" }).stdout ?? ""))
    throw new Error(`${QEMU} has no slirp (-netdev user): install libslirp-dev, rebuild with scripts/build-native.sh`);

  const flash = path.join(run, "flash.bin");
  fs.copyFileSync(FLASH, flash);
  const host = await startHostPage({ padding: 8192, port: HOST_PORT });
  cleanups.push(() => host.close());
  const monitor = path.join(run, "monitor.sock");
  const qemu = spawn("bash", [path.join(ROOT, "scripts", "run-native.sh"), flash,
    "-netdev", "user,id=net0",
    "-object", "gsm-bts,id=gsm0,netdev=net0",
    "-machine", "pmb887x,gsm-network=gsm0"], {
    env: { ...process.env, QEMU_BIN: QEMU, BOARD: ph.board, RW: "1",
      MONITOR: `unix:${monitor}`, SERIAL: path.join(run, "serial.log") },
    stdio: ["ignore", fs.openSync(path.join(run, "qemu.log"), "w"), "inherit"],
  });
  let exited = false;
  qemu.on("exit", () => { exited = true; });
  cleanups.push(() => { if (!exited) qemu.kill(); });

  const qemuLog = path.join(run, "qemu.log");
  while (!fs.existsSync(monitor) && !exited) await sleep(200);
  if (exited) throw new Error(`qemu exited before its monitor came up: see ${qemuLog}`);
  const sock = net.connect(monitor);
  cleanups.push(() => sock.destroy());
  let out = "";
  let waiter = null, broken = null;
  const fail = (e) => {
    broken = broken || e;
    if (waiter) { waiter.reject(broken); waiter = null; }
  };
  sock.on("error", (e) => fail(new Error(`qemu monitor: ${e.message} (see ${qemuLog})`)));
  sock.on("close", () => fail(new Error(`qemu monitor closed${exited ? ", qemu exited" : ""} (see ${qemuLog})`)));
  sock.on("data", (d) => {
    out += d;
    if (waiter && out.includes("(qemu) ")) { waiter.resolve(); waiter = null; }
  });
  const HMP_TIMEOUT_MS = 60000;
  const hmp = (line) => new Promise((resolve, reject) => {
    if (broken) return reject(broken);
    out = "";
    const timer = setTimeout(() => fail(new Error(`qemu monitor: no prompt ${HMP_TIMEOUT_MS / 1000} s after "${line}"`)),
      HMP_TIMEOUT_MS);
    waiter = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } };
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
  };
}

async function webBackend() {
  const { chromium } = await import("playwright-core");
  const PORT = process.env.PORT || "8080";
  const DIST = opt("dist", "dist");
  // HMP key names -> the linux keycodes the page's keypad sends
  const KEYCODE = { ret: 28, f1: 59, f2: 60, f4: 62, up: 103, down: 108, right: 106, kp_divide: 98,
    0: 11, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10 };

  // the gateway serve.mjs passes /gprs to, on loopback; its slirp may reach
  // this host's loopback, where the page waits
  const gw = await startGateway({ dir: GATEWAY, run, hostLoopback: true, listen: GATEWAY_LISTEN });
  cleanups.push(() => gw.close());
  const gwLog = gw.log;
  const host = await startHostPage({ padding: 8192, port: HOST_PORT });
  cleanups.push(() => host.close());

  const browser = await chromium.launch({ headless: true });
  cleanups.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("crash", () => errors.push("page crashed"));
  await page.goto(`http://127.0.0.1:${PORT}/?dist=${DIST}`, { waitUntil: "domcontentloaded" });
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
    url: `10.0.2.2:${host.port}`,
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
      const r = host.requests.find((q) => q.method === "GET" && /UP\.Browser/.test(q.headers["user-agent"] ?? ""));
      return r ? { url: r.url, userAgent: r.headers["user-agent"] } : null;
    },
    exited: () => errors.length > 0,
    serial,
    // the relay's frame counts and the gateway's log, for a failed run
    report: async () => ({
      frames: await page.evaluate(() => window.__gprsNet?.frames),
      caption: await page.evaluate(() => document.querySelector("#gsm-caption")?.textContent),
      gateway: fs.readFileSync(gwLog, "utf8").trim().split("\n").slice(-4),
    }),
    errors,
  };
}

let phone;
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
let failed = null;
try {
  phone = WEB ? await webBackend() : await nativeBackend();
  let request = null;
  let shown = false;
  const registered = await until("registration", async () => {
    const now = await phone.lcd();
    if (PILOT && off(now, PILOT) <= 2) {
      log("leaving the Phone Pilot");
      await key("f4", 100, 2500);
      return false;
    }
    return off(now, REGISTERED) <= 2;
  }, left());
  checks.push(["registered (status icons match the reference)", registered]);
  if (registered) {
    log("registered");
    await keys(ph.setup);
    log(`typing ${phone.url}`);
    await type(phone.url);
    await keys(ph.go);
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
      if (!PAGE) log(`no page reference for ${PHONE}: it has not got this far before`);
      else shown = await until("page on the LCD", async () => off(await phone.lcd(), PAGE) <= 2, Math.min(60, left()));
    }
  }
  checks.push(["the host got the browser's GET (uplink)", !!request]);
  checks.push(["the page shows on the LCD (downlink)", shown]);

  const results = path.join(ROOT, "tests", "results");
  fs.mkdirSync(results, { recursive: true });
  if (!phone.exited())
    fs.writeFileSync(path.join(results, `gprscheck${WEB ? "-web" : ""}-${PHONE}.png`), PNG.sync.write(await lcdPng()));
  checks.push(["no firmware >>EXIT<<", !(await phone.serial()).includes(">>EXIT<<")]);
  if (WEB) {
    checks.push(["no page error", !phone.errors.length]);
    log(`page network: ${JSON.stringify(await phone.report())}`);
  }
} catch (e) {
  failed = e;
} finally {
  await cleanup();
}
if (failed) {
  console.error(`[gprs] ${failed.stack || failed}`);
  checks.push(["the check ran to its end", false]);
}

for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
const pass = checks.every(([, ok]) => ok);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
