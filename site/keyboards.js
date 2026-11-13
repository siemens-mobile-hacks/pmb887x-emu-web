// On-screen keyboard definitions: "boards" describe the physical button
// arrangement (any number of rows/columns/keys + optional auxLeft/auxRight
// columns for the phone's side keys), "keyboards" pair a board with the
// letter variants (English/Russian/...) engraved on it, and applyKbdLayout()
// renders both into #keypad/#aux-keys-left/#aux-keys-right. app.js imports
// this module and hooks up input handling + the two dropdowns.

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
// KE970 volume rocker: solid triangles, as engraved either side of its
// dividing line (keyboards/LG KE970-3.jpg). The side column runs down the
// screen, so they point up and down rather than along the phone.
const VOL_ARROW = {
  up: '<svg class="key-icon" viewBox="0 0 14 14"><path d="M7 3.4 12.6 10.6H1.4Z"/></svg>',
  down: '<svg class="key-icon" viewBox="0 0 14 14"><path d="M7 10.6 1.4 3.4h11.2Z"/></svg>',
};
// side power button: broken circle + bar, stroke-drawn (see .key-icon-line)
const POWER_ICON = '<svg class="key-icon-line" viewBox="0 0 14 14"><line x1="7" y1="1.2" x2="7" y2="7.2"/><path d="M4.2 3.5a4.8 4.8 0 1 0 5.6 0"/></svg>';
// one-glyph alternates for the aux columns on narrow screens (.key-short in
// style.css swaps them in): camera = body + lens, browser = wireframe globe
const CAMERA_ICON = '<svg class="key-icon-line" viewBox="0 0 16 12.6"><path d="M5.5 2.8 6.7 1.2h2.6l1.2 1.6"/><rect x="1" y="2.8" width="14" height="8.8" rx="1.6"/><circle cx="8" cy="7.2" r="2.7"/></svg>';
const GLOBE_ICON = '<svg class="key-icon-line" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.6"/><line x1="1.4" y1="7" x2="12.6" y2="7"/><ellipse cx="7" cy="7" rx="2.7" ry="5.6"/></svg>';
// S75 media key: play triangle next to the two pause bars, as engraved
const PLAY_PAUSE_ICON = '<svg class="key-icon" viewBox="0 0 20 12"><path d="M1 1 8.4 6 1 11Z"/><rect x="12" y="1" width="2.6" height="10" rx="0.7"/><rect x="16.4" y="1" width="2.6" height="10" rx="0.7"/></svg>';
// S75 music key: two beamed notes (♫), heads slanted under a thick beam
const NOTES_ICON = '<svg class="key-icon-line" viewBox="0 0 16 14">'
  + '<line x1="5.6" y1="3.2" x2="13.6" y2="1.7" stroke-width="2.6"/>'
  + '<line x1="5.6" y1="3.4" x2="5.6" y2="10.4"/>'
  + '<line x1="13.6" y1="1.9" x2="13.6" y2="8.8"/>'
  + '<ellipse cx="3.7" cy="10.5" rx="2" ry="1.6" fill="currentColor" stroke="none" transform="rotate(-18 3.7 10.5)"/>'
  + '<ellipse cx="11.7" cy="8.9" rx="2" ry="1.6" fill="currentColor" stroke="none" transform="rotate(-18 11.7 8.9)"/>'
  + '</svg>';
// S75 browser key: the planet ringed by its orbit, the ring crossing the
// planet's face and its ends sticking out either side — traced off
// keyboards/pasted file.png, not the WWW globe of the generic board
const BROWSER_ORBIT_ICON = '<svg class="key-icon-line icon-wide" viewBox="0 0 24 17" stroke-width="1.4">'
  + '<circle cx="12" cy="8.5" r="7.6"/>'
  + '<ellipse cx="12" cy="8.5" rx="11" ry="2.8" transform="rotate(20 12 8.5)"/>'
  + '</svg>';
