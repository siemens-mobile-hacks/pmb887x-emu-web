#!/bin/bash
# Phase-0a gate runner (doc/wasm-tcg-backend-plan.md §5): build the guest
# op-suite image, run it on the native TCG JIT and native TCI (+ the wasm
# TCI page when available) and byte-compare the serial logs.
#
#   scripts/run-tcg-isa.sh            # native JIT + native TCI (+ wasm if possible)
#   WASM=0 scripts/run-tcg-isa.sh     # skip the wasm leg
#   WASM=1 scripts/run-tcg-isa.sh     # force the wasm leg (fail if unusable)
#
# Gate: every backend green (exit 0, "fail=0", no "not ok") and all serial
# logs byte-identical. Suite runtime well under a minute per backend.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/tests/tcg-isa"
JIT="${QEMU_JIT:-$ROOT/build/qemu-native-build/qemu-system-arm}"
TCI="${QEMU_TCI:-$ROOT/build/qemu-native-tci-build/qemu-system-arm}"
T="$(mktemp -d)"
trap 'rm -rf "$T"; [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true' EXIT

fail=0
run_qemu() { # <name> <binary> <log>
  local name="$1" bin="$2" log="$3"
  [ -x "$bin" ] || { echo "!! $name: $bin not built — see scripts/build-native.sh"; return 2; }
  echo "== $name =="
  local rc=0
  timeout 120 "$bin" -M versatilepb -kernel "$DIR/tcgisa.bin" \
      -semihosting -display none -monitor none -serial "file:$log" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "!! $name: qemu exited $rc"
    return 1
  fi
  grep -q '^# result: pass=.* fail=0$' "$log" || { echo "!! $name: suite failures:"; grep '^not ok' "$log" | head; return 1; }
  grep -q '^not ok' "$log" && { echo "!! $name: 'not ok' lines present"; return 1; }
  echo "   $(tail -1 "$log")"
  return 0
}

echo "== building the op-suite image =="
make -C "$DIR" >/dev/null
make -C "$DIR" install >/dev/null || true   # refresh site/dist/tcgisa.bin when dist exists

run_qemu "native JIT" "$JIT" "$T/jit.log" || fail=1
run_qemu "native TCI" "$TCI" "$T/tci.log" || fail=1

if cmp -s "$T/jit.log" "$T/tci.log"; then
  echo "== JIT vs TCI serial: IDENTICAL ($(wc -c < "$T/jit.log") bytes)"
else
  echo "!! JIT vs TCI serial DIFFER:"
  diff "$T/jit.log" "$T/tci.log" | head -20 || true
  fail=1
fi

# ---- wasm leg ----------------------------------------------------------
WASM="${WASM:-auto}"
if [ "$WASM" = "0" ]; then
  echo "== wasm leg skipped (WASM=0)"
else
  if [ ! -f "$ROOT/site/dist/qemu-system-arm.wasm" ] || [ ! -f "$ROOT/site/dist/tcgisa.bin" ]; then
    if [ "$WASM" = "1" ]; then
      echo "!! wasm leg forced but dist artifacts missing (./build.sh + make install)"
      fail=1
    else
      echo "== wasm leg skipped (no site/dist artifacts)"
    fi
  elif [ ! -d "$ROOT/tools/node_modules" ]; then
    if [ "$WASM" = "1" ]; then
      echo "!! wasm leg forced but tools/node_modules missing (cd tools && npm i)"
      fail=1
    else
      echo "== wasm leg skipped (no tools/node_modules)"
    fi
  else
    echo "== wasm TCI (page) =="
    PORT_TCG=8093
    ( cd "$ROOT" && PORT=$PORT_TCG HTTPS=0 node serve.mjs >/dev/null 2>&1 ) &
    SRV=$!
    for _ in $(seq 1 50); do
      curl -sf "http://127.0.0.1:$PORT_TCG/" >/dev/null && break
      sleep 0.1
    done
    if ( cd "$ROOT/tools" && node tcgisa.mjs "$PORT_TCG" "$T/wasm.log" ); then
      if cmp -s "$T/jit.log" "$T/wasm.log"; then
        echo "== wasm vs JIT serial: IDENTICAL"
      else
        echo "!! wasm vs JIT serial DIFFER:"
        diff "$T/jit.log" "$T/wasm.log" | head -20 || true
        fail=1
      fi
    else
      echo "!! wasm leg failed"
      fail=1
    fi
    kill "$SRV" 2>/dev/null || true
    SRV=""
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "== RESULT: FAIL"
  exit 1
fi
echo "== RESULT: PASS (phase-0a gate)"
