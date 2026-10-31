#!/bin/bash
# Parallel scenebench A/B: every run of every dist is its own single-run
# scenebench process, all started together, so a 4-run A/B of two dists
# takes one scenario length (~2.5 min for bobby at 30 s) instead of eight.
#
#   tools/parbench.sh <scenario> <distA,distB,...> [runs per dist] [measure s]
#
# Prints each dist's sorted cpu values, the median and the underruns.
# Under the contention the absolute cpu reads higher than a lone run
# (~1.0 instead of ~0.8 cores for bobby on a 32-core host), but the legs
# share it, so they compare; noise is about +-1 %, so repeat a marginal
# result with the dists swapped.  Twelve or more browsers saturate the host
# (underruns appear): keep runs x dists at 8 or so.
sc=$1; dists=$2; n=${3:-3}; m=${4:-30}
if [ -z "$sc" ] || [ -z "$dists" ]; then
  echo "usage: $0 <scenario> <distA,distB,...> [runs per dist] [measure s]" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$PWD/tools/chrome}
out=$(mktemp -d "${TMPDIR:-/tmp}/parbench.XXXX")
i=0
IFS=, read -ra D <<< "$dists"
for r in $(seq 1 "$n"); do
  for d in "${D[@]}"; do
    i=$((i+1))
    node tools/scenebench.mjs "$sc" "$d" --runs 1 --measure "$m" > "$out/$i.log" 2>&1 &
    sleep 1.1
  done
done
wait
for d in "${D[@]}"; do
  lines=$(grep -h "SCENEBENCH $sc $d median" "$out"/*.log)
  vals=$(echo "$lines" | sed -nE 's/.*cpu=([0-9.]+).*/\1/p' | sort -n | tr '\n' ' ')
  fails=$(echo "$lines" | grep -c "ok=0")
  med=$(echo $vals | awk '{n=split($0,a," "); if(n) print a[int((n+1)/2)]}')
  und=$(echo "$lines" | sed -nE 's/.*underruns=([0-9]+).*/\1/p' | tr '\n' ' ')
  echo "PAR $sc $d cpu=[$vals] median=$med underruns=[$und] fails=$fails"
done
echo "logs: $out"
