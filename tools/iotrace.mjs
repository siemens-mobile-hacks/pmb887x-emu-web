// Boot with PMB887X_TRACE_IO=<spec> and capture the console trace.
import { chromium } from "playwright-core";
import { fullflash } from "/workspace/tools/testflash.mjs";
const port = process.env.PORT || "8080";
const secs = Number(process.argv[2] || 50);
const spec = process.env.TRACE || "scu,dsp";
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const lines = [];
p.on("console", m => { const t = m.text(); if (t.startsWith("[qemu]")) lines.push(t.slice(7)); });
await p.goto(`http://127.0.0.1:${port}/?trace=${spec}&dist=${process.env.DIST || "dist-jit"}${process.env.EXTRA_Q ? "&" + process.env.EXTRA_Q : ""}`, { waitUntil: "domcontentloaded" });
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await new Promise(r => setTimeout(r, secs * 1000));
await b.close();
process.stdout.write(lines.join("\n"));
