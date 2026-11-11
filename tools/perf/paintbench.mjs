// The page's LCD paint step, old and new, timed in a page of its own:
//   node tools/perf/paintbench.mjs [cdp-url]      (no argument: a local headless Chromium)
// Prints ms per frame for the conversion alone and with putImageData.
import { chromium } from "playwright-core";

const cdp = process.argv[2];
const port = process.env.PORT || 8080;
const browser = cdp ? await chromium.connectOverCDP(cdp)
  : await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
const page = await (cdp ? browser.contexts()[0] : await browser.newContext()).newPage();
await page.goto(`http://127.0.0.1:${port}/`);
const res = await page.evaluate(async () => {
  const out = {};
  for (const [w, h] of [[132, 176], [240, 320]]) {
    const stride = w * 4, at = 1 << 20;
    const HEAPU8 = new Uint8Array(new SharedArrayBuffer(4 << 20));
    for (let i = 0; i < w * h * 4; i++) HEAPU8[at + i] = (i * 2654435761) >>> 24;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    document.body.append(canvas);
    const ctx = canvas.getContext("2d");
    const addr = BigInt(at);
    const before = (put) => {
      const img = ctx.createImageData(w, h);
      const dst = new Uint32Array(img.data.buffer);
      const dv = new DataView(HEAPU8.buffer);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const px = dv.getUint32(Number(addr) + y * stride + x * 4, true);
          dst[y * w + x] = 0xff000000 | ((px & 0x000000ff) << 16)
                         | (px & 0x0000ff00) | ((px >>> 16) & 0x000000ff);
        }
      }
      if (put) ctx.putImageData(img, 0, 0);
    };
    let img = null, dst = null;
    const after = (put) => {
      if (img?.width !== w || img.height !== h) {
        img = ctx.createImageData(w, h);
        dst = new Uint32Array(img.data.buffer);
      }
      const rowWords = stride >> 2;
      const src = new Uint32Array(HEAPU8.buffer, Number(addr), rowWords * h);
      for (let y = 0, i = 0; y < h; y++) {
        for (let o = y * rowWords, end = o + w; o < end; o++) {
          const px = src[o];
          dst[i++] = 0xff000000 | ((px & 0x000000ff) << 16)
                   | (px & 0x0000ff00) | ((px >>> 16) & 0x000000ff);
        }
      }
      if (put) ctx.putImageData(img, 0, 0);
    };
    const time = async (f, put) => {
      for (let i = 0; i < 50; i++) f(put);
      let best = Infinity;
      for (let r = 0; r < 5; r++) {
        const t = performance.now();
        for (let i = 0; i < 200; i++) f(put);
        best = Math.min(best, (performance.now() - t) / 200);
        await new Promise((ok) => setTimeout(ok, 20));
      }
      return +best.toFixed(4);
    };
    out[`${w}x${h}`] = {
      before: await time(before, false), after: await time(after, false),
      beforePut: await time(before, true), afterPut: await time(after, true),
    };
    canvas.remove();
  }
  return out;
});
console.log(JSON.stringify(res));
await page.close();
await browser.close();
