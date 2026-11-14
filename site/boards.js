// Board configs: the ustar reader for boards.tar and the readers over the
// boards' TOML text. Pure code; app.js fills boardText from boards.tar.

// Tiny ustar reader: regular files only, through writeFn(name, bytes).
// A pax extended header ('x') or GNU long name ('L') is not a file but the
// full name of the next one; pax globals ('g') and macOS's AppleDouble
// "._*" companions are skipped. Throws on a header without the ustar magic
// (POSIX "ustar\0" or GNU "ustar  "): that is no archive this can read.
export function untar(buf, writeFn) {
  const dec = new TextDecoder();
  const str = (bytes) => dec.decode(bytes).replace(/\0.*$/s, "");
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.byteLength) {
    const h = new Uint8Array(buf, off, 512);
    let name = str(h.subarray(0, 100));
    if (!name) break;
    const magic = String.fromCharCode(...h.subarray(257, 263));
    if (magic !== "ustar\0" && magic !== "ustar ")
      throw new Error(`not a ustar archive (header at ${off})`);
    const size = parseInt(str(h.subarray(124, 136)).replace(/ .*$/, ""), 8) || 0;
    const type = String.fromCharCode(h[156]);
    const data = new Uint8Array(buf, off + 512, Math.min(size, buf.byteLength - off - 512));
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { longName = paxPath(data) ?? longName; continue; }
    if (type === "L") { longName = str(data); continue; }
    if (longName != null) {
      name = longName;
      longName = null;
    } else if (magic === "ustar\0") {
      // POSIX only: GNU keeps other fields there
      const prefix = str(h.subarray(345, 500));
      if (prefix) name = prefix.replace(/\/$/, "") + "/" + name;
    }
    if (name.startsWith("./")) name = name.slice(2);
    if (name.split("/").pop().startsWith("._")) continue;
    if (type === "0" || type === "\0") writeFn(name, data);
  }
}

// the `path` record of a pax extended header: "<len> path=<value>\n" records,
// <len> counting bytes
function paxPath(data) {
  const dec = new TextDecoder();
  for (let i = 0; i < data.length;) {
    const sp = data.indexOf(0x20, i);
    const len = sp > i ? parseInt(dec.decode(data.subarray(i, sp)), 10) : NaN;
    if (!(len > sp - i)) break;
    const rec = dec.decode(data.subarray(sp + 1, i + len - 1));
    if (rec.startsWith("path=")) return rec.slice(5);
    i += len;
  }
  return null;
}

export const boardText = new Map();   // "siemens-s75.toml" -> file contents

// `[peripheral.LCD0] width/height` of the board or an include it `extends`
export function readPanel(file) {
  for (const [, txt] of boardChain(file)) {
    const sec = txt.match(/\[peripheral\.LCD0\]([\s\S]*?)(?=\n\[|$)/);
    if (!sec) continue;
    const w = sec[1].match(/^[ \t]*width[ \t]*=[ \t]*(\d+)/m);
    const h = sec[1].match(/^[ \t]*height[ \t]*=[ \t]*(\d+)/m);
    if (w && h) return { w: +w[1], h: +h[1] };
  }
  return null;
}

// The same configs carry the device's real name in `[board] vendor/model`,
// which is what qemu itself prints at boot ("Board: Siemens S75").
export function readBoardName(file) {
  for (const [, txt] of boardChain(file)) {
    const sec = txt.match(/\[board\]([\s\S]*?)(?=\n\[|$)/);
    if (!sec) continue;
    const v = sec[1].match(/^[ \t]*vendor[ \t]*=[ \t]*"([^"]+)"/m);
    const m = sec[1].match(/^[ \t]*model[ \t]*=[ \t]*"([^"]+)"/m);
    if (v && m) return `${v[1]} ${m[1]}`;
  }
  return null;
}

