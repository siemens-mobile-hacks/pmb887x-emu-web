#!/usr/bin/env bash
# build-arm.sh <dist> <hooks.patch> [lever.patch]: build the qemu working
# tree plus the lever patch (if any) plus the bench hooks into site/<dist>,
# then take both patches off again.  The qemu tree must be clean.
set -euo pipefail
DIST=$1
HOOKS=$(realpath "$2")
LEVER=${3:+$(realpath "$3")}
cd /workspace
[ -z "$(git -C qemu status --short | grep -v '^??')" ] || { echo "qemu tree not clean"; exit 1; }
[ -n "$LEVER" ] && git -C qemu apply "$LEVER"
git -C qemu apply "$HOOKS"
LOG=$(mktemp)
ok=0
PATH=/workspace/build/qemu-wasm64/pyvenv/bin:$PATH NO_DEPLOY=1 bash scripts/ninja-fast.sh > "$LOG" 2>&1 || ok=1
grep -E "ninja-fast|error:|FAILED" "$LOG" | grep -v "onlylist contained" || true
git -C qemu apply -R "$HOOKS"
[ -n "$LEVER" ] && git -C qemu apply -R "$LEVER"
if [ $ok != 0 ]; then echo "BUILD FAILED (log: $LOG)"; exit 1; fi
rm -f "$LOG"
rm -rf "site/$DIST" && mkdir -p "site/$DIST"
cp build/qemu-wasm64/qemu-system-arm.{js,wasm,js.symbols} "site/$DIST/"
echo "site/$DIST: qemu $(git -C qemu rev-parse --short HEAD) + ${LEVER:+$(basename "$LEVER") + }$(basename "$HOOKS"); wasm md5 $(md5sum site/$DIST/qemu-system-arm.wasm | cut -c1-8)"
