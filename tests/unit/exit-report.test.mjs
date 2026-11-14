import { test } from "node:test";
import assert from "node:assert/strict";
import { serialMessages, parseExit } from "../../site/exit-report.js";

const frame = (t) => "\xff\xfe" + String.fromCharCode(t.length >> 8, t.length & 255, (t.length ^ 1) >> 8, (t.length ^ 1) & 255) + t;

test("serialMessages: frames, plain runs and a frame still arriving", () => {
  assert.deepEqual(serialMessages("boot ok\r\n" + frame("one") + frame("two") + "\x00tail"), ["boot ok", "one", "two", "tail"]);
  // a header whose length check fails is plain bytes, cut on the non-printables
  assert.deepEqual(serialMessages("\xff\xfe\x00\x03\x00\x03abc"), ["abc"]);
  // a frame cut short is held back, not split
  assert.deepEqual(serialMessages("x " + frame("complete").slice(0, 8)), ["x "]);
  assert.deepEqual(serialMessages(""), []);
});

test("parseExit: x75/x85 dump, newest one wins, ends at the first non-field", () => {
  const dump = (code) => [">>EXIT<<", "ExitType: Processor Exit", `ExitCode: ${code}`, "FILE: Prefetch_Abort!", "CPSR: 0x20000110"];
  const msgs = serialMessages([...dump("0x0101"), "later", ...dump("0x0206"), "not a field", "Checksum: 0x0"].map(frame).join(""));
  const r = parseExit(msgs);
  assert.equal(r.type, "Processor Exit");
  assert.equal(r.code, "0x0206");
  assert.deepEqual(r.rows.map(([n]) => n), ["Type", "Code", "File", "CPSR"]);
});

test("parseExit: x65 prints a label and its value as two messages", () => {
  const msgs = ["EXIT: 000E:F7FB", "FILE: ", "ddsphw", "CPSR: 60000130", "ExitString: ", "CepId: FFFF"];
  const r = parseExit(msgs);
  assert.equal(r.code, "000E:F7FB");
  assert.deepEqual(r.rows, [["Code", "000E:F7FB"], ["File", "ddsphw"], ["CPSR", "60000130"], ["String", ""], ["CepId", "FFFF"]]);
});

test("parseExit: no dump", () => {
  assert.equal(parseExit(["hello", "EXITED"]), null);
});
