#!/bin/bash
# Android arm64 emulator with a current Chromium, for profiling the page in
# Android's V8 configuration without a phone (doc/android-emulator.md).
# Pure software emulation: needs no KVM, no root beyond apt, no kernel
# modules.  Everything lives under build/android-emu/.
#
#   scripts/setup-android-emu.sh install        download + verify the pinned packages, patch one
#                                               byte of the emulator (see the doc), create the AVD
#   scripts/setup-android-emu.sh start          boot headless in the background, wait until Android is up
#   scripts/setup-android-emu.sh wait           only wait for a boot in progress
#   scripts/setup-android-emu.sh browser [url]  install Chromium once, open <url>, forward DevTools
#   scripts/setup-android-emu.sh devtools       re-create the port forwards only
#   scripts/setup-android-emu.sh status         emulator, boot state, DevTools /json/version
#   scripts/setup-android-emu.sh stop           shut the emulator down
#   scripts/setup-android-emu.sh adb <args...>  the SDK's adb against this emulator
#   scripts/setup-android-emu.sh up [url]       install + start + browser
#
# The quick substitute, not Android: the Linux arm64 build of the same
# Chromium milestone under qemu-user, wasm trap handler off as on Android.
# Several times the emulator's page speed, up in seconds, tools/wprof2.mjs
# keeps its call stacks.
#   scripts/setup-android-emu.sh linux-install        qemu-user, arm64 libraries, headless Chromium
#   scripts/setup-android-emu.sh linux-browser [url]  start it on <url>, DevTools on LINUX_DEVTOOLS_PORT
#   scripts/setup-android-emu.sh linux-stop
#
# Env overrides:
#   ANDROID_EMU_CPUS=12-15,28-31  taskset list for the emulator and for the
#                                 Linux browser (default: unpinned)
#   ANDROID_EMU_CORES=4           guest cores, a host thread each (start)
#   ANDROID_EMU_RAM=4096          guest RAM, MiB (start)
#   DEVTOOLS_PORT=9222            host port of Chromium's DevTools socket
#   PORT=8080                     page server port, reverse-forwarded into the guest
#   CHROME_FLAGS="..."            extra Chromium switches (e.g. --js-flags=...)
#   LINUX_DEVTOOLS_PORT=9333      DevTools port of the Linux arm64 Chromium
#   LINUX_TRAP_HANDLER=1          leave its wasm trap handler on (desktop configuration)
#   BOOT_TIMEOUT=1800             seconds start/wait give Android to boot
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/build/android-emu"
DL="$BASE/dl"
SDK="$BASE/sdk"
AVD=pmb-arm64
LOG="$BASE/log/emulator.log"
ADB="$SDK/platform-tools/adb"
SERIAL=emulator-5554

# Pinned packages.  The emulator must stay at 30.x and the image at API 29:
# later emulators refuse or cannot start an arm64 guest on an x86_64 host,
# and no emulator starts the API 30+ arm64 images there (see the doc).
EMU_ZIP=emulator-linux-6885378.zip          # Android Emulator 30.2.2
EMU_SHA=599ebc73e4155dd83900f4ba4080cd9dd5906a09e85ced35815cb3d05331228b
PT_ZIP=platform-tools_r37.0.1-linux.zip
PT_SHA=d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1
IMG_ZIP=arm64-v8a-29_r08.zip                # system-images;android-29;default;arm64-v8a
IMG_SHA=7fd1610e16a69ac2e202278e82077de134ce404fe099d872019f69f3a340acdd
IMG_DIR=system-images/android-29/default/arm64-v8a
# Chromium 157.0.8103.0, V8 15.7.112: two commits past the M157 branch point
# (1717349), M157 being Android stable in 2026-11.  Not trunk: in r1741244
# (160.0.8155.0) a busy worker no longer answers Profiler.enable, on desktop
# Linux too, and tools/wprof2.mjs needs that.
CHROMIUM_REV=1717351
CHROMIUM_SHA=393a9c7984849790bbc393917a7ea29468d3b11c0483e5f8addada6386696edf
GOOGLE_REPO=https://dl.google.com/android/repository
SNAPSHOTS=https://commondatastorage.googleapis.com/chromium-browser-snapshots/Android_Arm64
# Chrome for Testing headless shell, linux-arm64, same milestone: V8 15.7.112.23
CFT_VER=157.0.8103.50
CFT_SHA=55add1fa634756811fd644094ec226fc7e405be698fb07dbf0634bca689e293a
CFT=https://storage.googleapis.com/chrome-for-testing-public
# what the headless shell links (its deb.deps); apt adds their dependencies
LINUX_LIBS="libc6 libgcc-s1 libglib2.0-0t64 libnss3 libnspr4 libatk1.0-0t64
  libdbus-1-3 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2
  libgbm1 libexpat1 libxcb1 libxkbcommon0 libudev1 libasound2t64 libatspi2.0-0t64
  fonts-dejavu-core"
