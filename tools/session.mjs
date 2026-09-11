// Persistent headless-browser session for the wasm qemu page.
//
// Booting the emulator is the slow part (splash at ~30 s, full boot minutes).
// This daemon keeps ONE browser + booted page alive and answers cheap
// commands over a unix socket, so iterating on a build means one reload
// instead of a fresh browser+boot per question.
//
//   node tools/session.mjs            # foreground
//   node tools/session.mjs --daemon   # detach; logs to tools/.session.log
//
// Then drive it with tools/ctl.mjs:
//   boot [k=v ...]   fresh page (+fullflash upload, ONLINE start); waits
//                    until the module is up. Extra args become query params
//                    (iorewind=1, iopace=20, icount=shift=4 ...).
//   status           one compact line: uptime, insns (+rate since last call),
//                    tbs, vclock, fb updates, serial size, page status
//   wait <pred>      block until: exit | fb=N | insns=N | splash | secs=N
//                    | serial=TEXT     (timeout WAIT_TIMEOUT, default 300 s)
//   rate [secs]      measure insns/s over a window (default 10 s)
//   serial [n]       last n bytes of the guest serial log (default 2000)
//   shot [path]      page screenshot (+ -lcd.png crop); default session-shot.png
//   key <name>       press a keypad key (data-key name: up, left_soft, ...)
//   keys <a,b,c>     press several keys in sequence
//   eval <js>        evaluate JS in the page, print JSON result
//   reload [k=v ...] same as boot
//   quit             close everything
import { chromium } from "playwright-core";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fullflash, files as fullflashFiles } from "./testflash.mjs";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const SOCK = path.join(TOOLS, ".session.sock");
const LOG = path.join(TOOLS, ".session.log");
const PORT = process.env.PORT || "8080";
const URL_ = () => `http://127.0.0.1:${PORT}/`;

if (process.argv.includes("--daemon")) {
  const out = fs.openSync(LOG, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true, stdio: ["ignore", out, out],
  });
  child.unref();
  console.log(`session: daemonized (pid ${child.pid}), log: ${LOG}`);
  process.exit(0);
}

const log = (...a) => fs.appendFileSync(LOG, new Date().toISOString() + " " + a.join(" ") + "\n");
log("session starting");
fs.rmSync(SOCK, { force: true });

let browser = null;
let page = null;
let bootAt = 0;
let lastSample = null; // {t, insns} for rate-since-last-status
let consoleLines = [];

async function ensureServer() {
  const up = async () => {
    try {
      const res = await fetch(URL_(), { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch { return false; }
  };
  if (await up()) return;
  log("serve.mjs not reachable — starting it");
  const serve = spawn(process.execPath, [path.join(TOOLS, "..", "serve.mjs")], {
    detached: true, stdio: "ignore",
    env: { ...process.env, PORT: String(PORT) },
  });
  serve.unref();
  for (let i = 0; i < 20 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await up())) throw new Error(`serve.mjs did not come up on :${PORT}`);
}

async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
    log("browser launched");
  }
}

async function boot(params = []) {
  await ensureServer();
  await ensureBrowser();
  if (page) await page.close().catch(() => {});
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => log("pageerror:", String(e).slice(0, 300)));
  consoleLines = [];
  page.on("console", (m) => {
    consoleLines.push(((Date.now() - bootAt) / 1000).toFixed(1) + "s " + m.text());
    if (consoleLines.length > 50000) consoleLines.splice(0, 10000);
  });
  // rw=1 is a page checkbox (writable flash), not a query param
  const rw = params.includes("rw=1");
  params = params.filter((p) => p !== "rw=1");
  const q = params.length ? "?" + params.join("&") : "";
  await page.goto(URL_() + q, { waitUntil: "networkidle", timeout: 120000 });
  await page.selectOption("#startup", "ONLINE");
  if (rw) await page.check("#rw");
  await page.setInputFiles("#fullflash", fullflashFiles); // + .cfi-efa sidecar if present (LG)
  await page.click("#btn-start");
  bootAt = Date.now();
  lastSample = null;
  // wait for the wasm module object to exist
  await page.waitForFunction(() => !!window.__qemu, null, { timeout: 120000 });
  return { booted: true, url: URL_() + q };
}

const PROBE = `(() => {
  const m = window.__qemu; if (!m) return { noModule: true };
  const g = (f) => { try { return Number(m[f]()); } catch { return -1; } };
  let ser = "", serErr = "";
  try { ser = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log")); } catch (e) { serErr = String(e); }
  return { insns: g("_wasm_insns"), tbs: g("_wasm_tbs"), vclockMs: g("_wasm_vclock"),
           fb: g("_wasm_fb_updates"), serLen: ser.length, ser,
           status: document.querySelector("#status")?.textContent || "" };
})()`;

async function probe() {
  if (!page) throw new Error("no page — run: node ctl.mjs boot");
  return page.evaluate(PROBE);
}

const fmtM = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : String(n));