// The phone's system connector is a peripheral of type "accessory-connector":
// `accessories` is a (multi-line) inline table of profiles, `default` the one
// plugged in at boot, `unplugged` the one that means nothing is.
// -> { names: [...profiles], default, unplugged } or null (no connector).
export function readAccessories(file) {
  for (const [, txt] of boardChain(file)) {
    for (const sec of txt.matchAll(/(?:^|\n)\[peripheral\.[^\]]+\]([\s\S]*?)(?=\n\[|(?![\s\S]))/g)) {
      const body = sec[1];
      if (!/^[ \t]*type[ \t]*=[ \t]*"accessory-connector"/m.test(body)) continue;
      const key = (k) => body.match(new RegExp(`^[ \\t]*${k}[ \\t]*=[ \\t]*"([^"]+)"`, "m"))?.[1] ?? null;
      const start = body.search(/^[ \t]*accessories[ \t]*=[ \t]*\{/m);
      const names = [];
      if (start >= 0) {
        // the profile names are the keys one brace deep
        let level = 0;
        const tok = /\{|\}|"(?:[^"\\]|\\.)*"|#[^\n]*|([A-Za-z0-9_-]+)[ \t]*=/g;
        tok.lastIndex = body.indexOf("{", start);
        for (let m; (m = tok.exec(body));) {
          if (m[0] === "{") level++;
          else if (m[0] === "}" && --level === 0) break;
          else if (m[1] && level === 1) names.push(m[1]);
        }
      }
      return { names, default: key("default"), unplugged: key("unplugged") };
    }
  }
  return null;
}

// the transceiver models qemu has (hw/gsm): a board with one gets the cell
export const RADIO_TYPE_RE = /^[ \t]*type[ \t]*=[ \t]*"(?:hd155153np|hd155155npeb|hd155165bp|pmb6270|pmb6272|bright-6pla)"/m;

// The board's config files, the board itself first. An `extends` path is
// relative to the file that names it, as qemu reads it (board.c).
export function boardChain(file, depth = 0) {
  const txt = boardText.get(file);
  if (!txt || depth > 4) return [];
  const ext = txt.match(/^[ \t]*extends[ \t]*=[ \t]*"([^"]+)"/m);
  return [[file, txt], ...(ext ? boardChain(siblingPath(file, ext[1]), depth + 1) : [])];
}

function siblingPath(file, rel) {
  const out = [];
  for (const p of [...file.split("/").slice(0, -1), ...rel.split("/")]) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}


// The page shows the phone's LCD panel, the one console qemu's wasm display
// listens on, and every board with a screen declares it as LCD0. The bare
// chip boards (apoxi-, generic-, siemens-pmb8875/6) and the Panasonics have
// none, so qemu stops at once with "wasm display: no console found".
const LCD0_RE = /^\[peripheral\.LCD0\]/m;
export function boardHasDisplay(device) {
  return boardChain(device + ".toml").some(([, txt]) => LCD0_RE.test(txt));
}

// the chip a board runs on, its config's cpu.type (keyboards.js settings go by it)
export const CPU_TYPE_RE = /^[ \t]*cpu\.type[ \t]*=[ \t]*"([^"]+)"/m;
export function boardCpu(device) {
  for (const [, txt] of boardChain(device + ".toml")) {
    const m = txt.match(CPU_TYPE_RE);
    if (m) return m[1];
  }
  return null;
}

// Does a GSM run of this board have a transceiver to receive with?
export function gsmBoardHasRadio(device) {
  return boardChain(device + ".toml").some(([, txt]) => RADIO_TYPE_RE.test(txt));
}

// Does the board have a SIM slot for a -device gsm-sim to sit in?
export const SIM_SLOT_RE = /^[ \t]*type[ \t]*=[ \t]*"iso7816-slot"/m;
export function boardHasSimSlot(device) {
  return boardChain(device + ".toml").some(([, txt]) => SIM_SLOT_RE.test(txt));
}