// LG call key: the hung-up receiver lying in its cradle (arch with the
// ends curling down — material "call_end"), as engraved on the real phones.
// Both LG boards use it, level with the key edge.
const CALL_ICON_HUNGUP = '<svg class="key-icon" viewBox="0 0 24 24"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.7l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.68-1.36-2.66-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>';
// KE800 "C" erase key: a U turned sideways, opening to the right
const C_ICON = '<svg class="key-icon-line" viewBox="0 0 13 14"><path stroke-width="2.3" d="M11 2.2H6a4.6 4.6 0 0 0 0 9.2h5"/></svg>';
const CALL_ICON = '<svg class="key-icon" viewBox="0 0 24 24"><g transform="rotate(90 12 12)"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></g></svg>';
// hang-up key: red receiver lying parallel to the ground above the white
// power symbol, as on the real keypad (colors via .icon-hangup/.icon-power)
const END_ICON = '<svg class="key-icon key-icon-stack" viewBox="0 0 24 40">'
  + '<g class="icon-hangup" transform="rotate(180 12 7.5) translate(0 -4.5) rotate(-45 12 12)"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></g>'
  // the power mark is a closed ring with the bar inside it, not the usual
  // broken-circle glyph (see the engraving in keyboards/S75-ru.webp)
  + '<g class="icon-power" transform="translate(0 13)">'
  + '<path fill-rule="evenodd" d="M2 12a10 10 0 1 1 20 0 10 10 0 1 1-20 0Zm2.6 0a7.4 7.4 0 1 0 14.8 0 7.4 7.4 0 1 0-14.8 0Z"/>'
  + '<rect x="10.8" y="6.4" width="2.4" height="11.2" rx="1.2"/></g>'
  + '</svg>';

// a "board" describes the physical buttons: any number of rows (each with
// its own grid columns and keys) plus optional auxLeft/auxRight columns for
// the side keys flanking the LCD (auxLeft = left side, auxRight = right
// side, top to bottom). label may be HTML (e.g. an icon); short is a one-glyph
// alternate label aux keys switch to when the screen is narrow (see
// .key-short in style.css). Every key also needs a KEY_TO_LINUX entry
// (app.js) to reach qemu; keys without one are still clickable but simply
// send nothing.

// the 3x4 digit block is the same on every phone here — only the legends
// under the digits change, and those come from the variant's subs
const DIGIT_ROW = { cls: "krow krow-digits", cols: "repeat(3, 1fr)", keys: [
  { key: "1" }, { key: "2" }, { key: "3" },
  { key: "4" }, { key: "5" }, { key: "6" },
  { key: "7" }, { key: "8" }, { key: "9" },
  { key: "star", label: "*", title: "*", cls: "key-inline" },
  { key: "0", cls: "key-inline" },
  { key: "hash", label: "#", title: "#", cls: "key-inline" },
]};

