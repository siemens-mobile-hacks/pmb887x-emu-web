import glob, os, sys

# Which legs ran while the host was busy, decided by the monitor rather
# than by eye.
#
# Round 35 rejected three legs after noticing that k3's last three read
# ~9 % high, then confirming it against a live `vmstat`.  That worked but
# it is not a procedure: it needed the contamination to be large enough
# to see in the result, which means it can only catch the bursts that
# already ruined something.  hostmon.tsv samples pressure every 10 s
# independently of the results, so the same judgement can be made from
# the pressure alone -- before looking at a single ms/Mi, which is the
# only ordering that cannot talk itself into a convenient answer.
#
# A leg's window is (previous leg's mtime, this leg's mtime]: j2mebench
# writes its log when it finishes, so each mtime is an end, and the sweep
# is serial, so one leg's end is the next one's start.  That is exact and
# needs no assumed duration; DUR is only the fallback for the first leg.
#
# Coverage is checked before the verdict, and this is the whole point.
# The monitor was started mid-sweep, so the first run of this script
# cleared k3_ft1 -- a leg the *results* convict at +9 % -- on the
# strength of one sample taken 14 s before it finished, after the burst
# had already stopped.  A window that is 8 % observed is not evidence of
# quiet; it is absence of evidence wearing the same word.  Anything under
# COVER is reported as unknown, never as clean.
#
# The threshold.  A quiet sample on this host shows pswpout flat and
# allocstall creeping by a few tens per 10 s.  The burst that damaged k3
# ran at ~24 k pages/s, i.e. ~240 k per sample.  Anything in between is
# ambiguous, so flag at 2 k pages per sample -- two orders below the
# burst and one above the noise -- and print the margin so a borderline
# call is visible rather than silently decided.
DUR = 170.0          # a 45 s-window leg takes ~2.5-3 min wall
COVER = 0.80         # fraction of a leg's window the monitor must see
SWAP_PER_SAMPLE = 2000
STALL_PER_SAMPLE = 500

S = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[-1]):
    S = sys.argv[-1]
elif not glob.glob(os.path.join(S, "k[0-9]_*.log")):
    S = os.path.join(S, "round35")          # the archived evidence

rows = []
with open(os.path.join(S, "hostmon.tsv")) as f:
    next(f, None)
    for line in f:
        p = line.split("\t")
        if len(p) >= 7:
            rows.append((int(p[0]), int(p[1]), int(p[3])))
if len(rows) < 2:
    sys.exit("hostmon.tsv has no samples -- is hostmon.sh running?")

# rate per sample, attributed to the interval that ends at t
deltas = [(rows[i][0], rows[i][1] - rows[i - 1][1], rows[i][2] - rows[i - 1][2])
          for i in range(1, len(rows))]

print(f"hostmon covers {rows[0][0]} .. {rows[-1][0]} "
      f"({(rows[-1][0] - rows[0][0]) / 60:.0f} min, {len(rows)} samples)")
worst = max(deltas, key=lambda d: d[1])
print(f"worst swap-out sample: +{worst[1]} pages   "
      f"worst stall sample: +{max(d[2] for d in deltas)}\n")

mon_lo, mon_hi = deltas[0][0], deltas[-1][0]

print(f"{'leg':<12} {'ended':>6}  {'cover':>5}  {'swapout':>8} {'stall':>6}  verdict")
dirty, unknown = [], []
files = sorted(glob.glob(os.path.join(S, "k[0-9]_*.log")), key=os.path.getmtime)
prev_end = None
for f in files:
    leg = os.path.basename(f)[:-4]
    end = os.path.getmtime(f)
    start = prev_end if prev_end is not None and end - prev_end < 600 else end - DUR
    prev_end = end

    seen = max(0.0, min(end, mon_hi) - max(start, mon_lo))
    cover = seen / (end - start) if end > start else 0.0
    hhmm = f"{int(end % 86400 // 3600 + 0):02d}:{int(end % 3600 // 60):02d}"

    win = [d for d in deltas if start < d[0] <= end]
    if cover < COVER or not win:
        unknown.append(leg)
        print(f"{leg:<12} {hhmm:>6}  {cover*100:>4.0f}%  {'-':>8} {'-':>6}  "
              f"unknown -- not observed")
        continue
    sw, st = max(d[1] for d in win), max(d[2] for d in win)
    bad = sw > SWAP_PER_SAMPLE or st > STALL_PER_SAMPLE
    if bad:
        dirty.append(leg)
    print(f"{leg:<12} {hhmm:>6}  {cover*100:>4.0f}%  {sw:>8} {st:>6}  "
          f"{'REJECT' if bad else 'clean'}")

if dirty:
    print("\nmonitor REJECT = {" + ", ".join(
        '("%s", "%s")' % tuple(l.split("_", 1)) for l in dirty) + "}")
else:
    print("\nno observed leg overlaps a burst; the monitor rejects nothing")
if unknown:
    print(f"{len(unknown)} leg(s) unobserved: " + " ".join(unknown))
    print("Those keep whatever verdict the results-side argument gave them;\n"
          "the monitor neither clears nor convicts a window it did not see.")
print("\nThe monitor is a veto, not a certificate: it only sees pressure it\n"
      "has a counter for, so a cleared leg can still be wrong -- but a\n"
      "convicted one is convicted on evidence collected before the result.")
