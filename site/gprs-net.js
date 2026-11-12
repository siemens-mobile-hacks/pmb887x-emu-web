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

export class GprsNet {
  constructor(module, { url = gatewayUrl(), onStatus = () => {} } = {}) {
    this.m = module;
    this.url = url;
    this.onStatus = onStatus;
    this.ws = null;
    this.attached = false;
    this.timer = 0;
    this.frames = { in: 0, out: 0 };
  }

  start() {
    if (this.timer) return;
    this.connect();
    this.timer = setInterval(() => this.poll(), 20);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    this.ws?.close();
    this.ws = null;
  }

  connect() {
    const ws = this.ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.onStatus("connecting");
    ws.onopen = () => this.onStatus("online");
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer) || !this.attached) return;
      const m = this.m;
      m.HEAPU8.set(new Uint8Array(e.data), Number(m._wasm_net_buf()));
      if (m._wasm_net_put(e.data.byteLength)) this.frames.in++;
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onStatus("offline", CLOSED[e.code] ?? "The GPRS gateway is not reachable");
    };
  }

  // the phone's frames go out as they come; none queue while offline
  poll() {
    const m = this.m;
    if (!this.attached && !(this.attached = !!m._wasm_net_attach())) return;
    const buf = Number(m._wasm_net_buf());
    let len;
    while ((len = m._wasm_net_take()) > 0) {
      if (this.ws?.readyState !== WebSocket.OPEN) continue;
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
