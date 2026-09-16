# Emulator UI redesign — acceptance criteria

Scope: the Boot panel, status bar, Run panel, and mobile layout of the PMB887X emulator web UI.
Each item is written as a change to the current UI, followed by how to verify it.

Out of scope, must not change: the phone keypad (all keys, sizes, spacing, icons, shortcut labels) and the side keys (camera F8, play/pause F6, volume Num +, volume Num − etc) on desktop and mobile. Any diff to their markup, dimensions, or positions relative to the screen is a failure.

---

## 1. Rename and restructure the Boot panel into a Firmware panel

### 1.1 Rename
- Change: the fieldset legend "Boot" becomes "Firmware".
- Verify: no element on the page reads "Boot" or "Fullflash" as a heading.

### 1.2 Replace the two loose sections with a mode toggle
- Change: remove the separate "Fullflash" and "My own file (.bin)" sections. Add a two-option segmented control at the top of the panel: **Preset** | **Own file**. Implement as a radio group (`role="radiogroup"`, arrow-key navigable), styled as a segmented button.
- Change: only the controls belonging to the selected mode are rendered. Switching modes does not clear the other mode's values; they are restored if the user switches back within the session.
- Default: **Preset** if any preset is cached or was last used; otherwise **Preset** with the first list entry selected.
- Verify: with Preset selected, no file inputs are in the DOM. With Own file selected, no preset dropdown is in the DOM.

### 1.3 Preset mode contents
Render in this order:
1. Preset dropdown (existing list, existing labels minus the " — cached" suffix, which moves to the status line).
2. One status line, 11–12px secondary text, reflecting cache state for the selected preset:
   - not cached: `Not downloaded · fetches 64 MiB on Start`
   - cached: `✓ Cached · 64 MiB`
   - downloading: `Downloading · 23 / 64 MiB` with a thin progress bar beneath.
   Replace the two existing helper paragraphs ("preset fullflashes download when you press Start…" and "cached (64 MiB) — boots from the local cache") with this single line.
3. A **Clear cache** text link on the same row as the status line, right-aligned. Shown only when the selected preset is cached. Clicking it deletes that preset's cache and updates the status line to the not-cached variant. Remove the red trash icon button.
4. Read-only device line: `Device: siemens-s75 (from preset)`. No dropdown.
5. Advanced disclosure (unchanged contents).
- Verify: selecting a different preset updates the status line and device line without a page reload. Clear cache is absent for uncached presets.

### 1.4 Own file mode contents
Render in this order:
1. Label `Fullflash (.bin)`.
2. A drop zone (`<input type="file" accept=".bin,.cfi-efa" multiple>` behind a styled label) reading "Choose file or drop here". Drag-and-drop onto the zone must work.
3. Once a `.bin` is chosen, the drop zone is replaced by a file chip: file icon, filename (ellipsised), size in MiB, and a × button that clears it and restores the drop zone.
4. Label `Device` and a dropdown whose initial value is a placeholder `Select a device` (disabled option). No device is pre-selected. If the app can infer the device from the file, it may pre-select it; the user can still change it.
5. **Only when the selected device is an LG model:** label `EFA sidecar (.cfi-efa)`, a second drop zone reading "Choose file", and helper text `LG phones keep their EEPROM in the EFA block.` This block is absent from the DOM for non-LG devices. Once a sidecar is chosen it becomes a file chip like the `.bin` one.
6. Advanced disclosure.
- Verify: with device `siemens-s75`, the EFA block does not exist. Switching to `lg-kg800` adds it; switching back removes it (a chosen sidecar is remembered and restored if the user returns to an LG device).

