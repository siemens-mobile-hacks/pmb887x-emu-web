#!/bin/bash
# Run the natively-built qemu-system-arm (pmb887x Siemens phone emulator).
#
#   scripts/run-native.sh <fullflash.bin> [extra qemu args...]
#
# Mirrors the web page's boot: same -drive, -serial and PMB887X_* env vars
# (PMB887X_BOARD / _STARTUP / _FLASH0_OTP0/1) and -device gsm-sim, but a
# deterministic -icount clock where the page runs vcpu-timers (ICOUNT below).
#
# Env overrides:
#   BOARD=siemens-s75    board config id (default: inferred from filename)
#   STARTUP=ONLINE       ONLINE | PTEST | OFFLINE
#   SIM=virtual          virtual | none
#   OPERATOR=00101       MCC+MNC
#   IMEI=490154203237518 15 digits
#   ESN=12345678         8 hex chars
#   RW=1                 writable flash (firmware can modify the .bin)
#   EFA_FILE=path        explicit EFA block for FLASH0 (default: derived
#                        as <fullflash>.cfi-efa, e.g. the LG EEPROM block)
#   DISPLAY_MODE=none    none | vnc=[:display] | sdl | gtk
#   SERIAL=path          serial log file, kept (default: a new
#                        $TMPDIR/pmb887x-serial.XXXXXX.log per run, removed
#                        when qemu exits)
#   MONITOR=stdio        stdio | unix:path | none
#   ICOUNT=<spec>        -icount value; "none" omits it, "vt" runs the web
#                        page's vcpu-timers clock instead (default
#                        shift=3,sleep=off: deterministic, which lockstep
#                        and the test suites need)
#   GSM=1                qemu's GSM cell (gsm-bts, doc/gsm-network.md)
#   GSM_RELAY=host:port  the cell with SMS, USSD and calls served by a relay
#                        server at host:port (doc/gsm-relay.md)
#   QEMU_BIN=path        the qemu-system-arm to run (default the JIT build's,
#                        $QEMU_NATIVE_BUILD/qemu-system-arm: build-dirs.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT"
source "$ROOT/scripts/build-dirs.sh"
QEMU="${QEMU_BIN:-$NATIVE_BUILD/qemu-system-arm}"
BOARDS="${BOARDS_DIR:-$BSP_DIR/lib/data/board}"

[ -x "$QEMU" ] || { echo "$QEMU not built — see scripts/build-native.sh" >&2; exit 1; }
[ -n "${1:-}" ] || { echo "usage: $0 <fullflash.bin> [extra qemu args...]" >&2; exit 1; }
FLASH="$(realpath "$1")"; shift
[ -f "$FLASH" ] || { echo "fullflash not found: $FLASH" >&2; exit 1; }

# device inference from filename: the web page's own rules (DEVICE_RULES in
# site/fullflashes.js)
BOARD="${BOARD:-}"
if [ -z "$BOARD" ]; then
  BOARD="$(node -e 'import(process.argv[1]).then((m) => console.log(m.inferDevice(process.argv[2]) ?? ""))' \
    "$ROOT/site/fullflashes.js" "$(basename "$FLASH")")"
  BOARD="${BOARD:-siemens-s75}"
fi
[ -f "$BOARDS/$BOARD.toml" ] || { echo "unknown board: $BOARD (no $BOARDS/$BOARD.toml)" >&2; exit 1; }

IMEI="${IMEI:-490154203237518}"
ESN="${ESN:-12345678}"
[[ "$IMEI" =~ ^[0-9]{15}$ ]] || { echo "IMEI must be 15 digits: $IMEI" >&2; exit 1; }
[[ "$ESN" =~ ^[0-9A-Fa-f]{8}$ ]] || { echo "ESN must be 8 hex chars: $ESN" >&2; exit 1; }
STARTUP="${STARTUP:-ONLINE}"
SIM="${SIM:-virtual}"
OPERATOR="${OPERATOR:-00101}"
DISPLAY_MODE="${DISPLAY_MODE:-none}"
SERIAL_TMP=""
if [ -z "${SERIAL:-}" ]; then
  SERIAL="$(mktemp --suffix=.log "${TMPDIR:-/tmp}/pmb887x-serial.XXXXXX")"
  SERIAL_TMP="$SERIAL"
fi
MONITOR="${MONITOR:-stdio}"
# Timing model: an instruction-driven virtual clock — stock icount, fixed
# shift, deterministic sleep=off — for every board.
ICOUNT="${ICOUNT:-shift=3,sleep=off}"
# bare unix:path means "listen" — add the server options unless given fully
if [[ "$MONITOR" == unix:* && "$MONITOR" != *,* ]]; then
  MONITOR="$MONITOR,server=on,wait=off"
