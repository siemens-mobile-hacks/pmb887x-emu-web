# Emulator UI — recording control acceptance criteria

Scope: the video-recording control in the mobile top row, on top of what is already implemented. Nothing else changes.

Problem being fixed: the record button is a red circle sitting next to the emulator's Stop button, and both actions read as "stop". Recording must look and read differently from stopping the emulator at every step.

---

## 1. Idle record button (not recording)

- Change: replace the red-circle icon with a video-camera outline icon. The button keeps its 28×28 size and position (between Screenshot and Settings) and uses the same neutral outline style as Screenshot and Settings — no red anywhere.
- Change: `aria-label` is `Start recording`.
- Change: the button is enabled only while the emulator is booting, running, or paused; otherwise disabled with `aria-label="Start recording (emulator not running)"`.
- Verify: while idle, no element in the top row uses the danger colour.

## 2. Recording pill (while recording)

- Change: on tap, the record button is replaced in place by a **recording pill**: a rounded pill with a red 6px dot, an elapsed-time counter `m:ss` updating every second, and a **Finish** button (24px tall, outline style, danger colour text and border). The pill uses the danger tint background and danger text colour.
- Change: the pill is `flex: none` and sized to its content; it never ellipsises.
- Change: the word "Stop" must not appear in the recording pill or its accessible names. The Finish button's `aria-label` is `Finish recording`.
- Change: tapping Finish ends the recording, triggers the existing save/download flow, and restores the idle record button from section 1 in the same position.
- Verify: while recording, the top row contains exactly two pills (status, recording) and exactly one button labelled Stop (in the status pill) and one labelled Finish (in the recording pill). The two pills use different colours: green for status, red for recording.

## 3. Status pill while recording

- Change: when the recording pill appears, the status pill drops its `Running · ` prefix and shows only the uptime `mm:ss` so both pills fit. The state dot and Stop button are unchanged. When recording ends, the prefix returns.
- Change: Stop in the status pill still stops the emulator. If a recording is in progress when Stop is tapped, the recording is finished and saved first, then the emulator stops; no confirmation dialog.
- Verify: at 320px viewport width, both pills, the Screenshot button, and the Settings button fit on one 32px row with no wrapping or overflow; the status pill's counter is still legible.

## 4. Row layout during recording

Left to right, while recording: status pill (`flex: 1; min-width: 0`) · Screenshot button · recording pill · Settings button. Screenshot stays enabled while recording.

- Verify: the row height stays 32px in both states; no layout shift occurs in the screen row or keypad when recording starts or ends.

## 5. Accessibility and copy

- On start, announce `Recording started` via a polite live region; on finish, `Recording saved`.
- Labels use sentence case; "Finish" is the only verb for ending a recording anywhere in the UI (buttons, labels, tooltips, live regions). "Stop" is reserved for the emulator.
- Verify: searching the mobile UI text and accessible names while recording returns exactly one "Stop" and exactly one "Finish".

---

## Global

- Desktop keeps its current record button behaviour; this change applies to the mobile top row only. (If desktop is updated later, it follows the same rules.)
- No change to recording format, save location, screenshot behaviour, emulator core, or keyboard shortcuts.
