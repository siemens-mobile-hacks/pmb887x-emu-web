// site/sdcard.js: the FAT image round trip, and a pull into a folder (an
// in-memory stand-in for the File System Access API's directory handle).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImage, readImage, CardSync } from "../../site/sdcard.js";

let clock = 1_700_000_000_000;
const err = (name) => Object.assign(new Error(name), { name });

class MemFileHandle {
  kind = "file";
  constructor(name, data = new Uint8Array(0)) {
    this.name = name;
    this.data = data;
    this.mtime = ++clock;
  }
  async getFile() {
    return new File([this.data], this.name, { lastModified: this.mtime });
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (d) => { chunks.push(Buffer.from(d)); },
      close: async () => { this.data = new Uint8Array(Buffer.concat(chunks)); this.mtime = ++clock; },
    };
  }
}

class MemDir {
  kind = "directory";
  constructor(name = "") {
    this.name = name;
    this.kids = new Map();
  }
  async *entries() {
    yield* [...this.kids];
  }
  async getDirectoryHandle(n, { create } = {}) {
    let h = this.kids.get(n);
    if (!h) {
      if (!create) throw err("NotFoundError");
      this.kids.set(n, (h = new MemDir(n)));
    }
    if (h.kind !== "directory") throw err("TypeMismatchError");
    return h;
  }
  async getFileHandle(n, { create } = {}) {
    let h = this.kids.get(n);
    if (!h) {
      if (!create) throw err("NotFoundError");
      this.kids.set(n, (h = new MemFileHandle(n)));
    }
    if (h.kind !== "file") throw err("TypeMismatchError");
    return h;
  }
  async removeEntry(n) {
    const h = this.kids.get(n);
    if (!h) throw err("NotFoundError");
    if (h.kind === "directory" && h.kids.size) throw err("InvalidModificationError");
    this.kids.delete(n);
  }
}

const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);

test("an image reads back as the files it was built from", () => {
  const files = [
    { path: "photo.jpg", data: bytes("jpeg"), mtime: clock },
    { path: "A long name with spaces.txt", data: bytes("long"), mtime: clock },
    { path: "Misc", dir: true },
    { path: "Misc/README.TXT", data: bytes("x".repeat(70000)), mtime: clock },
    { path: "Misc/empty.bin", data: new Uint8Array(0), mtime: clock },
  ];
  const got = new Map(readImage(buildImage(files)).map((e) => [e.path, e]));
  for (const f of files) {
    const e = got.get(f.path);
    assert.ok(e, `${f.path} is on the card`);
    assert.equal(!!e.dir, !!f.dir, f.path);
    if (!f.dir) assert.equal(text(e.data), text(f.data), f.path);
  }
  assert.equal(got.size, files.length);
});

test("a name the phone writes back in capitals is the same file, not a deletion", async () => {
  const root = new MemDir();
  const misc = await root.getDirectoryHandle("Misc", { create: true });
  await (await root.getFileHandle("photo.jpg", { create: true })).createWritable()
    .then(async (w) => { await w.write(bytes("old")); await w.close(); });
  await (await misc.getFileHandle("note.txt", { create: true })).createWritable()
    .then(async (w) => { await w.write(bytes("note")); await w.close(); });
  const sync = new CardSync({ dir: root });
  await sync.initialImage();

  // the phone rewrote photo.jpg without the lower-case flags, and made a new
  // file in Misc, which it also names in capitals
  const image = buildImage([
    { path: "PHOTO.JPG", data: bytes("new"), mtime: clock },
    { path: "MISC", dir: true },
    { path: "MISC/NOTE.TXT", data: bytes("note"), mtime: clock },
    { path: "MISC/NEW.TXT", data: bytes("fresh"), mtime: clock },
  ]);
  await sync.pull(image);

  assert.deepEqual([...root.kids.keys()].sort(), ["Misc", "photo.jpg"]);
  assert.equal(text(root.kids.get("photo.jpg").data), "new");
  assert.deepEqual([...misc.kids.keys()].sort(), ["NEW.TXT", "note.txt"]);
  assert.equal(text(misc.kids.get("NEW.TXT").data), "fresh");
});

