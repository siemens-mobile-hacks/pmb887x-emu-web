import { test } from "node:test";
import assert from "node:assert/strict";
import {
  untar, boardText, boardChain, readPanel, readBoardName, readAccessories, boardCpu, gsmBoardHasRadio, boardHasDisplay, boardHasSimSlot,
} from "../../site/boards.js";

// a minimal ustar archive: one 512-byte header per file, data padded to 512
function tar(files) {
  const blocks = [];
  for (const [name, text, opts = {}] of files) {
    const data = new TextEncoder().encode(text);
    const h = new Uint8Array(512);
    const put = (off, s) => h.set(new TextEncoder().encode(s), off);
    put(0, opts.name ?? name);
    put(124, data.length.toString(8).padStart(11, "0") + " ");
    put(156, opts.type ?? "0");
    put(257, opts.magic ?? "ustar\u000000");
    if (opts.prefix) put(345, opts.prefix);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out.buffer;
}

const read = (buf) => {
  const got = [];
  untar(buf, (name, data) => got.push([name, new TextDecoder().decode(data)]));
  return got;
};

test("untar: names, contents, ./ and the ustar prefix, directories skipped", () => {
  const buf = tar([
    ["a.toml", "x = 1\n"],
    ["./b.toml", "y".repeat(700)],
    ["dir/", "", { type: "5" }],
    ["c.toml", "z", { prefix: "include/" }],
  ]);
  assert.deepEqual(read(buf), [["a.toml", "x = 1\n"], ["b.toml", "y".repeat(700)], ["include/c.toml", "z"]]);
});

test("untar: an empty archive yields nothing", () => {
  assert.deepEqual(read(new ArrayBuffer(1024)), []);
});

// "<len> key=value\n", len counting its own digits and the bytes
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bytes = (n) => new TextEncoder().encode(String(n) + body).length;
  let n = bytes(0);
  while (bytes(n) !== n) n = bytes(n);
  return String(n) + body;
}

test("untar: pax and GNU long names name the next file; globals and ._* skipped", () => {
  const long = "include/" + "d".repeat(70) + "/" + "e".repeat(70) + "/плата.toml";
  const buf = tar([
    ["pax_global_header", paxRecord("comment", "x"), { type: "g" }],
    ["./PaxHeaders/x", paxRecord("mtime", "1") + paxRecord("path", long), { type: "x" }],
    [long.slice(0, 99), "pax"],
    ["././@LongLink", long.replace("плата", "gnu") + "\0", { type: "L", magic: "ustar  \0" }],
    [long.slice(0, 99), "gnu", { magic: "ustar  \0" }],
    ["._a.toml", "apple"],
    ["include/._b.toml", "apple"],
    ["a.toml", "a"],
  ]);
  assert.deepEqual(read(buf), [[long, "pax"], [long.replace("плата", "gnu"), "gnu"], ["a.toml", "a"]]);
});

test("untar: no ustar magic, no archive", () => {
  assert.throws(() => read(tar([["a.toml", "a", { magic: "\0".repeat(8) }]])), /not a ustar archive/);
  const junk = new Uint8Array(2048).fill(0x41);
  assert.throws(() => read(junk.buffer), /not a ustar archive/);
});

function load(files) {
  boardText.clear();
  for (const [k, v] of Object.entries(files)) boardText.set(k, v);
}

test("boardChain follows extends, board first, and stops at the cap and on cycles", () => {
  load({
    "p.toml": 'extends = "include/q.toml"\n', "include/q.toml": "q = 1\n",
    "c0.toml": 'extends = "c1.toml"\n', "c1.toml": 'extends = "c0.toml"\n',
  });
  assert.deepEqual(boardChain("p.toml").map(([f]) => f), ["p.toml", "include/q.toml"]);
  assert.equal(boardChain("c0.toml").length, 5);
  assert.deepEqual(boardChain("missing.toml"), []);
});

test("boardChain resolves extends from the including file's directory", () => {
  load({
    "p.toml": 'extends = "include/q.toml"\n', "include/q.toml": 'extends = "r.toml"\n',
    "include/r.toml": 'extends = "../s.toml"\n', "r.toml": "wrong = 1\n", "s.toml": "s = 1\n",
  });
  assert.deepEqual(boardChain("p.toml").map(([f]) => f), ["p.toml", "include/q.toml", "include/r.toml", "s.toml"]);
});

