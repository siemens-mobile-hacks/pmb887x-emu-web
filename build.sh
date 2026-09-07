#!/bin/bash
# One-shot build: emsdk + wasm deps + patched qemu-system-arm + web dist.
# Individual steps are cached; see scripts/*.sh.
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== [1/3] toolchain + deps =="
bash "$WEB_DIR/scripts/build-deps.sh"

echo "== [2/3] qemu (wasm64, arm-softmmu, TCG interpreter) =="
bash "$WEB_DIR/scripts/build-qemu.sh"

echo "== [3/3] done =="
echo "serve with:  (cd web && ./serve.mjs)   -> http://127.0.0.1:8080  (LAN/phone: https://<lan-ip>:6808)"
