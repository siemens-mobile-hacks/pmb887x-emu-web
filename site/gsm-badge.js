// The pill's network badge (#gprs in index.html, renderGprs in app.js):
// what it shows for the relay's state (gprs-net.js). No DOM, so tests/unit
// can drive it.

// the bearer names the tag has glyphs for (#gsm-bearer-* in index.html)
export const BEARERS = ["GPRS", "EDGE"];
export const bearerOf = (name) => BEARERS.includes(name) ? name : "GPRS";

// the states in which the badge follows the gateway link
const LINK = new Set(["connecting", "online", "offline", "refused"]);

// badge is what the badge stands for (gprsBadge() in app.js): the cell's
// "nonet", "registered" or "attached", "idle" on a dist that cannot read the
// cell, or the link's "connecting", "online", "offline" or "refused". g is
// the GprsNet. The antenna (net) shows the cell, the tag (gprs) the link.
export function badgeLook(badge, g) {
  const cell = g.ms === null ? "unknown"
    : g.registered || g.gprsAttached ? "registered" : "nonet";
  return {
    net: LINK.has(badge) && cell === "nonet" ? "registered" : cell,
    gprs: badge === "attached" || LINK.has(badge) ? badge : "none",
  };
}