test("readers take the first file of the chain that answers", () => {
  load({
    "phone.toml": 'extends = "base.toml"\n[board]\nvendor = "Siemens"\n[peripheral.LCD0]\nwidth = 132\n',
    "base.toml": '[board]\nvendor = "X"\nmodel = "Y"\ncpu.type = "pmb8876"\n[peripheral.LCD0]\nwidth = 132\nheight = 176\n'
      + '[peripheral.RF]\ntype = "pmb6270"\n',
    "bare.toml": "[board]\n",
  });
  assert.deepEqual(readPanel("phone.toml"), { w: 132, h: 176 });
  assert.equal(readBoardName("phone.toml"), "X Y");
  assert.equal(boardCpu("phone"), "pmb8876");
  assert.equal(gsmBoardHasRadio("phone"), true);
  assert.equal(gsmBoardHasRadio("bare"), false);
  assert.equal(readPanel("bare.toml"), null);
  assert.equal(readBoardName("nope.toml"), null);
});

test("boardHasDisplay: an LCD0 panel anywhere in the chain, with or without a size", () => {
  load({
    "phone.toml": 'extends = "include/sg2.toml"\n[board]\nmodel = "S75"\n',
    "include/sg2.toml": '[peripheral.LCD0]\ntype = "ssd1286"\nbus = "DIF"\n',
    "chip.toml": '[board]\ncpu.type = "pmb8876"\n[peripheral.GIMMICK]\ntype = "s1d13732"\n# [peripheral.LCD0]\n',
  });
  assert.equal(boardHasDisplay("phone"), true);
  assert.equal(boardHasDisplay("chip"), false);
  assert.equal(boardHasDisplay("missing"), false);
});

test("readPanel: a panel named by type alone has its model's size", () => {
  load({
    "s75.toml": 'extends = "include/sg2.toml"\n[board]\nmodel = "S75"\n',
    "include/sg2.toml": '[peripheral.LCD0]\ntype = "ssd1286"\nbus = "DIF"\n',
    "sl65.toml": 'extends = "include/sg2.toml"\n[peripheral.LCD0]\ntype = "l2f50250"\n',
    "big.toml": '[peripheral.LCD0]\ntype = "jbt6k71"\n',
  });
  assert.deepEqual(readPanel("s75.toml"), { w: 132, h: 176 });
  assert.deepEqual(readPanel("sl65.toml"), { w: 130, h: 130 }, "the board's own type before the include's");
  assert.deepEqual(readPanel("big.toml"), { w: 240, h: 320 }, "lcd.c's default");
});

test("boardHasSimSlot: a slot in the board or an include, not in a comment", () => {
  load({
    "phone.toml": 'extends = "include/sg2.toml"\n[board]\nmodel = "S75"\n',
    "include/sg2.toml": '[peripheral.SIM]\ntype = "iso7816-slot"\n',
    "noslot.toml": '[board]\n# [peripheral.SIM]\n# type = "iso7816-slot"\n',
  });
  assert.equal(boardHasSimSlot("phone"), true);
  assert.equal(boardHasSimSlot("noslot"), false);
  assert.equal(boardHasSimSlot("missing"), false);
});

test("readAccessories: the profile names one brace deep, default and unplugged", () => {
  load({
    "a.toml": `[peripheral.CONN]
type = "accessory-connector"
default = "data-cable"
unplugged = "none"
accessories = {
  none = { id = 0 },  # comment with = sign
  data-cable = { id = 1, nested = { deep = 2 } },
  "quoted = not a key" = 3,
  music_set = { id = "x}" },
}
[peripheral.OTHER]
type = "foo"
`,
    "child.toml": 'extends = "a.toml"\n[peripheral.X]\ntype = "bar"\n',
    "plain.toml": '[peripheral.CONN]\ntype = "accessory-connector"\n',
  });
  const want = { names: ["none", "data-cable", "music_set"], default: "data-cable", unplugged: "none" };
  assert.deepEqual(readAccessories("a.toml"), want);
  assert.deepEqual(readAccessories("child.toml"), want);
  assert.deepEqual(readAccessories("plain.toml"), { names: [], default: null, unplugged: null });
  assert.equal(readAccessories("missing.toml"), null);
});