export const KBD_BOARDS = {
  // every Siemens key the emulator knows, whether or not one phone has them
  // all: joystick block, both soft keys and the full side column
  generic: {
    auxLeft: [
      { key: "music", label: "♪", short: "♪", title: "Media key (note)" },
      { key: "play", label: "▶", short: "▶", title: "Play / pause" },
      { key: "ptt", label: "PTT", short: "P", title: "Push to talk" },
      { key: "camera", label: "CAM", short: CAMERA_ICON, title: "Camera" },
      { key: "browser", label: "WWW", short: GLOBE_ICON, title: "Browser / internet" },
      { key: "vol_up", label: "Vol+", short: "+", title: "Volume up" },
      { key: "vol_down", label: "Vol−", short: "−", title: "Volume down" },
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
      DIGIT_ROW,
    ],
  },

  // Siemens S75 (keyboards/S75-ru.webp): one square joystick pad in the
  // middle — four arrow marks around a dash-engraved OK button — flanked by
  // the dash soft keys above and call + media (left) / browser + hang-up
  // (right) beside it; the screen is flanked by camera / play-pause on the
  // left and the volume rocker on the right.
  s75: {
    auxLeft: [
      { key: "camera", label: CAMERA_ICON, short: CAMERA_ICON, title: "Camera (left side)" },
      { key: "play", label: PLAY_PAUSE_ICON, short: PLAY_PAUSE_ICON, title: "Play / pause (left side)" },
    ],
    auxRight: [
      { key: "vol_up", label: "+", short: "+", title: "Volume up (right side)" },
      { key: "vol_down", label: "−", short: "−", title: "Volume down (right side)" },
    ],
    rows: [
      // no cols: .krow-s75-mid owns them, so a touch screen can widen the
      // middle column to fit a thicker joystick pad (style.css)
      { cls: "krow krow-s75-mid", keys: [
        { cls: "kflank", keys: [
          { key: "left_soft", label: "—", cls: "kspan2", title: "Left soft key" },
          { key: "send", label: CALL_ICON, cls: "key-send", title: "Green key (call)" },
          { key: "music", label: NOTES_ICON, title: "Media key (music player)" },
        ]},
        { cls: "kpad", keys: [
          { key: "up", label: "▲", cls: "key-nav kpad-up", title: "Joystick up" },
          { key: "left", label: "◀", cls: "key-nav kpad-left", title: "Joystick left" },
          { key: "center", label: "—", cls: "key-center kpad-ok", title: "Joystick press (OK)" },
          { key: "right", label: "▶", cls: "key-nav kpad-right", title: "Joystick right" },
          { key: "down", label: "▼", cls: "key-nav kpad-down", title: "Joystick down" },
        ]},
        { cls: "kflank", keys: [
          { key: "right_soft", label: "—", cls: "kspan2", title: "Right soft key" },
          { key: "browser", label: BROWSER_ORBIT_ICON, title: "Browser / internet" },
          { key: "end", label: END_ICON, cls: "key-end", title: "Red key / power" },
        ]},
      ]},
      DIGIT_ROW,
    ],
  },

// LG KE800 Chocolate: 4-way pad with OK center, soft keys + up above it,
// call / down / C below it; side keys sit on BOTH flanks of the phone —
// vol rocker on the left, power / camera / mp3 (top to bottom) on the
// right. C maps to the board CLEAR key (backspace). Legends glow red on
// the real phone (keyboards/LG KE800.png) → key-red.
ke800: {
  auxLeft: [
    { key: "vol_up", label: "Vol+", short: "+", title: "Volume up (left side)" },
    { key: "vol_down", label: "Vol−", short: "−", title: "Volume down (left side)" },
  ],
  auxRight: [
    { key: "end", label: POWER_ICON, short: POWER_ICON, title: "Power / end call (right side, top)" },
    { key: "camera", label: "CAM", short: CAMERA_ICON, title: "Camera (right side)" },
    { key: "music", label: "MP3", short: "♪", title: "Music player (right side)" },
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
    DIGIT_ROW,
  ],
},

// LG KE970 Shine (keyboards/LG KE970.jpg, keyboards/LG KE970-2.jpg): the
// front carries no pad at all — a scroll wheel lies between two dash soft
// keys, and it is the whole navigation: roll it for up/down, press it for
// OK. It stands in here as a pad, wider than it is tall like the roller
// itself; left/right have no mark of their own on the phone but are keys of
// its matrix, so the pad carries them. The slide-out keypad adds call / C /
// end above the digits, and the only side keys are on the right flank
// (keyboards/LG KE970-3.jpg — the left flank is bare).
ke970: {
  auxRight: [
    { key: "vol_up", label: VOL_ARROW.up, short: VOL_ARROW.up, title: "Volume up (right side)" },
    { key: "vol_down", label: VOL_ARROW.down, short: VOL_ARROW.down, title: "Volume down (right side)" },
    { key: "music", label: "MP3", short: "MP3", title: "Music player (right side)" },
    { key: "camera", label: CAMERA_ICON, short: CAMERA_ICON, title: "Camera (right side)" },
  ],
  rows: [
    // the wheel: .kwheel dresses the pad as the roller it stands for (a
    // ridged chrome bar), the hit areas are the pad's own
    { cls: "krow krow-ke970-mid", keys: [
      { key: "left_soft", label: "—", title: "Left soft key" },
      { cls: "kpad kwheel", keys: [
        { key: "up", label: NAV_CHEVRON.up, cls: "key-nav kpad-up", title: "Scroll wheel up" },
        { key: "left", label: NAV_CHEVRON.left, cls: "key-nav kpad-left", title: "Left" },
        { key: "center", label: "OK", cls: "key-center kpad-ok", title: "Scroll wheel press (OK)" },
        { key: "right", label: NAV_CHEVRON.right, cls: "key-nav kpad-right", title: "Right" },
        { key: "down", label: NAV_CHEVRON.down, cls: "key-nav kpad-down", title: "Scroll wheel down" },
      ]},
      { key: "right_soft", label: "—", title: "Right soft key" },
    ]},
    // call and end carry no colour here: the KE970 prints them in the same
    // dark ink as every other legend, green and red are the Siemens boards'
    { cls: "krow krow-call", cols: "1fr 1.2fr 1fr", keys: [
      { key: "send", label: CALL_ICON_HUNGUP, title: "Call key" },
      { key: "clear", label: "C", title: "C — erase / back" },
      { key: "end", label: END_ICON, title: "End call / power" },
    ]},
    DIGIT_ROW,
  ],
},
};

