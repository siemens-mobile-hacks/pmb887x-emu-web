// The phone's Internet in the browser (doc/gsm-network.md). qemu's built-in
// GSM cell hands the phone's IP packets to the page (ui/wasm.c: a port on
// the cell's hub, read with _wasm_net_take, written with _wasm_net_put), and
// this is the network behind it, in slirp's place: the phone is 10.0.2.15,
// its gateway and the page's own server 10.0.2.2, its DNS 10.0.2.3.
//
// TCP ends here. An HTTP request becomes a fetch(): of the same path on the
// page's origin for 10.0.2.2 or the page's host name, otherwise of
// https://<host><path>, which only works where that site allows CORS.
// `relay` (URL -> URL to fetch instead) is the hook for a server-side relay.
// No IP fragments, no TLS, one request per connection (Connection: close).

const GATEWAY_MAC = [0x52, 0x55, 10, 0, 2, 2];
const HOST = [10, 0, 2, 2];
const DNS = [10, 0, 2, 3];
const MTU = 1500;
const MSS = 1400;
const WINDOW = 16384;
const IN_FLIGHT = 4 * MSS;
const RTO_MS = 3000;
const RTO_MAX_MS = 24000;
const RETRIES = 8;
const FIN = 1, SYN = 2, RST = 4, PSH = 8, ACK = 16;
const EMPTY = new Uint8Array(0);
const latin1 = new TextDecoder("latin1");

