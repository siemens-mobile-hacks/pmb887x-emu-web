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
  // stopwatch: crown + round body + hand (KE800 * key)
  timer: '<svg viewBox="0 0 12 13"><line x1="6" y1="1" x2="6" y2="2.7"/><circle cx="6" cy="7.2" r="4.1"/><line x1="6" y1="7.2" x2="7.6" y2="5.7"/></svg>',
  // solid wide up-arrow (KE800 # key, sits lower than the flash)
  arrow_up: '<svg class="icon-arrow" viewBox="0 0 16 12"><path fill="currentColor" stroke="none" d="M8 1 14.8 7.6H11V11H5V7.6H1.2Z"/></svg>',
  // filled flash whose tail ends in a down-pointing arrowhead (KE800 # key)
  flash_down: '<svg class="icon-flash" viewBox="0 0 12 15"><path stroke-width="2" d="M8.7 1.6 4.4 6.9h2.6L4.9 10.3"/><path fill="currentColor" stroke="none" d="M4.1 13.9 6.9 11.6 3.9 10.2Z"/></svg>',
};

// KE800 D-pad arrows: thick unfilled chevrons (^ v < >), not solid triangles
const NAV_CHEVRON = {
  up: '<svg class="key-icon-line" viewBox="0 0 14 9"><path stroke-width="2.2" d="M2 7.2 7 1.8l5 5.4"/></svg>',
  down: '<svg class="key-icon-line" viewBox="0 0 14 9"><path stroke-width="2.2" d="M2 1.8l5 5.4 5-5.4"/></svg>',
  left: '<svg class="key-icon-line" viewBox="0 0 9 14"><path stroke-width="2.2" d="M7.2 2 1.8 7l5.4 5"/></svg>',
  right: '<svg class="key-icon-line" viewBox="0 0 9 14"><path stroke-width="2.2" d="M1.8 2 7.2 7 1.8 12"/></svg>',
};
// side power button: broken circle + bar, stroke-drawn (see .key-icon-line)
const POWER_ICON = '<svg class="key-icon-line" viewBox="0 0 14 14"><line x1="7" y1="1.2" x2="7" y2="7.2"/><path d="M4.2 3.5a4.8 4.8 0 1 0 5.6 0"/></svg>';
// KE800 call key: the hung-up receiver lying in its cradle (arch with the
// ends curling down — material "call_end"), as engraved on the real phone
const CALL_ICON_HUNGUP = '<svg class="key-icon" viewBox="0 0 24 24"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.7l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.68-1.36-2.66-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>';
// KE800 "C" erase key: a U turned sideways, opening to the right
const C_ICON = '<svg class="key-icon-line" viewBox="0 0 13 14"><path stroke-width="2.3" d="M11 2.2H6a4.6 4.6 0 0 0 0 9.2h5"/></svg>';
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

// LG KE800 Chocolate: 4-way pad with OK center, soft keys + up above it,
// call / down / C below it, and side keys (vol rocker, power, camera, mp3)
// hanging off the aux column. C maps to the board CLEAR key (backspace).
// Legends glow red on the real phone (keyboards/LG KE800.png) → key-red.
ke800: {
  aux: [
    { key: "vol_up", label: "Vol+", title: "Volume up (left side)" },
    { key: "vol_down", label: "Vol−", title: "Volume down (left side)" },
    { key: "end", label: POWER_ICON, title: "Power / end call (side)" },
    { key: "camera", label: "CAM", title: "Camera (side)" },
    { key: "music", label: "MP3", title: "Music player (side)" },
  ],
  rows: [
    { cls: "krow krow-soft", cols: "1fr 1.2fr 1fr", keys: [
      { key: "left_soft", label: "—", cls: "key-red", title: "Left soft key" },
      { key: "up", label: NAV_CHEVRON.up, cls: "key-nav key-red", title: "D-pad up" },
      { key: "right_soft", label: "—", cls: "key-red", title: "Right soft key" },
    ]},
    { cls: "krow krow-joy", cols: "1fr 1.2fr 1fr", keys: [
      { key: "left", label: NAV_CHEVRON.left, cls: "key-nav key-red", title: "D-pad left" },
      { key: "center", label: "OK", cls: "key-nav key-center key-red", title: "OK" },
      { key: "right", label: NAV_CHEVRON.right, cls: "key-nav key-red", title: "D-pad right" },
    ]},
    { cls: "krow krow-call", cols: "1fr 1.2fr 1fr", keys: [
      { key: "send", label: CALL_ICON_HUNGUP, cls: "key-send key-red", title: "Call key" },
      { key: "down", label: NAV_CHEVRON.down, cls: "key-nav key-red", title: "D-pad down" },
      { key: "clear", label: C_ICON, cls: "key-red", title: "C — erase / back" },
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

// KE800 bottom-row sub-legend stacks, as engraved on the real keypad:
// * → timer icon with ".," under it, 0 → "+" above the space mark,
// # → flash upper right + solid arrow lower left
const KE800_STAR_SUB = `<span class="sub-stack">${KBD_ICONS.timer}<span>.,</span></span>`;
const KE800_ZERO_SUB = '<span class="sub-stack">+<span>␣</span></span>';
const KE800_HASH_SUB = `<span class="sub-pair">${KBD_ICONS.flash_down}${KBD_ICONS.arrow_up}</span>`;

// a "layout" = a board + the legends shown on it (sub-labels, keyed by
// data-key). Add an entry here — or a whole new board for a phone with
// different keys/arrangement — and the dropdown picks it up automatically.
export const KBD_LAYOUTS = {
  en: {
    name: "Siemens Generic English",
    board: "s75",
    subs: {
      1: `␣ ${KBD_ICONS.voicemail}`,
      2: "abc", 3: "def", 4: "ghi", 5: "jkl", 6: "mno",
      7: "pqrs", 8: "tuv", 9: "wxyz",
      0: "+", star: KBD_ICONS.bell, hash: KBD_ICONS.key,
    },
  },
  ru: {
    name: "Siemens Generic Russian",
    board: "s75",
    subs: {
      1: `␣ ${KBD_ICONS.voicemail}`,
      2: "abc абвг", 3: "def дежз", 4: "ghi ийкл", 5: "jkl мно",
      6: "mno прс", 7: "pqrs туфх", 8: "tuv цчшщь", 9: "wxyz ъыэюя",
      0: "+", star: KBD_ICONS.bell, hash: KBD_ICONS.key,
    },
  },

  // LG KE800 (keyboards/LG KE800.png): space sits on 0, * carries the clock
  // icon, # the up-arrow + flash icons, 1 the voicemail icon
  ke800_en: {
    name: "LG KE800 English",
    board: "ke800",
    subs: {
      1: KBD_ICONS.voicemail,
      2: "abc", 3: "def", 4: "ghi", 5: "jkl", 6: "mno",
      7: "pqrs", 8: "tuv", 9: "wxyz",
      0: KE800_ZERO_SUB, star: KE800_STAR_SUB, hash: KE800_HASH_SUB,
    },
  },
  ke800_ru: {
    name: "LG KE800 Russian",
    board: "ke800",
    subs: {
      1: KBD_ICONS.voicemail,
      2: "abc абвг", 3: "def дежз", 4: "ghi ийкл", 5: "jkl мноп",
      6: "mno рсту", 7: "pqrs фхцч", 8: "tuv шщъы", 9: "wxyz ьэюя",
      0: KE800_ZERO_SUB, star: KE800_STAR_SUB, hash: KE800_HASH_SUB,
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
