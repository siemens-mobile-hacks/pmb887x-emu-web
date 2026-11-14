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
