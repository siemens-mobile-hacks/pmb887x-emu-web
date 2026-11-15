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

// window.__qemulog (?tracebuf=1) holds only the newest lines: past 30000
// the page cuts the oldest 10000, so an index into it goes stale and a tool
// that remembers one skips lines.  Added with page.addInitScript() before the
// page loads, QEMULOG_COUNT wraps the array the page assigns there so that
// log.total counts every line it ever pushed.
export const QEMULOG_COUNT = `(() => {
  let buf;
  Object.defineProperty(window, "__qemulog", {
    configurable: true,
    get: () => buf,
    set: (v) => {
      buf = v;
      if (!Array.isArray(v)) return;
      v.total = v.length;
      v.push = function (...xs) { this.total += xs.length; return Array.prototype.push.apply(this, xs); };
    },
  });
})()`;

// In-page source of (log, seen) => { lines, total, lost }: the lines pushed
// after the first `seen`, by the count above (by index without it), the new
// count, and how many of them the page had already cut.
export const QEMULOG_SINCE = `((log, seen) => {
  if (!log) return { lines: [], total: seen, lost: 0 };
  const total = log.total ?? log.length, first = total - log.length;
  const from = Math.max(seen, first);
  return { lines: log.slice(from - first), total, lost: from - seen };
})`;

// An empty page at origin (e.g. "http://127.0.0.1:19100"), answered by the
// browser itself: the wasm probes time compiles and calls with that origin's
// storage and headers, and index.html would fetch and compile the engine in
// the background meanwhile (its prefetch). No request reaches the server.
export async function gotoBlank(page, origin, ms = 60000) {
  const url = new URL("/probe-blank.html", origin).href;
  await page.route(url, (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    headers: { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" },
    body: "<!doctype html><title>probe</title>",
  }));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: ms });
}
