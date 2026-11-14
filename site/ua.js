// The short user-agent line the HUD and the diagnostics report show:
// "Android 8 · Chrome 147 · SM-G955U". hi is the high-entropy UA-CH answer
// (platformVersion, model) when it has arrived, else null.

function uaOS(platform, platformVersion) {
  const ua = navigator.userAgent;
  if (platform) {
    const major = platformVersion ? String(platformVersion).split(".")[0] : null;
    // only the platforms whose release number anyone quotes carry one
    return major && (platform === "Android" || platform === "iOS")
      ? `${platform} ${major}` : platform;
  }
  let m;
  if ((m = ua.match(/Android (\d+)/))) return `Android ${m[1]}`;
  if ((m = ua.match(/(?:iPhone|CPU) OS (\d+)/))) return `iOS ${m[1]}`;
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}

// Chromium shuffles navigator.userAgentData.brands on purpose (the "Not"
// entry is there to break naive parsers), so "the first one" is whichever it
// felt like this morning: take the specific brand over the generic engine
// one, and give it the name people call it by.
const UA_BRAND = {
  "Google Chrome": "Chrome", HeadlessChrome: "Chrome", Chromium: "Chrome",
  "Microsoft Edge": "Edge", Edg: "Edge", OPR: "Opera",
};
function uaBrowser() {
  const brands = navigator.userAgentData?.brands?.filter((b) => !/not/i.test(b.brand)) ?? [];
  const pick = brands.find((b) => b.brand !== "Chromium") ?? brands[0];
  if (pick) return `${UA_BRAND[pick.brand] ?? pick.brand} ${String(pick.version).split(".")[0]}`;
  const m = navigator.userAgent.match(/(Edg|OPR|Chrome|Firefox|Safari)\/(\d+)/);
  return m ? `${UA_BRAND[m[1]] ?? m[1]} ${m[2]}` : null;
}

function uaModel(mobile, hiModel) {
  if (!mobile) return null;
  // the reduced user agent calls every phone "K"; only UA-CH has the real one
  const fromUa = navigator.userAgent.match(/Android [\d.]+;\s*([^;)]+?)(?:\s+Build\/|\))/)?.[1];
  const model = (hiModel || fromUa || "").trim();
  return model && model !== "K" ? model : null;
}

export function buildShortUA(hi) {
  const d = navigator.userAgentData;
  const mobile = d?.mobile ?? /Mobi|Android/.test(navigator.userAgent);
  let os = uaOS(d?.platform, hi?.platformVersion);
  if (!mobile) {
    // the desktop line is "Linux x86_64 · Chrome 147": with no model to
    // name, the architecture rides with the OS rather than being a token
    const m = navigator.userAgent.match(/\b(x86_64|aarch64|arm64|Win64|WOW64)\b/);
    const arch = m && (m[1] === "Win64" || m[1] === "WOW64" ? "x64" : m[1]);
    if (arch && !(os ?? "").includes(arch)) os = os ? `${os} ${arch}` : arch;
  }
  // anything this browser will not say is left out, never printed as
  // "undefined"
  return [os, uaBrowser(), uaModel(mobile, hi?.model)].filter(Boolean).join(" · ");
}