test("a file deleted on the phone is deleted in the folder", async () => {
  const root = new MemDir();
  for (const n of ["keep.txt", "gone.txt"]) {
    const w = await (await root.getFileHandle(n, { create: true })).createWritable();
    await w.write(bytes(n));
    await w.close();
  }
  const sync = new CardSync({ dir: root });
  await sync.initialImage();
  await sync.pull(buildImage([{ path: "KEEP.TXT", data: bytes("keep.txt"), mtime: clock }]));
  assert.deepEqual([...root.kids.keys()], ["keep.txt"]);
});

const put = async (dir, name, s) => {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(bytes(s));
  await w.close();
};

test("a name outside the BMP (an emoji) keeps its surrogate pair", () => {
  const files = [{ path: "photo 📷.jpg", data: bytes("x"), mtime: clock }];
  assert.deepEqual(readImage(buildImage(files)).map((e) => e.path), ["photo 📷.jpg"]);
});

test("names that differ only in case: the first goes on the card, the other stays on the disk", async () => {
  const root = new MemDir();
  await put(root, "a.txt", "lower");
  await put(root, "A.TXT", "upper");
  const sync = new CardSync({ dir: root });
  const got = readImage(await sync.initialImage());
  assert.deepEqual(got.map((e) => [e.path, text(e.data)]), [["a.txt", "lower"]]);
  // the phone's edit goes to the file the card holds, the twin is untouched
  await sync.pull(buildImage([{ path: "a.txt", data: bytes("edited"), mtime: clock }]));
  assert.equal(text(root.kids.get("a.txt").data), "edited");
  assert.equal(text(root.kids.get("A.TXT").data), "upper");
});

// a FAT16 image's first FAT and its data area, as buildImage lays them out
const layout = (img) => {
  const dv = new DataView(img.buffer);
  const bs = dv.getUint32(446 + 8, true) * 512;
  const fat = bs + dv.getUint16(bs + 14, true) * 512;
  return { dv, fat, root: fat + 2 * dv.getUint16(bs + 22, true) * 512 };
};

test("a broken cluster chain is an error, not a file cut short", async () => {
  const csize = 2048 * 4;
  const img = buildImage([{ path: "big.bin", data: new Uint8Array(3 * csize), mtime: clock }]);
  const { dv, fat, root } = layout(img);
  // the root's entries: the label, then big.bin
  const first = dv.getUint16(root + 32 + 26, true);
  dv.setUint16(fat + first * 2, 0xffff, true);      // the chain ends after one cluster
  assert.throws(() => readImage(img), /cluster/);
  dv.setUint16(fat + first * 2, first, true);       // the chain loops
  assert.throws(() => readImage(img), /loops/);

  // pull throws too (the page tries again), and the folder is untouched
  const dir = new MemDir();
  await put(dir, "big.bin", "on the disk");
  const sync = new CardSync({ dir });
  await sync.initialImage();
  await assert.rejects(sync.pull(img));
  assert.equal(text(dir.kids.get("big.bin").data), "on the disk");
});

test("a conflict copy is written once, and never over a file on the disk", async () => {
  const root = new MemDir();
  await put(root, "n.txt", "base");
  await put(root, "n~phone.txt", "the user's own");
  const sync = new CardSync({ dir: root });
  await sync.initialImage();
  await put(root, "n.txt", "edited on the disk");
  const img = buildImage([
    { path: "n.txt", data: bytes("edited on the phone"), mtime: clock },
    { path: "n~phone.txt", data: bytes("the user's own"), mtime: clock },
  ]);
  await sync.pull(img);
  await sync.pull(img);
  assert.equal(text(root.kids.get("n~phone.txt").data), "the user's own");
  assert.equal(text(root.kids.get("n~phone2.txt").data), "edited on the phone");
  assert.equal(root.kids.has("n~phone3.txt"), false);
});
