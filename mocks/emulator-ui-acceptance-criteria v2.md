# Emulator UI — mobile follow-up acceptance criteria

Scope: changes to the **mobile layout (< ~600px)** on top of the redesign already implemented. Desktop, the Firmware panel, the sheets, and the status logic are unchanged and not covered here. Each item states the change to the current implementation, then how to verify it.

---

## 1. Merge the two top rows into one

Current: row 1 = firmware summary + settings gear; row 2 = status pill (Start/Stop) + screenshot + record. Together they take ~80px.

- Change: delete both rows and replace them with a single 32px flex row containing, left to right:
  1. **Status/firmware pill** (`flex: 1; min-width: 0`), a rounded pill with:
     - a 6px state dot (grey idle, green booting/running, amber paused);
     - one line of ellipsised 11–12px text. **Idle:** the firmware short name and cache state (`S75 v40 lg1 · cached`, or the `.bin` filename in Own file mode) followed by a chevron-down icon; this text is a button and opens the existing Firmware sheet. **Downloading / booting / running / paused:** the existing state text (`Running · 12:41`), not a button; the Firmware sheet cannot be opened in these states.
     - the existing action button (Start / Cancel / Stop), reduced to 24px tall, right-aligned inside the pill.
  2. **Screenshot** button, 28×28.
  3. **Record** button, 28×28.
  4. **Settings** button, 28×28, gear icon, opens the existing Settings sheet.
- Change: pill text ellipsises, never wraps. The action button and the three icon buttons have `flex: none`.
- Change: the "Locked while running" text and lock icon from the old summary row are removed; the running-state pill text is sufficient.
- Verify: on a 320px-wide viewport the row is 32px tall, all four controls are visible, and the firmware name is truncated with an ellipsis. Exactly one row exists between the top of the viewport and the screen.

## 2. Thin edge keys on mobile

Current: the four side keys are 28×28 squares with gaps, costing ~70px of horizontal space.

- Change: restyle the mobile side keys as thin edge tabs: 14px wide, 40px tall, 8px vertical gap between the two keys in each column, corners rounded only on the outer side (`4px 0 0 4px` left, `0 4px 4px 0` right). Left column: camera, play/pause. Right column: volume up, volume down. Each column is top-aligned with a 34px offset from the top of the screen box. Icons 10–11px; no shortcut labels on mobile.
- Change: each edge key gets a touch target of at least 32×44px extending outward from the screen (into the page padding), via negative margin + padding or a `::before` pseudo-element, without changing the 14px visual width.
- Change: the screen row becomes: left key column | screen box | right key column, with 2px gaps and 8px page padding on each side.
- Not changed: desktop side keys; key order and mapping (F8, F6, Num +, Num −).
- Verify: the screen row's non-screen width is 2×8 + 2×14 + 2×2 = 48px. Tapping 20px outside the screen edge next to a key triggers that key.

## 3. Screen box at the device's exact aspect ratio

Current: the canvas is letterboxed with `object-fit: contain`, leaving black bars.

- Change: remove `object-fit` letterboxing. The screen box gets `aspect-ratio` from the selected device profile (S75: 132×176 → `3 / 4`; each other device uses its own native panel size, added to the device profile if missing).
- Change: the box is sized to fit within **both** the available width (viewport − 48px, per section 2) **and** the available height (viewport − top row − keypad − gaps), whichever is tighter, then centred horizontally in the screen row. The `<canvas>` fills the box at `width: 100%; height: 100%` and the emulator renders at the box's size, so no black bars appear inside or around it.
- Verify: at 390×844 the box is 342px wide and 456px tall with no black bars; at 320×568 the box is height-limited, narrower than the row, centred, and still 3:4. Switching to a device with a different panel size changes the ratio.

## 4. Keypad must always fit — hard requirement

Current: on some viewports the keypad's bottom rows are pushed off-screen or require scrolling.

- Change: the keypad is the last child of the `100dvh` column with `margin-top: auto; flex: none`, and is never clipped, scrolled, or pushed off-screen. All rows including `* 0 #` must be fully visible whenever the emulator view is shown.
- Change: keypad row height scales with the viewport instead of being fixed. Define `--key-h: clamp(30px, 6.5dvh, 44px)` (tune the middle value so a typical phone lands on today's height) and use it for every keypad row including the nav cluster, so the keypad scales uniformly. Key set, order, icons, labels, 3-column grid, and gaps are unchanged.
- Change: the screen box (section 3) is what absorbs any height shortfall — it shrinks (keeping its ratio) before the keypad reaches its 30px minimum. The keypad hits its minimum only on viewports under ~520px tall.
- Change: on the shortest supported viewport (320×568 with browser URL bar expanded, ~490px usable), the top row (32px), the keypad at 30px rows, and a screen box of at least 120px tall must all fit. If they cannot, the screen box gives way; the keypad is never reduced below its minimum or clipped.
- Verify at each of 320×568, 360×640, 390×844, 430×932, each with URL bar shown and hidden: `document.documentElement.scrollHeight === window.innerHeight`, the keypad's bounding box bottom ≤ viewport bottom, and every keypad key is fully inside the viewport. Rotating the phone and toggling the URL bar must not introduce scroll or clip the keypad.

---

## Global

- A clipped or scrolled keypad on any viewport listed in section 4 fails acceptance regardless of the other criteria.
- No change to desktop layout, emulator core, keyboard shortcuts, screenshot, or record behaviour.
- New controls are keyboard-reachable and have accessible names.