// LG bottom-row sub-legend stacks. 0 is engraved the same on both phones —
// "+" above the space mark — while * and # are the KE800's: the timer icon
// with ".," under it, and the flash upper right + solid arrow lower left.
// The KE970 prints those two plainer and overrides them (see its keyboard).
const LG_STAR_SUB = `<span class="sub-stack">${KBD_ICONS.timer}<span>.,</span></span>`;
const LG_ZERO_SUB = '<span class="sub-stack">+<span>␣</span></span>';
const LG_HASH_SUB = `<span class="sub-pair">${KBD_ICONS.flash_down}${KBD_ICONS.arrow_up}</span>`;

// Siemens multi-tap, read off the firmware's own cycle bar (one tap per key
// in an SMS): S75 v40, EL71 v41 and SL65 v49 cycle the same in English. The
// EL71 is a Russian phone, and in Cyrillic its keys cycle the Russian
// letters, the digit, then the Latin ones; * opens the symbol table and #
// changes case, so neither is part of it. These are the lower-case cycles:
// with capitals on, the accented tail is shorter (the SL65's 2 is
// ABC2ÄÆÅ: no À or Ç), so an accented capital can come out as its
// neighbour. Letters, digits and punctuation sit at the same place either
// way.
const SIEMENS_TAPS_EN = {
  1: " \n1", 2: "abc2äàæåç", 3: "def3éè", 4: "ghi4ì", 5: "jkl5",
  6: "mno6öøòñ", 7: "pqrs7ß", 8: "tuv8üù", 9: "wxyz9", 0: ".,?!'\"0+-()@/:_",
};
const SIEMENS_TAPS_RU = {
  ...SIEMENS_TAPS_EN,
  2: [SIEMENS_TAPS_EN[2], "абвг2abc"],
  3: [SIEMENS_TAPS_EN[3], "деёжзє3def"],
  4: [SIEMENS_TAPS_EN[4], "ийкл4ghiї"],
  5: [SIEMENS_TAPS_EN[5], "мно5jkl"],
  6: [SIEMENS_TAPS_EN[6], "прс6mno"],
  7: [SIEMENS_TAPS_EN[7], "туфх7pqrs"],
  8: [SIEMENS_TAPS_EN[8], "цчшщъ8tuv"],
  9: [SIEMENS_TAPS_EN[9], "ыьэюя9wxyz"],
};

// Siemens legends, shared by every Siemens keyboard: the digit block is
// engraved the same way across the family (keyboards/S75-ru.webp), the
// Russian keypad simply adds its letters after the Latin ones.
const SIEMENS_VARIANTS = {
  en: {
    name: "English",
    subs: {
      1: `␣ ${KBD_ICONS.voicemail}`,
      2: "abc", 3: "def", 4: "ghi", 5: "jkl", 6: "mno",
      7: "pqrs", 8: "tuv", 9: "wxyz",
      0: "+", star: KBD_ICONS.bell, hash: KBD_ICONS.key,
    },
    taps: SIEMENS_TAPS_EN,
  },
  ru: {
    name: "Russian",
    subs: {
      1: `␣ ${KBD_ICONS.voicemail}`,
      2: "abc абвг", 3: "def дежз", 4: "ghi ийкл", 5: "jkl мно",
      6: "mno прс", 7: "pqrs туфх", 8: "tuv цчшщь", 9: "wxyz ъыэюя",
      0: "+", star: KBD_ICONS.bell, hash: KBD_ICONS.key,
    },
    taps: SIEMENS_TAPS_RU,
  },
};

