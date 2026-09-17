#!/usr/bin/env bash
# Interleaved A/B of the J2ME mechanisms, all inside one binary.
#
# Every mechanism this session added carries an off switch, so the four
# legs below differ only by a query parameter — no second build, no
# build-to-build difference to argue about, and the order is palindromic
# so a host that drifts during the run drifts across both halves.
#
#   PORT=8080 bash tools/j2meab.sh [legs] [dist]
#
# Read MIPS/cpu, not MIPS: the denominator is the CPU time the vCPU
# thread actually burned (j2mebench `busy` says how much wall time that
# was), which is what makes this measurable on a host with co-tenants.
# Mi must agree between legs — it is the determinism check.
set -u
legs=${1:-2}
dist=${2:-dist-jit}
cd "$(dirname "$0")/.."

declare -A Q=(
  [abc]=""
  [ab]="env=W64_NOPCC=1"
  [a]="env=W64_NOPCC=1&env=W64_NOSSIRUN=1"
  [none]="env=W64_NOPCC=1&env=W64_NOSSIRUN=1&env=W64_NODMARUN=1"
)
order=(none a ab abc abc ab a none)

out=tests/results/j2meab-$(date +%Y%m%d-%H%M%S).log
echo "j2meab: dist=$dist legs=$legs -> $out"
# A leg that dies takes its slot in the palindrome with it, and the guest
# stalls often enough on a loaded host to cost half of them.  Retry in
# place, so the order the legs were meant to run in survives.
for ((i = 0; i < legs; i++)); do
  for k in "${order[@]}"; do
    for try in 1 2 3; do
      line=$(EXTRA_Q="${Q[$k]}" node tools/j2mebench.mjs --dist "$dist" --tag "ab-$k" 2>&1 |
               grep -E "^J2ME |^perMi|^  " | tr '\n' ' ')
      case $line in
        *"MIPS/cpu="*) break ;;
        *) printf '%-5s try %d: %s\n' "$k" "$try" "$line" >> "$out" ;;
      esac
    done
    printf '%-5s %s\n' "$k" "$line" | tee -a "$out"
  done
done

echo "=== summary (median MIPS/cpu per leg) ==="
awk '{
  for (i = 1; i <= NF; i++) {
    if ($i ~ /^MIPS\/cpu=/) { split($i, a, "="); v[$1] = v[$1] " " a[2]; n[$1]++ }
  }
} END { for (k in v) printf "%-5s n=%d %s\n", k, n[k], v[k] }' "$out"
