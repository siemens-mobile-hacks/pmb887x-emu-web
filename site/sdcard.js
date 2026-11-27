// Memory card for the phone: a FAT16 SD image made from a folder on the
// user's disk, and kept in sync with it while the phone runs (doc/sd-card.md).
//
//   buildImage(files)  -> Uint8Array   files: [{ path: "Misc/a.txt", data, mtime }]
//                                       (folders as { path, dir: true })
//   readImage(image)   -> [{ path, dir, data, mtime }]   FAT12/FAT16, LFN
//   CardSync           the folder <-> image sync (File System Access API)
//
// The image is what the firmware expects of an SD card (SDSC: CSD v1, so at
// most 2 GB and a power-of-two size for qemu's sd-card): an MBR with one
// FAT16 partition at LBA 2048, 2 FATs, 512 root entries. Names that are not
// plain 8.3 get VFAT long-name entries.

const SECTOR = 512;
const PART_START = 2048;
const ROOT_ENTRIES = 512;
const MIN_MB = 64;
const MAX_MB = 2048;

/* ------------------------------------------------------------------ */
/* building                                                            */
/* ------------------------------------------------------------------ */

function fatDateTime(ms) {
  const d = new Date(ms || Date.now());
  const y = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

const SFN_OK = /^[A-Z0-9!#$%&'()\-@^_`{}~]+$/;
const SFN_BAD = /[^A-Z0-9!#$%&'()\-@^_`{}~]/g;

// "hello.txt" -> plain 8.3 (lower-case flags), else null
function plainShortName(name) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (!base || base.length > 8 || ext.length > 3 || (dot > 0 && !ext)) return null;
  if (base.includes(".")) return null;
  const B = base.toUpperCase(), E = ext.toUpperCase();
  if (!SFN_OK.test(B) || (E && !SFN_OK.test(E))) return null;
  const caseOf = (s, S) => (s === S ? 0 : s === s.toLowerCase() ? 1 : -1);
  const cb = caseOf(base, B), ce = E ? caseOf(ext, E) : 0;
  if (cb < 0 || ce < 0) return null;
  return { sfn: B.padEnd(8) + E.padEnd(3), nt: (cb ? 0x08 : 0) | (ce ? 0x10 : 0) };
}

// a unique "BASIS~N EXT" for a long name
function makeShortName(name, used) {
  const dot = name.lastIndexOf(".");
  let base = (dot > 0 ? name.slice(0, dot) : name).toUpperCase().replace(/[ .]/g, "").replace(SFN_BAD, "_");
  let ext = (dot > 0 ? name.slice(dot + 1) : "").toUpperCase().replace(/ /g, "").replace(SFN_BAD, "_").slice(0, 3);
  if (!base) base = "_";
  for (let n = 1; n < 1000000; n++) {
    const tail = "~" + n;
    const sfn = (base.slice(0, 8 - tail.length) + tail).padEnd(8) + ext.padEnd(3);
    if (!used.has(sfn)) return sfn;
  }
  throw new Error("no short name left for " + name);
}

function sfnChecksum(sfn) {
  let s = 0;
  for (let i = 0; i < 11; i++) s = (((s & 1) << 7) | (s >> 1)) + sfn.charCodeAt(i) & 0xff;
  return s;
}

function writeEntry(buf, off, sfn, attr, nt, cluster, size, mtime) {
  for (let i = 0; i < 11; i++) buf[off + i] = sfn.charCodeAt(i);
  buf[off + 11] = attr;
  buf[off + 12] = nt;
  const { date, time } = fatDateTime(mtime);
  const dv = new DataView(buf.buffer, buf.byteOffset + off, 32);
  dv.setUint16(14, time, true); dv.setUint16(16, date, true);   // created
  dv.setUint16(18, date, true);                                  // accessed
  dv.setUint16(22, time, true); dv.setUint16(24, date, true);   // modified
  dv.setUint16(26, cluster, true);
  dv.setUint32(28, size, true);
}

// the 32-byte entries (LFN ones first) for one name
function nameEntries(name, used) {
  const plain = plainShortName(name);
  if (plain && !used.has(plain.sfn)) {
    used.add(plain.sfn);
    return { sfn: plain.sfn, nt: plain.nt, lfn: [] };
  }
  const sfn = makeShortName(name, used);
  used.add(sfn);
  const sum = sfnChecksum(sfn);
  const units = [];
  for (const ch of name) {
    const c = ch.codePointAt(0);
    units.push(c > 0xffff ? 0x5f : c);   // no surrogates in names: "_"
  }
  units.push(0);
  while (units.length % 13) units.push(0xffff);
  const n = units.length / 13, lfn = [];
  for (let k = n; k >= 1; k--) {
    const e = new Uint8Array(32);
    e[0] = k | (k === n ? 0x40 : 0);
    e[11] = 0x0f; e[13] = sum;
    const part = units.slice((k - 1) * 13, k * 13);
    const pos = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
    pos.forEach((p, i) => { e[p] = part[i] & 0xff; e[p + 1] = part[i] >> 8; });
    lfn.push(e);
  }
  return { sfn, nt: 0, lfn };
}

function makeTree(files) {
  const root = { name: "", dir: true, children: new Map(), mtime: 0 };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const key = parts[i];
      let child = node.children.get(key);
      if (!child) {
        child = last && !f.dir
          ? { name: key, dir: false, data: f.data, mtime: f.mtime }
          : { name: key, dir: true, children: new Map(), mtime: f.mtime || 0 };
        node.children.set(key, child);
      }
      node = child;
    }
  }
  return root;
}