### 1.5 Multi-file selection auto-fills the sidecar
- Change: the fullflash picker accepts multiple files. When the user selects or drops more than one file at once, apply these rules in order:
  1. Exactly one file ends in `.bin` and exactly one ends in `.cfi-efa` → the `.bin` fills the fullflash slot and the `.cfi-efa` fills the EFA sidecar slot. If the Device dropdown is still on the placeholder, leave it; if it is set to a non-LG device, show an inline warning under the device dropdown: `An EFA sidecar was provided but this device doesn't use one.` The sidecar is kept but not sent to the emulator unless an LG device is chosen.
  2. Exactly one `.bin` and no `.cfi-efa`, plus other files → use the `.bin`, ignore the rest, show an inline notice under the chip: `Ignored N other file(s).`
  3. Two or more `.bin` files, or two or more `.cfi-efa` files → reject the whole selection and show an inline error under the drop zone: `Choose one .bin and, optionally, one .cfi-efa.` Slots are unchanged.
  4. No `.bin` at all (e.g. only a `.cfi-efa`) → if a `.bin` is already loaded, fill only the sidecar slot; otherwise show the same error as rule 3.
- Change: the EFA sidecar drop zone accepts only a single `.cfi-efa`; dropping a `.bin` there shows `Expected a .cfi-efa file.` and leaves the slot unchanged.
- Change: extension matching is case-insensitive. Files whose names differ only by extension (e.g. `kg800.bin` + `kg800.cfi-efa`) need no special handling beyond the rules above.
- Verify: select `a.bin` and `a.cfi-efa` together in one dialog → both chips appear, sidecar block is visible once an LG device is chosen. Drop `a.bin`, `b.bin` → error, nothing loaded. Drop only `a.cfi-efa` with `a.bin` already loaded → sidecar chip appears.

### 1.6 Remove Start and Stop from the panel
- Change: delete the Start and Stop buttons at the bottom of the panel. They move to the status pill (section 2).
- Verify: the panel's last child is the Advanced disclosure.

### 1.7 Lock the panel while running
- Change: while emulator state is booting or running, every control inside the Firmware panel is `disabled` (segmented control, dropdowns, file inputs, chip × buttons, Clear cache). A single line of secondary text is inserted above the Advanced disclosure: `🔒 Locked while running. Stop to change firmware.` (use the lock icon, not the emoji).
- Change: values are not lost; when the emulator stops, controls re-enable with their previous values.
- Verify: press Start, confirm no Firmware control is focusable; press Stop, confirm they are.

---

## 2. Make the status pill the only Start/Stop control

### 2.1 Structure
- Change: the existing pill above the screen (currently `● idle`) gains a button in its right end. The pill's left part is state text; the right part is the action. Screenshot and record buttons stay to the right of the pill, unchanged.

### 2.2 States
| Emulator state | Dot | Text | Button |
|---|---|---|---|
| idle, firmware ready | grey | `Idle` | **Start** (filled accent) |
| idle, firmware not ready | grey | `Idle` | **Start** (disabled) + caption below the pill: `Choose a firmware to start` (Preset mode) or `Choose a file and device to start` (Own file mode) |
| downloading | grey, spinner | `Downloading · 23 / 64 MiB` | **Cancel** (outline) |
| booting | green, spinner | `Booting` | **Stop** (outline) |
| running | green | `Running · mm:ss` (uptime, updates every second) | **Stop** (outline) |
| paused (F6) | amber | `Paused · mm:ss` | **Stop** (outline) |

- "Firmware ready" means: Preset mode with any preset selected; Own file mode with a `.bin` and a device chosen. The sidecar is optional and does not gate Start.
- Start and Stop are never rendered at the same time.
- Verify: the DOM contains exactly one of `Start`/`Stop`/`Cancel` at any moment. Uptime counter resets on each Start.

### 2.3 Copy
- Change: the screen placeholder text while idle becomes `Ready to boot` (was `press "Start" to boot`).

---

## 3. Regroup the Run panel (desktop right column)

### 3.1 Groups
- Change: replace the current flat layout with two labelled groups in this order:
  - **Keyboard**: layout dropdown, language dropdown, checkbox `Show shortcuts on keys`, checkbox `Performance HUD` (drop the parenthetical "(guest speed, per second)"; move it to a tooltip on the label).
  - **Export**: two buttons side by side, `Flash` and `EFA`, each with a download icon.
