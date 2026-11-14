import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { esnToOtp0, imeiToOtp1 } from "../../site/otp.js";

test("esnToOtp0: byte-reversed ESN xor the key, then the empty half", () => {
  assert.equal(esnToOtp0("12345678"), "4AB3C31100000000");
  assert.equal(esnToOtp0("abcdef01"), esnToOtp0("ABCDEF01"));
  for (const bad of ["1234567", "123456789", "1234567g", ""]) assert.throws(() => esnToOtp0(bad), /8 hex/);
});

test("imeiToOtp1: nibble-swapped pairs of the first 14 digits, then FF", () => {
  assert.equal(imeiToOtp1("490154203237518"), "94104502237315FF");
  for (const bad of ["49015420323751", "4901542032375180", "49015420323751a"]) assert.throws(() => imeiToOtp1(bad), /15 digits/);
});

test("scripts/run-native.sh derives the same words", () => {
  const sh = new URL("../../scripts/run-native.sh", import.meta.url).pathname;
  const src = execFileSync("sed", ["-n", "/^ESN_KEY=/,/^OTP1+=/p", sh], { encoding: "utf8" });
  assert.match(src, /OTP1\+="FF"/);
  for (const [esn, imei] of [["12345678", "490154203237518"], ["0a1B2c3D", "001010123456789"], ["ffffffff", "999999999999999"]]) {
    const out = execFileSync("bash", ["-c", `ESN=${esn}; IMEI=${imei}\n${src}\necho "$OTP0 $OTP1"`], { encoding: "utf8" }).trim();
    assert.equal(out, `${esnToOtp0(esn)} ${imeiToOtp1(imei)}`);
  }
});
