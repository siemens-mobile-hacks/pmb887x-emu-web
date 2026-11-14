// Driving the page's own-file boot the way a user does: the Startup mode,
// optionally the GSM option and the device, the image (with its sidecars),
// then Start. Every option left undefined is left as the page has it.
export async function loadOwnFlash(page, files, { startup, gsm, device } = {}) {
  if (startup !== undefined) await page.selectOption("#startup", startup);
  if (gsm !== undefined) await page.setChecked("#gsm", gsm);
  await page.click("#ff-mode-own");
  await page.setInputFiles("#fullflash", files);
  if (device !== undefined) await page.selectOption("#device", device);
}

export async function bootOwnFlash(page, files, opts) {
  await loadOwnFlash(page, files, opts);
  await page.click("#btn-start");
}

// A frozen page never settles an evaluate or a screenshot: give up after
// ms and resolve to fallback instead (a rejection also gives the fallback).
export const bounded = (promise, fallback, ms = 15000) => Promise.race([
  Promise.resolve(promise).catch(() => fallback),
  new Promise((r) => setTimeout(() => r(fallback), ms)),
]);
