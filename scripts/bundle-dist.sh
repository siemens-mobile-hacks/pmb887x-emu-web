#!/bin/bash
# Assemble the deployable static bundle in <repo>/dist (gitignored):
# everything the page loads, plus a pre-gzip'd .gz sidecar next to every
# compressible file — so the nginx image (deploy/nginx/, gzip_static on)
# or any other static host serves the ~28 MB dist-jit wasm as its ~4 MB
# sidecar without ever compressing on the fly (same idea as serve.mjs'
# gz sidecars, but frozen at bundle time).
#
#   scripts/bundle-dist.sh           what the page loads (list below)
#   BUNDLE_TESTS=1  ...              + tcgisa/tcgbench test images
#   BUNDLE_SYMBOLS=1 ...             + qemu-system-arm.js.symbols (profiling)
#   BUNDLE_OUT=dir GZIP_LEVEL=6 ...  alternate destination / faster gzip
#
# dist/manifest.sha256 covers every shipped file (sidecars included):
# `cd dist && sha256sum -c manifest.sha256` verifies a copy or a deploy.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="$WEB_DIR/site"
OUT="${BUNDLE_OUT:-$WEB_DIR/dist}"
GZIP_LEVEL="${GZIP_LEVEL:-9}"

fail() { echo "bundle-dist: $*" >&2; exit 1; }
note() { echo "bundle-dist: $*"; }

case "$GZIP_LEVEL" in
  [1-9]) ;;
  *) fail "GZIP_LEVEL must be 1..9, got '$GZIP_LEVEL'" ;;
esac
command -v gzip >/dev/null || fail "gzip not found"
command -v sha256sum >/dev/null || fail "sha256sum not found"

if [ "${BUNDLE_TESTS:-0}" = 1 ]; then note "including test suites (tcgisa/tcgbench)"; fi
if [ "${BUNDLE_SYMBOLS:-0}" = 1 ]; then note "including .symbols maps"; fi

# --------------------------------------------------------------- contents --

# The editable page (site/ top level; index.html pulls in the rest).
page="index.html app.js style.css keyboards.js fullflashes.js recalc.js recalc-worker.js"

# The two engines: dist-jit = wasm64 TCG backend, the page default
# (required); dist = TCI interpreter, the ?dist=dist fallback (only built
# with TCI=1 — optional).
engines="dist dist-jit"

for f in $page; do
  [ -f "$SITE/$f" ] || fail "site/$f missing"
done
# app.js fetches "dist/boards.tar" unconditionally, whatever ?dist= selects
[ -f "$SITE/dist/boards.tar" ] ||
  fail "site/dist/boards.tar missing — run scripts/build-qemu.sh (or scripts/pack-boards.sh)"
[ -f "$SITE/dist-jit/qemu-system-arm.wasm" ] ||
  fail "site/dist-jit/qemu-system-arm.wasm missing — run scripts/build-qemu.sh"
# the Siemens key module lives in dist/ for the same reason boards.tar does
[ -f "$SITE/dist/siemens-recalc.wasm" ] ||
  fail "site/dist/siemens-recalc.wasm missing — run scripts/build-recalc-wasm.sh"

# ---------------------------------------------------------------- assemble --

rm -rf "$OUT"
mkdir -p "$OUT/dist" "$OUT/dist-jit"

for f in $page; do
  cp "$SITE/$f" "$OUT/$f"
done

# boards.tar only ever lives in dist/ (pack-boards.sh drops stale copies
# next to the other engine) — the page expects it there.
cp "$SITE/dist/boards.tar" "$OUT/dist/boards.tar"
for f in siemens-recalc.js siemens-recalc.wasm; do
  cp "$SITE/dist/$f" "$OUT/dist/$f"
done

for d in $engines; do
  for f in qemu-system-arm.js qemu-system-arm.wasm; do
    if [ -f "$SITE/$d/$f" ]; then cp "$SITE/$d/$f" "$OUT/$d/$f"; fi
  done
done
if [ ! -f "$OUT/dist/qemu-system-arm.wasm" ]; then
  note "no TCI build in site/dist (built with TCI=1) — ?dist=dist will 404 on the deployed page"
fi

if [ "${BUNDLE_TESTS:-0}" = 1 ]; then
  for f in "$SITE"/dist/tcgisa.bin "$SITE"/dist/tcgbench*.bin "$SITE"/dist-jit/tcgisa.bin; do
    if [ -f "$f" ]; then cp "$f" "$OUT/${f#"$SITE"/}"; fi
  done
fi
if [ "${BUNDLE_SYMBOLS:-0}" = 1 ]; then
  for d in $engines; do
    f="$SITE/$d/qemu-system-arm.js.symbols"
    if [ -f "$f" ]; then cp "$f" "$OUT/$d/"; fi
  done
fi

# ------------------------------------------------------------ gz sidecars --

# -n: no filename/timestamp in the header → byte-deterministic bundles.
# Level 9 is build-time-only cost, worth it for the wasm (the wire
# bottleneck per README: dist-jit 28 MB → ~4 MB, TCI 45 MB → ~11 MB).
gz_re='\.(html?|css|m?js|json|wasm|tar|bin|svg|txt|symbols)$'
while IFS= read -r -d '' f; do
  [[ $f =~ $gz_re ]] || continue
  gzip -"$GZIP_LEVEL" -n -k "$f"
done < <(find "$OUT" -type f -print0)

# ----------------------------------------------------- manifest + summary --

( cd "$OUT" && find . -type f ! -name manifest.sha256 -print0 |
    LC_ALL=C sort -z | xargs -0 sha256sum ) > "$OUT/manifest.sha256"

printf '%-46s %12s %12s\n' file bytes '.gz bytes'
tot_raw=0
tot_gz=0
while IFS= read -r -d '' f; do
  [ -f "$f.gz" ] || continue
  r=$(stat -c %s "$f")
  g=$(stat -c %s "$f.gz")
  tot_raw=$((tot_raw + r))
  tot_gz=$((tot_gz + g))
  printf '%-46s %12d %12d\n' "${f#"$OUT"/}" "$r" "$g"
done < <(find "$OUT" -type f -print0)

printf '%-46s %12d %12d\n' "total (compressed files)" "$tot_raw" "$tot_gz"
note "$(du -sh "$OUT" | cut -f1) in $OUT — sha256sum -c manifest.sha256 verifies it"
note "host it: deploy/nginx/README.md (docker compose up -d --build)"
