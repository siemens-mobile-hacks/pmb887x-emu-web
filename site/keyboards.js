// On-screen keyboard definitions: "boards" describe the physical button
// arrangement (any number of rows/columns/keys + optional aux column),
// "layouts" the legends shown on a board, and applyKbdLayout() renders both
// into #keypad/#aux-keys. app.js imports this module and hooks up input
// handling + the layout dropdown.

// small line-art icons matching the engraved S75 key legends
export const KBD_ICONS = {
  voicemail: '<svg viewBox="0 0 26 12"><circle cx="5" cy="6" r="4"/><circle cx="21" cy="6" r="4"/><line x1="9" y1="6" x2="17" y2="6"/></svg>',
  key: '<svg viewBox="0 0 26 12"><circle cx="20" cy="6" r="3.8"/><line x1="16.2" y1="6" x2="2.5" y2="6"/><line x1="6" y1="6" x2="6" y2="9.8"/></svg>',
  bell: '<svg viewBox="0 0 14 13"><path d="M7 2C5.2 2 4.1 3.4 4.1 5.3c0 2.2-.6 3.2-1.5 3.9h8.8c-.9-.7-1.5-1.7-1.5-3.9C9.9 3.4 8.8 2 7 2Z"/><path d="M5.7 10.9a1.3 1.3 0 0 0 2.6 0"/></svg>',
};
const CALL_ICON = '<svg class="key-icon" viewBox="0 0 24 24"><g transform="rotate(90 12 12)"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></g></svg>';
// hang-up key: red receiver lying parallel to the ground above the white
// power symbol, as on the real keypad (colors via .icon-hangup/.icon-power)
const END_ICON = '<svg class="key-icon key-icon-stack" viewBox="0 0 24 40">'
  + '<g class="icon-hangup" transform="rotate(180 12 7.5) translate(0 -4.5) rotate(-45 12 12)"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></g>'
  + '<g class="icon-power" transform="translate(0 13)"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></g>'
  + '</svg>';

// a "board" describes the physical buttons: any number of rows (each with
// its own grid columns and keys) plus an optional aux column. label may be
// HTML (e.g. an icon). Every key also needs a KEY_TO_LINUX entry (app.js) to
// reach qemu; keys without one are still clickable but simply send nothing.
export const KBD_BOARDS = {
  s75: {
    aux: [
      { key: "music", label: "♪", title: "Media key (note)" },
      { key: "play", label: "▶", title: "Play / pause" },
      { key: "ptt", label: "PTT", title: "Push to talk" },
      { key: "camera", label: "CAM", title: "Camera" },
      { key: "browser", label: "WWW", title: "Browser / internet" },
      { key: "vol_up", label: "Vol+", title: "Volume up" },
      { key: "vol_down", label: "Vol−", title: "Volume down" },
    ],
    rows: [
      { cls: "krow krow-soft", cols: "1fr 1.2fr 1fr", keys: [
        { key: "left_soft", label: "L-soft", title: "Left soft key" },
        { key: "up", label: "▲", cls: "key-nav", title: "Joystick up" },
        { key: "right_soft", label: "R-soft", title: "Right soft key" },
      ]},
      { cls: "krow krow-joy", cols: "1fr 1.2fr 1fr", keys: [
        { key: "left", label: "◀", cls: "key-nav", title: "Joystick left" },
        { key: "center", label: "●", cls: "key-nav key-center", title: "Joystick press (OK)" },
        { key: "right", label: "▶", cls: "key-nav", title: "Joystick right" },
      ]},
      { cls: "krow krow-call", cols: "1fr 1.2fr 1fr", keys: [
        { key: "send", label: CALL_ICON, cls: "key-send", title: "Green key (call)" },
        { key: "down", label: "▼", cls: "key-nav", title: "Joystick down" },
        { key: "end", label: END_ICON, cls: "key-end", title: "Red key / power" },
      ]},
      { cls: "krow krow-digits", cols: "repeat(3, 1fr)", keys: [
        { key: "1" }, { key: "2" }, { key: "3" },
        { key: "4" }, { key: "5" }, { key: "6" },
        { key: "7" }, { key: "8" }, { key: "9" },
        { key: "star", label: "*", title: "*", cls: "key-inline" },
        { key: "0", cls: "key-inline" },
        { key: "hash", label: "#", title: "#", cls: "key-inline" },
      ]},
    ],
  },
};

// a "layout" = a board + the legends shown on it (sub-labels, keyed by
// data-key). Add an entry here — or a whole new board for a phone with
// different keys/arrangement — and the dropdown picks it up automatically.
export const KBD_LAYOUTS = {
  en: {
    name: "Siemens S75 English",
    board: "s75",
    subs: {
      1: `␣ ${KBD_ICONS.voicemail}`,
      2: "abc", 3: "def", 4: "ghi", 5: "jkl", 6: "mno",
      7: "pqrs", 8: "tuv", 9: "wxyz",
      0: "+", star: KBD_ICONS.bell, hash: KBD_ICONS.key,
    },
  },
  ru: {
    name: "Siemens S75 Russian",
    board: "s75",
    subs: {
      1: `␣ ${KBD_ICONS.voicemail}`,
      2: "abc абвг", 3: "def дежз", 4: "ghi ийкл", 5: "jkl мно",
      6: "mno прс", 7: "pqrs туфх", 8: "tuv цчшщь", 9: "wxyz ъыэюя",
      0: "+", star: KBD_ICONS.bell, hash: KBD_ICONS.key,
    },
  },
};

function keyButton(def, sub) {
  const btn = document.createElement("button");
  btn.dataset.key = def.key;
  if (def.title) btn.title = def.title;
  if (def.cls) btn.className = def.cls;
  const main = document.createElement("span");
  main.className = "key-main";
  main.innerHTML = def.label ?? def.key;
  btn.appendChild(main);
  const subHtml = sub ?? def.sub ?? "";
  if (subHtml) {
    const subEl = document.createElement("span");
    subEl.className = "key-sub";
    subEl.innerHTML = subHtml;
    btn.appendChild(subEl);
  }
  return btn;
}

// rebuild the on-screen keyboard from a layout; onRender runs once the DOM
// is in place (app.js re-binds input handling there)
export function applyKbdLayout(id, onRender) {
  const layout = KBD_LAYOUTS[id] ?? KBD_LAYOUTS.en;
  const board = KBD_BOARDS[layout.board] ?? KBD_BOARDS.s75;
  const keypad = document.getElementById("keypad");
  keypad.replaceChildren();
  for (const row of board.rows) {
    const rowEl = document.createElement("div");
    rowEl.className = row.cls ?? "krow";
    rowEl.style.gridTemplateColumns = row.cols;
    for (const def of row.keys) rowEl.appendChild(keyButton(def, layout.subs[def.key]));
    keypad.appendChild(rowEl);
  }
  const aux = document.getElementById("aux-keys");
  aux.replaceChildren(...(board.aux ?? []).map((def) => keyButton(def)));
  aux.style.display = board.aux?.length ? "" : "none";
  onRender?.();
}
