#!/bin/bash
# Run the natively-built qemu-system-arm (pmb887x Siemens phone emulator).
#
#   scripts/run-native.sh <fullflash.bin> [extra qemu args...]
#
# Mirrors the web page's boot: same -icount, -drive, -serial and PMB887X_*
# env vars (PMB887X_BOARD / _STARTUP / _SIM / _SIM_OPERATOR / _FLASH0_OTP0/1).
#
# Env overrides:
#   BOARD=siemens-s75    board config id (default: inferred from filename)
#   STARTUP=ONLINE       ONLINE | PTEST | OFFLINE
#   SIM=virtual          virtual | none
#   OPERATOR=00101       MCC+MNC
#   IMEI=490154203237518 15 digits
#   ESN=12345678         8 hex chars
#   RW=1                 writable flash (firmware can modify the .bin)
#   DISPLAY_MODE=none    none | vnc=[:display] | sdl | gtk
#   SERIAL=path          serial log file     (default /tmp/pmb887x-serial.log)
#   MONITOR=stdio        stdio | unix:path | none
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QEMU="$ROOT/build/qemu-native-build/qemu-system-arm"
BOARDS="$ROOT/build/bsp/lib/data/board"

[ -x "$QEMU" ] || { echo "qemu-system-arm not built — see scripts/build-native.sh" >&2; exit 1; }
[ -n "${1:-}" ] || { echo "usage: $0 <fullflash.bin> [extra qemu args...]" >&2; exit 1; }
FLASH="$(realpath "$1")"; shift
[ -f "$FLASH" ] || { echo "fullflash not found: $FLASH" >&2; exit 1; }

# device inference from filename (same rules as the web page)
BOARD="${BOARD:-}"
if [ -z "$BOARD" ]; then
  UP="$(basename "$FLASH" | tr '[:lower:]' '[:upper:]')"
  for rule in "EL71 siemens-el71" "E71 siemens-e71" "C81 siemens-c81" \
              "S75 siemens-s75" "S65 siemens-s65" "CX75 siemens-cx75" \
              "CX70 siemens-cx70" "CX65 siemens-cx65" "SL75 siemens-sl75" \
              "CL61 siemens-cl61" "C75 siemens-c75" "C72 siemens-c72" \
              "C65 siemens-c65" "S68 siemens-s68" "M81 siemens-m81" "M72 siemens-m72"; do
    pat="${rule%% *}"; dev="${rule##* }"
    if [[ "$UP" == *"$pat"* ]]; then BOARD="$dev"; break; fi
  done
  BOARD="${BOARD:-siemens-s75}"
fi
[ -f "$BOARDS/$BOARD.toml" ] || { echo "unknown board: $BOARD (no $BOARDS/$BOARD.toml)" >&2; exit 1; }

IMEI="${IMEI:-490154203237518}"
ESN="${ESN:-12345678}"
STARTUP="${STARTUP:-ONLINE}"
SIM="${SIM:-virtual}"
OPERATOR="${OPERATOR:-00101}"
DISPLAY_MODE="${DISPLAY_MODE:-none}"
SERIAL="${SERIAL:-/tmp/pmb887x-serial.log}"
MONITOR="${MONITOR:-stdio}"
# bare unix:path means "listen" — add the server options unless given fully
if [[ "$MONITOR" == unix:* && "$MONITOR" != *,* ]]; then
  MONITOR="$MONITOR,server=on,wait=off"
fi

# OTP words from IMEI/ESN (same derivation as site/app.js)
ESN_KEY=(0x32 0xe5 0xf7 0x03)
OTP0="0200"
for i in 0 1 2 3; do
  byte=$(( 16#${ESN:((3 - i)) * 2:2} ^ ${ESN_KEY[$i]} ))
  OTP0+="$(printf '%02X' "$byte")"
done
OTP0+="00000000"
OTP1="0000"
for ((i = 0; i < 14; i += 2)); do OTP1+="${IMEI:i+1:1}${IMEI:i:1}"; done
OTP1+="FF"

READONLY="readonly=on"; [ "${RW:-0}" = "1" ] && READONLY=""

export PMB887X_BOARD="$BOARDS/$BOARD.toml"
export PMB887X_STARTUP="$STARTUP"
export PMB887X_SIM="$SIM"
export PMB887X_SIM_OPERATOR="$OPERATOR"
export PMB887X_FLASH0_OTP0="$OTP0"
export PMB887X_FLASH0_OTP1="$OTP1"

echo "board:    $BOARD"
echo "fullflash: $FLASH$([ "${RW:-0}" = 1 ] && echo ' (writable)')"
echo "serial:   $SERIAL   monitor: $MONITOR   display: $DISPLAY_MODE"
echo

: > "$SERIAL"
exec "$QEMU" \
  -machine pmb887x \
  -icount precise-clocks=on \
  -display "$DISPLAY_MODE" \
  -drive "if=pflash,format=raw,file=$FLASH${READONLY:+,$READONLY}" \
  -serial "file:$SERIAL" \
  -monitor "$MONITOR" \
  "$@"
