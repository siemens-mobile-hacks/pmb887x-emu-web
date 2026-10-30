// Recording check: boot the SL65, play a MIDI from My stuff, record the LCD
// with the page's own record button while the speaker is muted, and report
// the saved file's streams (ffprobe) and the sound's level (ffmpeg
// volumedetect), so a silent or missing audio track fails.
//
//   PORT=8080 node tools/recprobe.mjs [dist] [--secs 10] [--unmuted]
//
// Needs ffmpeg/ffprobe on PATH.  Exit 0 iff the file has a video and an
// audio stream and the audio is not silence.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const dist = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--"))) || "dist-jit";
const secs = Number(opt("secs", 10));
const muted = !argv.includes("--unmuted");
const port = process.env.PORT || "8080";
const flash = [here + "../fullflashes/SL65v49lg1_TIM.bin", here + "../../fullflashes/SL65v49lg1_TIM.bin"].find(existsSync);
if (!flash) throw new Error("SL65v49lg1_TIM.bin not found");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const outBase = path.join(here, `../tests/results/recprobe-${stamp}`);

const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const p = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
let ok = false;
try {
  await p.goto(`http://127.0.0.1:${port}/?dist=${dist}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  if (muted !== ((await p.evaluate(() => window.__audio?.().on)) === false)) await p.click("#btn-sound");
  await p.selectOption("#startup", "ONLINE");
  await p.click("#ff-mode-own");
  await p.setInputFiles("#fullflash", [flash]);
  await p.click("#btn-start");
  await p.waitForFunction(() => !!window.__qemu?._wasm_insns, null, { timeout: 240000 });
  // booted: past 5e8 guest instructions and the rate low for 4 s
  let quiet = 0, last = await p.evaluate(() => Number(window.__qemu._wasm_insns()));
  for (let t = 0; t < 300 && quiet < 4; t++) {
    await sleep(1000);
    const c = await p.evaluate(() => Number(window.__qemu._wasm_insns()));
    quiet = c - last < 8e6 && c > 5e8 ? quiet + 1 : 0;
    last = c;
  }
  await sleep(10000);
  const key = async (k, ms) => { await p.click(`[data-key="${k}"]`, { delay: 80 }); await sleep(ms); };
  for (const [k, ms] of [["end", 1500], ["end", 1500], ["center", 3000], ["8", 3000], ["down", 1200], ["down", 1200],
    ["down", 1200], ["center", 3000], ["down", 1200], ["center", 3000], ["center", 5000]]) await key(k, ms);
  console.log(`[recprobe] audio ${JSON.stringify(await p.evaluate(() => window.__audio()))}`);

  const download = p.waitForEvent("download", { timeout: 60000 });
  await p.click("#btn-record");
  await sleep(secs * 1000);
  await p.click("#btn-record");
  const d = await download;
  const file = outBase + path.extname(d.suggestedFilename());
  await d.saveAs(file);
  await p.locator("#lcd").screenshot({ path: outBase + "-lcd.png" });

  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries",
    "stream=codec_type,codec_name,sample_rate,channels:format=duration", "-of", "json", file], { encoding: "utf8" }));
  const streams = probe.streams.map((s) => s.codec_type + ":" + s.codec_name + (s.sample_rate ? "@" + s.sample_rate : ""));
  console.log(`[recprobe] ${path.basename(file)} streams=${streams.join(",")} duration=${probe.format.duration}`);
  const hasAudio = probe.streams.some((s) => s.codec_type === "audio");
  let maxDb = null;
  if (hasAudio) {
    // volumedetect reports on stderr
    const r = execFileSync("sh", ["-c", `ffmpeg -hide_banner -nostats -i "${file}" -map 0:a -af volumedetect -f null - 2>&1`],
      { encoding: "utf8" });
    const max = /max_volume: (-?[\d.]+) dB/.exec(r), mean = /mean_volume: (-?[\d.]+) dB/.exec(r);
    maxDb = max ? Number(max[1]) : null;
    console.log(`[recprobe] audio mean=${mean?.[1]} dB max=${max?.[1]} dB`);
  }
  ok = probe.streams.some((s) => s.codec_type === "video") && hasAudio && maxDb !== null && maxDb > -60;
} catch (e) {
  console.log(`[recprobe] error: ${String(e.message || e).slice(0, 300)}`);
}
await browser.close();
console.log(`RECPROBE ${ok ? "PASS" : "FAIL"} (speaker ${muted ? "muted" : "on"})`);
process.exit(ok ? 0 : 1);
