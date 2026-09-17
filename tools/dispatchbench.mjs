#!/usr/bin/env node
// Run tests/wasm/dispatchbench.mjs inside the Chromium the emulator runs in.
//
// node and Chromium ship different V8 versions, and the whole question is how
// V8 compiles return_call_indirect, so a number measured under node is not
// evidence about the emulator.  Same file, same encoder, different host.
//
//   node tools/dispatchbench.mjs [transitions] [reps]
//   DB_NFUNC=256 DB_PAD=32 node tools/dispatchbench.mjs 3000000 7

import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const src = readFileSync(here + "../tests/wasm/dispatchbench.mjs", "utf8");
const chromeArgs = (process.env.CHROME_ARGS || "").split(/\s+/).filter(Boolean);

const cfg = {
  DB_NFUNC: process.env.DB_NFUNC || "256",
  DB_PAD: process.env.DB_PAD || "32",
  DB_N: process.argv[2] || "3000000",
  DB_REPS: process.argv[3] || "7",
};
for (const k of Object.keys(process.env)) {
  if (k.startsWith("DB_")) cfg[k] = process.env[k];
}

const b = await chromium.launch({ headless: true, args: chromeArgs });
const page = await b.newPage();
page.on("console", (m) => console.log(m.text()));
page.on("pageerror", (e) => console.log("PAGEERROR " + e.message));

const ver = await page.evaluate(() => navigator.userAgent);
console.log("UA " + ver);

await page.evaluate(
  ([cfgIn, code]) => {
    globalThis.DB_CFG = cfgIn;
    // the module reads DB_CFG at load, so it has to be installed first
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    return import(url);
  },
  [cfg, src],
);

await b.close();
