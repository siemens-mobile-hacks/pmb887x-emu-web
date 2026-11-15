import { test } from "node:test";
import assert from "node:assert/strict";

class FakeSocket {
  static OPEN = 1;
  static made = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = 0; FakeSocket.made.push(this); }
  send() { this.sent++; }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  drop(code) { this.readyState = 3; this.onclose?.({ code }); }
  receive(bytes) { this.onmessage?.({ data: new ArrayBuffer(bytes) }); }
}
globalThis.WebSocket = FakeSocket;
const { GprsNet } = await import("../../site/gprs-net.js");

// a phone whose next poll() finds `queued` frames of 60 bytes to send
function rig({ put = () => 1 } = {}) {
  FakeSocket.made = [];
  let queued = 0;
  const m = {
    HEAPU8: new Uint8Array(2048),
    _wasm_net_attach: () => 1, _wasm_net_buf: () => 0, _wasm_net_put: put,
    _wasm_net_take: () => (queued > 0 ? (queued--, 60) : 0),
  };
  const states = [];
  let traffic = 0;
  const g = new GprsNet(m, {
    url: "ws://gw/gprs",
    onChange: (what) => {
      if (what === "traffic") traffic++;
      else states.push(g.reason ? `${g.state}: ${g.reason}` : g.state);
    },
  });
  const send = (n = 1) => { queued = n; g.poll(); };
  return { g, send, states, traffic: () => traffic, last: () => FakeSocket.made.at(-1) };
}

test("GprsNet: start() dials only when the phone first sends", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1e9 });
  const { g, states, last } = rig();
  let queued = 0;
  g.m._wasm_net_take = () => (queued > 0 ? (queued--, 60) : 0);
  g.start();
  t.mock.timers.tick(10 * 60e3);           // ten minutes of 20 ms polls, no frame
  assert.equal(FakeSocket.made.length, 0);
  assert.equal(g.state, "idle");
  queued = 1;
  t.mock.timers.tick(20);
  assert.equal(FakeSocket.made.length, 1);
  assert.deepEqual(states, ["connecting"]);
  last().open();
  queued = 2;
  t.mock.timers.tick(20);
  assert.equal(last().sent, 2);
  g.stop();
});

test("GprsNet: redials after a close only for a frame, after the backoff", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1e9 });
  const { g, send, states, last } = rig();
  g.connect();
  last().open();
  send(3);
  assert.equal(last().sent, 3);
  t.mock.timers.tick(16 * 60e3);
  last().drop(4008);                       // the gateway's idle close
  t.mock.timers.tick(5000);
  g.poll();                                // nothing to send: no dial
  assert.equal(FakeSocket.made.length, 1);
  send();                                  // a frame: the link held, so 1 s backoff is over
  assert.equal(FakeSocket.made.length, 2);
  send();                                  // still connecting: no second dial
  assert.equal(FakeSocket.made.length, 2);
  last().open();
  send(2);
  assert.equal(last().sent, 2);
  const idle = "GPRS disconnected after a long idle time";
  assert.deepEqual(states, ["connecting", "online", `offline: ${idle}`, `connecting: ${idle}`, "online"]);
});

test("GprsNet: an unreachable gateway is dialled at 1, 2, 4 … 30 s", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1e9 });
  const { g, send, last } = rig();
  g.connect();
  last().drop(1006);
  const gaps = [];
  let t0 = Date.now();
  for (let s = 0; s < 125; s += 0.25) {
    t.mock.timers.tick(250);
    const n = FakeSocket.made.length;
    send();
    if (FakeSocket.made.length > n) {
      gaps.push(Math.round((Date.now() - t0) / 1000));
      t0 = Date.now();
      last().drop(1006);
    }
  }
  assert.deepEqual(gaps, [1, 2, 4, 8, 16, 30, 30, 30]);
});

test("GprsNet: refusals never redial quickly; a final one never", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1e9 });
  for (const code of [4001, 4002, 4029]) {
    const { g, send, last } = rig();
    g.connect();
    last().drop(code);
    t.mock.timers.tick(59e3);
    send();
    assert.equal(FakeSocket.made.length, 1, `${code} redialled within a minute`);
    t.mock.timers.tick(1e3);
    send();
    assert.equal(FakeSocket.made.length, 2, `${code} not redialled after a minute`);
  }
  for (const code of [4003, 4004, 4009]) {
    const { g, send, last } = rig();
    g.connect();
    last().drop(code);
    t.mock.timers.tick(24 * 3600e3);
    send();
    assert.equal(FakeSocket.made.length, 1, `${code} redialled`);
  }
});

test("GprsNet: stop() leaves nothing to redial", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1e9 });
  const { g, send, states, last } = rig();
  g.connect();
  const ws = last();
  g.stop();
  ws.drop(1000);                           // the close stop() asked for
  t.mock.timers.tick(60e3);
  send();
  assert.equal(FakeSocket.made.length, 1);
  assert.deepEqual(states, ["connecting", "off"]);
  assert.equal(g.state, "off");
});

