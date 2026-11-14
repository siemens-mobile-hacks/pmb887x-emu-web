# Sourced by the paired A/B scripts (bootab.sh, swab.sh): SETS[i] is two
# whole physical cores with all their SMT threads, consecutive in core
# order, read from this host's CPU topology.
mapfile -t SETS < <(python3 - <<'PY'
import glob


def expand(s):
    out = []
    for part in s.strip().split(","):
        a, _, b = part.partition("-")
        out += range(int(a), int(b or a) + 1)
    return out


cores = sorted({tuple(expand(open(f).read())) for f in
                glob.glob("/sys/devices/system/cpu/cpu[0-9]*/topology/thread_siblings_list")})
for i in range(0, len(cores) - 1, 2):
    print(",".join(str(c) for c in sorted(cores[i] + cores[i + 1])))
PY
)

# need_sets <pairs>: fail unless the pairs' core sets (ORD in the callers)
# exist on this host
need_sets() {
  local ord=(0 4 2 6) max=0 p
  for p in $(seq 1 "$1"); do [ "${ord[$((p - 1))]}" -gt "$max" ] && max=${ord[$((p - 1))]}; done
  if [ $((max + 2)) -gt "${#SETS[@]}" ]; then
    echo "$1 pairs need $(( (max + 2) * 2 )) physical cores; this host has $(( ${#SETS[@]} * 2 ))" >&2
    exit 2
  fi
}
