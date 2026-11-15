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

// The link is dialled only when the phone has a frame to send: the first
// time it uses GPRS, so a phone that never does holds none of the
// gateway's connections, and after a close not before the backoff has
// passed: 1 s, doubling to 30 s while the gateway stays away, back to 1 s
// once a link held for a minute. The gateway counts every attempt (4029
// above 20 a minute), so a refusal that may clear waits a minute, and one
// that will not today is final.
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30000;
const HELD_MS = 60000;
const REFUSED_WAIT = { 4001: 60000, 4002: 60000, 4029: 60000 };
const REFUSED_FINAL = new Set([4003, 4004, 4009]);

// the shortest gap between two "traffic" notices: a page lights its
// indicator from them, a few times a second at most
const TRAFFIC_MS = 250;

// the size of qemu's staging buffer (NET_FRAME_MAX in qemu/ui/wasm.c):
// _wasm_net_put checks the length only after the copy into it
const NET_FRAME_MAX = 1600;

// state: "idle" (no link, none wanted yet), "connecting", "online",
// "offline" (closed or never reached: reason and code say why, retryAt when
// a frame may dial again, Infinity for never) and "off" after stop().
// onChange("state") follows every change of state; onChange("traffic")
// follows frames counted since the last notice, at most every TRAFFIC_MS.
export class GprsNet {
  constructor(module, { url = gatewayUrl(), onChange = () => {} } = {}) {
    this.m = module;
    this.url = url;
    this.onChange = onChange;
    this.ws = null;
    this.attached = false;
    this.timer = 0;
    this.state = "idle";
    this.reason = "";    // why the link is down; kept while it is dialled again
    this.code = 0;
    this.frames = { in: 0, out: 0 };
    this.bytes = { in: 0, out: 0 };
    this.backoff = BACKOFF_MIN;
    this.retryAt = 0;    // when a frame may dial again; Infinity: never
    this.openedAt = 0;
    this.noticed = 0;    // frames in + out at the last traffic notice
    this.noticedAt = 0;
  }

  start() {
    if (this.timer) return;
    this.retryAt = 0;
    this.timer = setInterval(() => this.poll(), 20);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    this.retryAt = Infinity;
    this.ws?.close();
    this.ws = null;
    this.setState("off");
  }

  setState(state) {
    this.state = state;
    this.onChange("state");
  }

  connect() {
    const ws = this.ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.openedAt = 0;
    this.setState("connecting");
    ws.onopen = () => {
      this.openedAt = Date.now();
      this.reason = "";
      this.code = 0;
      this.setState("online");
    };
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer) || !this.attached) return;
      const len = e.data.byteLength;
      if (len > NET_FRAME_MAX) return;
      const m = this.m;
      m.HEAPU8.set(new Uint8Array(e.data), Number(m._wasm_net_buf()));
      if (m._wasm_net_put(len)) {
        this.frames.in++;
        this.bytes.in += len;
      }
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
      this.code = e.code;
      this.reason = CLOSED[e.code] ?? "The GPRS gateway is not reachable";
      this.setState("offline");
    };
  }

  // the phone's frames go out as they come; none queue while offline, and
  // one that finds no link dials it once the backoff allows
  poll() {
    const m = this.m;
    if (!this.attached && !(this.attached = !!m._wasm_net_attach())) return;
    const buf = Number(m._wasm_net_buf());
    let len;
    while ((len = m._wasm_net_take()) > 0) {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        if (!this.ws && Date.now() >= this.retryAt) this.connect();
        continue;
      }
      this.ws.send(m.HEAPU8.slice(buf, buf + len));
      this.frames.out++;
      this.bytes.out += len;
    }
    const n = this.frames.in + this.frames.out;
    if (n !== this.noticed) {
      const now = Date.now();
      if (now - this.noticedAt >= TRAFFIC_MS) {
        this.noticed = n;
        this.noticedAt = now;
        this.onChange("traffic");
      }
    }
  }
}

export function gatewayUrl() {
  const u = new URL("gprs", location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}
