#!/bin/bash
# Incremental build helper for the wasm64 TCG backend build dir.
set -euo pipefail
source /workspace/build/deps/emsdk/emsdk_env.sh >/dev/null 2>&1
export PATH="$HOME/.local/bin:$PATH"
export CPATH="/workspace/build/deps/target/include"
export PKG_CONFIG_PATH="/workspace/build/deps/target/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"
cd /workspace/build/qemu-wasm64
exec ninja -j"$(nproc)" "$@"