- Change: remove the "Run" legend; the group headings replace it.

### 3.2 Export enablement
- Change: both Export buttons are `disabled` while state is idle, downloading, or booting, with a caption beneath: `Available once running`. They enable in running and paused states and the caption is removed.
- Verify: buttons are disabled on page load; enabled after boot completes.

---

## 4. Desktop layout (≥ ~900px)

- Change: three-column grid: Firmware panel (fixed ~420px, as today) | phone column (`1fr`, contents horizontally centred) | Run panel (fixed ~420px, as today). All columns `align-items: start`.
- Change: the phone column, top to bottom: status pill row, screen with side keys, keypad. Spacing between these is as today.
- Verify: screenshot the page at 1770px wide; the phone column is centred and the two panels top-align with the status pill.

---

## 5. Mobile layout (< ~600px)

### 5.1 Container
- Change: the page becomes a single flex column of `height: 100dvh` with `overflow: hidden`. There is no page scroll while the emulator view is shown.

### 5.2 Order
Top to bottom, in one column, full width with 10px side padding:
1. Header row (5.3)
2. Status pill row (section 2, same markup as desktop)
3. Screen with side keys (5.5)
4. Keypad (unchanged, `margin-top: auto` so it pins to the bottom)

The current Boot panel above the screen and the "Siemens / LG PMB887X emulator" title bar are removed from this view.

### 5.3 Header row
- Change: a flex row with two children:
  - **Firmware summary** (`flex: 1`): a button styled as a bordered row, two text lines. Line 1: firmware name (preset label, or the `.bin` filename in Own file mode), ellipsised. Line 2: `Preset · cached`, `Preset · not downloaded`, or `Own file · lg-kg800`. A chevron-down icon at the right end. Tapping opens the Firmware sheet (5.4).
  - **Settings button** (32×32, gear icon, `aria-label="Settings"`). Tapping opens the Settings sheet (5.4).
- Change: while running, the summary button is disabled, its chevron becomes a lock icon, and line 2 reads `Locked while running`.

### 5.4 Sheets
- Change: add a bottom-sheet component: slides up from the bottom, covers at most 90% of viewport height, has a drag handle, a title, scrollable body, and a full-width **Done** button. Closing = Done, swipe down, or tapping the scrim. Focus is trapped inside while open; Escape closes it.
- **Firmware sheet**: title `Firmware`; body is the exact Firmware panel from section 1 (same component, same behaviour including multi-file auto-fill and running lock). No Start/Stop inside.
- **Settings sheet**: title `Settings`; body is the Keyboard and Export groups from section 3, stacked.
- Verify: open Firmware sheet, change preset, tap Done → header summary line 1 updates immediately.

### 5.5 Screen and side keys
- Change: the screen row is a flex row: left side-key column | screen (`flex: 1`) | right side-key column. Side keys keep their current size, spacing, and vertical position relative to the screen exactly as today.
- Change: the screen wrapper takes all remaining vertical space (`flex: 1; min-height: 0` on the wrapper). The `<canvas>` inside uses `width: 100%; height: 100%; object-fit: contain` so it scales to the largest size that fits without distortion. Letterboxing shows as black.
- Verify: on a 390×844 viewport the keypad is fully visible without scrolling and the canvas is at least as tall as it is today.

---

## 6. Global rules

- 6.1 Any disabled control must have a visible one-line reason within 8px of it (see 2.2, 3.2, 1.7).
- 6.2 Exactly one filled primary button per view: Start when idle. Stop and Cancel are outline buttons.
- 6.3 All new labels, buttons, and captions use sentence case. No terminal punctuation on labels; captions and helper text end with a period.
- 6.4 No behaviour change to emulator core, keyboard shortcuts (F1–F9, Num keys, Enter), screenshot, or record.