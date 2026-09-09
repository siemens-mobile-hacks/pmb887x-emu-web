// Memory-path diagnostics: boots the S75 flash and samples the cold-path
// memory counters (wasm_memstat, see build/qemu include/qemu/wasm-diag.h)
// every N seconds alongside v/insns.  The interpreter fast paths carry no
// counters (hot path); these count the slow-path entries:
//   ldHelp/stHelp  tci_qemu_ld/st fell through to helper_ld/stXX_mmu
//   ioLd/ioSt      MMIO dispatches under the BQL
//   fill           tlb_fill_align calls (page-table walks)
//   romdFlip       romd mode transitions (flash command/array)
//   topC/topoReuse memory topology commits / romd FlatView-variant reuses
//                   (0016: reuse>0 && topC ≈ flip means the variant cache
//                   is absorbing the re-renders)
//   exit           >>EXIT<< seen in the guest serial log
//   node tools/memstat.mjs [secs] [intervalSecs]
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";

const secs = Number(process.argv[2] || 60);
const iv = Number(process.argv[3] || 10);
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on("console", (m) => { const t = m.text(); if (t.startsWith("STATS")) console.log(t); });
await p.goto("http://127.0.0.1:8080/", { waitUntil: "domcontentloaded" });
await p.addScriptTag({ content: `
  window.__stats = setInterval(() => {
    const m = window.__qemu;
    if (!m || !m._wasm_memstat) return;
    const g = (i) => Number(m._wasm_memstat(i));
    const f = (n) => (n / 1e6).toFixed(1) + "M";
    let ser = "";
    try { ser = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log")); } catch {}
    console.log("STATS v=" + (Number(m._wasm_vclock()) / 1e9).toFixed(2) +
      " insns=" + f(Number(m._wasm_insns())) +
      " ldHelp=" + f(g(0)) + " stHelp=" + f(g(1)) +
      " ioLd=" + f(g(2)) + " ioSt=" + f(g(3)) + " fill=" + f(g(4)) +
      " romdFlip=" + f(g(10)) + " topC=" + f(g(11)) + " topoReuse=" + f(g(12)) +
      " exit=" + (ser.includes(">>EXIT<<") ? "YES" : "no"));
  }, ${iv * 1000});
` });
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await new Promise((r) => setTimeout(r, secs * 1000));
await b.close();
