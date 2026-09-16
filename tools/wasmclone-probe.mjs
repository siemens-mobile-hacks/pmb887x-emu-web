// AOT-cache probe: does a WebAssembly.Module restored from IndexedDB
// actually skip compilation, and what does the persistence cost?
//
//   PORT=8080 node tools/wasmclone-probe.mjs [--count 4000] [--browsers chromium,firefox]
//
// Open item 1 in doc/performance-handoff.md prices the AOT cache at a
// ~19.5 %-of-boot ceiling *only if* restoring a module from IndexedDB is
// much cheaper than compiling it.  Structured clone is specified to
// preserve compiled code; implementations differ, and round nineteen
// found four fifths of an in-boot compile is cold cache, not compiling —
// so the headline needs measuring before anyone builds the machine.
//
// Method: synthesise `--count` modules shaped like a real batch module
// (~2.1 imports, 69 declared locals, ~2.4 KB of dense i32 arithmetic
// with import calls — size is the invisible term per round 19), then:
//
//   same page    fresh compile / fresh instantiate / structuredClone
//                round trip (in-memory handle, no persistence)
//   IndexedDB    one bulk transaction of N puts (the boot-start readback
//                cost), and N sequential one-put transactions (what
//                writing at every batch close would really cost)
//   page reload  fresh isolate — forces true deserialisation: getAll
//                the modules back, instantiate + call each, and compile
//                fresh ones beside them for a same-conditions baseline.
//
// The verdict line extrapolates to the EL71 boot economy of round 19:
// ~34k modules / ~88 MB per 25 s boot at 83 us a compile cold.
import { chromium, firefox } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const COUNT = Number(opt("count", 4000));
const OPS = Number(opt("ops", 120)); // ~2.5 KB: a real batch module's size (round 19: 88 MB / 34k ≈ 2.6 KB)
const PORT = process.env.PORT || "8080";
const browsers = opt("browsers", "chromium,firefox").split(",");
const url = `http://127.0.0.1:${PORT}/`;

