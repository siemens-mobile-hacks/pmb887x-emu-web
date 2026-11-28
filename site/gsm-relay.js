// The virtual network's services in the browser (doc/gsm-relay.md): SMS,
// calls and USSD between the phones of every page (and real phones) on one
// relay server. qemu's cell (hw/gsm/gsm-relay.c)
// talks the relay's byte protocol over a chardev that is the page
// (ui/wasm.c: "-chardev wasm-gsm", read with _wasm_gsmrelay_take, written
// with _wasm_gsmrelay_put, the link's state given with _wasm_gsmrelay_open),
// and this carries the bytes over a WebSocket to serve.mjs's /gsmrelay,
// which pipes them to the relay's TCP port.
//
// The relay names each phone by the last digits of its IMSI (it moves to the
// next free number when that one is taken) and says which number it gave in
// an 'N' frame; the page shows it. Each page gets an IMSI of its own,
// kept in localStorage so the number stays the same across reloads:
// simImsi() below.

const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30000;
const HELD_MS = 60000;
const RELAY_BUF = 4096;   // RELAY_BUF_SIZE in qemu/ui/wasm.c
// relay bytes the cell has not taken: more means the emulator stalled, and the
// link is closed (and redialled) rather than handing the cell speech that old
const PENDING_MAX = 256 * 1024;

// state: "idle" (no machine yet), "connecting", "online", "offline" (the
// relay is not reachable; retried after a backoff), "off" after stop().
// onChange("state") and onChange("number") follow each change.
// alive(): is the module still running? Once it says no, or a call into the
// module throws (it aborted), the link stops by itself.
export class GsmRelay {
  constructor(module, { url = relayUrl(), onChange = () => {}, alive = () => true } = {}) {
    this.m = module;
    this.url = url;
    this.onChange = onChange;
    this.alive = alive;
    this.ws = null;
    this.timer = 0;
    this.state = "idle";
    this.number = "";
    this.backoff = BACKOFF_MIN;
    this.retryAt = 0;
    this.openedAt = 0;
    this.pending = [];       // relay bytes qemu has not taken yet
    this.pendingBytes = 0;
    this.rx = new Uint8Array(0);  // a frame of the relay cut by a message end
    this.bytes = { in: 0, out: 0 };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), 20);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState("off");
  }

  // fn() against the module, unless it is gone: then the link stops
  withModule(fn) {
    if (this.state === "off") return;
    try {
      if (!this.alive()) throw new Error("the emulator has exited");
      fn();
    } catch (e) {
      console.warn("gsm-relay: stopped:", e?.message ?? e);
      this.stop();
    }
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onChange("state");
  }

  connect() {
    const ws = this.ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.openedAt = 0;
    this.setState("connecting");
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.openedAt = Date.now();
      this.pending = [];
      this.pendingBytes = 0;
      this.rx = new Uint8Array(0);
      this.withModule(() => {
        this.m._wasm_gsmrelay_open(1);
        this.setState("online");
      });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || !(e.data instanceof ArrayBuffer)) return;
      const data = new Uint8Array(e.data);
      this.bytes.in += data.length;
      this.watch(data);
      this.pending.push(data);
      this.pendingBytes += data.length;
      this.withModule(() => this.feed());
      if (this.ws !== ws) return;
      if (this.pendingBytes > PENDING_MAX) {
        ws.close();
        return;
      }
      // a background tab's timers fire once a second at best (once a minute
      // after 5 minutes): what the relay sends drives the pump too
      this.poll();
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.withModule(() => this.m._wasm_gsmrelay_open(0));
      if (this.state === "off") return;
      const now = Date.now();
      if (this.openedAt && now - this.openedAt >= HELD_MS) this.backoff = BACKOFF_MIN;
      this.retryAt = now + this.backoff;
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
      this.setState("offline");
    };
  }

  // the relay's frames are [type][length][payload]: 'N' carries the number
  watch(data) {
    let b = this.rx.length ? concat(this.rx, data) : data;
    let i = 0;
    while (b.length - i >= 2 && b.length - i >= 2 + b[i + 1]) {
      if (b[i] === 0x4e) {
        const n = String.fromCharCode(...b.subarray(i + 2, i + 2 + b[i + 1]));
        if (n !== this.number) {
          this.number = n;
          this.onChange("number");
        }
      }
      i += 2 + b[i + 1];
    }
    this.rx = b.slice(i);
  }

  // into qemu's ring as far as it has room; the rest waits for the next poll
  feed() {
    const m = this.m;
    const buf = Number(m._wasm_gsmrelay_buf());
    while (this.pending.length) {
      const d = this.pending[0];
      const n = Math.min(d.length, RELAY_BUF);
      m.HEAPU8.set(d.subarray(0, n), buf);
      const took = m._wasm_gsmrelay_put(n);
      this.pendingBytes -= took;
      if (took < d.length) this.pending[0] = d.subarray(took);
      else this.pending.shift();
      if (took < n) break;
    }
  }

  poll() {
    this.withModule(() => this.pump());
  }

  pump() {
    const m = this.m;
    if (!m._wasm_gsmrelay_ready()) return;
    if (!this.ws && Date.now() >= this.retryAt) this.connect();
    if (this.pending.length) this.feed();
    const buf = Number(m._wasm_gsmrelay_buf());
    let len;
    while ((len = m._wasm_gsmrelay_take()) > 0) {
      if (this.ws?.readyState !== WebSocket.OPEN) continue;
      this.ws.send(m.HEAPU8.slice(buf, buf + len));
      this.bytes.out += len;
    }
  }
}

