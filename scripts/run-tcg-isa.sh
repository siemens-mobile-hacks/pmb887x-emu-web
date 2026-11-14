#!/bin/bash
# Phase-0a gate runner: build the guest
# op-suite image, run it on every backend — native TCG JIT, native TCI and
# the wasm64 page (site/dist-jit, or TCGISA_DIST) — and byte-compare all
# serial logs against the native JIT.
#
#   scripts/run-tcg-isa.sh            # skips the wasm leg if it cannot run
#   WASM=0 scripts/run-tcg-isa.sh     # native legs only
#   WASM=1 scripts/run-tcg-isa.sh     # fail instead of skipping (gate.sh)
#
# The wasm leg starts its own serve.mjs on PORT_TCG (default 8093; gate.sh
# passes its --port + 13) and fails if that port already answers.
#
# Gate: every backend green (exit 0, "fail=0", no "not ok") and all serial
# logs byte-identical. Suite runtime well under a minute per backend.
#
# Without WASM=1 a missing dist SKIPS the wasm leg rather than failing, so
# read the leg list in the output: a run that says "PASS" while silently
# skipping the backend you just edited is worth nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/tests/tcg-isa"
JIT="${QEMU_JIT:-$ROOT/build/qemu-native-build/qemu-system-arm}"
TCI="${QEMU_TCI:-$ROOT/build/qemu-native-tci-build/qemu-system-arm}"
T="$(mktemp -d)"
IMG=""
trap 'rm -rf "$T"; [ -z "$IMG" ] || rm -f "$IMG"; [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true' EXIT

fail=0
run_qemu() { # <name> <binary> <log>
  local name="$1" bin="$2" log="$3"
  [ -x "$bin" ] || { echo "!! $name: $bin not built — see scripts/build-native.sh"; return 2; }
  echo "== $name =="
  local rc=0
  timeout 120 "$bin" -M versatilepb -kernel "$T/tcgisa.bin" \
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
# Gates run concurrently, and make rewrites the images in place: build under
# a lock on the directory and boot this run's own copies.
(
  flock 9
  make -C "$DIR" >/dev/null
  make -C "$DIR" install >/dev/null || true   # refresh site/dist/tcgisa.bin when dist exists
  cp "$DIR/tcgisa.bin" "$DIR/tcgisa-wasm.bin" "$T/"
) 9<"$DIR"

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
# The wasm64 backend is the point: every perf patch edits it, and it has
# its own emitter, so native JIT-vs-TCI agreement says nothing about it.
# The suite image is this run's copy, served from site/dist/ under a name of
# its own (removed on exit), while the *engine* comes from the dist named
# in the page URL.
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
  if ( cd "$ROOT/tools" && TCGISA_IMAGE="dist/${IMG##*/}" node "$driver" "$PORT_TCG" "$dist" "$log" >/dev/null ); then
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
  echo "== wasm leg skipped (WASM=0)"
elif [ ! -d "$ROOT/site/dist" ]; then
  [ "$WASM" = "1" ] && { echo "!! wasm leg forced but site/dist missing"; fail=1; } \
                    || echo "== wasm leg skipped (no site/dist)"
elif [ ! -d "$ROOT/tools/node_modules" ]; then
  [ "$WASM" = "1" ] && { echo "!! wasm leg forced but tools/node_modules missing (cd tools && npm i)"; fail=1; } \
                    || echo "== wasm leg skipped (no tools/node_modules)"
else
  PORT_TCG="${PORT_TCG:-8093}"
  IMG="$(mktemp "$ROOT/site/dist/tcgisa-run.XXXXXX.bin")"
  cp "$T/tcgisa-wasm.bin" "$IMG"
  # shellcheck source=serve-local.sh
  . "$ROOT/scripts/serve-local.sh"
  # The wasm64 leg is the point of this gate: it is the backend every perf
  # patch edits, with its own emitter, so native JIT-vs-TCI agreement says
  # nothing about it.  (Fixed 2026-09-16: it had been a KNOWN HOLE since
  # 2026-09-13 — an Asyncify rewind into an uninstrumented frame on the
  # versatilepb machine-init path; the 0090 commit on the qemu branch
  # added the missing onlylist names.)
  # TCGISA_DIST re-points the wasm64 leg at a variant build.  It was hard
  # wired to dist-jit, which made this gate silently test the wrong binary
  # whenever a variant was under evaluation: `gate.sh --dist X` passes X to
  # every other job, so the summary read PASS for a dist nobody had run.
  if ! start_serve "$ROOT" "$PORT_TCG"; then
    echo "!! wasm leg: no serve.mjs of its own on $PORT_TCG"
    fail=1
  else
    echo "== serve.mjs on port $PORT_TCG, image site/dist/${IMG##*/}"
    run_wasm_leg "wasm64 (page, ${TCGISA_DIST:-dist-jit})" "${TCGISA_DIST:-dist-jit}" \
        tcgisa.mjs "$T/wasm64.log" || fail=1
    kill "$SRV" 2>/dev/null || true
    SRV=""
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "== RESULT: FAIL"
  exit 1
fi
echo "== RESULT: PASS (phase-0a gate)"