U="$BASE/linux-arm64"
LINUX_PORT="${LINUX_DEVTOOLS_PORT:-9333}"

DEVTOOLS_PORT="${DEVTOOLS_PORT:-9222}"
PAGE_PORT="${PORT:-8080}"
APK=ChromePublic.apk
PKG=org.chromium.chrome
ACTIVITY=com.google.android.apps.chrome.Main

export ANDROID_SDK_ROOT="$SDK" ANDROID_HOME="$SDK"
export ANDROID_AVD_HOME="$BASE/avd" ANDROID_EMULATOR_HOME="$BASE/emu-home"

adb() { "$ADB" -s "$SERIAL" "$@"; }
emu_pid() { pgrep -x qemu-system-aar || true; }

fetch() {  # fetch <url> <file> <sha256>
  local url=$1 out=$2 sha=$3
  if [ ! -f "$out" ] || ! echo "$sha  $out" | sha256sum -c --quiet 2>/dev/null; then
    echo "downloading $url"
    mkdir -p "$(dirname "$out")"
    curl -fL --retry 3 -o "$out.part" "$url"
    echo "$sha  $out.part" | sha256sum -c --quiet
    mv "$out.part" "$out"
  fi
}

apt_install() {
  [ $# -gt 0 ] || return 0
  sudo apt-get update -q
  sudo apt-get install -y -q --no-install-recommends "$@"
}

# each unpack is keyed by its zip name, so a changed pin unpacks again
unpack() {  # unpack <zip> <dest dir> <dir the zip creates there>
  local zip=$1 dest=$2 made=$3
  if [ "$(cat "$dest/$made/.from" 2>/dev/null)" != "$(basename "$zip")" ]; then
    rm -rf "${dest:?}/$made"
    mkdir -p "$dest"
    unzip -q -o "$zip" -d "$dest"
    basename "$zip" > "$dest/$made/.from"
  fi
}

cmd_install() {
  local need=()
  command -v curl >/dev/null || need+=(curl ca-certificates)
  command -v unzip >/dev/null || need+=(unzip)
  command -v fdtput >/dev/null || need+=(device-tree-compiler)
  # the headless emulator still links libGL and libX11
  for lib in libGL.so.1:libgl1 libX11.so.6:libx11-6; do
    ldconfig -p | grep "${lib%%:*}" >/dev/null || need+=("${lib##*:}")
  done
  apt_install "${need[@]}"

  fetch "$GOOGLE_REPO/$EMU_ZIP" "$DL/$EMU_ZIP" "$EMU_SHA"
  fetch "$GOOGLE_REPO/$PT_ZIP" "$DL/$PT_ZIP" "$PT_SHA"
  fetch "$GOOGLE_REPO/sys-img/android/$IMG_ZIP" "$DL/$IMG_ZIP" "$IMG_SHA"
  fetch "$SNAPSHOTS/$CHROMIUM_REV/chrome-android.zip" \
        "$DL/chromium-$CHROMIUM_REV/chrome-android.zip" "$CHROMIUM_SHA"

  unpack "$DL/$EMU_ZIP" "$SDK" emulator
  unpack "$DL/$PT_ZIP" "$SDK" platform-tools
  unpack "$DL/$IMG_ZIP" "$SDK/$(dirname "$IMG_DIR")" "$(basename "$IMG_DIR")"
  if [ "$(cat "$BASE/apk/.from" 2>/dev/null)" != "$CHROMIUM_REV" ]; then
    rm -rf "$BASE/apk"
    unzip -q -o -j "$DL/chromium-$CHROMIUM_REV/chrome-android.zip" \
      'chrome-android/apks/*' -d "$BASE/apk"
    echo "$CHROMIUM_REV" > "$BASE/apk/.from"
  fi
  # One byte of the emulator's QEMU: its TCG miscompiles "dup vN.2d, xM"
  # when it emits host vector code (after it, the host register it takes
  # for xM holds something else, so "p = operator new(n); dup v0.2d, x0;
  # ...; str x1, [x0]" faults at a garbage address: storaged, mediaswcodec
  # and Chromium die of SIGSEGV at random).  Without AVX it calls helpers
  # for vector ops instead, so make its host probe (cpuid/xgetbv, then
  # have_avx1/have_avx2) skip the AVX branch: jne -> jmp.
  local q="$SDK/emulator/qemu/linux-x86_64/qemu-system-aarch64-headless"
  case "$(od -An -tx1 -j $((0x37b53)) -N 5 "$q" | tr -d ' \n')" in
    83f8067515) printf '\xeb' | dd of="$q" bs=1 seek=$((0x37b56)) conv=notrunc status=none ;;
    83f806eb15) ;;
    *) echo "unexpected bytes at the AVX probe of $q" >&2; exit 1 ;;
  esac

  # the 30.x emulator only accepts an SDK root that has these two
  mkdir -p "$SDK/platforms" "$BASE/log" "$ANDROID_EMULATOR_HOME"

  # The AVD is written by hand: avdmanager would need a JDK and the SDK
  # command-line tools for the same two small files.
  local avd="$ANDROID_AVD_HOME/$AVD.avd"
  mkdir -p "$avd"
  printf 'avd.ini.encoding=UTF-8\npath=%s\ntarget=android-29\n' "$avd" \
    > "$ANDROID_AVD_HOME/$AVD.ini"
  cat > "$avd/config.ini" <<EOF
