#!/usr/bin/env bash
# gate-lever.sh <lever.patch> <commit-msg-file>: apply the lever to a
# clean qemu tree, build it into dist-jit, run the keep gate, and on GREEN
# commit it in qemu with the given message (numbers filled in first); on
# RED take the patch back off.  The superproject pin, versions.env history
# line and doc entry stay manual.
set -uo pipefail
P=$(realpath "$1"); M=$(realpath "$2")
N=$(basename "$P" .patch)
LOG=/workspace/tools/perf/logs
cd /workspace
[ -z "$(git -C qemu status --short | grep -v '^??')" ] || { echo "qemu tree not clean"; exit 1; }
grep -qE "\b(J2ME|VIDEO|BOOT|CENSUS)\.?$|: (J2ME|VIDEO|BOOT)\." "$M" && { echo "fill the placeholders in $M first"; exit 1; }
git -C qemu apply "$P" || { echo "apply failed"; exit 1; }
PATH=/workspace/build/qemu-wasm64/pyvenv/bin:$PATH bash scripts/ninja-fast.sh > "$LOG/build-gate-$N.log" 2>&1 || {
  echo "BUILD FAILED"; grep -E "error:" "$LOG/build-gate-$N.log" | head -5; git -C qemu apply -R "$P"; exit 1; }
echo "dist-jit $(md5sum site/dist-jit/qemu-system-arm.wasm | cut -c1-8)"
scripts/gate.sh keep > "$LOG/gate-$N.log" 2>&1
if grep -q "keep GREEN" "$LOG/gate-$N.log"; then
  echo "gate keep GREEN"
  git -C qemu add -A -- $(git -C qemu diff --name-only) && git -C qemu commit -q -F "$M" && git -C qemu log --oneline -1
else
  echo "GATE NOT GREEN:"; grep -E "FAIL|RED" "$LOG/gate-$N.log" | head -8
  git -C qemu apply -R "$P"
fi
