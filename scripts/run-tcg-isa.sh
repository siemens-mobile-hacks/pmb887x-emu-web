#!/bin/bash
# Phase-0a gate runner: build the guest
# op-suite image, run it on every backend that is built — native TCG JIT,
# native TCI, the wasm64 page (site/dist-jit) and the wasm TCI page
# (site/dist) — and byte-compare all serial logs against the native JIT.
#
#   scripts/run-tcg-isa.sh            # every backend that is available
#   WASM=0 scripts/run-tcg-isa.sh     # native legs only
#   WASM=1 scripts/run-tcg-isa.sh     # fail instead of skipping a wasm leg
#
# Gate: every backend green (exit 0, "fail=0", no "not ok") and all serial
# logs byte-identical. Suite runtime well under a minute per backend.
#
# A missing dist SKIPS its leg rather than failing, so read the leg list in
# the output: for most of this workspace's life only site/dist-jit is built
# and a run that says "PASS" while silently skipping the backend you just
# edited is worth nothing.
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

# ---- wasm legs ---------------------------------------------------------
# Two of them, and the wasm64 one is the point: it is the backend every
# perf patch edits, and it has its own emitter, so native JIT-vs-TCI
# agreement says nothing about it.  The suite image is served from
# site/dist/tcgisa.bin for both legs (`make install` above refreshes it),
# while the *engine* comes from the dist named in the page URL — so the
# wasm64 leg runs with only site/dist-jit built, which is the usual state
# of this workspace.
run_wasm_leg() { # <name> <dist> <driver> <log>
  local name="$1" dist="$2" driver="$3" log="$4"
  if [ ! -f "$ROOT/site/$dist/qemu-system-arm.wasm" ]; then
    if [ "$WASM" = "1" ]; then
      echo "!! $name forced but site/$dist/qemu-system-arm.wasm missing"
      return 1
    fi
    echo "== $name skipped (site/$dist not built)"
    return 0
  fi
  echo "== $name =="
  if ( cd "$ROOT/tools" && node "$driver" "$PORT_TCG" "$dist" "$log" >/dev/null ); then
    if cmp -s "$T/jit.log" "$log"; then
      echo "   $name vs native JIT serial: IDENTICAL"
      return 0
    fi
    echo "!! $name vs native JIT serial DIFFER:"
    diff "$T/jit.log" "$log" | head -20 || true
    return 1
  fi
  echo "!! $name failed"
  return 1
}

WASM="${WASM:-auto}"
if [ "$WASM" = "0" ]; then
  echo "== wasm legs skipped (WASM=0)"
elif [ ! -f "$ROOT/site/dist/tcgisa.bin" ]; then
  [ "$WASM" = "1" ] && { echo "!! wasm legs forced but site/dist/tcgisa.bin missing"; fail=1; } \
                    || echo "== wasm legs skipped (no site/dist/tcgisa.bin)"
elif [ ! -d "$ROOT/tools/node_modules" ]; then
  [ "$WASM" = "1" ] && { echo "!! wasm legs forced but tools/node_modules missing (cd tools && npm i)"; fail=1; } \
                    || echo "== wasm legs skipped (no tools/node_modules)"
else
  PORT_TCG="${PORT_TCG:-8093}"
  ( cd "$ROOT" && PORT=$PORT_TCG HTTPS=0 node serve.mjs >/dev/null 2>&1 ) &
  SRV=$!
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT_TCG/" >/dev/null && break
    sleep 0.1
  done
  # The wasm64 leg is the point of this gate: it is the backend every perf
  # patch edits, with its own emitter, so native JIT-vs-TCI agreement says
  # nothing about it.  (Fixed 2026-09-16: it had been a KNOWN HOLE since
  # 2026-09-13 — an Asyncify rewind into an uninstrumented frame on the
  # versatilepb machine-init path; the 0090 commit on the qemu branch
  # added the missing onlylist names.)
  run_wasm_leg "wasm64 (page, dist-jit)" dist-jit tcgisa.mjs "$T/wasm64.log" || fail=1
  run_wasm_leg "wasm TCI (page, dist)" dist tcgisa.mjs "$T/wasmtci.log" || fail=1
  kill "$SRV" 2>/dev/null || true
  SRV=""
fi

if [ "$fail" -ne 0 ]; then
  echo "== RESULT: FAIL"
  exit 1
fi
echo "== RESULT: PASS (phase-0a gate)"
