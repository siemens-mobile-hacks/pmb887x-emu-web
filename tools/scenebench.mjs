// Scenario benchmark: boot a phone, walk the keypad into an app and
// measure how the emulator keeps up with it.  Self-contained (own browser
// per run, no session daemon).
//
//   PORT=8080 node tools/scenebench.mjs <scenario> [dist[,dist@query...]]
//        [--runs 3] [--measure S] [--flash path]
//
// Scenarios (EL71v41lg91, the page's EL71 preset, unless named):
//   stopwatch  Extras -> Stopwatch, started.  The app redraws as fast as it
//              can, so the guest is compute-bound and the parallel LCD bus
//              (DIF + DMAC) carries a full-screen refill every frame.
//              vratio = virtual seconds per wall second = the speed the
//              stopwatch's own digits run at (1.0 = real time).
//   idle       the idle screen, nothing pressed: what the emulator costs
//              while the phone waits (cpu = host cores the browser used).
//   music      My stuff -> Sounds -> "This time" (967 kB AAC, 2:01) in the
//              media player.  The number is the audio the listener hears:
//              underruns (dropouts; underrunAt: [second of the window, audio
//              rendered in it] per dropout), gapMs/gapPct (output silenced by them,
//              from site/audio-worklet.js), cushion (latency the worklet
//              grew to absorb them), produced (ring seconds rendered per
//              wall second; < 1 while the guest renders slower than real
//              time), minFillMs/maxFillMs (ring delay sampled once a
//              second), drainedMs/cutMs (ring audio skipped to cut the
//              delay: played faster, or cut at the 500 ms cap),
//              stretchedMs (ring audio replayed to play slower while the
//              guest renders slower than real time) and peak (> 0: not
//              silence).
//   midi       SL65v49 (TIM): My stuff -> Sounds -> Poly -> "Asia" (9 kB
//              MIDI, loops) in the media player; the same audio numbers.
//   bobby      s75_working: Games -> "Bobby Carrot 3 Evolution" (J2ME) with
//              its sound turned on, first level, Bobby walking left and
//              right through the window; vratio, fps and the audio numbers.
//   towerblox  s75_working: Games -> "Tower Bloxx" (J2ME) with its sound
//              turned on, Quick Game, a block dropped every 1.5 s through
//              the window (missed ones end the game, the next press starts a
//              new one); vratio, fps and the audio numbers.
//   video      SL65v49 (TIM): My stuff -> Videos -> "Berlin.3gp" (~25 s,
//              loops) in the video player.  The player never idles, so on a
//              fast host it keeps real time at a full core; the numbers that
//              move are fps (frames drawn) and, on a slow host, vratio.
//
// Every scenario reports cpu: host CPU seconds per wall second used by the
// browser this tool launched (all its processes and threads), so a build
// that renders the same guest with less host work shows up even when both
// keep real time.
//
// SCENEBENCH_DEVTOOLS=<port> opens the browser's CDP port and logs when the
// measurement starts, so tools/wprof2.mjs (PROF_ATTACH=<port>) can profile it.
// SCENEBENCH_CONSOLE=<text> prints the page console lines containing it.
// SCENEBENCH_SAVEREF=<png> saves the LCD the path ends on as the scenario's
// reference and stops (how tools/test_targets/*.png are made).
//
// Slow hosts: wrap it, e.g. CORES=0-3 SPIN=2 tools/slowhost.sh node
// tools/scenebench.mjs music.  The browser's audio thread is throttled
// with it, as on a real slow machine.
//
// Every navigation is checked against an LCD reference
// (tools/test_targets/<phone>_*.png, title-bar rows) and redone from the
// idle screen when a key press was dropped — the firmware drops them freely
// under load.  A dist may be "<dir>@<query>" (extra page parameters, %2C
// for commas).  Runs are sequential and interleaved across dists so host
// drift hits all of them.  Results: tests/results/scenebench-<scenario>-<ts>.json.
import { chromium, firefox } from "playwright-core";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const scenarioName = positional[0];
const dists = (positional[1] || "dist-jit").split(",");
const runs = Number(opt("runs", 3));
const port = process.env.PORT || "8080";
const keyScale = Number(opt("keyscale", 1));

