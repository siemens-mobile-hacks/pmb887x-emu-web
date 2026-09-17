#!/bin/bash
# Exits (and any other counter) per Mi, read at MATCHED instruction counts.
#
# This is the tight meter for a TB-shape change: ~0.8 % spread against the
# +-8 % of a fixed-wall clock, so it resolves a 2-3 % mechanism the clock
# cannot see.  What makes it honest is the milestone.  A per-Mi rate is NOT
# window-independent -- the boot's own mix changes as it runs, and the same
# binary reads exits/Mi 100 759 at 1018 Mi and 114 857 at 839 Mi.  A faster
# leg reaches further in a fixed 20 s, so sampling both legs at the same
# *second* hands the winning leg a flattering window, and the confound points
# the same way as the hypothesis.  diagall's per-second samples are
# cumulative, so each leg is instead sampled at the first sample at or past a
# chosen Mi.
#
#   tools/exitrate.sh run  <secs> <rounds> <out> "<name>:<extra-q>" ...
#   tools/exitrate.sh read <out> <Mi> [counter ...]
#
# Give the legs as a palindrome (a b b a) so slow drift cancels within a
# round.  Counters named x* are also summed as XTOT.
#
#   tools/exitrate.sh run 20 3 /tmp/ft "ft2:" "ft3:env=W64_FTMAX%3D3" \
#                                      "ft3:env=W64_FTMAX%3D3" "ft2:"
#   tools/exitrate.sh read /tmp/ft 600
set -u
cd "$(dirname "$0")/.."
mode="$1"; shift

if [ "$mode" = run ]; then
  S="$1"; R="$2"; OUT="$3"; shift 3
  : > "$OUT.raw"
  for r in $(seq 1 "$R"); do
    for leg in "$@"; do
      name="${leg%%:*}"; q="${leg#*:}"
      [ "$q" = "$name" ] && q=""
      q="env=W64_XCOUNT%3D1${q:+&$q}"
      for _ in $(seq 1 20); do
        busy=$(ps -eo pcpu,stat,comm |
               awk '$3 ~ /chrome|firefox/ && $2 !~ /Z/ && $1 > 5 {n++} END {print n+0}')
        [ "$busy" -eq 0 ] && break
        sleep 2
      done
      EXTRA_Q="$q" node tools/diagall.mjs "$S" 1 2>/dev/null | grep -E "^t=" |
        sed "s/^/$name r$r /" >> "$OUT.raw"
      echo "== r$r $name done" >&2
    done
  done
  exit 0
fi

OUT="$1"; MI="$2"; shift 2
KEYS="${*:-xGototb xGototb1 xSelf xGotoptr lookup lookupJc lookupQht}"
awk -v mi="$MI" -v keys="$KEYS" '
{
  name = $1; round = $2
  delete v
  for (i = 3; i <= NF; i++) { split($i, kv, "="); k = kv[1]; val = kv[2]
    sub(/[Ms]$/, "", val); v[k] = val + 0 }
  key = name "|" round
  if (v["insns"] >= mi && !(key in seen)) {
    seen[key] = 1
    n = split(keys, K, " ")
    line = sprintf("%-6s %-4s insns=%4.0fMi t=%5.1f", name, round, v["insns"], v["t"])
    tot = 0
    for (j = 1; j <= n; j++) {
      r = v[K[j]] / v["insns"]
      line = line sprintf("  %s=%.0f", K[j], r)
      if (K[j] ~ /^x/) tot += r
      sum[name "|" K[j]] += r
    }
    cnt[name]++
    if (tot > 0) { line = line sprintf("  XTOT=%.0f", tot); sumx[name] += tot }
    print line
  }
}
END {
  print ""
  n = split(keys, K, " ")
  for (name in cnt) {
    line = sprintf("MEAN %-6s n=%d", name, cnt[name])
    for (j = 1; j <= n; j++) line = line sprintf("  %s=%.0f", K[j], sum[name "|" K[j]] / cnt[name])
    if (sumx[name] > 0) line = line sprintf("  XTOT=%.0f", sumx[name] / cnt[name])
    print line
  }
}' "$OUT.raw"
