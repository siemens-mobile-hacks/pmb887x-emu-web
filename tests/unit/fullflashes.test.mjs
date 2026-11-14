import { test } from "node:test";
import assert from "node:assert/strict";
import { inferDevice, variantFor } from "../../site/fullflashes.js";

test("inferDevice: substring rules, longer tokens first", () => {
  assert.equal(inferDevice("KE800-v11b.bin"), "lg-ke800");
  assert.equal(inferDevice("rr_ff_el71_stock.bin"), "siemens-el71");
  assert.equal(inferDevice("E71_v45.bin"), "siemens-e71");
  assert.equal(inferDevice("cl61a.bin"), "siemens-cl61a");
  assert.equal(inferDevice("CL61.bin"), "siemens-cl61");
  assert.equal(inferDevice("ME75.bin"), "siemens-me75");
  assert.equal(inferDevice("s75_working20060710172101.bin"), "siemens-s75");
  assert.equal(inferDevice("CX70_FW56_clean.bin"), "siemens-cx70");
  assert.equal(inferDevice("unknown.bin"), null);
});

test("variantFor: exact model names only, rebadges flagged inexact", () => {
  assert.deepEqual(variantFor("C1F0"), { device: "siemens-el71", exact: true });
  assert.deepEqual(variantFor("s66"), { device: "siemens-s65", exact: false });
  assert.equal(variantFor("S665"), null);
  assert.equal(variantFor("CL61A"), null);
});
