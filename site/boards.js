// Board configs: the ustar reader for boards.tar and the readers over the
// boards' TOML text. Pure code; app.js fills boardText from boards.tar.

// tiny ustar reader
export function untar(buf, writeFn) {
  const dv = new DataView(buf);
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= buf.byteLength) {
    let name = dec.decode(new Uint8Array(buf, off, 100)).replace(/\0.*$/, "");
    const size = parseInt(dec.decode(new Uint8Array(buf, off + 124, 12)).replace(/[\0 ].*$/, ""), 8) || 0;
    const type = String.fromCharCode(dv.getUint8(off + 156));
    if (!name) break;
    if (name.startsWith("./")) name = name.slice(2);
    // ustar prefix field
    const prefix = dec.decode(new Uint8Array(buf, off + 345, 155)).replace(/\0.*$/, "");
    if (prefix) name = prefix.replace(/\/$/, "") + "/" + name;
    if (type === "0" || type === "\0") {
      writeFn(name, new Uint8Array(buf, off + 512, size));
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
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

// The board's config files, the board itself first.
export function boardChain(file, depth = 0) {
  const txt = boardText.get(file);
  if (!txt || depth > 4) return [];
  const ext = txt.match(/^[ \t]*extends[ \t]*=[ \t]*"([^"]+)"/m);
  return [[file, txt], ...(ext ? boardChain(ext[1], depth + 1) : [])];
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
