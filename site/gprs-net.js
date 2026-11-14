// The phone's Internet in the browser (doc/gsm-network.md). qemu's built-in
// GSM cell hands the phone's IP side to the page as Ethernet frames
// (ui/wasm.c: a port on the cell's hub, read with _wasm_net_take, written
// with _wasm_net_put), and this relays them over a WebSocket to the GPRS
// gateway at /gprs (bts-emulator's gprs-gw), where a slirp of its own is the
// phone's network: the phone is 10.0.2.15, its gateway 10.0.2.2, its DNS
// 10.0.2.3, and the operator's WAP and MMS settings work unchanged.

// what the gateway's close codes mean to the user
const CLOSED = {
  4001: "Two phones from this address are online already",
  4002: "The GPRS gateway is full, try again later",
  4003: "This address is banned from the GPRS gateway",
  4029: "Too many GPRS connections from this address, try again in a minute",
  4004: "Today's GPRS traffic for this address is used up",
  4008: "GPRS disconnected after a long idle time",
  4009: "This page may not use the GPRS gateway",
};

// After a close the link is dialled again only when the phone has a frame
// to send, and not before the backoff has passed: 1 s, doubling to 30 s
// while the gateway stays away, back to 1 s once a link held for a minute.
// The gateway counts every attempt (4029 above 20 a minute), so a refusal
// that may clear waits a minute, and one that will not today is final.
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30000;
const HELD_MS = 60000;
const REFUSED_WAIT = { 4001: 60000, 4002: 60000, 4029: 60000 };
const REFUSED_FINAL = new Set([4003, 4004, 4009]);

// the size of qemu's staging buffer (NET_FRAME_MAX in qemu/ui/wasm.c):
// _wasm_net_put checks the length only after the copy into it
const NET_FRAME_MAX = 1600;

export class GprsNet {
  constructor(module, { url = gatewayUrl(), onStatus = () => {} } = {}) {
    this.m = module;
    this.url = url;
    this.onStatus = onStatus;
    this.ws = null;
    this.attached = false;
    this.timer = 0;
    this.frames = { in: 0, out: 0 };
    this.backoff = BACKOFF_MIN;
    this.retryAt = 0;    // when a frame may dial again; Infinity: never
    this.openedAt = 0;
  }

  start() {
    if (this.timer) return;
    this.retryAt = 0;
    this.connect();
    this.timer = setInterval(() => this.poll(), 20);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    this.retryAt = Infinity;
    this.ws?.close();
    this.ws = null;
  }

  // a redial keeps the offline caption up until the link is back
  connect(redial = false) {
    const ws = this.ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.openedAt = 0;
    if (!redial) this.onStatus("connecting");
    ws.onopen = () => {
      this.openedAt = Date.now();
      this.onStatus("online");
    };
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer) || !this.attached) return;
      if (e.data.byteLength > NET_FRAME_MAX) return;
      const m = this.m;
      m.HEAPU8.set(new Uint8Array(e.data), Number(m._wasm_net_buf()));
      if (m._wasm_net_put(e.data.byteLength)) this.frames.in++;
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const now = Date.now();
      if (this.openedAt && now - this.openedAt >= HELD_MS) this.backoff = BACKOFF_MIN;
      if (REFUSED_FINAL.has(e.code)) this.retryAt = Infinity;
      else {
        this.retryAt = now + Math.max(this.backoff, REFUSED_WAIT[e.code] ?? 0);
        this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
      }
      this.onStatus("offline", CLOSED[e.code] ?? "The GPRS gateway is not reachable");
    };
  }

  // the phone's frames go out as they come; none queue while offline, and
  // one that finds the link gone dials it again once the backoff allows
  poll() {
    const m = this.m;
    if (!this.attached && !(this.attached = !!m._wasm_net_attach())) return;
    const buf = Number(m._wasm_net_buf());
    let len;
    while ((len = m._wasm_net_take()) > 0) {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        if (!this.ws && Date.now() >= this.retryAt) this.connect(true);
        continue;
      }
      this.ws.send(m.HEAPU8.slice(buf, buf + len));
      this.frames.out++;
    }
  }
}

export function gatewayUrl() {
  const u = new URL("gprs", location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}