async function status() {
  const s = await probe();
  const now = Date.now();
  let rate = "";
  if (lastSample && s.insns > 0 && now > lastSample.t)
    rate = ` rate=${fmtM(Math.round((s.insns - lastSample.insns) / ((now - lastSample.t) / 1000)))}/s`;
  if (s.insns > 0) lastSample = { t: now, insns: s.insns };
  const up = bootAt ? ((now - bootAt) / 1000).toFixed(0) : "?";
  const exit = (s.ser.match(/>>EXIT<<[^\r\n]*/) || [])[0] || "";
  return {
    line: `up=${up}s insns=${fmtM(s.insns)}${rate} tbs=${fmtM(s.tbs)} vclock=${(s.vclockMs / 1e6).toFixed(1)}ms fb=${s.fb} serlen=${s.serLen} status="${s.status}"${exit ? " EXIT: " + exit : ""}`,
    raw: { uptimeS: Number(up), insns: s.insns, tbs: s.tbs, vclockMs: s.vclockMs, fb: s.fb, serLen: s.serLen, status: s.status, exit },
  };
}

async function wait(pred, timeoutMs = Number(process.env.WAIT_TIMEOUT || 300000)) {
  const t0 = Date.now();
  const m = String(pred).match(/^(exit|splash|fb|insns|secs|serial)(?:=(.+))?$/);
  if (!m) throw new Error(`bad predicate: ${pred} (exit | splash | fb=N | insns=N | secs=N | serial=TEXT)`);
  const [, kind, arg] = m;
  while (true) {
    const s = await probe();
    const t = (Date.now() - t0) / 1000;
    let done = false, why = "";
    if (kind === "exit") {
      const exit = (s.ser.match(/>>EXIT<<[^\r\n]*/) || [])[0] || "";
      done = !!exit || /exited/.test(s.status);
      why = exit || s.status;
    } else if (kind === "splash") { done = s.fb > 100; why = `fb=${s.fb}`; }
    else if (kind === "fb") { done = s.fb >= Number(arg); why = `fb=${s.fb}`; }
    else if (kind === "insns") { done = s.insns >= Number(arg); why = `insns=${s.insns}`; }
    else if (kind === "secs") { done = t >= Number(arg); why = `${t.toFixed(0)}s`; }
    else if (kind === "serial") { done = s.ser.includes(arg); why = `matched ${JSON.stringify(arg)}`; }
    if (done) return { done: true, afterS: Number(t.toFixed(1)), why };
    if (Date.now() - t0 > timeoutMs) return { done: false, afterS: Number(t.toFixed(1)), why: `timeout; ${why}` };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const commands = {
  boot: (args) => boot(args),
  reload: (args) => boot(args),
  status: async () => (await status()).line,
  "status-json": async () => (await status()).raw,
  wait: async (args) => wait(args[0], args[1] ? Number(args[1]) * 1000 : undefined),
  rate: async (args) => {
    const secs = Number(args[0] || 10);
    const a = await probe();
    await new Promise((r) => setTimeout(r, secs * 1000));
    const b = await probe();
    return { line: `${fmtM(Math.round((b.insns - a.insns) / secs))} insns/s over ${secs}s (insns ${fmtM(a.insns)} -> ${fmtM(b.insns)}, fb ${a.fb} -> ${b.fb})` };
  },
  serial: async (args) => {
    const n = Number(args[0] || 2000);
    const s = await probe();
    return s.serLen ? s.ser.slice(-n) : "(serial.log empty)";
  },
  shot: async (args) => {
    if (!page) throw new Error("no page");
    const out = args[0] ? path.resolve(args[0]) : path.join(TOOLS, "session-shot.png");
    await page.screenshot({ path: out });
    const lcd = await page.$("#lcd");
    if (lcd) await lcd.screenshot({ path: out.replace(/\.png$/, "-lcd.png") });
    return `saved ${out} (+ -lcd.png)`;
  },
  key: async (args) => {
    if (!page) throw new Error("no page");
    const btn = await page.$(`[data-key="${args[0]}"]`);
    if (!btn) throw new Error(`no key '${args[0]}' (see #keypad button[data-key] in site/index.html)`);
    await btn.click();
    return `pressed ${args[0]}`;
  },
  keys: async (args) => {
    for (const k of (args[0] || "").split(",").filter(Boolean)) await commands.key([k.trim()]);
    return `pressed ${args[0]}`;
  },
  eval: async (args) => {
    if (!page) throw new Error("no page");
    return page.evaluate(args.join(" "));
  },
  // console [substr]: captured page console lines (worker stderr included)
  console: async (args) => {
    const f = args.join(" ");
    return consoleLines.filter((l) => !f || l.includes(f)).join("\n");
  },
  stop: async () => {
    if (!page) throw new Error("no page");
    await page.click("#btn-stop");
    return "stop clicked";
  },
  quit: async () => { setTimeout(() => shutdown(), 100); return "bye"; },
};

const server = net.createServer((conn) => {
  let buf = "";
  conn.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      (async () => {
        try {
          const [cmd, ...args] = line.split(/\s+/);
          const fn = commands[cmd];
          if (!fn) throw new Error(`unknown command: ${cmd}`);
          const r = await fn(args);
          conn.write(JSON.stringify({ ok: true, result: r === undefined ? null : r }) + "\n");
        } catch (e) {
          conn.write(JSON.stringify({ ok: false, error: String(e).slice(0, 300) }) + "\n");
        }
      })();
    }
  });
});
server.listen(SOCK);
log("listening on", SOCK);

function shutdown() {
  log("shutting down");
  server.close();
  fs.rmSync(SOCK, { force: true });
  if (browser) browser.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