AvdId=$AVD
PlayStore.enabled=false
abi.type=arm64-v8a
avd.ini.encoding=UTF-8
hw.cpu.arch=arm64
hw.cpu.ncore=4
hw.ramSize=4096
vm.heapSize=256
hw.lcd.width=720
hw.lcd.height=1280
hw.lcd.density=320
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
hw.keyboard=yes
hw.sdCard=no
hw.audioInput=no
hw.audioOutput=no
hw.camera.back=none
hw.camera.front=none
disk.dataPartition.size=6G
fastboot.forceColdBoot=yes
image.sysdir.1=$IMG_DIR/
tag.id=default
tag.display=Default
EOF
  echo "installed: $("$SDK/emulator/emulator" -version | head -1), AVD $AVD"
}

cmd_start() {
  [ -x "$SDK/emulator/emulator" ] || { echo "not installed — run: $0 install" >&2; exit 1; }
  if [ -n "$(emu_pid)" ]; then
    echo "emulator already running (pid $(emu_pid))"
  else
    local pin=() smp=() cores="${ANDROID_EMU_CORES:-4}"
    local dtb="$ANDROID_AVD_HOME/$AVD.avd/ranchu-psci.dtb"
    # -feature -VirtioInput: the emulator's virtio input devices are PCI and
    #   the arm64 "ranchu" board has no PCI bus (cmd_wait covers the loss).
    # -feature -QuickbootFileBacked: guest RAM in memory, not in a file
    #   under the AVD.  -no-jni: no CheckJNI in the guest's ART.
    # -feature GLESDynamicVersion: offer the guest OpenGL ES 3.0 (the host
    #   SwiftShader has it) instead of 2.0; Chromium's GPU process exits
    #   without ES 3 and the browser follows.
    local opts=(-avd "$AVD" -no-window -no-audio -no-boot-anim -no-snapshot
      -no-jni -gpu swiftshader_indirect -memory "${ANDROID_EMU_RAM:-4096}"
      -feature -VirtioInput,-QuickbootFileBacked,GLESDynamicVersion)
    [ -n "${ANDROID_EMU_CPUS:-}" ] && pin=(taskset -c "$ANDROID_EMU_CPUS")
    "$ADB" start-server >/dev/null 2>&1
    mkdir -p "$(dirname "$LOG")"

    if [ "$cores" -gt 1 ]; then
      # More than one core takes three things this emulator does not do
      # for an arm64 guest without KVM: -smp (it passes none),
      # multi-threaded TCG (the default runs every core round-robin on one
      # host thread), and PSCI, which is how the kernel starts cores 1..n.
      # The board's device tree names PSCI as the enable-method but has no
      # /psci node, and leaves QEMU's PSCI emulation off; so dump the tree,
      # add the node, boot with the result and switch the emulation on.
      # SMC, not HVC: the kernel starts at EL2 and handles HVC itself.
      rm -f "$dtb"
      "$SDK/emulator/emulator" "${opts[@]}" -qemu -smp "$cores" \
        -machine "dumpdtb=$dtb" >/dev/null 2>&1 || true
      [ -s "$dtb" ] || { echo "could not dump the device tree" >&2; exit 1; }
      fdtput -c "$dtb" /psci
      fdtput -t s "$dtb" /psci compatible arm,psci-0.2 arm,psci
      fdtput -t s "$dtb" /psci method smc
      smp=(-smp "$cores" -accel tcg,thread=multi
           -dtb "$dtb" -global arm-cpu.psci-conduit=1)
    fi

    date +%s > "$BASE/log/start.ts"
    setsid nohup "${pin[@]}" "$SDK/emulator/emulator" "${opts[@]}" -show-kernel \
      ${smp[@]:+-qemu "${smp[@]}"} > "$LOG" 2>&1 < /dev/null &
    echo "emulator starting, log: $LOG"
  fi
  cmd_wait
}

