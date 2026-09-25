#!/usr/bin/env bash
# run-lever.sh <f1m|m1|t1|b1|b1b>: build a HEAD arm and the lever's arm,
# both with bench hooks, and run the lever's A/B.  The qemu tree must be
# clean; the lever patch is applied only for its build.  Measurement only:
# gate-lever.sh gates and commits.  Two binaries, both hooked; J2ME at
# tb-size=768 (see doc/performance-handoff.md, round fifty-three).
set -uo pipefail
L=${1:?lever}
R=/workspace/tools/perf/round53
HOOKS=/workspace/tools/perf/bench-hooks.patch
J2Q='qargs=-accel%20tcg,tb-size=768'
cd /workspace

j2me_abba() {  # <rounds> <distB> <tag>
  EXTRA_Q=$J2Q bash tools/perf/j2abba.sh "$1" dist-base "$2" "$3" 2>&1 | grep -E "^J2ME" | cut -c1-200
  VGFIT_KIND=j2me python3 tools/perf/vgfit.py dist-base "$2" "$3" 2>&1 | tail -3
}
video_abba() {  # <rounds> <distB> <tag>
  bash tools/perf/vgabba.sh "$1" dist-base "$2" "$3" 2>&1 | grep -E "^VIDEO" | cut -c1-200
  python3 tools/perf/vgfit.py dist-base "$2" "$3" 2>&1 | tail -3
}
boot_ab() {  # <distB>: S75 boot milestones, slot 2 = tcg_reg_free syncs
  PORT=8094 timeout 2400 node tools/idlebench.mjs "dist-b1base,$1" --board s75 --runs 4 --max 90 --noref 2>&1 \
    | grep -E "^\s*\[dist.*->|^dist-" | cut -c1-330
}

case "$L" in
  f1m)
    bash $R/build-arm.sh dist-base $HOOKS || exit 1
    bash $R/build-arm.sh dist-f1m $HOOKS $R/f1m.patch || exit 1
    bash $R/build-arm.sh dist-f1mc $HOOKS $R/f1mc.patch || exit 1
    j2me_abba 3 dist-f1m f1m
    video_abba 2 dist-f1m f1m
    echo "=== census (bench3 = memo tests executed, bench4 = memo hits)"
    EXTRA_Q=$J2Q PORT=8080 node tools/j2mebench.mjs --dist dist-f1mc --tag f1mc \
      --flash fullflashes/CX70_FW56_clean.bin --game 1 2>&1 | grep -E "^J2ME|^perMi:" | cut -c1-200
    node tools/videobench.mjs --dist dist-f1mc --tag f1mc 2>&1 | grep -E "^VIDEO|^perMi:" | cut -c1-200
    ;;
  m1|t1)
    bash $R/build-arm.sh dist-base $HOOKS || exit 1
    bash $R/build-arm.sh dist-$L $HOOKS $R/$L.patch || exit 1
    j2me_abba 2 dist-$L $L
    video_abba 2 dist-$L $L
    ;;
  b1|b1b)
    bash $R/build-arm.sh dist-b1base $R/b1-hooks.patch || exit 1
    bash $R/build-arm.sh dist-$L $R/b1-hooks.patch $R/$L.patch || exit 1
    boot_ab dist-$L
    ;;
  *) echo "unknown lever $L"; exit 2 ;;
esac
echo "LEVER-$L-DONE $(date +%H:%M:%S)"
