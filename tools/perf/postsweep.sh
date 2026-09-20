#!/usr/bin/env bash
# Everything that needs the sweep's dist-jit released, in one shell.
#
# One shell, no pid waiting: PID 1 in this container is `sleep infinity`
# and reaps nothing, so an orphaned child stays a zombie forever and a
# `while kill -0 $PID` loop never ends (it cost this session ten minutes).
#
# Order matters.  The census runs on the *pre-patch* dist because it is a
# measurement build whose numbers are rates, not speeds -- running it
# first means it is not waiting behind a ten-minute compile.  The
# snapshot is taken before the build for the same reason the A/B needs
# it: after `build-qemu-wasm64.sh` there is no pre-patch binary left.
set -u
cd /workspace
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"

echo "=== census (pre-patch dist, rates only) $(date +%H:%M:%S)"
bash "$S/census.sh"

echo "=== snapshot the pre-patch dist $(date +%H:%M:%S)"
rm -rf site/dist-jit-r34base
cp -a site/dist-jit site/dist-jit-r34base
echo "snapshot rc=$?"

echo "=== build $(date +%H:%M:%S)"
bash scripts/build-qemu-wasm64.sh > "$S/build34.log" 2>&1
rc=$?
echo "build rc=$rc $(date +%H:%M:%S)"
if [ $rc -ne 0 ]; then
  tail -40 "$S/build34.log"
  exit $rc
fi

echo "=== where the register write-backs come from $(date +%H:%M:%S)"
bash "$S/gsync.sh"

echo "=== counter check + LG A/B $(date +%H:%M:%S)"
bash "$S/lgab.sh"
echo "=== done $(date +%H:%M:%S)"