function concat(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
}

export function relayUrl() {
  const u = new URL("gsmrelay", location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

// Does this server pipe /gsmrelay to a relay? (serve.mjs answers a plain GET
// with {"relay": true} when GSM_RELAY is set.)
export async function relayOffered() {
  try {
    const res = await fetch("gsmrelay", { cache: "no-store" });
    return res.ok && (await res.json()).relay === true;
  } catch {
    return false;
  }
}

// The SIM's IMSI for this page: the operator's MCC+MNC and subscriber
// digits of its own, kept in localStorage ("gsm-relay-imsi": a list, one per
// tab open at once) so a reload keeps its number. A tab holds its entry with
// a Web Lock while it runs, so a second tab takes the next free one or adds
// a new one: two tabs with one IMSI would be one phone to the relay. Without
// Web Locks (a page over plain http on the LAN) no tab can tell which entries
// are taken: each tab then keeps its own in sessionStorage, which a reload of
// that tab keeps.
const IMSI_KEY = "gsm-relay-imsi";
const TAB_IMSI_KEY = "gsm-relay-imsi-tab";
let heldImsi = null;

const newSubscriber = (taken = []) => {
  let s;
  do {
    s = Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => x % 10).join("");
  } while (taken.includes(s));
  return s;
};

export async function simImsi(operator) {
  if (!navigator.locks) {
    let s = null;
    try { s = sessionStorage.getItem(TAB_IMSI_KEY); } catch {}
    if (!/^\d{10}$/.test(s ?? "")) {
      s = newSubscriber();
      try { sessionStorage.setItem(TAB_IMSI_KEY, s); } catch {}
    }
    return imsiOf(operator, heldImsi = s);
  }
  let list = [];
  try { list = JSON.parse(localStorage.getItem(IMSI_KEY) ?? "[]"); } catch {}
  if (!Array.isArray(list)) list = [];
  list = list.filter((s) => /^\d{10}$/.test(s));
  if (heldImsi && list.includes(heldImsi)) return imsiOf(operator, heldImsi);
  for (const s of list) {
    if (await hold(s)) return imsiOf(operator, heldImsi = s);
  }
  const s = newSubscriber(list);
  list.push(s);
  try { localStorage.setItem(IMSI_KEY, JSON.stringify(list)); } catch {}
  await hold(s);
  return imsiOf(operator, heldImsi = s);
}

const imsiOf = (operator, subscriber) => operator + subscriber.slice(operator.length - 5);

// taken for as long as the tab lives; false if another tab has it
function hold(s) {
  return new Promise((resolve) => {
    navigator.locks.request(`gsm-relay-imsi-${s}`, { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      return lock ? new Promise(() => {}) : undefined;
    });
  });
}