const ref = (name) => PNG.sync.read(readFileSync(here + "test_targets/" + name));
const EL71 = {
  image: "EL71v41lg91.bin",
  // title bar of the 240x320 LCD, under the status icons
  title: [20, 56],
  // boot done once the guest has run this many instructions and gone quiet
  bootInsns: 1e9,
};
// startAt: guest seconds before which the scene's keys do not begin. The
// SL65 firmware goes on searching for a network after its idle screen is up,
// and what that costs changes for minutes; 63 s is where the scenes began
// while the boot took 53 s (before qemu d5421c70af, which boots it in 23 s),
// so a build that boots faster is measured over the same stretch.
const SL65 = { image: "SL65v49lg1_TIM.bin", title: [0, 12], bootInsns: 5e8, startAt: 63 };
const S75 = { image: "s75_working20060710172101.bin", bootInsns: 1e9 };

const scenarios = {
  idle: { ...EL71, measure: 30, path: null },
  stopwatch: {
    ...EL71,
    measure: 20,
    // idle -> menu grid (opens on the centre icon) -> Extras (bottom left)
    // -> Stopwatch, 4th from the end: counted from the top it moves when the
    // SIM's toolkit adds its "SAT" entry
    path: [["center", 3000], ["down", 1200], ["down", 1200], ["left", 1200], ["center", 3000],
      ["up", 900], ["up", 900], ["up", 900], ["up", 900], ["center", 4000]],
    ref: ref("el71v41_stopwatch.png"),
    // centre toggles run/stop, so whether it runs is read off the digits
    async start(s) {
      for (let i = 0; i < 3; i++) {
        await s.key("center", 1500);
        if (await s.moving([56, 90])) return true;
      }
      return false;
    },
  },
  music: {
    ...EL71,
    measure: 60,
    // idle -> menu grid -> My stuff (bottom centre) -> Sounds -> 3rd entry
    path: [["center", 3000], ["down", 1200], ["down", 1200], ["center", 3000], ["center", 3000],
      ["down", 900], ["down", 900], ["center", 6000]],
    ref: ref("el71v41_mediaplayer.png"),
    // opening the file starts playback; the elapsed time must be moving
    async start(s) {
      return s.moving([250, 285], 2500);
    },
  },
  midi: {
    ...SL65,
    measure: 60,
    // idle -> menu grid -> 8 My stuff -> Sounds (4th) -> Poly (2nd) -> 1st
    path: [["center", 3000], ["8", 3000], ["down", 1200], ["down", 1200], ["down", 1200], ["center", 3000],
      ["down", 1200], ["center", 3000], ["center", 5000]],
    ref: ref("sl65v49_midiplayer.png"),
    async start(s) {
      return s.moving([80, 100], 2500);
    },
  },
  bobby: {
    ...S75,
    measure: 60,
    // idle -> menu grid -> 7 Games -> 7th entry; the game loads behind its
    // splash, the right soft key opens its menu: Sound (4th) toggles from the
    // off it is saved with to on, Start Game (2nd) opens the level list
    path: [["center", 3000], ["7", 3000], ...Array(6).fill(["down", 1200]), ["center", 20000], ["right_soft", 4000],
      ["down", 1200], ["down", 1200], ["down", 1200], ["center", 2500], ["up", 1200], ["up", 1200], ["center", 4000]],
    ref: ref("s75_bobby_levels.png"),
    title: [36, 136],
    // the first level: its clock (top left) counts the seconds
    async start(s) {
      await s.key("center", 6000);
      return s.moving([0, 12], 2000);
    },
    // a J2ME canvas only redraws what moves
    async play(s, until) {
      while (Date.now() < until) {
        await s.key("right", 800);
        await s.key("left", 800);
      }
    },
  },
  towerblox: {
    ...S75,
    measure: 60,
    // idle -> menu grid -> 7 Games -> 8th entry from the bottom (up wraps
    // around); the game asks on every launch whether to enable sounds (right
    // soft key: yes), then its menu opens on Build City, Quick Game below it
    path: [["center", 3000], ["7", 3000], ...Array(8).fill(["up", 1200]), ["center", 12000], ["right_soft", 6000],
      ["down", 1500]],
    ref: ref("s75_towerblox_menu.png"),
    // the highlighted Quick Game bar; clouds drift through the rest
    title: [59, 71],
    // the crane swings the block through the bar's rows
    async start(s) {
      for (let i = 0; i < 3; i++) {
        await s.key("center", 4000);
        if (await s.moving([59, 71])) return true;
      }
      return false;
    },
    // blind drops mostly miss: three misses end the game and fall back to the
    // menu on Quick Game, which the next press starts again
    async play(s, until) {
      while (Date.now() < until) await s.key("center", 1500);
    },
  },
};
scenarios.video = {
  ...SL65,
  measure: 30,
  // idle -> menu grid -> 8 My stuff -> Videos (2nd) -> the first clip
  path: [["center", 3000], ["8", 3000], ["down", 1200], ["center", 3000], ["center", 6000]],
  ref: existsSync(here + "test_targets/sl65v49_videoplayer.png") ? ref("sl65v49_videoplayer.png") : null,
  // the picture under the title bar changes every frame
  async start(s) {
    return s.moving([20, 110], 2000);
  },
};
const sc = scenarios[scenarioName];
if (!sc) {
  console.error(`usage: node scenebench.mjs <${Object.keys(scenarios).join("|")}> [dists] [--runs N] [--measure S]`);
  process.exit(2);
}
const measureS = Number(opt("measure", sc.measure));
const flash = opt("flash", [here + "../fullflashes/" + sc.image, here + "../../fullflashes/" + sc.image]
  .find((f) => existsSync(f)));
