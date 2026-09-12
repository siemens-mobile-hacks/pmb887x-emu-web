// Categorize a saved wprof2 profile (PROF_SAVE=<json>) for the busiest
// worker: self time per class, so "where does the vCPU go" is one table.
//   node tools/profcat.mjs <prof.json> [dist]
import fs from "node:fs";
const [file, dist = "dist-jit"] = process.argv.slice(2);
const profiles = JSON.parse(fs.readFileSync(file));
const syms = new Map();
for (const l of fs.readFileSync(new URL(`../site/${dist}/qemu-system-arm.js.symbols`, import.meta.url), "utf8").split("\n")) {
  const m = l.match(/^(\d+):(.*)$/); if (m) syms.set(m[1], m[2]);
}
const MAIN = /qemu-system-arm\.wasm$/;
const classify = (fr) => {
  const url = fr.url || "";
  const fn = fr.functionName || "";
  const m = /wasm-function\[(\d+)\]/.exec(fn);
  if (url.startsWith("wasm://") || (m && !MAIN.test(url))) return ["jit-guest", "(jit module)"];
  const name = m ? (syms.get(m[1]) || fn) : fn;
  if (/^tcg_qemu_tb_exec$/.test(name)) return ["jit-guest", "tcg_qemu_tb_exec"];
  if (/^(Module|Instance)$/.test(name)) return ["compile-" + name, name];
  if (/w64_batch_instantiate|w64_assemble|w64_batch_close|w64_batch_member|w64_instantiate|imports\.<computed>/.test(name)) return ["compile-glue", name];
  if (/^(tcg_|liveness|reachable_code|tb_gen_code|setjmp_gen_code|translator_|arm_tr_|disas_|gen_|thumb_|decode_|tcg_out|w64_spec|tb_link|tb_page|tb_add|tb_remove|tcg_temp|temp_|op_|la_|tcg_gen)/.test(name) || /trans_|translate/.test(name)) return ["translate", name];
  if (/lookup_tb_ptr|tb_lookup|tb_htable_lookup|qht_|tb_lookup_cmp|arm_get_tb_cpu_state|curr_cflags|jmp_cache/.test(name)) return ["tb-lookup", name];
  if (/_mmu$|mmu_lookup|_mmio_|tlb_|probe_access|io_prepare|io_read|io_write|address_space|memory_region|flatview|get_page_addr_code|victim_tlb|ram_block|iotlb|phys_page_find|section/.test(name)) return ["memory", name];
  if (/futex|mutex|timedwait|bql_|cond_|__timedwait|pthread/.test(name)) return ["locks-waits", name];
  if (/^(tpu_|vic_|pmb887x|dif_|dmac_|scu_|gptu_|stm_|rtc_|usart|ssc_|dsp_|pcl_|i2c|keypad|cpu_do_interrupt|arm_cpu_do_interrupt|qemu_set_irq|timer_|timerlist|qemu_clock|icount|cpsr_write|helper_cpsr|rebuild_hflags|arm_rebuild|do_interrupt|cpu_handle_interrupt|arm_cpu_exec_interrupt|cpu_exec|cpu_tb_exec|helper_|qemu_irq)/.test(name)) return ["cpu-loop+devices", name];
  if (/^tcg_qemu_tb_exec$/.test(name)) return ["jit-guest", "tcg_qemu_tb_exec"];
  return ["other", name];
};
let pick = 0, best = 0;
profiles.forEach((p, i) => {
  let busy = 0;
  for (let j = 0; j < p.samples.length; j++) {
    const n = p.nodes.find((n) => n.id === p.samples[j]);
    if (!n) continue;
    const [c] = classify(n.callFrame);
    if (c !== "locks-waits" && !/idle/.test(n.callFrame.functionName)) busy += p.timeDeltas[j] || 0;
  }
  if (busy > best) { best = busy; pick = i; }
});
const p = profiles[pick];
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const cat = new Map(), top = new Map();
let sum = 0;
for (let j = 0; j < p.samples.length; j++) {
  const n = byId.get(p.samples[j]); if (!n) continue;
  const dt = p.timeDeltas[j] || 0; sum += dt;
  const [c, name] = classify(n.callFrame);
  cat.set(c, (cat.get(c) || 0) + dt);
  const k = c + " | " + name;
  top.set(k, (top.get(k) || 0) + dt);
}
console.log(`profile #${pick}, total ${(sum / 1e3).toFixed(0)} ms`);
for (const [k, v] of [...cat.entries()].sort((a, b) => b[1] - a[1]))
  console.log((v / 1e3).toFixed(0).padStart(8) + " ms " + (100 * v / sum).toFixed(1).padStart(5) + " %  " + k);
console.log("\n-- top 'other' / 'cpu-loop+devices' symbols --");
for (const [k, v] of [...top.entries()].filter(([k]) => /^(other|cpu-loop)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 30))
  console.log((v / 1e3).toFixed(0).padStart(8) + " ms  " + k);

// FN=<substr>: caller stacks (self samples) of matching functions
if (process.env.FN) {
  const want = process.env.FN;
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const stacks = new Map();
  for (let j = 0; j < p.samples.length; j++) {
    const n = byId.get(p.samples[j]); if (!n) continue;
    const [, name] = classify(n.callFrame);
    if (!name.includes(want)) continue;
    const chain = [];
    let cur = parent.get(p.samples[j]);
    while (cur !== undefined && chain.length < 10) {
      const a = byId.get(cur); if (!a) break;
      chain.push(classify(a.callFrame)[1]);
      cur = parent.get(cur);
    }
    const k = chain.join(" <- ");
    stacks.set(k, (stacks.get(k) || 0) + (p.timeDeltas[j] || 0));
  }
  console.log(`\n-- callers of *${want}* --`);
  for (const [k, v] of [...stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
    console.log((v / 1e3).toFixed(0).padStart(6) + " ms  " + k);
}
