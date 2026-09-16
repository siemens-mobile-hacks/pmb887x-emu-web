// Boot el71 and print every page/console message plus pageerror, to find
// what aborts the runtime when a speculation hint is added.
import { chromium } from "playwright-core";
const port = process.env.PORT || "8080";
const secs = Number(process.argv[2] || 120);
const here = "/workspace/";
const B = { el71: ["rr_ff_el71_stock.bin"], s75: ["S75v40lg1.bin"],
            cx70: ["CX70_FW56_clean.bin"],
            ke800: ["KE800-v11b.bin", "KE800-v11b.bin.cfi-efa"] };
const FILES = (B[process.env.BOARD || "el71"]).map((f) => here + "fullflashes/" + f);
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + "s ";
p.on("console", (m) => { const t = m.text(); if (!t.startsWith("[qemu] RRIDLE")) console.log(ts() + t.slice(0, 300)); });
p.on("pageerror", (e) => console.log(ts() + "PAGEERROR " + String(e).slice(0, 400)));
await p.goto(`http://127.0.0.1:${port}/?dist=${process.env.DIST || "dist-jit"}&rt=off${process.env.EXTRA_Q || ""}`,
             { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", FILES);
await p.click("#btn-start");
await new Promise((r) => setTimeout(r, secs * 1000));
await b.close();
