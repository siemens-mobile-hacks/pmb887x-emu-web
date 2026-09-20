#!/bin/bash
# Build the pmb887x-upstream branch tip and run the 4-phone boot suite.
set -euo pipefail
LABEL="$1"
cd /workspace
bash tools/perf/build-rev.sh pmb887x-upstream
node tests/run.mjs --label "$LABEL" --timeout 150 2>&1 | tail -12