// LG multi-tap, typed out key by key in a KE800 v11b SMS (the firmware shows
// no cycle bar): punctuation on 1, and 0 types a space per tap rather than
// cycling; * opens the symbol table. That firmware has no Russian input, so
// the Cyrillic cycles are not read off a phone but follow the KE800's Russian
// legend in order, the digit after them as on every firmware read here —
// check them against a Russian LG firmware when there is one.
const LG_TAPS_EN = {
  1: ".,?!'\"1-()@/:_", 2: "abc2àâæç", 3: "def3éèêë", 4: "ghi4îï", 5: "jkl5",
  6: "mno6ñôöœ", 7: "pqrs7", 8: "tuv8û", 9: "wxyz9ŵŷ", 0: " ",
};
const LG_TAPS_RU = {
  ...LG_TAPS_EN,
  2: [LG_TAPS_EN[2], "абвг2"],
  3: [LG_TAPS_EN[3], "дежз3"],
  4: [LG_TAPS_EN[4], "ийкл4"],
  5: [LG_TAPS_EN[5], "мноп5"],
  6: [LG_TAPS_EN[6], "рсту6"],
  7: [LG_TAPS_EN[7], "фхцч7"],
  8: [LG_TAPS_EN[8], "шщъы8"],
  9: [LG_TAPS_EN[9], "ьэюя9"],
};

// LG legends: the KE800's keypad (keyboards/LG KE800.png), which the KE970
// shares letter for letter (keyboards/LG KE970-2.jpg) — voicemail on 1,
// space on 0 — and differs from only in the two marks it prints plainer,
// * and #, which its own keyboard overrides below. The Russian variant is
// the KE800's alone: the KE970 keyboard is English-only, no photo of a
// Russian one being at hand and its letter split being a guess otherwise.
const LG_VARIANTS = {
  en: {
    name: "English",
    subs: {
      1: KBD_ICONS.voicemail,
      2: "abc", 3: "def", 4: "ghi", 5: "jkl", 6: "mno",
      7: "pqrs", 8: "tuv", 9: "wxyz",
      0: LG_ZERO_SUB, star: LG_STAR_SUB, hash: LG_HASH_SUB,
    },
    taps: LG_TAPS_EN,
  },
  ru: {
    name: "Russian",
    subs: {
      1: KBD_ICONS.voicemail,
      2: "abc абвг", 3: "def дежз", 4: "ghi ийкл", 5: "jkl мноп",
      6: "mno рсту", 7: "pqrs фхцч", 8: "tuv шщъы", 9: "wxyz ьэюя",
      0: LG_ZERO_SUB, star: LG_STAR_SUB, hash: LG_HASH_SUB,
    },
    taps: LG_TAPS_RU,
  },
};

// The * symbol pickers: how a character no key cycles through gets typed.
// They differ by model, not by language (the Russian EL71's is the S75's).
//
// Siemens: a grid that opens with the cursor on its own "*". Left/Right
// walk it row to row and wrap from the end round to the start, so the grid
// is one circular sequence and its width (8 on the x75s, 9 on the SL65)
// never matters; the joystick press inserts the symbol. The x65 SL65 has a
// "`" after "^" that the x75 S75 and EL71 lack. The generic keyboard, which
// stands for both, keeps the SL65's list: the shortest way to anything up
// to "^" is rightward and to anything from "§" on leftward, both the same
// count on either family, so only "`" itself comes out wrong on an x75 (as
// "§"). "\n" is the picker's ↵.
const SIEMENS_PICKER_X65 = {
  open: "star", select: "center", start: "*",
  ring: "\n¿¡_;.,?!+-\"':*/()¤¥$£€@\\&#[]{}%~<=>|^`§ΓΔΘΛΞΠΣΦΨΩ",
};
const SIEMENS_PICKER_X75 = { ...SIEMENS_PICKER_X65, ring: SIEMENS_PICKER_X65.ring.replace("`", "") };

// LG phones swallow the first key that comes after ~10–15 s (guest) of no
// keys while they wake up (KE800: a key after 10 s idle typed, after 15 s it
// was lost), Siemens ones do not. Typing presses `key`, a side key that does
// nothing in an editor or the picker, before a character that comes `idle`
// ms after the last key.
const LG_WAKE = { key: "vol_up", idle: 8000 };

// LG (KE800 v11b): pages of twelve, each symbol on the key printed beside it
// (1–9, *, 0, #); Down/Up turn the page and wrap. A key only collects its
// symbol into a line at the top, and OK (the left soft key) inserts the
// line. The picker takes ~0.56 s (guest) to come up and the editor ~0.44 s
// to come back, and keys sent before either are lost, hence settle (after
// the opening press) and after (after OK).
const LG_PICKER = {
  open: "star", settle: 800, after: 600, next: "down", prev: "up", select: "left_soft",
  slots: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "star", "0", "hash"],
  pages: [" .,?!:;-@+*(", ")'\"_#&€£$¥%/", "<>¿¡§|~\\[]^=", "ΦΓΛΩΠΨΣΘΞΔ¤{", "}`¶"],
};