test("GprsNet: every close says why, with its code and when it may redial", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1e9 });
  const want = {
    4001: ["Two phones from this address are online already", 60e3],
    4002: ["The GPRS gateway is full, try again later", 60e3],
    4003: ["This address is banned from the GPRS gateway", Infinity],
    4004: ["Today's GPRS traffic for this address is used up", Infinity],
    4008: ["GPRS disconnected after a long idle time", 1e3],
    4009: ["This page may not use the GPRS gateway", Infinity],
    4029: ["Too many GPRS connections from this address, try again in a minute", 60e3],
    1006: ["The GPRS gateway is not reachable", 1e3],
    1000: ["The GPRS gateway is not reachable", 1e3],
  };
  for (const [code, [reason, wait]] of Object.entries(want)) {
    const { g, last } = rig();
    g.connect();
    last().drop(Number(code));
    assert.equal(g.state, "offline", code);
    assert.equal(g.code, Number(code));
    assert.equal(g.reason, reason, code);
    assert.equal(g.retryAt - Date.now(), wait, code);
  }
  // a link that comes back forgets the last close
  const { g, last, send } = rig();
  g.connect();
  last().drop(4008);
  t.mock.timers.tick(1e3);
  send();
  assert.equal(g.state, "connecting");
  assert.equal(g.reason, "GPRS disconnected after a long idle time");
  last().open();
  assert.deepEqual([g.state, g.reason, g.code], ["online", "", 0]);
});

test("GprsNet: counts frames and bytes each way, only those that went through", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1e9 });
  let accept = 1;
  const { g, send, last } = rig({ put: () => accept });
  g.connect();
  send(2);                                 // not open yet: dropped, not counted
  last().open();
  send(3);
  last().receive(100);
  last().receive(1601);                    // longer than qemu's buffer
  accept = 0;
  last().receive(80);                      // qemu's ring is full
  assert.deepEqual(g.frames, { in: 1, out: 3 });
  assert.deepEqual(g.bytes, { in: 100, out: 180 });
});

test("GprsNet: traffic is noticed at most every 250 ms, and only when there is some", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1e9 });
  const { g, send, last, traffic } = rig();
  g.connect();
  last().open();
  for (let ms = 0; ms < 1000; ms += 20) {  // a frame each way at every 20 ms poll
    t.mock.timers.tick(20);
    last().receive(40);
    send();
  }
  assert.equal(traffic(), 4);
  t.mock.timers.tick(1000);
  for (let i = 0; i < 20; i++) g.poll();   // quiet: nothing more
  assert.equal(traffic(), 5);              // the frames since the last notice, once
  t.mock.timers.tick(1000);
  g.poll();
  assert.equal(traffic(), 5);
});

test("GprsNet: reads the cell's ms-state once a second, notices each change, never dials for it", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1e9 });
  // mock tick() moves Date to its end before the intervals run: step it
  const run = (ms) => { for (let n = 0; n < ms; n += 20) t.mock.timers.tick(20); };
  const { g, states } = rig();
  let ms = 0, reads = 0;
  const notices = [];
  g.m._wasm_gsm_state = () => (reads++, ms);
  g.ms = 0;
  g.onChange = (what) => { if (what === "gsm") notices.push(g.ms); else states.push(g.state); };
  g.start();
  run(10e3);                // 500 polls of 20 ms
  assert.ok(reads >= 10 && reads <= 11, `${reads} reads in 10 s`);
  assert.deepEqual(notices, []);           // no change from the 0 it started with
  ms = 1;                                  // LOCATION UPDATING ACCEPT
  run(1000);
  ms = 1 | 2 | 4;                          // GMM ATTACH ACCEPT, then a PDP context
  run(1000);
  assert.deepEqual(notices, [1, 7]);
  assert.deepEqual([g.registered, g.gprsAttached, g.pdpActive], [true, true, true]);
  ms = 1;                                  // GMM DETACH
  run(1000);
  assert.deepEqual([g.registered, g.gprsAttached, g.pdpActive], [true, false, false]);
  assert.equal(FakeSocket.made.length, 0);
  assert.deepEqual(states, []);
  g.stop();
  const after = reads;
  run(10e3);                // stopped: no poll, no read
  assert.equal(reads, after);
});

test("GprsNet: a dist without _wasm_gsm_state has ms null and is never asked", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1e9 });
  const { g } = rig();
  assert.equal(g.ms, null);
  g.start();
  t.mock.timers.tick(5e3);
  assert.deepEqual([g.ms, g.registered, g.gprsAttached, g.pdpActive], [null, false, false, false]);
  g.stop();
});

test("GprsNet: a module with _wasm_gsm_state starts at 0, not registered", () => {
  FakeSocket.made = [];
  const g = new GprsNet({ _wasm_gsm_state: () => 1 }, { url: "ws://gw/gprs" });
  assert.equal(g.ms, 0);
  assert.equal(g.registered, false);
});
