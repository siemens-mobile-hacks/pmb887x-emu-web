// The pill's network badge (#gprs in index.html, renderGprs in app.js):
// what it shows for the relay's state (gprs-net.js). No DOM, so tests/unit
// can drive it.

// the bearer names the tag has glyphs for (#gsm-bearer-* in index.html)
export const BEARERS = ["GPRS", "EDGE"];
export const bearerOf = (name) => BEARERS.includes(name) ? name : "GPRS";

// the states in which the badge follows the gateway link
const LINK = new Set(["connecting", "online", "offline", "refused"]);

// gprs-net.js's close reasons (CLOSED there), short, for the status line;
// anything else is a link that did not come up or went away
const SHORT = {
  4001: "two phones online",
  4002: "gateway full",
  4003: "address banned",
  4004: "daily traffic used up",
  4008: "idle too long",
  4009: "page not allowed",
  4029: "too many connections",
};
export const shortReason = (code) => SHORT[code] ?? "unreachable";

// badge is what the badge stands for (gprsBadge() in app.js): the cell's
// "nonet", "registered" or "attached", "idle" on a dist that cannot read the
// cell, or the link's "connecting", "online", "offline" or "refused". g is
// the GprsNet, retryIn the redial countdown in seconds (0: none), bearer
// the tag's word. Gives the antenna (net: the cell), the tag (gprs: the
// link), the bearer it spells, the desktop status line and its tone ("",
// "warn" or "off"), and whether the amounts sent and received show: from
// the phone's first data, which is what dials the link, until Stop.
export function badgeView(badge, g, { retryIn = 0, bearer = "GPRS" } = {}) {
  const cell = g.ms === null ? "unknown"
    : g.registered || g.gprsAttached ? "registered" : "nonet";
  const link = LINK.has(badge);
  const b = bearerOf(bearer);
  let status, tone = "";
  switch (badge) {
    case "nonet": status = "No network"; break;
    case "registered": status = "Registered"; break;
    case "attached": status = `${b} attached` + (g.pdpActive ? " · context active" : ""); break;
    case "idle": status = `${b} not used yet`; break;
    case "connecting":
      // a reason is kept from the close while the link is dialled again
      status = g.reason ? `${b} reconnecting…` : `${b} connecting…`;
      tone = "warn";
      break;
    case "online": status = `${b} Connected`; break;
    case "offline":
      status = `${b} offline · ` + (retryIn > 0 ? `${shortReason(g.code)} · retry ${retryIn}s` : "waiting for data");
      tone = "off";
      break;
    case "refused": status = `${b} refused · ${shortReason(g.code)}`; tone = "off"; break;
    default: status = "";
  }
  return {
    net: link && cell === "nonet" ? "registered" : cell,
    gprs: badge === "attached" || link ? badge : "none",
    bearer: b, status, tone, amounts: link,
  };
}
