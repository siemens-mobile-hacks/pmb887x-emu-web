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
}
globalThis.WebSocket = FakeSocket;
const { GprsNet } = await import("../../site/gprs-net.js");

// a phone whose next poll() finds `queued` frames to send
function rig() {
  FakeSocket.made = [];
  let queued = 0;
  const m = {
    HEAPU8: new Uint8Array(2048),
    _wasm_net_attach: () => 1, _wasm_net_buf: () => 0, _wasm_net_put: () => 1,
    _wasm_net_take: () => (queued > 0 ? (queued--, 60) : 0),
  };
  const statuses = [];
  const g = new GprsNet(m, { url: "ws://gw/gprs", onStatus: (s, why) => statuses.push(why ? `${s}: ${why}` : s) });
  const send = (n = 1) => { queued = n; g.poll(); };
  return { g, send, statuses, last: () => FakeSocket.made.at(-1) };
}

test("GprsNet: redials after a close only for a frame, after the backoff", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1e9 });
  const { g, send, statuses, last } = rig();
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
  assert.deepEqual(statuses, ["connecting", "online", "offline: GPRS disconnected after a long idle time", "online"]);
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
  const { g, send, statuses } = rig();
  g.connect();
  g.stop();
  t.mock.timers.tick(60e3);
  send();
  assert.equal(FakeSocket.made.length, 1);
  assert.deepEqual(statuses, ["connecting"]);
});