// ---- page-side probe, injected whole -------------------------------------
const PROBE_BODY = String.raw`
const DB = __DB_NAME__, STORE = "m";
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => { r.result.createObjectStore(STORE); r.result.createObjectStore("p"); };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("aborted")); });
// one put in its own transaction.  Handlers attach BEFORE the put is
// issued: the chained form txDone(db.transaction(...).objectStore(...).put(...))
// crashed the renderer on its first transaction this session (Chromium
// 1243, only after a wasm-heavy preamble); this order ran 500x clean.
const put1 = (db, v, store, k) => new Promise((res, rej) => {
  const t = db.transaction(store, "readwrite");
  t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("aborted"));
  t.objectStore(store).put(v, k);
});

function moduleBytes() { // ~2.4 KB, 2 imports, 69 locals, dense i32 math
  const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
  const s = (str) => [str.length, ...str.split("").map(c => c.charCodeAt(0))];
  const F = 6, LOCALS = 69, OPS = OPSARG;
  const body = i => {
    const b = [1, ...u(LOCALS), 0x7f];                 // 1 group: LOCALS x i32
    b.push(0x41, ...u(i + 1));                         // seed: 1 value
    for (let k = 0; k < OPS; k++) {
      if (k % 12 === 11) {                                      // call import: net 0
        b.push(0x41, ...u(1 + (k & 0x1f)), 0x20, 0, 0x10, (k >> 4) & 1, 0x1a);
      } else {                                                 // const, binop: net 0
        b.push(0x41, ...u(1 + ((k * 37 + i * 11) & 0x3f)), 0x6a + (k % 5));
      }
    }
    b.push(0x0b);                                     // end, 1 value on stack
    return [...u(b.length), ...b];
  };
  const sect = (id, c) => [id, ...u(c.length), ...c];
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sect(1, [1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f]),            // (i32,i32)->i32
    ...sect(2, [2, ...s("e"), ...s("a"), 0x00, 0, ...s("e"), ...s("b"), 0x00, 0]),
    ...sect(3, [F, ...Array(F).fill(0)]),
    ...sect(7, (() => { const c = [F]; for (let i = 0; i < F; i++) c.push(...s("f" + i), 0x00, ...u(2 + i)); return c; })()),
    ...sect(10, (() => { const c = [F]; for (let i = 0; i < F; i++) c.push(...body(i)); return c; })()),
  ];
  return new Uint8Array(bytes);
}

async function run(count, phase) {
  const out = {};
  const bytes = moduleBytes();
  out.moduleBytes = bytes.length;
  const imports = { e: { a: (x, y) => x | 0, b: (x, y) => y | 0 } };

  if (phase === "first") {
    // warm, then timed fresh compiles
    for (let i = 0; i < 50; i++) new WebAssembly.Module(bytes);
    let t = performance.now(), mods = [];
    for (let i = 0; i < count; i++) mods.push(new WebAssembly.Module(bytes));
    out.compileUs = (performance.now() - t) * 1e3 / count;
    t = performance.now();
    for (const m of mods) { const w = new WebAssembly.Instance(m, imports); w.exports.f0(1, 2); }
    out.instantiateUs = (performance.now() - t) * 1e3 / count;
    t = performance.now();
    for (let i = 0; i < 1000; i++) structuredClone(mods[0]);
    out.cloneUs = (performance.now() - t) * 1e3 / 1000;

    const db = await idb();
    out.moduleStorable = true;
    t = performance.now();
    try {
      let w = db.transaction(STORE, "readwrite");
      for (let i = 0; i < count; i++) w.objectStore(STORE).put(mods[i], i);
      await txDone(w);
    } catch (e) {
      // Chromium: "A WebAssembly.Module can not be serialized for storage" —
      // the AOT cache can only persist bytes there.  Record and fall back.
      out.moduleStorable = false;
      out.storeError = String(e).slice(0, 120);
      const w = db.transaction(STORE, "readwrite");
      for (let i = 0; i < count; i++) w.objectStore(STORE).put(bytes, i);
      await txDone(w);
    }
    out.writeBulkMs = performance.now() - t;
    // what writing at every batch close really costs: one tx per put,
    // in its own store so the reloaded getAll(M) counts cleanly
    const SEQ = Math.min(500, count);
    t = performance.now();
    const putWhat = out.moduleStorable ? mods[0] : bytes;
    for (let i = 0; i < SEQ; i++) await put1(db, putWhat, "p", i);
    out.writePerPutMs = (performance.now() - t) / SEQ;
    mods = null;
  } else { // phase "reloaded"
    const db = await idb();
    let t = performance.now();
    const r = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    await new Promise((res, rej) => { r.onsuccess = res; r.onerror = () => rej(r.error); });
    const items = r.result;
    out.readAllMs = performance.now() - t;
    out.readBack = items.length;
    out.readIsModules = items.length > 0 && items[0] instanceof WebAssembly.Module;
    const imports2 = imports;
    if (out.readIsModules) {
      t = performance.now();
      for (const m of items) { const w = new WebAssembly.Instance(m, imports2); w.exports.f0(1, 2); }
      out.restoredInstUs = (performance.now() - t) * 1e3 / items.length;
    } else {
      // bytes persistence: the restore path is read + new Module(bytes)
      t = performance.now();
      for (const b of items) { const m = new WebAssembly.Module(b); new WebAssembly.Instance(m, imports2).exports.f0(1, 2); }
      out.restoredCiUs = (performance.now() - t) * 1e3 / items.length;
    }
    for (let i = 0; i < 50; i++) new WebAssembly.Module(bytes);
    t = performance.now();
    for (let i = 0; i < count; i++) new WebAssembly.Module(bytes);
    out.compileUs = (performance.now() - t) * 1e3 / count;
    t = performance.now();
    for (let i = 0; i < count; i++) { const m = new WebAssembly.Module(bytes); new WebAssembly.Instance(m, imports).exports.f0(1, 2); }
    out.freshCiUs = (performance.now() - t) * 1e3 / count;
  }
  return out;
}
`;
const probeSrc = (phase, db) => `(async () => {\nconst OPSARG = ${OPS};\n${PROBE_BODY.replace("__DB_NAME__", JSON.stringify(db))}\nreturn run(${COUNT}, ${JSON.stringify(phase)});\n})()`;