const ipStr = (b) => `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const put16 = (b, o, v) => { b[o] = v >>> 8; b[o + 1] = v & 255; };
const put32 = (b, o, v) => { put16(b, o, v >>> 16); put16(b, o + 2, v & 0xffff); };
const add32 = (a, n) => (a + n) >>> 0;
const diff32 = (a, b) => (a - b) | 0;

function sum16(b, acc = 0) {
  for (let i = 0; i + 1 < b.length; i += 2) acc += (b[i] << 8) | b[i + 1];
  if (b.length & 1) acc += b[b.length - 1] << 8;
  return acc;
}
function fold(acc) {
  while (acc > 0xffff) acc = (acc & 0xffff) + Math.floor(acc / 0x10000);
  return ~acc & 0xffff;
}
// TCP/UDP checksum over the pseudo header
const l4sum = (src, dst, proto, seg) =>
  fold(sum16(seg, sum16(src) + sum16(dst) + proto + seg.length));

export class GprsNet {
  constructor(module, { relay = null, log = null } = {}) {
    this.m = module;
    this.relay = relay;
    this.log = log;
    this.btsMac = null;
    this.ipId = 0;
    this.conns = new Map();
    this.names = new Map();    // fake address -> host name
    this.addrs = new Map();    // host name -> fake address
    this.requests = [];
    this.frames = { in: 0, out: 0 };
    this.attached = false;
    this.timer = 0;
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.poll(), 20);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    this.conns.clear();
  }

  // the guest's clock, so a slow emulator does not see early retransmits
  now() {
    const v = this.m._wasm_vclock?.();
    return v != null ? Number(v) / 1e6 : performance.now();
  }

  poll() {
    const m = this.m;
    if (!this.attached && !(this.attached = !!m._wasm_net_attach())) return;
    const buf = Number(m._wasm_net_buf());
    let len;
    while ((len = m._wasm_net_take()) > 0) {
      this.frames.in++;
      this.frame(m.HEAPU8.slice(buf, buf + len));
    }
    const now = this.now();
    for (const c of [...this.conns.values()]) this.tcpTimer(c, now);
  }

  put(frame) {
    const m = this.m;
    m.HEAPU8.set(frame, Number(m._wasm_net_buf()));
    if (m._wasm_net_put(frame.length)) this.frames.out++;
  }

  frame(f) {
    if (f.length < 34) return;
    this.btsMac ??= f.slice(6, 12);
    // IPv4 only: the cell answers ARP for the phone itself
    if (u16(f, 12) !== 0x0800) return;
    const ip = f.subarray(14);
    const ihl = (ip[0] & 15) * 4;
    const total = u16(ip, 2);
    if (ip[0] >> 4 !== 4 || ihl < 20 || total > ip.length || total < ihl) return;
    if (u16(ip, 6) & 0x3fff) return;
    const src = ip.slice(12, 16), dst = ip.slice(16, 20), body = ip.subarray(ihl, total);
    if (ip[9] === 1) this.icmp(src, dst, body);
    else if (ip[9] === 17) this.udp(src, dst, body);
    else if (ip[9] === 6) this.tcp(src, dst, body);
  }

  sendIp(proto, src, dst, payload) {
    if (20 + payload.length > MTU) return;
    const f = new Uint8Array(34 + payload.length);
    f.set(this.btsMac ?? [255, 255, 255, 255, 255, 255], 0);
    f.set(GATEWAY_MAC, 6);
    put16(f, 12, 0x0800);
    const ip = f.subarray(14, 34);
    ip[0] = 0x45;
    put16(ip, 2, 20 + payload.length);
    put16(ip, 4, this.ipId = (this.ipId + 1) & 0xffff);
    ip[6] = 0x40;
    ip[8] = 64;
    ip[9] = proto;
    ip.set(src, 12);
    ip.set(dst, 16);
    put16(ip, 10, fold(sum16(ip)));
    f.set(payload, 34);
    this.put(f);
  }

  icmp(src, dst, body) {
    if (body.length < 8 || body[0] !== 8) return;
    const r = body.slice();
    r[0] = 0;
    put16(r, 2, 0);
    put16(r, 2, fold(sum16(r)));
    this.sendIp(1, dst, src, r);
  }

  udp(src, dst, body) {
    if (body.length < 8 || ipStr(dst) !== ipStr(DNS) || u16(body, 2) !== 53) return;
    const answer = this.dns(body.subarray(8, u16(body, 4)));
    if (!answer) return;
    const r = new Uint8Array(8 + answer.length);
    put16(r, 0, 53);
    put16(r, 2, u16(body, 0));
    put16(r, 4, r.length);
    r.set(answer, 8);
    put16(r, 6, l4sum(dst, src, 17, r) || 0xffff);
    this.sendIp(17, dst, src, r);
  }

  // A records for every name: a fake address the HTTP side maps back
  dns(q) {
    if (q.length < 17 || u16(q, 4) < 1) return null;
    const labels = [];
    let o = 12;
    while (o < q.length && q[o]) {
      labels.push(latin1.decode(q.subarray(o + 1, o + 1 + q[o])));
      o += q[o] + 1;
    }
    const end = o + 5;
    if (end > q.length) return null;
    const address = u16(q, o + 1) === 1 ? this.addressOf(labels.join(".").toLowerCase()) : null;
    const r = new Uint8Array(end + (address ? 16 : 0));
    r.set(q.subarray(0, end));
    r[2] = 0x81;
    r[3] = 0x80;
    put16(r, 4, 1);
    put16(r, 6, address ? 1 : 0);
    put16(r, 8, 0);
    put16(r, 10, 0);
    if (address) {
      r.set([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4], end);
      r.set(address, end + 12);
    }
    return r;
  }

  addressOf(name) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return name.split(".").map(Number);
    if (name === location.hostname || name === "localhost") return HOST;
    if (!this.addrs.has(name)) {
      const n = this.addrs.size;
      const a = [10, 0, 3 + Math.floor(n / 250), 1 + (n % 250)];
      this.addrs.set(name, a);
      this.names.set(ipStr(a), name);
    }
    return this.addrs.get(name);
  }

  tcpOut(src, dst, sp, dp, seq, ack, flags, data = EMPTY, opts = EMPTY) {
    const s = new Uint8Array(20 + opts.length + data.length);
    put16(s, 0, sp);
    put16(s, 2, dp);
    put32(s, 4, seq);
    put32(s, 8, ack);
    s[12] = ((20 + opts.length) / 4) << 4;
    s[13] = flags;
    put16(s, 14, WINDOW);
    s.set(opts, 20);
    s.set(data, 20 + opts.length);
    put16(s, 16, l4sum(src, dst, 6, s));
    this.sendIp(6, src, dst, s);
  }

  // a segment of connection c from us to the phone
  segment(c, flags, seq, data = EMPTY, opts = EMPTY) {
    this.tcpOut(c.us, c.phone, c.dp, c.sp, seq, c.rcvNxt, flags | ACK, data, opts);
    if (flags & (SYN | FIN) || data.length) c.lastSend = this.now();
  }

  tcp(src, dst, seg) {
    if (seg.length < 20) return;
    const sp = u16(seg, 0), dp = u16(seg, 2), seq = u32(seg, 4), ack = u32(seg, 8);
    const off = (seg[12] >> 4) * 4, fl = seg[13];
    const data = seg.subarray(off);
    const key = `${ipStr(dst)}:${dp}:${sp}`;
    let c = this.conns.get(key);
    if (fl & RST) {
      this.conns.delete(key);
      return;
    }
    if (fl & SYN && !(fl & ACK) && (!c || seq !== add32(c.rcvNxt, -1))) {
      this.accept(key, src, dst, sp, dp, seq, seg, off);
      return;
    }
    if (!c) {
      const len = data.length + (fl & SYN ? 1 : 0) + (fl & FIN ? 1 : 0);
      if (fl & ACK) this.tcpOut(dst, src, dp, sp, ack, 0, RST);
      else this.tcpOut(dst, src, dp, sp, 0, add32(seq, len), RST | ACK);
      return;
    }
    if (fl & SYN) {
      // the phone did not get our SYN-ACK
      this.segment(c, SYN, c.iss, EMPTY, c.synOpts);
      return;
    }
    c.wnd = u16(seg, 14);
    if (fl & ACK && diff32(ack, c.sndUna) > 0 && diff32(ack, c.sndNxt) <= 0) {
      c.sndUna = ack;
      c.rto = RTO_MS;
      c.retries = 0;
      c.lastSend = this.now();
    }
    let ackNow = false;
    if (data.length) {
      ackNow = true;
      if (seq === c.rcvNxt && !c.peerFin) {
        c.rx.push(data.slice());
        c.rxBytes += data.length;
        c.rcvNxt = add32(c.rcvNxt, data.length);
        this.request(c);
      }
    }
    if (fl & FIN && add32(seq, data.length) === c.rcvNxt && !c.peerFin) {
      c.peerFin = true;
      c.rcvNxt = add32(c.rcvNxt, 1);
      ackNow = true;
    }
    if (ackNow) this.segment(c, 0, c.sndNxt);
    this.pump(c);
    this.reap(c);
  }

  accept(key, src, dst, sp, dp, seq, seg, off) {
    let mss = 536;
    for (let o = 20; o < off;) {
      const kind = seg[o];
      if (kind === 0) break;
      if (kind === 1) { o++; continue; }
      if (kind === 2 && seg[o + 1] === 4) mss = u16(seg, o + 2);
      o += Math.max(2, seg[o + 1]);
    }
    const iss = (Math.random() * 0x100000000) >>> 0;
    const c = {
      key, phone: src, us: dst, sp, dp, iss,
      mss: Math.min(MSS, mss),
      rcvNxt: add32(seq, 1),
      sndUna: iss, sndNxt: add32(iss, 1),
      wnd: u16(seg, 14),
      rx: [], rxBytes: 0, asked: false, peerFin: false,
      tx: null, txBase: add32(iss, 1), finSent: false,
      rto: RTO_MS, retries: 0, lastSend: 0, done: 0,
      synOpts: new Uint8Array([2, 4, MSS >> 8, MSS & 255]),
    };
    this.conns.set(key, c);
    this.segment(c, SYN, iss, EMPTY, c.synOpts);
    return c;
  }

  // send what the phone's window and our in-flight limit allow, then FIN
  pump(c) {
    if (!c.tx) return;
    for (;;) {
      const at = diff32(c.sndNxt, c.txBase);
      const inFlight = diff32(c.sndNxt, c.sndUna);
      if (at < c.tx.length) {
        const n = Math.min(c.mss, c.tx.length - at, c.wnd - inFlight, IN_FLIGHT - inFlight);
        if (n <= 0) return;
        this.segment(c, PSH, c.sndNxt, c.tx.subarray(at, at + n));
        c.sndNxt = add32(c.sndNxt, n);
      } else {
        if (!c.finSent) {
          this.segment(c, FIN, c.sndNxt);
          c.sndNxt = add32(c.sndNxt, 1);
          c.finSent = true;
        }
        return;
      }
    }
  }

  tcpTimer(c, now) {
    if (c.sndUna === c.sndNxt) {
      // our FIN is acknowledged and the phone never closed its side
      if (c.finSent && now - c.lastSend > 60000) this.conns.delete(c.key);
      return;
    }
    if (now - c.lastSend < c.rto) return;
    if (++c.retries > RETRIES) {
      this.conns.delete(c.key);
      return;
    }
    c.rto = Math.min(c.rto * 2, RTO_MAX_MS);
    if (c.sndUna === c.iss) {
      this.segment(c, SYN, c.iss, EMPTY, c.synOpts);
      return;
    }
    // go back to the first unacknowledged byte
    c.sndNxt = c.sndUna;
    if (diff32(c.sndUna, c.txBase) <= c.tx.length) c.finSent = false;
    this.pump(c);
  }

  reap(c) {
    if (c.finSent && c.peerFin && c.sndUna === c.sndNxt) this.conns.delete(c.key);
  }

  request(c) {
    if (c.asked) return;
    const raw = new Uint8Array(c.rxBytes);
    let o = 0;
    for (const d of c.rx) { raw.set(d, o); o += d.length; }
    const head = latin1.decode(raw);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    const lines = head.slice(0, end).split("\r\n");
    const headers = {};
    for (const l of lines.slice(1)) {
      const i = l.indexOf(":");
      if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
    }
    const length = Number(headers["content-length"] ?? 0);
    if (raw.length < end + 4 + length) return;
    c.asked = true;
    const [method, target] = lines[0].split(" ");
    this.http(c, method, target, headers, raw.slice(end + 4, end + 4 + length));
  }

  // the URL a request of the phone is fetched from
  urlFor(target, headers, us) {
    const u = /^https?:\/\//i.test(target)
      ? new URL(target)
      : new URL(target.startsWith("/") ? target : "/" + target, `http://${headers.host || ipStr(us)}`);
    const host = this.names.get(u.hostname) ?? u.hostname;
    if (host === ipStr(HOST) || host === location.hostname || host === "localhost")
      return new URL(u.pathname + u.search, location.origin).href;
    const out = `${location.protocol === "http:" ? u.protocol : "https:"}//${host}` +
      `${u.port ? ":" + u.port : ""}${u.pathname}${u.search}`;
    return this.relay ? this.relay(out) : out;
  }

  async http(c, method, target, headers, body) {
    const entry = { time: Date.now(), method, target, host: headers.host, userAgent: headers["user-agent"] };
    this.requests.push(entry);
    let status = 502, reason = "Bad Gateway", type = "text/plain; charset=utf-8", bytes;
    try {
      const url = entry.url = this.urlFor(target, headers, c.us);
      const sameOrigin = new URL(url).origin === location.origin;
      const fwd = new Headers();
      for (const [k, v] of Object.entries(headers)) {
        if (["host", "connection", "content-length", "keep-alive", "proxy-connection"].includes(k)) continue;
        // a cross-origin request with other headers needs a CORS preflight
        if (!sameOrigin && !["accept", "accept-language", "content-language", "content-type"].includes(k)) continue;
        try { fwd.set(k, v); } catch { /* not a valid header for fetch */ }
      }
      const r = await fetch(url, {
        method,
        headers: fwd,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        credentials: "same-origin",
      });
      bytes = new Uint8Array(await r.arrayBuffer());
      status = r.status;
      reason = r.statusText || (r.ok ? "OK" : "Error");
      type = r.headers.get("content-type") ?? "application/octet-stream";
    } catch (e) {
      bytes = new TextEncoder().encode(`Cannot fetch ${entry.url ?? target}: ${e.message ?? e}\n`);
    }
    entry.status = status;
    this.log?.(`${method} ${target} -> ${entry.url ?? "?"} ${status}`);
    const head = `HTTP/1.1 ${status} ${reason}\r\nContent-Type: ${type}\r\n` +
      `Content-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`;
    const tx = new Uint8Array(head.length + (method === "HEAD" ? 0 : bytes.length));
    for (let i = 0; i < head.length; i++) tx[i] = head.charCodeAt(i) & 255;
    if (method !== "HEAD") tx.set(bytes, head.length);
    if (!this.conns.has(c.key)) return;
    c.tx = tx;
    this.pump(c);
  }
}