// the presses that type `ch` through a picker, or null when it has none
function pickerPresses(picker, ch) {
  if (!picker) return null;
  if (picker.ring) {
    const ring = [...picker.ring];
    const at = ring.indexOf(ch);
    if (at < 0) return null;
    const right = (at - ring.indexOf(picker.start) + ring.length) % ring.length;
    const left = (ring.length - right) % ring.length;
    const moves = right < left ? Array(right).fill("right") : Array(left).fill("left");
    return [picker.open, ...moves, picker.select];
  }
  const page = picker.pages.findIndex((p) => p.includes(ch));
  if (page < 0) return null;
  const back = picker.pages.length - page;
  const turns = page <= back ? Array(page).fill(picker.next) : Array(back).fill(picker.prev);
  const slot = picker.slots[[...picker.pages[page]].indexOf(ch)];
  return [picker.open, ...turns, slot, picker.select];
}

// a "keyboard" = a board + one variant per letter set engraved on it; a
// variant carries the sub-labels (keyed by data-key) printed under the
// digits, and the multi-tap table (taps, see tapTable()) its firmware types
// with. Add a variant here — or a whole new keyboard, with its own board
// when the phone's keys/arrangement differ — and the two dropdowns pick it
// up automatically. The first variant of a keyboard is its default.
// tapPause is the keyboard's multi-tap timeout in guest ms: how long the
// firmware waits after a tap before it takes the letter and a new tap on the
// same key starts the next one. Measured from the release, with some margin:
// S75 and SL65 ~0.8 s, EL71 ~1 s, KE970 ~0.6 s.
export const KBD_KEYBOARDS = {
  siemens: {
    name: "Siemens Generic",
    board: "generic",
    tapPause: 1400,
    picker: SIEMENS_PICKER_X65,
    variants: SIEMENS_VARIANTS,
  },

  // the real S75 keypad: same legends, fewer keys, and they sit elsewhere
  s75: {
    name: "Siemens S75",
    board: "s75",
    tapPause: 1400,
    picker: SIEMENS_PICKER_X75,
    variants: SIEMENS_VARIANTS,
  },

  // LG KE800 (keyboards/LG KE800.png): the D-pad phone of the two
  ke800: {
    name: "LG KE800",
    board: "ke800",
    tapPause: 1000,
    picker: LG_PICKER,
    wake: LG_WAKE,
    variants: LG_VARIANTS,
  },

  // LG KE970 Shine (keyboards/LG KE970.jpg): the KE800's letters, the scroll
  // wheel in place of the D-pad, and a plainer bottom row — * carries ".,"
  // with no clock beside it, # the up arrow with no flash. English only —
  // see LG_VARIANTS.
  ke970: {
    name: "LG KE970",
    board: "ke970",
    tapPause: 1000,
    picker: LG_PICKER,
    wake: LG_WAKE,
    variants: {
      en: {
        name: "English",
        subs: { ...LG_VARIANTS.en.subs, star: ".,", hash: KBD_ICONS.arrow_up },
        taps: LG_TAPS_EN,
      },
    },
  },
};

export const DEFAULT_KEYBOARD = "siemens";

// the variant to show for a keyboard: the asked-for one if it has it (so
// Russian survives a phone switch), else the keyboard's first
export function pickVariant(keyboardId, variantId) {
  const variants = KBD_KEYBOARDS[keyboardId]?.variants ?? {};
  return variantId in variants ? variantId : Object.keys(variants)[0];
}

