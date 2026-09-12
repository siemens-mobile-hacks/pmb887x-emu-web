#!/bin/bash
# One-command C-iteration loop for the default wasm build (wasm64 TCG
# backend, site/dist-jit; TCI=1 for the interpreter dist):
#   edit build/qemu/**.c  ->  scripts/iterate.sh  ->  verdict
#
# Steps: incremental ninja rebuild + deploy to site/dist-jit/ (scripts/ninja-fast.sh),
# then the parallel boot-survival A/B check (tools/ab.mjs) against the fresh
# build. Total wall time ≈ rebuild (~10 s) + until-splash (~30 s).
#
# Env:
#   AB="fast rewind"   variants to boot in parallel (default: fast;
#                       repeat a name for parallel duplicate samples)
#   TEST=none          skip the browser check, just build+deploy
#   AB_TIMEOUT=90      per-variant verdict timeout (seconds)
#   AB_PASS_FB=100     splash threshold; AB_PASS_INSNS=<n> alt early-pass
#   plus everything ninja-fast.sh honors (VERBOSE, NO_DEPLOY, GZ)
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$WEB_DIR/scripts/ninja-fast.sh"

if [ "${TEST:-ab}" = "none" ]; then
  echo "iterate: build+deploy done (TEST=none)"
  exit 0
fi

cd "$WEB_DIR/tools"
# shellcheck disable=SC2086  # AB is intentionally word-split variant list
node ab.mjs ${AB:-fast}
