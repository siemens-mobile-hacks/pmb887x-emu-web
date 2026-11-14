// NOR flash OTP derivation, as pmb887x-emu's src/siemens/otp.cpp: the data
// only, since qemu's cfi-flash writes the lock words itself (smh 29df93fbf9)
const ESN_KEY = [0x32, 0xe5, 0xf7, 0x03];
const HEX = "0123456789ABCDEF";
export function esnToOtp0(esn) {
  if (!/^[0-9A-Fa-f]{8}$/.test(esn)) throw new Error("ESN must be 8 hex chars");
  let out = "";
  for (let i = 0; i < 4; i++) {
    const byte = parseInt(esn.slice((3 - i) * 2, (3 - i) * 2 + 2), 16) ^ ESN_KEY[i];
    out += HEX[byte >> 4] + HEX[byte & 0xf];
  }
  return out + "00000000";
}
export function imeiToOtp1(imei) {
  if (!/^\d{15}$/.test(imei)) throw new Error("IMEI must be 15 digits");
  let out = "";
  for (let i = 0; i < 14; i += 2) out += imei[i + 1] + imei[i];
  return out + "FF";
}
