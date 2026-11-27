import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeView, bearerOf, shortReason, BEARERS } from "../../site/gsm-badge.js";

// a GprsNet as badgeView reads it: the cell's bits and the last close
const net = (ms, { reason = "", code = 0 } = {}) => ({
  ms, reason, code,
  get registered() { return !!(this.ms & 1); },
  get gprsAttached() { return !!(this.ms & 2); },
  get pdpActive() { return !!(this.ms & 4); },
});
const view = (badge, ms, opts = {}) => badgeView(badge, net(ms, opts), opts);

test("gsm-badge: every state of the mockups' table", () => {
  const rows = [
    ["nonet", 0, {}, "nonet", "none", "No network", ""],
    ["registered", 1, {}, "registered", "none", "Registered (local)", ""],
    ["attached", 3, {}, "registered", "attached", "GPRS attached", ""],
    ["attached", 7, {}, "registered", "attached", "GPRS attached · context active", ""],
    ["connecting", 7, {}, "registered", "connecting", "GPRS connecting…", "warn"],
    ["connecting", 7, { reason: "x", code: 1006 }, "registered", "connecting", "GPRS reconnecting…", "warn"],
    ["online", 7, {}, "registered", "online", "GPRS Connected", ""],
    ["offline", 7, { code: 1006, retryIn: 1 }, "registered", "offline", "GPRS offline · unreachable · retry 1s", "off"],
    ["offline", 7, { code: 4002, retryIn: 59 }, "registered", "offline", "GPRS offline · gateway full · retry 59s", "off"],
    ["offline", 7, { code: 4002, retryIn: 0 }, "registered", "offline", "GPRS offline · waiting for data", "off"],
    ["refused", 7, { code: 4003 }, "registered", "refused", "GPRS refused · address banned", "off"],
    ["refused", 7, { code: 4004 }, "registered", "refused", "GPRS refused · daily traffic used up", "off"],
    ["refused", 7, { code: 4009 }, "registered", "refused", "GPRS refused · page not allowed", "off"],
  ];
  for (const [badge, ms, opts, net_, gprs, status, tone] of rows) {
    const v = view(badge, ms, opts);
    assert.deepEqual([v.net, v.gprs, v.status, v.tone], [net_, gprs, status, tone], `${badge} ${ms}`);
  }
});

test("gsm-badge: the antenna follows the cell after the phone's first data too", () => {
  for (const badge of ["connecting", "online", "offline", "refused"]) {
    const v = view(badge, 0, { code: 4003 });
    assert.equal(v.net, "nonet", badge);
    assert.equal(v.gprs, badge);
    assert.match(v.status, / · no network$/);
  }
  assert.equal(view("online", 0).status, "GPRS Connected · no network");
  assert.equal(view("online", 0).tone, "warn");
  assert.equal(view("refused", 0, { code: 4003 }).tone, "off");
  // a GPRS attach alone is a registration as far as the badge goes, as for
  // the title's "Network:" line
  assert.equal(view("attached", 2).net, "registered");
});

test("gsm-badge: registered without GPRS is a resting state", () => {
  for (const [badge, ms] of [["registered", 1], ["attached", 3], ["attached", 7]]) {
    const v = view(badge, ms);
    assert.doesNotMatch(v.status, /wait|yet|connect|…/i, badge);
    assert.equal(v.tone, "");
    assert.equal(v.amounts, false);
  }
  assert.equal(view("registered", 1).gprs, "none");
});

test("gsm-badge: the amounts show from the phone's first data on", () => {
  for (const b of ["nonet", "registered", "attached", "idle"]) assert.equal(view(b, 1).amounts, false, b);
  for (const b of ["connecting", "online", "offline", "refused"]) assert.equal(view(b, 1).amounts, true, b);
});

test("gsm-badge: a dist that cannot read the cell", () => {
  const v = view("idle", null);
  assert.deepEqual([v.net, v.gprs, v.status], ["unknown", "none", "GPRS not used yet"]);
  assert.equal(view("online", null).net, "unknown");
  assert.equal(view("online", null).status, "GPRS Connected");
});

test("gsm-badge: the bearer changes the tag's word and the wording, nothing else", () => {
  assert.deepEqual(BEARERS, ["GPRS", "EDGE"]);
  assert.equal(bearerOf("EDGE"), "EDGE");
  assert.equal(bearerOf("UMTS"), "GPRS");
  assert.equal(bearerOf(undefined), "GPRS");
  for (const [badge, ms, opts] of [["nonet", 0], ["registered", 1], ["attached", 7], ["connecting", 7],
    ["online", 7], ["online", 0], ["offline", 7, { code: 4002, retryIn: 59 }], ["refused", 7, { code: 4003 }]]) {
    const gprs = view(badge, ms, { ...opts });
    const edge = view(badge, ms, { ...opts, bearer: "EDGE" });
    assert.equal(gprs.bearer, "GPRS");
    assert.equal(edge.bearer, "EDGE");
    assert.equal(edge.status, gprs.status.replace(/^GPRS/, "EDGE"), badge);
    assert.deepEqual({ ...edge, bearer: 0, status: 0 }, { ...gprs, bearer: 0, status: 0 }, badge);
  }
});

test("gsm-badge: a short reason for every close code, unreachable otherwise", () => {
  const codes = { 4001: "two phones online", 4002: "gateway full", 4003: "address banned",
    4004: "daily traffic used up", 4008: "idle too long", 4009: "page not allowed",
    4029: "too many connections" };
  for (const [code, text] of Object.entries(codes)) assert.equal(shortReason(Number(code)), text);
  for (const code of [0, 1000, 1006, 4000]) assert.equal(shortReason(code), "unreachable");
});

test("gsm-badge: a registration through the relay names its host", () => {
  assert.equal(view("registered", 1, { via: "gw.example.org" }).status, "Registered (gw.example.org)");
});