function geometry(totalBytes) {
  // the smallest power-of-two card with room for the files and some to spare
  let mb = MIN_MB;
  for (;;) {
    const sectors = mb * 2048;
    const part = sectors - PART_START;
    let spc = 1;
    while (part / spc > 65000) spc *= 2;
    if (spc < 4) spc = 4;
    const rootSecs = ROOT_ENTRIES * 32 / SECTOR;
    let fatSz = 1;
    for (let k = 0; k < 4; k++) {
      const clusters = Math.floor((part - 4 - 2 * fatSz - rootSecs) / spc);
      fatSz = Math.ceil((clusters + 2) * 2 / SECTOR);
    }
    const clusters = Math.floor((part - 4 - 2 * fatSz - rootSecs) / spc);
    const room = clusters * spc * SECTOR;
    if (room >= totalBytes * 1.25 + 8 * 1024 * 1024 || mb >= MAX_MB) {
      if (room < totalBytes) throw new Error("the folder does not fit on a 2 GB card");
      return { mb, sectors, part, spc, fatSz, rootSecs, clusters };
    }
    mb *= 2;
  }
}

export function buildImage(files) {
  const tree = makeTree(files);
  // bytes the files and folders take, rounded per cluster later; a first guess
  let total = 0;
  const walkSize = (n) => {
    for (const c of n.children.values()) {
      if (c.dir) { total += 4096 + c.children.size * 64; walkSize(c); }
      else total += c.data.length + 4096;
    }
  };
  walkSize(tree);
  const g = geometry(total);
  const csize = g.spc * SECTOR;
  const img = new Uint8Array(g.sectors * SECTOR);
  const dv = new DataView(img.buffer);

  // MBR: one FAT16 (type 6) partition
  const pe = 446;
  img[pe] = 0x00;
  img[pe + 1] = 0xfe; img[pe + 2] = 0xff; img[pe + 3] = 0xff;   // CHS: use LBA
  img[pe + 4] = 0x06;
  img[pe + 5] = 0xfe; img[pe + 6] = 0xff; img[pe + 7] = 0xff;
  dv.setUint32(pe + 8, PART_START, true);
  dv.setUint32(pe + 12, g.part, true);
  img[510] = 0x55; img[511] = 0xaa;

  // boot sector
  const bs = PART_START * SECTOR;
  img.set([0xeb, 0x3c, 0x90], bs);
  "MSWIN4.1".split("").forEach((c, i) => (img[bs + 3 + i] = c.charCodeAt(0)));
  dv.setUint16(bs + 11, SECTOR, true);
  img[bs + 13] = g.spc;
  dv.setUint16(bs + 14, 4, true);                  // reserved sectors
  img[bs + 16] = 2;                                // FATs
  dv.setUint16(bs + 17, ROOT_ENTRIES, true);
  dv.setUint16(bs + 19, g.part < 65536 ? g.part : 0, true);
  img[bs + 21] = 0xf8;
  dv.setUint16(bs + 22, g.fatSz, true);
  dv.setUint16(bs + 24, 63, true);
  dv.setUint16(bs + 26, 255, true);
  dv.setUint32(bs + 28, PART_START, true);
  dv.setUint32(bs + 32, g.part < 65536 ? 0 : g.part, true);
  img[bs + 36] = 0x80; img[bs + 38] = 0x29;
  dv.setUint32(bs + 39, (Date.now() / 1000) >>> 0, true);
  "CARD       FAT16   ".split("").forEach((c, i) => (img[bs + 43 + i] = c.charCodeAt(0)));
  img[bs + 510] = 0x55; img[bs + 511] = 0xaa;

  const fat1 = bs + 4 * SECTOR;
  const fat2 = fat1 + g.fatSz * SECTOR;
  const rootOff = fat2 + g.fatSz * SECTOR;
  const dataOff = rootOff + g.rootSecs * SECTOR;
  const setFat = (c, v) => {
    dv.setUint16(fat1 + c * 2, v, true);
    dv.setUint16(fat2 + c * 2, v, true);
  };
  setFat(0, 0xfff8); setFat(1, 0xffff);
  let next = 2;
  const alloc = (bytes) => {
    const n = Math.max(1, Math.ceil(bytes / csize));
    if (next + n - 2 > g.clusters) throw new Error("card full");
    const first = next;
    for (let i = 0; i < n; i++) setFat(next + i, i === n - 1 ? 0xffff : next + i + 1);
    next += n;
    return first;
  };
  const clusterOff = (c) => dataOff + (c - 2) * csize;

  // entries of a folder: [{ e: Uint8Array(32) }...] laid out into its area
  const layoutDir = (node, selfCluster, parentCluster) => {
    const used = new Set();
    const out = [];
    if (selfCluster) {
      const dot = new Uint8Array(32), dotdot = new Uint8Array(32);
      writeEntry(dot, 0, ".          ", 0x10, 0, selfCluster, 0, node.mtime);
      writeEntry(dotdot, 0, "..         ", 0x10, 0, parentCluster, 0, node.mtime);
      out.push(dot, dotdot);
    } else {
      const label = new Uint8Array(32);
      writeEntry(label, 0, "CARD       ", 0x08, 0, 0, 0, Date.now());
      out.push(label);
    }
    const kids = [...node.children.values()];
    for (const c of kids) {
      const { sfn, nt, lfn } = nameEntries(c.name, used);
      out.push(...lfn);
      // (a folder's cluster goes in later, placeDir: its own entries decide its size)
      let cluster = 0, size = 0;
      if (!c.dir && c.data.length) {
        cluster = alloc(c.data.length);
        size = c.data.length;
        let off = 0;
        for (let k = cluster; off < c.data.length; k++, off += csize)
          img.set(c.data.subarray(off, Math.min(off + csize, c.data.length)), clusterOff(k));
      }
      const e = new Uint8Array(32);
      writeEntry(e, 0, sfn, c.dir ? 0x10 : 0x20, nt, cluster, size, c.mtime);
      out.push(e);
      c._entry = e;
    }
    return out;
  };

  const placeDir = (node, selfCluster, parentCluster) => {
    // sub-folders get their clusters before the entries are written
    for (const c of node.children.values()) {
      if (!c.dir) continue;
      const n = 2 + 2 * c.children.size + c.children.size * 20 / 13;   // LFN worst case
      c._cluster = alloc(Math.max(1, Math.ceil(n)) * 32);
    }
    const entries = layoutDir(node, selfCluster, parentCluster);
    for (const c of node.children.values())
      if (c.dir) new DataView(c._entry.buffer).setUint16(26, c._cluster, true);
    if (!selfCluster) {
      if (entries.length > ROOT_ENTRIES) throw new Error("too many entries in the card's root folder");
      entries.forEach((e, i) => img.set(e, rootOff + i * 32));
    } else {
      // the folder's chain may need more clusters than guessed: grow it
      let c = selfCluster, cap = csize / 32, i = 0;
      for (const e of entries) {
        if (i === cap) {
          // follow / extend the chain
          let nx = dv.getUint16(fat1 + c * 2, true);
          if (nx >= 0xfff8) { nx = alloc(1); setFat(c, nx); }
          c = nx; i = 0;
        }
        img.set(e, clusterOff(c) + i * 32);
        i++;
      }
    }
    for (const c of node.children.values())
      if (c.dir) placeDir(c, c._cluster, selfCluster);
  };
  placeDir(tree, 0, 0);
  return img;
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

function fatTime(date, time) {
  if (!date) return 0;
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31,
    time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
}

export function readImage(img) {
  const dv = new DataView(img.buffer, img.byteOffset, img.byteLength);
  // a partition table, or a file system from sector 0 ("superfloppy")
  let start = 0;
  const isBpb = (o) => (img[o] === 0xeb || img[o] === 0xe9) && dv.getUint16(o + 11, true) === 512;
  if (!isBpb(0) && img[510] === 0x55 && img[511] === 0xaa) start = dv.getUint32(446 + 8, true);
  const bs = start * SECTOR;
  if (!isBpb(bs)) throw new Error("no FAT file system on the card");
  const spc = img[bs + 13];
  const rsvd = dv.getUint16(bs + 14, true);
  const nfats = img[bs + 16];
  const rootEnts = dv.getUint16(bs + 17, true);
  const fatSz = dv.getUint16(bs + 22, true);
  const tot = dv.getUint16(bs + 19, true) || dv.getUint32(bs + 32, true);
  if (!fatSz) throw new Error("FAT32 is not supported");
  const fatOff = bs + rsvd * SECTOR;
  const rootOff = fatOff + nfats * fatSz * SECTOR;
  const dataOff = rootOff + Math.ceil(rootEnts * 32 / SECTOR) * SECTOR;
  const csize = spc * SECTOR;
  const clusters = Math.floor((tot - (dataOff - bs) / SECTOR) / spc);
  const fat12 = clusters < 4085;
  const nextOf = (c) => {
    if (fat12) {
      const v = dv.getUint16(fatOff + Math.floor(c * 1.5), true);
      const n = c & 1 ? v >> 4 : v & 0xfff;
      return n >= 0xff8 ? -1 : n;
    }
    const n = dv.getUint16(fatOff + c * 2, true);
    return n >= 0xfff8 ? -1 : n;
  };
  const chain = (c) => {
    const out = [];
    const seen = new Set();
    while (c >= 2 && c < clusters + 2 && !seen.has(c)) { seen.add(c); out.push(c); c = nextOf(c); }
    return out;
  };
  const readChain = (c, size) => {
    const cl = chain(c);
    const buf = new Uint8Array(size ?? cl.length * csize);
    let off = 0;
    for (const k of cl) {
      if (off >= buf.length) break;
      const n = Math.min(csize, buf.length - off);
      buf.set(img.subarray(dataOff + (k - 2) * csize, dataOff + (k - 2) * csize + n), off);
      off += n;
    }
    return buf;
  };
  const out = [];
  const walk = (bytes, prefix, depth) => {
    if (depth > 32) return;
    let lfn = [];
    for (let o = 0; o + 32 <= bytes.length; o += 32) {
      const b0 = bytes[o];
      if (b0 === 0) break;
      const attr = bytes[o + 11];
      if (b0 === 0xe5) { lfn = []; continue; }
      if (attr === 0x0f) {
        const pos = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
        const s = pos.map((p) => bytes[o + p] | (bytes[o + p + 1] << 8));
        lfn[(b0 & 0x1f) - 1] = s;
        continue;
      }
      if (attr & 0x08) { lfn = []; continue; }   // volume label
      let name;
      if (lfn.length) {
        const units = lfn.flat();
        const end = units.indexOf(0);
        name = String.fromCharCode(...(end >= 0 ? units.slice(0, end) : units.filter((u) => u !== 0xffff)));
      } else {
        const nt = bytes[o + 12];
        let base = String.fromCharCode(...bytes.subarray(o, o + 8)).trimEnd();
        let ext = String.fromCharCode(...bytes.subarray(o + 8, o + 11)).trimEnd();
        if (base.charCodeAt(0) === 0x05) base = "å" + base.slice(1);
        if (nt & 0x08) base = base.toLowerCase();
        if (nt & 0x10) ext = ext.toLowerCase();
        name = ext ? base + "." + ext : base;
      }
      lfn = [];
      if (name === "." || name === "..") continue;
      const e = new DataView(bytes.buffer, bytes.byteOffset + o, 32);
      const cluster = e.getUint16(26, true);
      const mtime = fatTime(e.getUint16(24, true), e.getUint16(22, true));
      const path = prefix + name;
      if (attr & 0x10) {
        out.push({ path, dir: true, mtime });
        walk(readChain(cluster), path + "/", depth + 1);
      } else {
        const size = e.getUint32(28, true);
        out.push({ path, dir: false, data: cluster ? readChain(cluster, size) : new Uint8Array(0), mtime });
      }
    }
  };
  walk(img.subarray(rootOff, rootOff + rootEnts * 32), "", 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* the folder                                                          */
/* ------------------------------------------------------------------ */

function hashBytes(data) {
  // FNV-1a, enough to tell versions of one file apart
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193);
  return (h >>> 0).toString(16) + ":" + data.length;
}

// everything under a directory handle: [{ path, dir, file? (File) }]
async function listFolder(handle, prefix = "", out = []) {
  for await (const [name, h] of handle.entries()) {
    if (name.startsWith(".")) continue;          // .DS_Store, .git, ...
    const path = prefix + name;
    if (h.kind === "directory") {
      out.push({ path, dir: true, handle: h });
      await listFolder(h, path + "/", out);
    } else {
      out.push({ path, dir: false, file: await h.getFile() });
    }
  }
  return out;
}

async function folderHandleFor(root, path, create) {
  let h = root;
  for (const p of path.split("/").filter(Boolean)) h = await h.getDirectoryHandle(p, { create });
  return h;
}

async function writeHostFile(root, path, data) {
  const i = path.lastIndexOf("/");
  const dir = await folderHandleFor(root, i >= 0 ? path.slice(0, i) : "", true);
  const fh = await dir.getFileHandle(path.slice(i + 1), { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

// a folder is removed only when it is empty (whatever the disk added stays)
async function removeHost(root, path) {
  const i = path.lastIndexOf("/");
  try {
    const dir = await folderHandleFor(root, i >= 0 ? path.slice(0, i) : "", false);
    await dir.removeEntry(path.slice(i + 1));
  } catch (e) {
    if (e.name !== "NotFoundError" && e.name !== "InvalidModificationError") throw e;
  }
}

async function hostFile(root, path) {
  const i = path.lastIndexOf("/");
  const dir = await folderHandleFor(root, i >= 0 ? path.slice(0, i) : "", false);
  return (await dir.getFileHandle(path.slice(i + 1))).getFile();
}

function conflictName(path) {
  const i = path.lastIndexOf("."), s = path.lastIndexOf("/");
  return i > s + 1 ? path.slice(0, i) + "~phone" + path.slice(i) : path + "~phone";
}

/* ------------------------------------------------------------------ */
/* sync                                                                */
/* ------------------------------------------------------------------ */

// base: what both sides held after the last sync
//   path -> { dir, hash, hostSig }   hostSig = size:lastModified on the disk
export class CardSync {
  constructor({ dir, log = () => {} }) {
    this.dir = dir;
    this.log = log;
    this.base = new Map();
  }

  // the first image, from the folder as it is now
  async initialImage() {
    const list = await listFolder(this.dir);
    const files = [];
    this.base.clear();
    for (const f of list) {
      if (f.dir) {
        files.push({ path: f.path, dir: true });
        this.base.set(f.path, { dir: true });
      } else {
        const data = new Uint8Array(await f.file.arrayBuffer());
        files.push({ path: f.path, data, mtime: f.file.lastModified });
        this.base.set(f.path, { dir: false, hash: hashBytes(data), hostSig: f.file.size + ":" + f.file.lastModified });
      }
    }
    this.log(`card: ${list.filter((f) => !f.dir).length} files from the folder`);
    return buildImage(files);
  }

  // the folder changed since the last sync?
  async hostChanged() {
    const list = await listFolder(this.dir);
    const seen = new Set();
    for (const f of list) {
      seen.add(f.path);
      const b = this.base.get(f.path);
      if (!b || b.dir !== f.dir) return true;
      if (!f.dir && b.hostSig !== f.file.size + ":" + f.file.lastModified) return true;
    }
    for (const p of this.base.keys()) if (!seen.has(p)) return true;
    return false;
  }

  // phone -> folder: what the image holds that the base does not
  async pull(image) {
    let entries;
    try {
      entries = readImage(image);
    } catch (e) {
      this.log("card: cannot read the card (" + e.message + "), nothing pulled");
      return 0;
    }
    const host = new Map((await listFolder(this.dir)).map((f) => [f.path, f]));
    // FAT names ignore case, and the phone may write a host name back in
    // capitals (PHOTO.JPG for photo.jpg): an image path takes the base's or
    // the folder's spelling, else its parent's, so that nothing on the disk
    // looks deleted or gets a twin of another case
    const fold = new Map();
    for (const p of [...host.keys(), ...this.base.keys()]) fold.set(p.toLowerCase(), p);
    const canon = (p) => {
      const hit = fold.get(p.toLowerCase());
      if (hit) return hit;
      const i = p.lastIndexOf("/");
      return i < 0 ? p : canon(p.slice(0, i)) + p.slice(i);
    };
    entries = entries.map((e) => ({ ...e, path: canon(e.path) }));
    const hostSig = (p) => { const f = host.get(p); return f && !f.dir ? f.file.size + ":" + f.file.lastModified : null; };
    const inImage = new Map(entries.map((e) => [e.path, e]));
    let n = 0;
    // folders first (parents before children), then files
    for (const e of entries) {
      if (!e.dir || this.base.has(e.path)) continue;
      await folderHandleFor(this.dir, e.path, true);
      this.base.set(e.path, { dir: true });
      n++;
    }
    for (const e of entries) {
      if (e.dir) continue;
      const hash = hashBytes(e.data);
      const b = this.base.get(e.path);
      if (b && !b.dir && b.hash === hash) continue;          // unchanged on the phone
      const hostEdited = b && hostSig(e.path) !== null && hostSig(e.path) !== b.hostSig;
      const hostNew = !b && host.get(e.path) && !host.get(e.path).dir;
      if (hostNew) {
        const f = host.get(e.path).file;
        if (hashBytes(new Uint8Array(await f.arrayBuffer())) === hash) {   // the same file on both sides
          this.base.set(e.path, { dir: false, hash, hostSig: f.size + ":" + f.lastModified });
          continue;
        }
      }
      if (hostEdited || hostNew) {
        // both changed: keep both. The phone's copy is not in the base (the
        // card does not hold it under that name): the folder has a change for
        // the card, and no pull deletes it
        const target = conflictName(e.path);
        this.log(`card: ${e.path} changed on both sides, the phone's copy is ${target}`);
        await writeHostFile(this.dir, target, e.data);
        n++;
        continue;
      }
      await writeHostFile(this.dir, e.path, e.data);
      const f = await hostFile(this.dir, e.path);
      this.base.set(e.path, { dir: false, hash, hostSig: f.size + ":" + f.lastModified });
      n++;
    }
    // deleted on the phone: delete on the disk unless the disk changed it;
    // files first, then folders deepest first, each only if left empty
    const gone = [...this.base].filter(([p]) => !inImage.has(p));
    for (const [p, b] of gone) {
      if (b.dir) continue;
      if (hostSig(p) === null || hostSig(p) === b.hostSig) {
        await removeHost(this.dir, p);
        this.base.delete(p);
        n++;
      }
    }
    const dirs = gone.filter(([, b]) => b.dir).map(([p]) => p).sort((x, y) => y.length - x.length);
    for (const p of dirs) {
      await removeHost(this.dir, p);
      this.base.delete(p);
      n++;
    }
    if (n) this.log(`card: ${n} change(s) from the phone written to the folder`);
    return n;
  }

  // folder -> card: after a pull, the folder holds everything
  async rebuild() {
    return this.initialImage();
  }
}

// the card's image as a download name
export function cardImageName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `card-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.img`;
}
