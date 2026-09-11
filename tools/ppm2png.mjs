// Minimal PPM (P6) → PNG converter, stdlib-only (node:zlib).  QEMU's HMP
// `screendump` writes PPM; the test harnesses save their screenshots to
// tests/results as PNG so they are viewable/pasteable everywhere.
import fs from "node:fs";
import zlib from "node:zlib";

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// PPM Buffer -> PNG Buffer, or null if not a valid 8-bit P6 PPM
export function ppmToPng(ppm) {
  const m = ppm.toString("latin1").match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!m || +m[3] !== 255) return null;
  const w = +m[1], h = +m[2];
  const off = Buffer.byteLength(m[0], "latin1");
  if (ppm.length < off + w * h * 3) return null;
  const raw = Buffer.alloc(h * (1 + w * 3)); // filter byte 0 + RGB rows
  for (let y = 0; y < h; y++) {
    ppm.copy(raw, y * (1 + w * 3) + 1, off + y * w * 3, off + (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function ppmFileToPng(file) {
  try {
    return ppmToPng(fs.readFileSync(file));
  } catch {
    return null;
  }
}
