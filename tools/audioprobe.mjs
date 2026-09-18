// Watch qemu's audio ring while a fullflash boots in headless chromium.
//
// Three separate claims, three separate numbers:
//   write advancing   the emscripten audio backend opened a voice and the
//                     guest's PCM pipeline is feeding it
//   read  advancing   the AudioWorklet is running and draining the ring
//   peak  > 0         what it produced is not silence
// A short write is how the backend paces the guest, so `used` (write - read)
// sitting near capacity means the worklet stalled, not that qemu is fast.
//
// TOGGLE_AT=<s>[,<s>...] clicks the sound button at those times. Muted, the
// ring stops being filled on purpose (active=0 is "nobody is listening"), so
// what to watch there is the guest clock, not `write`: if v stalls, mute has
// back-pressured the guest's PCM pipeline instead of draining it. A second
// toggle checks that playback comes back.
//
// Usage: TESTFLASH=<fullflash> [PORT=8080] [MAX=120] [DIST=dist-jit] \
//        [TOGGLE_AT=20,30] node audioprobe.mjs [extraQuery]
import { chromium } from "playwright-core";
import { files as fullflashFiles } from "./testflash.mjs";

const dist = process.env.DIST || "dist-jit";
const port = process.env.PORT || "8080";
const maxSecs = Number(process.env.MAX || 120);
const toggleAt = (process.env.TOGGLE_AT || "")
  .split(",").map(Number).filter((n) => n > 0);
const extraQ = process.argv[2] || "";

const PROBE = `(() => {
  const m = window.__qemu;
  if (!m || !m._wasm_audio_ring_ptr) return { noModule: true };
  const ptr = Number(m._wasm_audio_ring_ptr());
  if (!ptr) return { noRing: true };
  const h = new Int32Array(m.HEAPU8.buffer, ptr, 16);
  const cap = h[1], ch = h[2] || 1;
  const wr = Atomics.load(h, 5);
  const pcm = new Int16Array(m.HEAPU8.buffer, ptr + 64, cap * ch);
  // Peak over the last second of frames behind the write cursor: the window
  // the worklet is about to play, not the whole ring's history.
  let peak = 0;
  const win = Math.min(cap, wr, h[3] || 48000);
  for (let i = wr - win; i < wr; i++) {
    for (let c = 0; c < ch; c++) {
      const s = pcm[((i & (cap - 1)) * ch) + c];
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
  }
  // Guest clock plus any new PCMPLAY chatter: silence in the ring means one
  // of two very different things, and only the DSP log tells them apart.
  const log = window.__qemulog ?? [];
  const fresh = [];
  for (let i = window.__audioSeen ?? 0; i < log.length; i++) {
    if (/PCMPLAY|pcmplay|DSP_CMD|afe/i.test(log[i])) fresh.push(log[i].slice(0, 200));
  }
  window.__audioSeen = log.length;

  return {
    magic: (h[0] >>> 0).toString(16), cap, ch, freq: h[3],
    read: Atomics.load(h, 4), write: wr, active: h[6], gen: h[7], under: h[8],
    peak, audio: window.__audio ? window.__audio() : null,
    v: m._wasm_vclock ? Number(m._wasm_vclock()) / 1e9 : 0,
    dsp: fresh.slice(-6),
  };
})()`;

const b = await chromium.launch({
  headless: true,
  // headless chromium has no output device; without this the context never
  // leaves "suspended" and process() is never called, so read would stay put
  // for reasons that have nothing to do with this backend
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
p.on("console", (m) => {
  const t = m.text();
  if (/\[audio\]|AudioWorklet|audiodev|audio/i.test(t) || m.type() === "error") {
    console.log(`  [console.${m.type()}] ${t.slice(0, 300)}`);
  }
});
p.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));

const url = `http://127.0.0.1:${port}/?dist=${dist}${extraQ ? "&" + extraQ : ""}`;
await p.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", fullflashFiles);
const t0 = Date.now();
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });
console.log(`module ready ${((Date.now() - t0) / 1000).toFixed(1)}s  ${url}`);

let prev = null, maxPeak = 0, everActive = 0;
while ((Date.now() - t0) / 1000 < maxSecs) {
  await new Promise((r) => setTimeout(r, 1000));
  if (toggleAt.length && (Date.now() - t0) / 1000 >= toggleAt[0]) {
    toggleAt.shift();
    // the button only exists while an LG device is selected — a mute
    // cannot be clicked on anything else, so say so instead of failing
    if (await p.locator("#btn-sound").isVisible()) {
      await p.click("#btn-sound");
      const on = await p.getAttribute("#btn-sound", "aria-pressed");
      console.log(`  -- sound ${on === "true" ? "muted" : "unmuted"} --`);
    } else {
      console.log("  -- sound button hidden (non-LG device); not toggled --");
    }
  }
  let s;
  try {
    s = await p.evaluate(PROBE);
  } catch (e) {
    console.log("  [evaluate failed]", String(e).slice(0, 160));
    break;
  }
  const t = ((Date.now() - t0) / 1000).toFixed(1);
  if (s.noModule || s.noRing) {
    console.log(`t=${t}s ${s.noModule ? "no module" : "no ring"}`);
    continue;
  }
  const dw = prev ? s.write - prev.write : 0;
  const dr = prev ? s.read - prev.read : 0;
  maxPeak = Math.max(maxPeak, s.peak);
  everActive |= s.active;
  console.log(
    `t=${t}s v=${s.v.toFixed(1)} ${s.freq}Hz/${s.ch}ch active=${s.active} gen=${s.gen} ` +
      `write=${s.write} (+${dw}) read=${s.read} (+${dr}) used=${s.write - s.read} ` +
      `peak=${s.peak} under=${s.under} ctx=${s.audio?.state ?? "?"}@${s.audio?.rate ?? 0}`
  );
  for (const l of s.dsp ?? []) console.log("    dsp| " + l);
  prev = s;
}

console.log(
  `END magic=${prev?.magic} frames_written=${prev?.write} frames_read=${prev?.read} ` +
    `max_peak=${maxPeak} underruns=${prev?.under} ever_active=${everActive}`
);
await b.close();