const fmt = (us) => us == null ? "-" : us >= 1000 ? (us / 1000).toFixed(1) + " ms" : us.toFixed(1) + " us";

for (const name of browsers) {
  const B = name === "firefox" ? firefox : chromium;
  let browser;
  try { browser = await B.launch({ headless: true }); }
  catch (e) { console.log(`WASMCLONE ${name}: cannot launch (${String(e).slice(0, 80)}) — skipped`); continue; }
  const p = await browser.newPage();
  p.on("crash", () => console.log(`WASMCLONE ${name}: !! page crashed`));
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // fresh DB per run: a hard-killed browser can leave one wedged so that
  // every new transaction on it hangs (paid for once this session)
  const db = "wasmclone-probe-" + Date.now().toString(36);
  let first;
  try {
    console.log(`WASMCLONE ${name}: phase first...`);
    first = await p.evaluate(probeSrc("first", db));
    console.log(`WASMCLONE ${name}: reload...`);
    await p.reload({ waitUntil: "domcontentloaded" });
    console.log(`WASMCLONE ${name}: phase reloaded...`);
    const re = await p.evaluate(probeSrc("reloaded", db));
    console.log(`WASMCLONE ${name}: done, reporting.`);
    const mb = first.moduleBytes, totalMB = (COUNT * mb) / 1e6;
    console.log(`WASMCLONE ${name} module=${(mb / 1024).toFixed(2)}KB count=${COUNT} (${totalMB.toFixed(1)} MB)`);
    console.log(`  idb       : Module storable: ${first.moduleStorable ? "YES" : "NO — " + (first.storeError || "")}`);
    console.log(`  same page : compile ${fmt(first.compileUs)}/mod  instantiate ${fmt(first.instantiateUs)}/mod  structuredClone ${fmt(first.cloneUs)}/mod`);
    console.log(`  idb write : bulk ${first.writeBulkMs.toFixed(0)} ms (${(totalMB / (first.writeBulkMs / 1000)).toFixed(0)} MB/s)  one-put tx ${first.writePerPutMs.toFixed(2)} ms/put`);
    console.log(`  reloaded  : getAll ${re.readAllMs.toFixed(0)} ms (${re.readBack}/${COUNT} back, ${(totalMB / (re.readAllMs / 1000)).toFixed(0)} MB/s, ${re.readIsModules ? "Modules" : "bytes"})`);
    console.log(`  reloaded  : compile ${fmt(re.compileUs)}/mod  compile+instantiate ${fmt(re.freshCiUs)}/mod  restored ${re.readIsModules ? "instantiate " + fmt(re.restoredInstUs) : "bytes compile+inst " + fmt(re.restoredCiUs)}/mod`);
    // verdict: per-module cost of the AOT path (read share + restored
    // instantiate) against compiling fresh in the same isolate
    const readUs = (re.readAllMs * 1e3) / re.readBack;
    const aotUs = readUs + (re.readIsModules ? re.restoredInstUs : re.restoredCiUs);
    const freshUs = re.freshCiUs;
    const bootMods = 34000, bootBytesMB = 88, coldUs = 83;
    console.log(`  verdict   : AOT ${fmt(aotUs)}/mod vs fresh ${fmt(freshUs)}/mod -> ${(freshUs / aotUs).toFixed(2)}x`);
    console.log(`  extrapol. : boot ${bootMods} mods: compile-now ${ (bootMods * coldUs / 1e6).toFixed(2) } s cold / ${(bootMods * re.freshCiUs / 1e6).toFixed(2)} s warm-ish; AOT read+inst ${(bootMods * aotUs / 1e6).toFixed(2)} s + first-boot write ${(bootBytesMB / (totalMB / (first.writeBulkMs / 1000))).toFixed(1)} s-ish`);
  } catch (e) {
    console.log(`WASMCLONE ${name}: FAIL ${String(e).slice(0, 300)}`);
  }
  try { await p.evaluate(`indexedDB.deleteDatabase(${JSON.stringify(db)})`); } catch {}
  await browser.close();
}
