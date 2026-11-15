// Driving the page's own-file boot the way a user does: the Startup mode,
// optionally the GSM option, the image (with its sidecars), then the device
// and Start. Every option left undefined is left as the page has it.
//
// device: picked once the page's own detection of the image has landed, and
// the wait ends only when the page reports that device as ready.
export async function loadOwnFlash(page, files, { startup, gsm, device } = {}) {
  if (startup !== undefined) await page.selectOption("#startup", startup);
  if (gsm !== undefined) await page.setChecked("#gsm", gsm);
  await page.click("#ff-mode-own");
  await page.setInputFiles("#fullflash", files);
  if (device === undefined) return;
  // a file the page cannot place is never ready on its own
  await page.waitForFunction(() => window.__ui.ready, null, { timeout: 30000 }).catch(() => {});
  await page.selectOption("#device", device);
  await page.waitForFunction((d) => window.__ui.ready && window.__ui.device === d, device,
                             { timeout: 30000 });
}

export async function bootOwnFlash(page, files, opts) {
  await loadOwnFlash(page, files, opts);
  await page.click("#btn-start");
}

// A page whose main thread is frozen never settles an evaluate, a $ or a
// screenshot, and Playwright gives evaluate no time limit of its own.
export const PAGE_CALL_MS = 20000;

export class PageUnresponsive extends Error {}

// The promise of a page call, or a PageUnresponsive rejection once ms have
// passed without an answer. what names the call in that message.
export function pageCall(promise, what = "page call", ms = PAGE_CALL_MS) {
  const call = Promise.resolve(promise);
  // the abandoned call rejects later, when the browser goes
  call.catch(() => {});
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PageUnresponsive(
      `${what}: the page did not answer in ${ms / 1000} s (main thread frozen?)`)), ms);
  });
  return Promise.race([call, limit]).finally(() => clearTimeout(timer));
}

// pageCall that resolves to fallback instead of rejecting; onError gets the
// reason (the call's own error, or the PageUnresponsive).
export async function bounded(promise, fallback, { ms = 15000, onError } = {}) {
  try {
    return await pageCall(promise, "page call", ms);
  } catch (e) {
    onError?.(e);
    return fallback;
  }
}

// What window.__ui says about the run, as page code to splice into a
// sampler (`{ ..., ui: ${UI_READ} }`): the frozen counters of a guest that
// died look like an idle one, so a sampler reads these with them.
export const UI_READ = `((u) => u && { state: u.state, error: u.error, exitCode: u.exitCode,
  exit: u.exit && { type: u.exit.type, code: u.exit.code } })(window.__ui)`;

// Why the guest is gone, from a UI_READ reading: the firmware's EXIT dump,
// qemu's exit (exitCode is cleared at Start), or an error the page shows.
// null while none of them has happened.
export function guestGone(ui) {
  if (!ui) return null;
  if (ui.exit) return `firmware EXIT ${[ui.exit.type, ui.exit.code].filter(Boolean).join(" ") || "(no details)"}`;
  if (ui.exitCode != null) return `qemu exited (${ui.exitCode}), page ${ui.state}`;
  if (ui.error) return `page error: ${String(ui.error).slice(0, 200)} (page ${ui.state})`;
  return null;
}
