import { test } from "node:test";
import assert from "node:assert/strict";
import { tapTable, forDevice, caseStep, KBD_KEYBOARDS } from "../../site/keyboards.js";

test("tapTable: multi-tap counts take the shortest cycle", () => {
  const t = tapTable("siemens", "en");
  assert.deepEqual(t.chars.get("a"), { key: "2", count: 1 });
  assert.deepEqual(t.chars.get("c"), { key: "2", count: 3 });
  assert.equal(tapTable("no-such-keyboard", "en").chars.get("a").key, "2");
});

test("tapTable: ring picker takes the shorter way round (Siemens)", () => {
  const s75 = tapTable("s75", "en").chars.get("§");
  assert.deepEqual(s75.keys, ["star", ...Array(24).fill("right"), "center"]);
  const gen = tapTable("siemens", "en").chars.get("§").keys;
  assert.equal(gen[0], "star");
  assert.equal(gen.at(-1), "center");
  assert.ok(gen.slice(1, -1).every((k) => k === gen[1]));
});

test("tapTable: paged picker turns the fewer pages (LG) and carries its waits", () => {
  const t = tapTable("ke800", "en");
  assert.deepEqual(t.chars.get("<"), { keys: ["star", "down", "down", "1", "left_soft"], settle: 800, after: 600 });
  assert.deepEqual(t.chars.get("}").keys, ["star", "up", "1", "left_soft"]);
});

test("forDevice: the device's own, else its chip's, else the default", () => {
  const set = { default: "d", pmb8875: "c", "siemens-x": "own" };
  assert.equal(forDevice(set, "siemens-x", "pmb8875"), "own");
  assert.equal(forDevice(set, "siemens-y", "pmb8875"), "c");
  assert.equal(forDevice(set, "siemens-y", "pmb8876"), "d");
  assert.equal(forDevice(5, "a", "b"), 5);
});

test("caseStep: Siemens keeps the case it left; LG wraps every capital", () => {
  const sie = KBD_KEYBOARDS.s75.upper, lg = KBD_KEYBOARDS.ke800.upper;
  const run = (up, seq) => {
    let state = "lower";
    return seq.map((a) => { const r = caseStep(up, state, a); state = r.state; return [r.before.join(), state]; });
  };
  const U = { upper: true, letter: true }, l = { upper: false, letter: true }, d = { upper: false, letter: false };
  assert.deepEqual(run(sie, [U, U, U, l]), [["hash", "one"], ["hash", "caps"], ["", "caps"], ["hash", "lower"]]);
  assert.deepEqual(run(sie, [U, d, l]), [["hash", "one"], ["", "lower"], ["", "lower"]]);
  const r = caseStep(lg, "lower", U);
  assert.deepEqual([r.before, r.after, r.state], [lg.before, lg.after, "lower"]);
  assert.deepEqual(caseStep(lg, "lower", l), { before: [], after: [], state: "lower" });
  assert.deepEqual(caseStep(undefined, "one", U), { before: [], after: [], state: "one" });
});

// The legend is what the user reads off the key, the taps what pressing it
// types: every Cyrillic letter printed on a key must come from that key
// (the taps may type more than the key prints, ё on 3 say).
test("legends: a key's Cyrillic letters are typed by that key", () => {
  const bad = [];
  for (const [id, kbd] of Object.entries(KBD_KEYBOARDS)) {
    for (const [v, { subs, taps }] of Object.entries(kbd.variants)) {
      if (!subs || !taps) continue;
      for (const key of Object.keys(subs)) {
        const typed = [taps[key] ?? ""].flat().join("");
        const missing = [...subs[key]].filter((c) => /[Ѐ-ӿ]/.test(c) && !typed.includes(c));
        if (missing.length) bad.push(`${id}/${v} ${key}: ${missing.join("")} is not typed by its key`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
