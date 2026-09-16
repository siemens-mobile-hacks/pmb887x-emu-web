# Emulator UI — performance HUD acceptance criteria

Scope: the performance HUD on desktop and mobile, on top of what is already implemented. Nothing else changes.

Current: a three-line raw monospace block (`MIPS 14.3 (10s 11.9) v/wall 1.00 …`, `insns … cores … isolated …`, full browser user-agent) rendered at the top of the page, toggled by the "Performance HUD" checkbox. On mobile it wraps to ~7 lines and takes ~110px of height.

---

## 1. Remove the page-level block

- Change: delete the monospace block from the top of the page on both desktop and mobile. The page title bar is unaffected.
- Verify: no element above the Firmware panel (desktop) or the top row (mobile) contains performance text.

## 2. Shortened user-agent string

- Change: add a function `shortUserAgent()` returning `OS version · Browser version · Model`, built as:
  - **OS**: from `navigator.userAgentData.platform` plus `getHighEntropyValues(['platformVersion'])` when available; otherwise regex on `navigator.userAgent` for `Android (\d+)`, `iPhone OS (\d+)`, `Windows NT`, `Mac OS X`, `Linux`. Output examples: `Android 8`, `iOS 17`, `Windows`, `macOS`, `Linux`.
  - **Browser**: `userAgentData.brands` excluding entries whose brand contains `Not` (the placeholder brand), taking the first remaining brand and its major version; otherwise regex `(Edg|OPR|Chrome|Firefox|Safari)/(\d+)` with `Edg`→`Edge`, `OPR`→`Opera`. Output example: `Chrome 147`.
  - **Model**: mobile → `getHighEntropyValues(['model'])`, else the token between `Android x.x; ` and the next `)` or ` Build` in the UA. Desktop → the architecture token (`x86_64`, `arm64`, `Win64`) if present.
- Change: the result is cached once per page load. If any part is unavailable, that part is omitted rather than shown as `undefined`.
- Change: the full unmodified `navigator.userAgent` is still included in the existing "Copy diagnostics" output (add this action to the Settings sheet on mobile and the Keyboard/Export panel on desktop if not already present).
- Verify: on the Samsung test device the output is exactly `Android 8 · Chrome 147 · SM-G955U`; on the Linux desktop it is `Linux x86_64 · Chrome 147`.

## 3. HUD content — exactly two lines, both platforms

Both lines use the monospace font, `font-variant-numeric: tabular-nums`, `white-space: nowrap`, `overflow: hidden`, updated at 2 Hz (not per frame).

### Line 1 — live metrics
Tokens in priority order, joined with ` · `, each token fixed-width so the line does not jitter:

| # | Token | Format | Width | Colour |
|---|---|---|---|---|
| 1 | Speed | `1.00×` (v/wall, 2 decimals) | 5 | green ≥ 0.95, amber 0.80–0.94, red < 0.80 |
| 2 | MIPS | `13.9 MIPS` (1 decimal, pad to 4) | 9 | neutral |
| 3 | FPS | `0 fps` (integer, pad to 2) | 6 | neutral |
| 4 | Paint | `0 ms` (integer, pad to 3) | 6 | neutral |
| 5 | Lag | `lag 1.0s` (1 decimal) | 8 | amber ≥ 1.0 s, red ≥ 3.0 s |
| 6 | Halts | `0 halt/s` (integer, pad to 3) | 10 | neutral |

The 10-second averages currently shown in parentheses are removed from the HUD; they remain in "Copy diagnostics".

### Line 2 — environment
Tokens in priority order, joined with ` · `:

| # | Token | Example |
|---|---|---|
| 1 | Short user agent (section 2) | `Android 8 · Chrome 147 · SM-G955U` |
| 2 | Cores | `32c` |
| 3 | Memory | `32 GB` |
| 4 | Isolated (only when true) | `isolated` |

Line 2 is a muted colour and does not change during the session.

### Fitting rule
- Change: on load and on resize, measure the HUD container width, compute the character budget as `floor(width / charWidth) − 2` where `charWidth` is measured once from a hidden `0` glyph, and drop tokens from the **end** of each line (lowest priority first) until the line fits. Never reduce the font size, never wrap.
- Verify: at 272px container width (320px viewport) line 1 shows speed, MIPS, fps, lag; line 2 shows the short user agent. At 342px (390px viewport) both lines show every token. Resizing across the thresholds adds or removes tokens without wrapping or clipping mid-token.

## 4. Mobile placement — overlay, always visible

- Change: the HUD is rendered as an overlay strip on the **top edge of the screen box**, `position: absolute; top: 0; left: 0; right: 0`, background `rgba(0,0,0,0.6)`, padding `3px 6px`, two lines at 10px / line-height 1.4 (about 34px tall). It adds no height to the layout column; the keypad-fit rule from the previous AC still holds unchanged.
- Change: the HUD is always visible on mobile whenever the emulator is booting, running, or paused. The "Performance HUD" checkbox has no effect on mobile and is hidden from the mobile Settings sheet.
- Change: the strip is excluded from canvas screenshots and video recordings (those capture the `<canvas>` only). It is intentionally included in page screenshots.
- Change: the strip is `pointer-events: none` so taps pass through to the emulator screen.
- Verify: on the 390×844 test viewport the strip is visible while running, the screen box and keypad sizes are identical to the pre-change build, and a canvas screenshot does not contain the strip.

## 5. Desktop placement — under the status pill

- Change: the HUD renders as two lines directly beneath the status pill in the phone column, above the screen, centred, no background, muted text for line 2. It is shown only when the "Performance HUD" checkbox is on (existing behaviour of the toggle is kept).
- Verify: toggling the checkbox shows/hides the two lines without shifting the Firmware or Keyboard panels; the phone column moves down by the HUD height only.

## 6. Status pill warning

- Change: when speed < 0.80× for more than 3 consecutive seconds, the status pill changes to the amber/warning colour and its text gains a ` · slow` suffix (`Running · 2:10 · slow`). It returns to green when speed is ≥ 0.80× for 3 consecutive seconds. Applies to both platforms, independent of whether the HUD is shown.
- Exception: the warning is suppressed entirely while the real-time cap is still banking — the first 30 seconds of the guest's own clock, roughly the boot, reported as `window.__ui.rtcap === "banked"`. There speed is below 1.00× by construction (the guest is behind and allowed to catch up), so the warning would fire on every boot and mean nothing. The 3-second hysteresis restarts from zero at the switch, so the first amber pill of a run needs 3 full seconds of strict-mode slowness.
- The HUD's own `×` and `lag` tokens keep their colours throughout, banked phase included: the strip is a raw instrument and should show the real numbers, while the pill is a judgement about whether the user should care.
- Verify: (a) during the banked phase, throttle the CPU in devtools until speed drops below 0.80× and hold for >3 s — the pill stays green with no suffix; (b) wait for `window.__ui.rtcap` to leave `"banked"`, then throttle again — the pill turns amber within ~3 s and recovers when throttling is removed.

---

## Global

- No change to emulator core, metric computation, keypad, side keys, screenshot, or recording behaviour.
- The HUD strip has `aria-hidden="true"`; the metrics remain available to assistive tech through the existing "Copy diagnostics" action.
