// The Siemens firmware's EXIT crash dump, read out of the serial log (the
// page's half is in app.js: when to look and how to show it).

export const EXIT_MARK = ">>EXIT<<";        // x75/x85 opens with this
export const EXIT_HEAD = "EXIT: ";          // x65 opens with the code instead
// what the firmware prints -> the row this page draws for it
export const EXIT_FIELDS = [
  [EXIT_HEAD, "Code"],
  ["ExitType: ", "Type"],
  ["ExitCode: ", "Code"],
  ["FILE: ", "File"],
  ["At address: ", "Address"],
  ["ExitString: ", "String"],
  ["CepId: ", "CepId"],
  ["CepName: ", "CepName"],
  ["CPSR: ", "CPSR"],
  ["Checksum: ", "Checksum"],
  ["recursive Exit detected: ", "Recursive"],
  ["2nd Exit: ", "2nd exit"],
];

// Every trace message is framed: FF FE, a big-endian 16-bit length, that
// length with its low bit flipped, then that many bytes of text. Bytes that
// are not a frame (a half-written tail, a firmware that frames differently)
// are cut on their non-printable runs instead, which lands in the same
// places — the payloads themselves are plain ASCII.
export function serialMessages(text) {
  const msgs = [];
  const at = (i) => text.charCodeAt(i);
  let i = 0, plainFrom = 0, end = text.length;
  const flushPlain = (to) => {
    for (const s of text.slice(plainFrom, to).split(/[^\x20-\x7e]+/))
      if (s.trim()) msgs.push(s);
  };
  while (i + 1 < end) {
    if (at(i) !== 0xff || at(i + 1) !== 0xfe) { i++; continue; }
    if (i + 6 > end) { end = i; break; }              // header still arriving
    const len = (at(i + 2) << 8) | at(i + 3);
    if (((at(i + 4) << 8) | at(i + 5)) !== (len ^ 1)) { i++; continue; }
    if (i + 6 + len > end) { end = i; break; }        // payload still arriving
    flushPlain(i);
    msgs.push(text.slice(i + 6, i + 6 + len));
    i = plainFrom = i + 6 + len;
  }
  flushPlain(end);
  return msgs;
}

// The newest dump in the log, or null. A dump is contiguous, so it ends at
// the first message that is not one of its fields.
export function parseExit(msgs) {
  let at = -1;
  for (let i = msgs.length - 1; i >= 0 && at < 0; i--) {
    if (msgs[i] === EXIT_MARK || msgs[i].startsWith(EXIT_HEAD)) at = i;
  }
  if (at < 0) return null;
  const rows = [];
  for (let i = msgs[at] === EXIT_MARK ? at + 1 : at; i < msgs.length; i++) {
    const f = EXIT_FIELDS.find(([label]) => msgs[i].startsWith(label));
    if (!f) break;
    // x65 prints a label and its value as two messages ("FILE: ", "ddsphw")
    let value = msgs[i].slice(f[0].length).trim();
    if (!value && i + 1 < msgs.length
        && !EXIT_FIELDS.some(([label]) => msgs[i + 1].startsWith(label))) {
      value = msgs[++i].trim();
    }
    rows.push([f[1], value]);
  }
  const field = (name) => rows.find(([n]) => n === name)?.[1] ?? null;
  return { rows, type: field("Type"), code: field("Code") };
}