if (!flash || !existsSync(flash)) throw new Error(`${sc.image} not found: pass --flash <path>`);
const distDir = (spec) => spec.split("@")[0];
const distQuery = (spec) => { const i = spec.indexOf("@"); return i < 0 ? "" : spec.slice(i + 1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CPU seconds used so far by every process descended from this one (the
// browser it launched), from /proc
const CLK_TCK = 100;
function treeCpuS() {
  let total = 0;
  const walk = (pid) => {
    let kids = [];
    try {
      for (const t of readdirSync(`/proc/${pid}/task`))
        kids.push(...readFileSync(`/proc/${pid}/task/${t}/children`, "ascii").split(" ").filter(Boolean));
    } catch { return; }
    for (const k of kids) {
      try {
        const f = readFileSync(`/proc/${k}/stat`, "ascii").split(") ")[1].split(" ");
        total += (Number(f[11]) + Number(f[12])) / CLK_TCK;
      } catch {}
      walk(k);
    }
  };
  walk(process.pid);
  return total;
}
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
// SCENEBENCH_BROWSER=firefox runs Playwright's Firefox instead of Chromium;
// SCENEBENCH_FF_PREFS='{"pref": value}' adds user prefs to it.
// SCENEBENCH_CDP=http://127.0.0.1:9222 attaches to a running Chromium
// instead (a phone's Chrome through tools/perf/adbtun.mjs, with the page
// port reversed to it): the run opens a tab of its own and closes it, the
// flash goes to the page through DevTools, and cpu is not measured.
const cdp = process.env.SCENEBENCH_CDP;
const browserName = process.env.SCENEBENCH_BROWSER || "chromium";
const outBase = path.join(here, `../tests/results/scenebench-${scenarioName}-` +
  `${browserName === "chromium" ? "" : browserName + "-"}${stamp}`);

const SNAP = `(() => {
  const m = window.__qemu;
  const r = { t: performance.now(), v: Number(m._wasm_vclock()), insns: Number(m._wasm_insns()),
    fb: Number(m._wasm_fb_updates()) };
  const ptr = m._wasm_audio_ring_ptr ? Number(m._wasm_audio_ring_ptr()) : 0;
  if (ptr) {
    const h = new Int32Array(m.HEAPU8.buffer, ptr, 16);
    Object.assign(r, { freq: h[3], read: Atomics.load(h, 4), write: Atomics.load(h, 5), active: h[6],
      under: Atomics.load(h, 8), gap: Atomics.load(h, 9), primeMs: h[10], rateMilli: h[11],
      drained: h[13], cut: h[14], stretched: h[15] });
    const cap = h[1], ch = h[2] || 1, pcm = new Int16Array(m.HEAPU8.buffer, ptr + 64, cap * ch);
    let peak = 0;
    for (let i = 1; i <= Math.min(cap, h[3] || 0); i++) {
      const f = ((r.write - i) & (cap - 1)) * ch;
      peak = Math.max(peak, Math.abs(pcm[f]), ch > 1 ? Math.abs(pcm[f + 1]) : 0);
    }
    r.peak = peak;
  }
  return r;
})()`;

async function runOnce(spec, run) {
  const devtools = process.env.SCENEBENCH_DEVTOOLS;
  const browser = cdp ? await chromium.connectOverCDP(cdp) : browserName === "firefox"
    ? await firefox.launch({ headless: true, firefoxUserPrefs: {
      "media.autoplay.default": 0,
      "media.autoplay.block-webaudio": false,
      "media.autoplay.blocking_policy": 0,
      ...JSON.parse(process.env.SCENEBENCH_FF_PREFS || "{}"),
    } })
    : await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required",
      ...(devtools ? [`--remote-debugging-port=${devtools}`] : []),
      ...(process.env.SCENEBENCH_CHROME_ARGS ? process.env.SCENEBENCH_CHROME_ARGS.split(" ") : [])] });
  const p = cdp ? await browser.contexts()[0].newPage()
    : await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let pageErr = null, serialExit = false;
  p.on("pageerror", (e) => { pageErr = String(e).slice(0, 200); });
  const conMatch = process.env.SCENEBENCH_CONSOLE;
  p.on("console", (m) => {
    if (m.text().includes(">>EXIT<<")) serialExit = true;
    if (conMatch && m.text().includes(conMatch)) console.log(`[console] ${m.text().slice(0, 300)}`);
  });
  const tag = `${distDir(spec)}-r${run}`;
  const shoot = async (what) => {
    try { await (await p.$("#lcd")).screenshot({ path: `${outBase}-${tag}-${what}.png` }); } catch {}
  };
  const result = { dist: spec, run };
  try {
    const q = distQuery(spec);
    await p.goto(`http://127.0.0.1:${port}/?dist=${distDir(spec)}${q ? "&" + q : ""}`,
      { waitUntil: "domcontentloaded", timeout: 120000 });
    // the scenes are measured without the GSM network the page gives EL71
    // by default, as the numbers before it were
    await p.evaluate(() => {
      const gsm = document.querySelector("#gsm");
      gsm.checked = false;
      for (const type of ["input", "change"]) gsm.dispatchEvent(new Event(type, { bubbles: true }));
    });
    if (cdp) {
      // a phone's layout keeps both in closed sheets, out of a pointer's reach
      await p.evaluate(() => {
        const st = document.querySelector("#startup");
        st.value = "ONLINE";
        st.dispatchEvent(new Event("change", { bubbles: true }));
        document.querySelector("#ff-mode-own").click();
      });
      // the browser cannot open a path of this machine
      const bytes = readFileSync(flash), step = 3 << 20;
      await p.evaluate(() => { window.__sbFlash = []; });
      for (let o = 0; o < bytes.length; o += step) {
        await p.evaluate((b64) => {
          window.__sbFlash.push(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        }, bytes.subarray(o, o + step).toString("base64"));
      }
      await p.evaluate((name) => {
        const dt = new DataTransfer();
        dt.items.add(new File(window.__sbFlash, name));
        delete window.__sbFlash;
        const el = document.querySelector("#fullflash");
        el.files = dt.files;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, path.basename(flash));
    } else {
      await p.selectOption("#startup", "ONLINE");
      await p.click("#ff-mode-own");
      await p.setInputFiles("#fullflash", [flash]);
    }
    const t0 = Date.now();
    await p.click("#btn-start");
    await p.waitForFunction(() => !!window.__qemu?._wasm_insns, null, { timeout: 240000 });

    const grab = () => p.evaluate(() => {
      const c = document.getElementById("lcd");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
      return { width: d.width, height: d.height, data: Array.from(d.data) };
    });
    // % of pixels over rows [y0, y1) with any channel off by > 48
    const diffPct = async (ref, [y0, y1] = [0, ref.height], live = null) => {
      live = live || await grab();
      if (live.width !== ref.width || live.height !== ref.height) return 100;
      let diff = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < live.width; x++, n++) {
        const i = (y * live.width + x) * 4;
        if (Math.abs(live.data[i] - ref.data[i]) > 48 || Math.abs(live.data[i + 1] - ref.data[i + 1]) > 48 ||
            Math.abs(live.data[i + 2] - ref.data[i + 2]) > 48) diff++;
      }
      return (100 * diff) / n;
    };
    // Attached to a phone, the walk waits in guest time: an idle guest keeps
    // real time, a busy one that cannot gets the time it needs and no more.
    const vclockMs = () => p.evaluate(() => Number(window.__qemu._wasm_vclock()) / 1e6);
    const wait = async (ms) => {
      if (!cdp) return sleep(ms);
      const v0 = await vclockMs(), t0 = Date.now();
      do await sleep(Math.min(ms, 100));
      while ((await vclockMs()) - v0 < ms && Date.now() - t0 < ms * 30);
    };
    // a hold: an instant down/up is missed by the firmware's keypad scan
    const press = async (k) => {
      if (!cdp) return p.click(`[data-key="${k}"]`, { delay: 80 });
      await p.hover(`[data-key="${k}"]`);
      await p.mouse.down();
      await wait(80);
      await p.mouse.up();
    };
    const s = {
      key: async (k, waitMs) => { await press(k); await wait(waitMs * keyScale); },
      // the same hold, but the wait is wall time and not stretched by --keyscale
      tap: async (k, waitMs) => { await press(k); await sleep(waitMs); },
      moving: async (rows, waitMs = 1500) => {
        const a = await grab();
        await wait(waitMs * keyScale);
        return (await diffPct(a, rows)) > 0.2;
      },
    };
    const fail = (why) => { throw new Error(why + (pageErr ? " pageerror=" + pageErr : "") + (serialExit ? " serial=EXIT" : "")); };

    // boot done: the instruction rate stays low for 4 s (EL71 idles at ~4M/s)
    let quiet = 0, last = await p.evaluate(SNAP);
    for (;;) {
      await sleep(1000);
      if (serialExit || pageErr) fail("boot");
      if ((Date.now() - t0) / 1000 > 300) fail("guest never went idle");
      const c = await p.evaluate(SNAP);
      quiet = (c.insns - last.insns) / ((c.t - last.t) / 1000) < 8e6 ? quiet + 1 : 0;
      last = c;
      if ((Date.now() - t0) / 1000 >= 15 && quiet >= 4 && c.insns >= sc.bootInsns) break;
    }
    result.tIdle = +((Date.now() - t0) / 1000 - 4).toFixed(1);
    await wait(10000);   // the network search banner and first redraws settle
    while (sc.startAt && (await p.evaluate(SNAP)).v / 1e9 < sc.startAt) await sleep(1000);

    // The idle screen's soft-key row tells it apart from any menu and the
    // dialer; captured once the first presses have cleared any popup.
    await s.key("end", 1500);
    await s.key("end", 1500);
    const idle = await grab();
    const SOFT = [idle.height - Math.round(idle.height * 28 / 320), idle.height];
    const atIdle = async () => (await diffPct(idle, SOFT)) <= 2;
    const saveRef = process.env.SCENEBENCH_SAVEREF;
    if (saveRef) {
      for (const [k, ms] of sc.path) await s.key(k, ms);
      const live = await grab();
      const png = new PNG({ width: live.width, height: live.height });
      png.data = Buffer.from(live.data);
      writeFileSync(saveRef, PNG.sync.write(png));
      await shoot("saveref");
      fail(`reference saved to ${saveRef}`);
    }
    let there = !sc.path;
    for (let attempt = 1; attempt <= 4 && !there; attempt++) {
      for (let i = 0; i < 6 && !(await atIdle()); i++) await s.key("end", 1500);
      for (const [k, ms] of sc.path) await s.key(k, ms);
      for (let i = 0; i < 5 && !there; i++) {
        there = (await diffPct(sc.ref, sc.title)) <= 2;
        if (!there) await wait(1000);
      }
      if (!there) console.log(`[scenebench] ${tag}: attempt ${attempt} missed the app, retrying`);
      if (serialExit || pageErr) fail("navigation");
    }
    if (!there) fail("could not reach the app");
    if (sc.start && !(await sc.start(s))) fail("app did not start");
    await shoot("start");
    if (devtools || cdp) console.log(`[scenebench] ${tag}: measuring`);
    if (process.env.SCENEBENCH_AT_MEASURE) await p.evaluate(process.env.SCENEBENCH_AT_MEASURE);

    await sleep(3000);
    const a = await p.evaluate(SNAP);
    const cpu0 = treeCpuS();
    let minFill = Infinity, maxFill = 0, prev = a;
    const underrunAt = [];
    const playing = sc.play ? sc.play({ key: s.tap }, Date.now() + measureS * 1000) : null;
    for (let el = 0; el < measureS * 1000; el += 1000) {
      await sleep(1000);
      const c = await p.evaluate(SNAP);
      if (c.freq) {
        const fill = ((c.write - c.read) | 0) / c.freq * 1000;
        minFill = Math.min(minFill, fill);
        maxFill = Math.max(maxFill, fill);
      }
      // second of the window, and audio rendered in it (s per wall s)
      if (c.under !== prev.under)
        underrunAt.push([Math.round((c.t - a.t) / 1000), +(((c.write - prev.write) | 0) / c.freq / ((c.t - prev.t) / 1000)).toFixed(2)]);
      prev = c;
    }
    await playing;
    if (a.freq) result.underrunAt = JSON.stringify(underrunAt);
    const c = await p.evaluate(SNAP);
    const cpu1 = treeCpuS();
    await shoot("end");
    const wall = (c.t - a.t) / 1000;
    Object.assign(result, {
      wall: +wall.toFixed(1),
      vratio: +((c.v - a.v) / 1e9 / wall).toFixed(3),
      mips: +((c.insns - a.insns) / 1e6 / wall).toFixed(1),
      fps: +((c.fb - a.fb) / wall).toFixed(1),
      cpu: +((cpu1 - cpu0) / wall).toFixed(3),
    });
    if (a.freq) {
      Object.assign(result, {
        underruns: c.under - a.under,
        // the worklet counts output frames at the context's rate
        gapMs: Math.round((c.gap - a.gap) / await p.evaluate(() => {
          const ac = new AudioContext(), rate = ac.sampleRate;
          ac.close();
          return rate;
        }) * 1000),
        produced: +(((c.write - a.write) | 0) / a.freq / wall).toFixed(3),
        cushionMs: c.primeMs,
        minFillMs: Math.round(minFill),
        maxFillMs: Math.round(maxFill),
        drainedMs: Math.round(((c.drained - a.drained) | 0) / a.freq * 1000),
        cutMs: Math.round(((c.cut - a.cut) | 0) / a.freq * 1000),
        stretchedMs: Math.round(((c.stretched - a.stretched) | 0) / a.freq * 1000),
        peak: c.peak,
        listening: !!c.active,
      });
      result.gapPct = +(result.gapMs / 10 / wall).toFixed(2);
    }
    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.error = String(e.message || e).slice(0, 300);
    await shoot("fail");
  }
  if (cdp) await p.close().catch(() => {});
  await browser.close();
  return result;
}

const results = [];
for (let r = 1; r <= runs; r++) {
  for (const d of dists) {
    const res = await runOnce(d, r);
    results.push(res);
    const show = Object.entries(res).filter(([k]) => !["dist", "run"].includes(k)).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`[scenebench] ${scenarioName} ${d} r${r}: ${show}`);
  }
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : null; };
const keys = ["vratio", "mips", "fps", "cpu", "underruns", "gapMs", "gapPct", "produced", "cushionMs", "minFillMs", "maxFillMs", "drainedMs", "cutMs", "stretchedMs"];
const summary = {};
for (const d of dists) {
  const ok = results.filter((x) => x.dist === d && x.ok);
  summary[d] = { ok: ok.length, of: runs };
  for (const k of keys) if (ok.some((x) => x[k] != null)) summary[d][k] = median(ok.map((x) => x[k]));
  console.log(`SCENEBENCH ${scenarioName} ${d} median: ` + Object.entries(summary[d]).map(([k, v]) => `${k}=${v}`).join(" "));
}
writeFileSync(`${outBase}.json`, JSON.stringify({
  scenario: scenarioName, browser: browserName, stamp, measureS, flash: path.basename(flash),
  loadavg: readFileSync("/proc/loadavg", "ascii").split(" ").slice(0, 3).join(" "),
  slowhost: process.env.SPIN ? { cores: process.env.CORES, spin: process.env.SPIN } : null,
  summary, results,
}, null, 1));
console.log(`results: ${outBase}.json`);
