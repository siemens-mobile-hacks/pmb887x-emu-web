// A/B boot-survival check against the page's default build (site/dist-jit/).
//
//   node ab.mjs [variant ...]      (default: fast)
//
// Variants are booted in PARALLEL TABS of one browser (the old workflow ran
// them one after another, each with a fixed 35 s wait). Named variants:
//   fast          ?x=1                — the stock build (x=1 is an inert query
//                                       param: serve.mjs revalidates every file
//                                       by ETag, so nothing needs busting)
//   key=value     any other token     — appended as a query param (e.g. bank=0)
// Repeat a variant (e.g. `node ab.mjs fast fast`) to get two parallel samples
// of the same build — replaces the old "run it twice to be sure".
//
// Verdict per variant (exit code 1 only if some variant FAILs):
//   PASS   first splash drawn (fb updates > AB_PASS_FB, default 100 — the
//          proven "booted" signal) or insns >= AB_PASS_INSNS (default off)
//   FAIL   the page reports a firmware EXIT (early boot-ROM abort shows up
//          within seconds), an error, or qemu exiting; the module never
//          starting within AB_TIMEOUT; the page failing to set up
//   TIMEOUT no verdict within AB_TIMEOUT s (default 90) — treated as PASS,
//          like the old "OK(35s)" (survived, splash just hadn't arrived)
import { chromium } from "playwright-core";
import { files as fullflashFiles } from "./testflash.mjs";

const PORT = process.env.PORT || "8080";
const TIMEOUT = Number(process.env.AB_TIMEOUT || 90);
const PASS_FB = Number(process.env.AB_PASS_FB ?? 100);
const PASS_INSNS = Number(process.env.AB_PASS_INSNS || 0);
const POLL_MS = 2000;

const NAMED = { fast: "x=1" };
const variants = process.argv.slice(2);
if (!variants.length) variants.push("fast");

const queryOf = (v) => (NAMED[v] ?? v);
const fmtM = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : String(n));

const browser = await chromium.launch({ headless: true });
// Tag each variant; duplicates of the same query get #2, #3 suffixes.
const runs = variants.map((v, i) => {
  const q = NAMED[v] ?? v;
  const dup = variants.slice(0, i).filter((x) => (NAMED[x] ?? x) === q).length;
  return { q, tag: dup ? `${q}#${dup + 1}` : q };
});

await Promise.all(runs.map(({ q, tag }) => runVariant(browser, tag, q)));

async function runVariant(browser, tag, q) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`[${tag}] pageerror:`, String(e).slice(0, 150)));
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?${q}`, { waitUntil: "networkidle", timeout: 120000 });
    await page.selectOption("#startup", "ONLINE");
    await page.click("#ff-mode-own");
    await page.setInputFiles("#fullflash", fullflashFiles);
    await page.click("#btn-start");
  } catch (e) {
    console.log(`[${tag}] FAIL: page setup: ${String(e).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }

  const t0 = Date.now();
  let lastInsns = 0, verdict = null, detail = "", nextBeat = 10;
  while (!verdict) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const s = await page
      .evaluate(() => {
        const m = window.__qemu;
        if (!m) return { noModule: true };
        const g = (f) => { try { return Number(m[f]()); } catch { return -1; } };
        let ser = "";
        try { ser = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log")); } catch {}
        return {
          insns: g("_wasm_insns"), fb: g("_wasm_fb_updates"),
          ser, ui: window.__ui ?? {},
        };
      })
      .catch((e) => ({ evalErr: String(e).slice(0, 150) }));
    const t = (Date.now() - t0) / 1000;

    if (s.noModule || s.evalErr) {
      // module still loading, or a page that does not answer
      if (t >= TIMEOUT) { verdict = "FAIL"; detail = s.evalErr ?? "the emulator module never started"; }
      continue;
    }
    lastInsns = s.insns;

    const { ui } = s;
    if (ui.exit) { verdict = "FAIL"; detail = `firmware EXIT ${[ui.exit.type, ui.exit.code].filter(Boolean).join(" ")}`; }
    else if (ui.error) { verdict = "FAIL"; detail = ui.error; }
    else if (ui.state === "idle" && ui.exitCode != null) { verdict = "FAIL"; detail = `qemu exited (${ui.exitCode})`; }
    else if (s.fb > PASS_FB) { verdict = "PASS"; detail = `splash fb=${s.fb}`; }
    else if (PASS_INSNS && s.insns >= PASS_INSNS) { verdict = "PASS"; detail = `insns=${fmtM(s.insns)}`; }
    else if (t >= TIMEOUT) { verdict = "TIMEOUT"; detail = `still running, insns=${fmtM(s.insns)} fb=${s.fb}`; }

    if (!verdict && t >= nextBeat) {
      nextBeat += 10;
      console.log(`[${tag}] t=${t.toFixed(0)}s insns=${fmtM(s.insns)} fb=${s.fb} serlen=${s.ser.length}`);
    }
  }
  const rate = Math.round(lastInsns / ((Date.now() - t0) / 1000));
  console.log(`[${tag}] ${verdict} (${((Date.now() - t0) / 1000).toFixed(0)}s): ${detail} | ~${fmtM(rate)} insns/s avg`);
  if (verdict === "FAIL") process.exitCode = 1;
  await page.close();
}

await browser.close();
