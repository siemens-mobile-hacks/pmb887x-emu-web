#!/usr/bin/env bash
# Sample host memory pressure next to every benchmark leg.
#
# Round 35 found wall drifting +0.111 %/minute across a 17-leg sweep --
# base read 4.151, 4.209, 4.543 in three successive rounds while the
# within-round nobc/base ratio held at -26.0/-23.0/-26.2 %.  The cause is
# not in this container: our whole process table is ~1.5 GB RSS against
# AnonPages 70.8 GB and 29.8 GB swapped, so ~100 GB of anon memory belongs
# to processes in another namespace.  We cannot fix it and cannot see it.
#
# What we can do is timestamp it.  Every leg writes a result JSON; this
# writes a pressure line every 10 s.  Joining the two by time turns "that
# arm ran late so discount it" into a covariate -- and, more usefully,
# lets a leg be *rejected* rather than silently averaged in.
#
# The counters, and why these:
#   pswpout    cumulative pages swapped out; the rate is live eviction,
#              which is what actually stalls us.  swpd alone cannot tell
#              a 29 GB cold residue from 29 GB being churned.
#   allocstall_movable  direct-reclaim entries.  This one blocks the
#              allocating thread, so it is the counter closest to wall.
#   MemAvailable  headroom, in kB.
#   runq       first loadavg field.
set -u
S=${PERF_LOGS:-/workspace/tools/perf/logs}
mkdir -p "$S"
OUT="$S/hostmon.tsv"
[ -s "$OUT" ] || printf 'epoch\tpswpout\tpswpin\tallocstall\tmemavail_kb\tswpd_kb\trunq\n' > "$OUT"
while :; do
  read -r so si as <<<"$(awk '/^pswpout /{o=$2} /^pswpin /{i=$2} /^allocstall_movable /{a=$2} END{print o, i, a}' /proc/vmstat)"
  read -r av sf st <<<"$(awk '/^MemAvailable:/{a=$2} /^SwapFree:/{f=$2} /^SwapTotal:/{t=$2} END{print a, f, t}' /proc/meminfo)"
  rq=$(cut -d' ' -f1 /proc/loadavg)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date +%s)" "$so" "$si" "$as" "$av" "$((st - sf))" "$rq" >> "$OUT"
  sleep 10
done
