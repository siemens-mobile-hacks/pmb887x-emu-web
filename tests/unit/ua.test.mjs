import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildShortUA } from "../../site/ua.js";

const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const as = (userAgent, userAgentData) =>
  Object.defineProperty(globalThis, "navigator", { value: { userAgent, userAgentData }, configurable: true });
afterEach(() => { if (real) Object.defineProperty(globalThis, "navigator", real); });

const ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

test("desktop Chrome: OS with the architecture, then the browser", () => {
  as("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36", {
    mobile: false, platform: "Linux",
    brands: [{ brand: "Not=A?Brand", version: "99" }, { brand: "Chromium", version: "147" }, { brand: "Google Chrome", version: "147" }],
  });
  assert.equal(buildShortUA(null), "Linux x86_64 · Chrome 147");
});

test("Android: the reduced UA's K is no model; UA-CH supplies it", () => {
  as(ANDROID, { mobile: true, platform: "Android", brands: [{ brand: "Chromium", version: "147" }] });
  assert.equal(buildShortUA(null), "Android · Chrome 147");
  assert.equal(buildShortUA({ platformVersion: "8.0.0", model: "SM-G955U" }), "Android 8 · Chrome 147 · SM-G955U");
});

test("no UA-CH: parsed from the user agent string", () => {
  as("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0");
  assert.equal(buildShortUA(null), "Windows x64 · Firefox 128");
  as("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1");
  assert.equal(buildShortUA(null), "iOS 17 · Safari 604");
  as("something odd");
  assert.equal(buildShortUA(null), "");
});