// What typing a character on the computer's keyboard presses on the phone,
// for a keyboard + variant: char -> { key, count } (press `key` `count`
// times), plus the keyboard's tapPause. A variant's taps maps a key to the
// characters it cycles through, in the firmware's order; a key whose cycle
// depends on the phone's input language gives one string per language, and
// a character counts from the one it comes earliest in — the language it is
// typed in (Russian Siemens: "а" is 2×1 in Cyrillic, "a" 2×1 in English,
// though each also sits further along the other's cycle). A character on no
// cycle but in the keyboard's picker maps to { keys, settle, after }
// instead: those keys, one press each, waiting settle ms once the first has
// opened the picker and after ms once the last has closed it. The lookup is by lower case: the phone's own case mode decides
// the case.
export function tapTable(keyboardId, variantId) {
  const id = keyboardId in KBD_KEYBOARDS ? keyboardId : DEFAULT_KEYBOARD;
  const kbd = KBD_KEYBOARDS[id];
  const taps = kbd.variants[pickVariant(id, variantId)].taps ?? {};
  const chars = new Map();
  for (const [key, cycles] of Object.entries(taps)) {
    for (const cycle of [cycles].flat()) {
      [...cycle].forEach((ch, i) => {
        if (!(chars.get(ch)?.count <= i + 1)) chars.set(ch, { key, count: i + 1 });
      });
    }
  }
  const picker = kbd.picker;
  for (const ch of picker ? [...(picker.ring ?? picker.pages.join(""))] : []) {
    if (!chars.has(ch)) {
      chars.set(ch, { keys: pickerPresses(picker, ch), settle: picker.settle ?? 0, after: picker.after ?? 0 });
    }
  }
  return { chars, pause: kbd.tapPause, wake: kbd.wake };
}

function keyButton(def, sub) {
  const btn = document.createElement("button");
  btn.dataset.key = def.key;
  if (def.title) btn.title = def.title;
  if (def.cls) btn.className = def.cls;
  const main = document.createElement("span");
  main.className = "key-main";
  main.innerHTML = def.label ?? def.key;
  btn.appendChild(main);
  if (def.short) {
    const shortEl = document.createElement("span");
    shortEl.className = "key-short";
    shortEl.innerHTML = def.short;
    btn.appendChild(shortEl);
  }
  const subHtml = sub ?? def.sub ?? "";
  if (subHtml) {
    const subEl = document.createElement("span");
    subEl.className = "key-sub";
    subEl.innerHTML = subHtml;
    btn.appendChild(subEl);
  }
  return btn;
}

// a def carrying its own `keys` is a group, not a key: it renders as a nested
// grid styled by its cls (the S75 joystick pad and the key columns flanking
// it), so one row entry can hold a block that is more than one key tall
function keyNode(def, subs) {
  if (!def.keys) return keyButton(def, subs?.[def.key]);
  const group = document.createElement("div");
  if (def.cls) group.className = def.cls;
  if (def.cols) group.style.gridTemplateColumns = def.cols;
  for (const inner of def.keys) group.appendChild(keyNode(inner, subs));
  return group;
}

// rebuild the on-screen keyboard from a keyboard + letter variant; onRender
// runs once the DOM is in place (app.js re-binds input handling there)
export function applyKbdLayout(keyboardId, variantId, onRender) {
  const id = keyboardId in KBD_KEYBOARDS ? keyboardId : DEFAULT_KEYBOARD;
  const kbd = KBD_KEYBOARDS[id];
  const variant = kbd.variants[pickVariant(id, variantId)];
  const board = KBD_BOARDS[kbd.board] ?? KBD_BOARDS.generic;
  const keypad = document.getElementById("keypad");
  keypad.replaceChildren();
  for (const row of board.rows) {
    const rowEl = document.createElement("div");
    rowEl.className = row.cls ?? "krow";
    if (row.cols) rowEl.style.gridTemplateColumns = row.cols;
    for (const def of row.keys) rowEl.appendChild(keyNode(def, variant.subs));
    keypad.appendChild(rowEl);
  }
  // side columns: auxLeft = left flank, auxRight = right flank (if the board
  // has one). A side this board has no keys for is left empty; style.css
  // takes it out of the layout (`.aux-keys-*:empty`) and sizes the screen box
  // for the flanks that remain.
  for (const [elId, defs] of [["aux-keys-left", board.auxLeft], ["aux-keys-right", board.auxRight]]) {
    document.getElementById(elId)
      .replaceChildren(...(defs ?? []).map((def) => keyButton(def)));
  }
  // A tab is one glyph wide by default, and on a phone that floor is what it
  // gets. A board that writes a word on a side key instead (the KE970's MP3)
  // needs more than a glyph's worth, so it says so and style.css raises the
  // floor for it — at the cost of a little screen width, which is the trade
  // the board asked for. An icon short is markup with no text in it, so the
  // rendered text is what the test reads.
  const wideTab = [...document.querySelectorAll(
    ".aux-keys-left .key-short, .aux-keys-right .key-short")]
    .some((el) => el.textContent.trim().length > 1);
  document.querySelector(".phone-panel")?.classList.toggle("tabs-wide", wideTab);
  onRender?.();
}
