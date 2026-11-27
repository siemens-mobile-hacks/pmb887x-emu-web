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
  assert.equal(await sync.hostChanged(), false);
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