cmd_wait() {
  local t0 deadline r="" input=""
  t0=$(cat "$BASE/log/start.ts" 2>/dev/null || date +%s)
  deadline=$(( $(date +%s) + ${BOOT_TIMEOUT:-1800} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ -n "$(emu_pid)" ] || { echo "emulator exited — see $LOG" >&2; tail -5 "$LOG" >&2; exit 1; }
    # With no input device at all the kernel never creates /dev/input, and
    # Android 10's system_server aborts on that in a loop ("Could not
    # register INotify for /dev/input").  An empty directory is enough;
    # it has to be there before system_server starts, so as soon as adbd
    # answers.  Input still works through `adb shell input` and DevTools.
    if [ -z "$input" ] && timeout 10 "$ADB" -s "$SERIAL" shell \
         "su 0 sh -c 'mkdir -p /dev/input && restorecon /dev/input'" >/dev/null 2>&1; then
      input=1
      echo "adbd up ($(( $(date +%s) - t0 )) s since start)"
    fi
    r=$(timeout 10 "$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
    [ "$r" = 1 ] && break
    sleep 2
  done
  [ "$r" = 1 ] || { echo "Android did not boot within ${BOOT_TIMEOUT:-1800} s" >&2; exit 1; }
  echo "Android booted ($(( $(date +%s) - t0 )) s since start)"
}

cmd_devtools() {
  # The page needs a secure context for SharedArrayBuffer, and plain http
  # is one only on loopback: the guest reaches the page server as its own
  # 127.0.0.1, not as 10.0.2.2.
  adb reverse "tcp:$PAGE_PORT" "tcp:$PAGE_PORT" >/dev/null
  adb forward "tcp:$DEVTOOLS_PORT" localabstract:chrome_devtools_remote >/dev/null
  echo "guest 127.0.0.1:$PAGE_PORT -> host, host 127.0.0.1:$DEVTOOLS_PORT -> Chromium DevTools"
}

cmd_browser() {
  local url="${1:-http://127.0.0.1:$PAGE_PORT/?dist=dist-jit}"
  local mark="/data/local/tmp/$PKG.rev"
  if [ "$(adb shell "cat $mark 2>/dev/null" | tr -d '\r')" != "$CHROMIUM_REV" ] ||
     ! adb shell pm path "$PKG" 2>/dev/null | grep package: >/dev/null; then
    echo "installing $APK r$CHROMIUM_REV (about 10 minutes)"
    adb uninstall "$PKG" >/dev/null 2>&1 || true
    adb install -g "$BASE/apk/$APK"
    adb shell "echo $CHROMIUM_REV > $mark"
  fi
  # userdebug images let Chromium read its switches from this file.  The
  # three timeout switches are not optional here: at this speed the browser
  # otherwise aborts itself ("Timed out waiting for GPU channel").
  adb shell "echo 'chrome --no-first-run --disable-fre --no-default-browser-check \
--disable-timeouts-for-profiling --disable-gpu-watchdog --disable-hang-monitor \
${CHROME_FLAGS:-}' > /data/local/tmp/chrome-command-line"
  cmd_devtools
  adb shell am force-stop "$PKG"
  # one tab: do not restore those of earlier launches
  adb shell "su 0 rm -rf /data/data/$PKG/app_tabs"
  for i in $(seq 0 300); do
    # a busy system_server sometimes drops the launch: ask again
    if [ $((i % 45)) = 0 ] && [ -z "$(adb shell pidof "$PKG" | tr -d '\r')" ]; then
      adb shell am start -n "$PKG/$ACTIVITY" -a android.intent.action.VIEW -d "'$url'" >/dev/null
    fi
    if curl -fsS -m 5 "http://127.0.0.1:$DEVTOOLS_PORT/json/version" 2>/dev/null; then
      echo; return 0
    fi
    sleep 2
  done
  echo "DevTools did not answer on port $DEVTOOLS_PORT" >&2; exit 1
}

linux_pids() { pgrep -f "^qemu-aarch64 .*-L $U/root " || true; }

cmd_linux_install() {
  local need=()
  command -v curl >/dev/null || need+=(curl ca-certificates)
  command -v unzip >/dev/null || need+=(unzip)
  command -v qemu-aarch64 >/dev/null || need+=(qemu-user)
  command -v aarch64-linux-gnu-gcc >/dev/null || need+=(gcc-aarch64-linux-gnu libc6-dev-arm64-cross)
  apt_install "${need[@]}"

  local zip=chrome-headless-shell-linux-arm64.zip
  fetch "$CFT/$CFT_VER/linux-arm64/$zip" "$DL/cft-$CFT_VER/$zip" "$CFT_SHA"
  unpack "$DL/cft-$CFT_VER/$zip" "$U" chrome-headless-shell-linux-arm64

  # The arm64 libraries, from the ports archive of the host's Ubuntu
  # release, unpacked and not installed: an apt with private state resolves
  # and verifies them, dpkg-deb extracts.  No root, no foreign architecture
  # on the host.
  local rootfs="$U/root" apt="$U/apt" codename want
  codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
  want="$codename $(echo $LINUX_LIBS)"
  if [ "$(cat "$rootfs/.from" 2>/dev/null)" != "$want" ]; then
    rm -rf "$rootfs" "$apt"
    mkdir -p "$apt/lists/partial" "$apt/cache/archives/partial" "$apt/etc" \
             "$rootfs/usr/lib" "$rootfs/usr/bin" "$rootfs/usr/sbin" "$rootfs/tmp"
    : > "$apt/status"
    for suite in "$codename" "$codename-updates"; do
      echo "deb [arch=arm64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg]" \
           "http://ports.ubuntu.com/ubuntu-ports $suite main universe"
    done > "$apt/etc/sources.list"
    local aptget=(apt-get -q -o APT::Architecture=arm64 -o APT::Architectures=arm64
      -o "Dir::Etc::sourcelist=$apt/etc/sources.list" -o Dir::Etc::sourceparts=/dev/null
      -o "Dir::State::lists=$apt/lists" -o "Dir::State::status=$apt/status"
      -o "Dir::Cache=$apt/cache" -o Debug::NoLocking=1 -o APT::Sandbox::User=
      -o APT::Install-Recommends=0)
    "${aptget[@]}" update
    # shellcheck disable=SC2086
    "${aptget[@]}" install --download-only -y $LINUX_LIBS
    for l in lib bin sbin; do ln -s "usr/$l" "$rootfs/$l"; done
    for deb in "$apt"/cache/archives/*.deb; do dpkg-deb -x "$deb" "$rootfs"; done
    rm -rf "$apt"
    echo "$want" > "$rootfs/.from"
  fi

  cat > "$U/mremap-shim.c" <<'EOF'
/* V8 moves its embedded builtins into the code range with
 * mremap(MREMAP_DONTUNMAP), which leaves the old mapping in place, and wasm
 * code keeps calling the old addresses.  qemu-user 10.2 forgets the old
 * range, so the first wasm call dies with SEGV_MAPERR inside the chrome
 * binary's own text.  Refuse the call: V8 then copies the builtins. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdarg.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

void *mremap(void *old, size_t old_size, size_t new_size, int flags, ...)
{
    va_list ap;
    va_start(ap, flags);
    void *new_addr = va_arg(ap, void *);
    va_end(ap);
    if (flags & MREMAP_DONTUNMAP) {
        errno = EINVAL;
        return MAP_FAILED;
    }
    return (void *)syscall(SYS_mremap, old, old_size, new_size, flags, new_addr);
}
EOF
  aarch64-linux-gnu-gcc -O2 -shared -fPIC -o "$U/mremap-shim.so" "$U/mremap-shim.c"

  # Chromium starts its child processes through this too
  # (--browser-subprocess-path): no binfmt_misc in the container.  The x86
  # loader of sh and qemu itself logs that it cannot preload the arm64 shim;
  # that is harmless.
  cat > "$U/chrome-arm64" <<EOF
#!/bin/sh
exec qemu-aarch64 -E LD_PRELOAD=$U/mremap-shim.so -L $U/root $U/chrome-headless-shell-linux-arm64/chrome-headless-shell "\$@"
EOF
  chmod +x "$U/chrome-arm64"
  echo "installed: $("$U/chrome-arm64" --version), $(qemu-aarch64 --version | head -1)"
}

cmd_linux_browser() {
  local url="${1:-http://127.0.0.1:$PAGE_PORT/?dist=dist-jit}" pin=()
  # Android's V8 has no wasm trap handler: explicit bounds checks, no guard
  # regions.  The Linux build gets the same from this feature switch
  # (--js-flags=--no-wasm-trap-handler does not do it).
  local trap=(--disable-features=WebAssemblyTrapHandler)
  [ -x "$U/chrome-arm64" ] || { echo "not installed — run: $0 linux-install" >&2; exit 1; }
  cmd_linux_stop >/dev/null
  [ -n "${ANDROID_EMU_CPUS:-}" ] && pin=(taskset -c "$ANDROID_EMU_CPUS")
  [ "${LINUX_TRAP_HANDLER:-0}" = 1 ] && trap=()
  rm -rf "$U/profile"
  mkdir -p "$BASE/log"
  # --no-sandbox, --no-zygote: neither the namespace sandbox nor the zygote's
  # fork-without-exec works under qemu-user.
  # shellcheck disable=SC2086
  setsid nohup "${pin[@]}" "$U/chrome-arm64" --headless --no-sandbox --no-zygote \
    --browser-subprocess-path="$U/chrome-arm64" --remote-debugging-port="$LINUX_PORT" \
    --user-data-dir="$U/profile" "${trap[@]}" ${CHROME_FLAGS:-} "$url" \
    > "$BASE/log/chrome-arm64.log" 2>&1 < /dev/null &
  for _ in $(seq 1 60); do
    if curl -fsS -m 3 "http://127.0.0.1:$LINUX_PORT/json/version" 2>/dev/null; then
      echo; return 0
    fi
    sleep 1
  done
  echo "DevTools did not answer on port $LINUX_PORT — see $BASE/log/chrome-arm64.log" >&2; exit 1
}

cmd_linux_stop() {
  local pids; pids=$(linux_pids)
  [ -n "$pids" ] || { echo "linux arm64 chromium: not running"; return 0; }
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
  echo "linux arm64 chromium stopped"
}

cmd_status() {
  local pid; pid=$(emu_pid)
  if [ -n "$(linux_pids)" ]; then
    echo "linux arm64 chromium: $(linux_pids | wc -l) processes"
    curl -fsS -m 5 "http://127.0.0.1:$LINUX_PORT/json/version" 2>/dev/null || echo "devtools: no answer on $LINUX_PORT"
    echo
  fi
  [ -n "$pid" ] || { echo "emulator: not running"; return 0; }
  echo "emulator: pid $pid, cpus $(taskset -cp "$pid" | sed 's/.*: //')"
  echo "boot_completed: $(timeout 10 "$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  curl -fsS -m 5 "http://127.0.0.1:$DEVTOOLS_PORT/json/version" 2>/dev/null || echo "devtools: no answer on $DEVTOOLS_PORT"
  echo
}

cmd_stop() {
  [ -n "$(emu_pid)" ] || { echo "emulator: not running"; return 0; }
  timeout 20 "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do [ -z "$(emu_pid)" ] && break; sleep 1; done
  [ -z "$(emu_pid)" ] || pkill -9 -x qemu-system-aar || true
  "$ADB" kill-server >/dev/null 2>&1 || true
  echo "emulator stopped"
}

cmd="${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
  install)  cmd_install ;;
  start)    cmd_start ;;
  wait)     cmd_wait ;;
  browser)  cmd_browser "$@" ;;
  devtools) cmd_devtools ;;
  status)   cmd_status ;;
  stop)     cmd_stop ;;
  adb)      adb "$@" ;;
  up)       cmd_install; cmd_start; cmd_browser "$@" ;;
  linux-install) cmd_linux_install ;;
  linux-browser) cmd_linux_browser "$@" ;;
  linux-stop)    cmd_linux_stop ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 1 ;;
esac