fi

# OTP words from IMEI/ESN (same derivation as site/app.js)
ESN_KEY=(0x32 0xe5 0xf7 0x03)
OTP0=""
for i in 0 1 2 3; do
  byte=$(( 16#${ESN:((3 - i)) * 2:2} ^ ${ESN_KEY[$i]} ))
  OTP0+="$(printf '%02X' "$byte")"
done
OTP0+="00000000"
OTP1=""
for ((i = 0; i < 14; i += 2)); do OTP1+="${IMEI:i+1:1}${IMEI:i:1}"; done
OTP1+="FF"

READONLY="readonly=on"; [ "${RW:-0}" = "1" ] && READONLY=""

export PMB887X_BOARD="$BOARDS/$BOARD.toml"
export PMB887X_STARTUP="$STARTUP"
export PMB887X_FLASH0_OTP0="$OTP0"
export PMB887X_FLASH0_OTP1="$OTP1"
if [ -n "${EFA_FILE:-}" ]; then
  export PMB887X_FLASH0_EFA_FILE="$(realpath "$EFA_FILE")"
fi

echo "board:    $BOARD"
echo "fullflash: $FLASH$([ "${RW:-0}" = 1 ] && echo ' (writable)')"
echo "serial:   $SERIAL   monitor: $MONITOR   display: $DISPLAY_MODE"
echo

# does the board's config, or a file it `extends`, contain this text outside
# a comment line?  An `extends` path is relative to the file that names it, as
# qemu reads it (hw/arm/pmb887x/board/board.c).
board_has() {
  local f="$BOARDS/$BOARD.toml" ext depth
  for depth in 0 1 2 3 4; do
    [ -f "$f" ] || return 1
    awk -v s="$1" '!/^[ \t]*#/ && index($0, s) { found = 1; exit } END { exit !found }' "$f" && return 0
    ext="$(sed -nE 's/^[ \t]*extends[ \t]*=[ \t]*"([^"]+)".*/\1/p' "$f" | head -n 1)"
    [ -n "$ext" ] || return 1
    f="$(dirname "$f")/$ext"
  done
  return 1
}

# the card is a device of its own, plugged into the board's empty
# "iso7816-slot"; a board without one runs with no SIM
SIM_ARGS=()
if [ "$SIM" = virtual ] && board_has '"iso7816-slot"'; then
  SIM_ARGS=(-device "gsm-sim,operator=$OPERATOR")
fi

GSM_ARGS=()
if [ -n "${GSM_RELAY:-}" ]; then
  GSM_ARGS=(-machine pmb887x,gsm-network=gsm0
    -chardev "socket,id=gsmrelay,host=${GSM_RELAY%:*},port=${GSM_RELAY##*:},reconnect-ms=2000"
    -object gsm-bts,id=gsm0,relay=gsmrelay)
elif [ "${GSM:-0}" = 1 ]; then
  GSM_ARGS=(-machine pmb887x,gsm-network=gsm0 -object gsm-bts,id=gsm0)
fi

# ICOUNT=none boots without -icount entirely
ICOUNT_ARGS=()
if [ "$ICOUNT" = "vt" ]; then
  ICOUNT_ARGS=(-accel tcg,thread=multi,vcpu-timers=on)
elif [ "$ICOUNT" != "none" ]; then
  ICOUNT_ARGS=(-icount "$ICOUNT")
fi

: > "$SERIAL"
QEMU_ARGS=(
  -machine pmb887x
  "${ICOUNT_ARGS[@]}"
  -display "$DISPLAY_MODE"
  -drive "if=pflash,format=raw,file=$FLASH${READONLY:+,$READONLY}"
  -serial "file:$SERIAL"
  -monitor "$MONITOR"
  "${SIM_ARGS[@]}"
  "${GSM_ARGS[@]}"
  "$@"
)
# the tools pass SERIAL and signal this pid as qemu's
[ -n "$SERIAL_TMP" ] || exec "$QEMU" "${QEMU_ARGS[@]}"

# The log is this script's own: qemu runs as a child so that the log can go
# when it ends.  It is a background job only so that a signal reaches the
# traps at once; it keeps the terminal (-monitor stdio).
"$QEMU" "${QEMU_ARGS[@]}" <&0 &
QPID=$!
trap 'rm -f "$SERIAL_TMP"' EXIT
trap 'kill "$QPID" 2>/dev/null' INT TERM HUP
rc=0
wait "$QPID" || rc=$?
# a signal ends the first wait early; qemu has been told to stop by then
if kill -0 "$QPID" 2>/dev/null; then
  rc=0
  wait "$QPID" || rc=$?
fi
exit "$rc"
