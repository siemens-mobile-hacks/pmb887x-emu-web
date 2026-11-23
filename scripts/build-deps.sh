#!/bin/bash
# Build the emscripten/wasm64 dependency stack (zlib, libffi headers, pixman,
# glib) used to compile qemu-pmb887x to WebAssembly.
#
# Mirrors qemu's tests/docker/dockerfiles/emsdk-wasm64-cross.docker.
# Result: $WASM_DEPS/target/{include,lib} + emsdk installed under
# $WASM_DEPS/emsdk. Safe to re-run: a step whose stamp names the versions
# below is skipped, and a version bump or an interrupted step redoes it.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Toolchain versions (mirror qemu's tests/docker/dockerfiles/emsdk-wasm64-cross.docker)
EMSDK_VERSION="4.0.10"
ZLIB_VERSION="1.3.2"
# zlib-1.3.2.tar.xz; the sha256 GitHub's release lists for the asset
ZLIB_SHA256="d7a0654783a4da529d1bb793b7ad9c3318020af77667bcae35f95d0e42a792f3"
PIXMAN_VERSION="0.44.2"
LIBFFI_VERSION="v3.5.2"
GLIB_VERSION="2.84.0"
# glib-2.84.0.tar.xz; from download.gnome.org's glib-2.84.0.sha256sum
GLIB_SHA256="f8823600cb85425e2815cfad82ea20fdaa538482ab74e7293d58b3f64a5aff6a"

source "$WEB_DIR/scripts/build-dirs.sh"
TARGET="$DEPS_ROOT/target"
SRCDIR="$DEPS_ROOT/src"
mkdir -p "$TARGET" "$SRCDIR"

export PATH="$HOME/.local/bin:$PATH"

# --- emsdk ---
# The stamp is written once install and activate have finished. An emsdk
# from before the stamps counts as done when it was activated and its
# emscripten is the pinned version.
EMSDK_DIR="$DEPS_ROOT/emsdk"
EMSDK_STAMP="$EMSDK_DIR/.pmb887x-installed"
emsdk_new=0
if [ ! -x "$EMSDK_DIR/emsdk" ]; then
  git clone --depth 1 --branch "$EMSDK_VERSION" \
    https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
if [ ! -f "$EMSDK_STAMP" ] && [ -f "$EMSDK_DIR/.emscripten" ] &&
   [ "$(tr -d '"' < "$EMSDK_DIR/upstream/emscripten/emscripten-version.txt" 2>/dev/null)" = "$EMSDK_VERSION" ]; then
  echo "$EMSDK_VERSION" > "$EMSDK_STAMP"
fi
if [ "$(cat "$EMSDK_STAMP" 2>/dev/null)" != "$EMSDK_VERSION" ]; then
  # an older checkout does not know a newer version: fetch its tag
  git -C "$EMSDK_DIR" rev-parse -q --verify "refs/tags/$EMSDK_VERSION" >/dev/null ||
    git -C "$EMSDK_DIR" fetch -q --depth 1 origin tag "$EMSDK_VERSION"
  git -C "$EMSDK_DIR" checkout -q "$EMSDK_VERSION"
  (cd "$EMSDK_DIR" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")
  echo "$EMSDK_VERSION" > "$EMSDK_STAMP"
  emsdk_new=1
fi
use_emsdk

# Each library step below writes $TARGET/.built-<name> last, with its version
# and the emsdk's, and runs again unless that stamp matches: a bump of either
# rebuilds it, and so does an interrupted step. A target from before the
# stamps is taken at the version its pkg-config file records, unless the
# emsdk was just (re)installed.
built() { # <name> <version> <installed file> [<pkg-config module>]
  local stamp="$TARGET/.built-$1" v="$2"
  if [ ! -f "$stamp" ] && [ "$emsdk_new" = 0 ] && [ -e "$3" ]; then
    [ -z "${4:-}" ] || v="$(sed -n 's/^Version: *//p' "$TARGET/lib/pkgconfig/$4.pc" 2>/dev/null)"
    [ -z "$v" ] || echo "$v emsdk $EMSDK_VERSION" > "$stamp"
  fi
  [ "$(cat "$stamp" 2>/dev/null)" = "$2 emsdk $EMSDK_VERSION" ]
}
mark_built() { echo "$2 emsdk $EMSDK_VERSION" > "$TARGET/.built-$1"; }

export CPATH="$TARGET/include"
export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"
export CFLAGS="-O2 -pthread -DWASM_BIGINT -sMEMORY64=1"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-sMEMORY64=1 -sWASM_BIGINT -sASYNCIFY=1 -L$TARGET/lib"

cat > "$SRCDIR/cross.meson" <<EOF
[host_machine]
system = 'emscripten'
cpu_family = 'wasm64'
cpu = 'wasm64'
endian = 'little'

[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
pkgconfig = ['pkg-config', '--static']

[built-in options]
c_args = ['-O2', '-pthread', '-DWASM_BIGINT', '-sMEMORY64=1']
cpp_args = ['-O2', '-pthread', '-DWASM_BIGINT', '-sMEMORY64=1']
objc_args = ['-O2', '-pthread', '-DWASM_BIGINT', '-sMEMORY64=1']
c_link_args = ['-sMEMORY64=1', '-sWASM_BIGINT', '-sASYNCIFY=1', '-L$TARGET/lib']
cpp_link_args = ['-sMEMORY64=1', '-sWASM_BIGINT', '-sASYNCIFY=1', '-L$TARGET/lib']
EOF

# fetch <file> <sha256> <url>...: the first URL that answers, checked
# against its pinned sha256 before anything unpacks it
fetch() {
  local out="$1" sum="$2" url
  shift 2
  for url in "$@"; do
    curl -fsSL -o "$out.part" "$url" && break
    rm -f "$out.part"
  done
  if [ ! -f "$out.part" ]; then
    echo "build-deps: could not download $(basename "$out") from: $*" >&2
    exit 1
  fi
  if ! echo "$sum  $out.part" | sha256sum -c --quiet - >/dev/null 2>&1; then
    rm -f "$out.part"
    echo "build-deps: $(basename "$out") does not match its sha256 above" >&2
    exit 1
  fi
  mv -f "$out.part" "$out"
}

# --- zlib ---
if ! built zlib "$ZLIB_VERSION" "$TARGET/lib/libz.a" zlib; then
  cd "$SRCDIR"
  # zlib.net moves a release to fossils/ once the next one is out, and has
  # dropped 1.3.2 from both: GitHub's release asset is the last resort
  fetch "zlib-$ZLIB_VERSION.tar.xz" "$ZLIB_SHA256" \
    "https://zlib.net/zlib-$ZLIB_VERSION.tar.xz" \
    "https://zlib.net/fossils/zlib-$ZLIB_VERSION.tar.xz" \
    "https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.xz"
  rm -rf "zlib-$ZLIB_VERSION"
  tar xJf "zlib-$ZLIB_VERSION.tar.xz"
  cd "zlib-$ZLIB_VERSION"
  emconfigure ./configure --prefix="$TARGET" --static
  emmake make install
  mark_built zlib "$ZLIB_VERSION"
fi

# --- libffi (headers only: qemu's wasm/TCI build links none of its code) ---
if ! built libffi "${LIBFFI_VERSION#v}" "$TARGET/include/ffi.h" libffi; then
  cd "$SRCDIR"
  rm -rf libffi
  git clone -q https://github.com/libffi/libffi
  cd libffi && git checkout -q "$LIBFFI_VERSION"
  autoreconf -fiv >/dev/null 2>&1
  emconfigure ./configure --host=wasm64-unknown-linux \
    --prefix="$TARGET" --enable-static --disable-shared --disable-dependency-tracking \
    --disable-builddir --disable-multi-os-directory --disable-raw-api --disable-docs
  emmake make install SUBDIRS='include'
  mark_built libffi "${LIBFFI_VERSION#v}"
fi

# --- libresolv stub (glib's res_query probe) ---
if ! built resolv 1 "$TARGET/lib/libresolv.a"; then
  cd "$SRCDIR"
  cat > res_query.c <<'EOF'
#include <netdb.h>
int res_query(const char *name, int class, int type, unsigned char *dest, int len)
{
    h_errno = HOST_NOT_FOUND;
    return -1;
}
EOF
  emcc $CFLAGS -c res_query.c -fPIC -o libresolv.o
  ar rcs libresolv.a libresolv.o
  mkdir -p "$TARGET/lib"
  cp libresolv.a "$TARGET/lib/"
  mark_built resolv 1
fi

# --- pixman ---
if ! built pixman "$PIXMAN_VERSION" "$TARGET/lib/libpixman-1.a" pixman-1; then
  cd "$SRCDIR"
  rm -rf pixman
  git clone -q https://gitlab.freedesktop.org/pixman/pixman
  cd pixman && git checkout -q "pixman-$PIXMAN_VERSION"
  meson setup _build --prefix="$TARGET" --cross-file="$SRCDIR/cross.meson" \
    --default-library=static --buildtype=release -Dtests=disabled -Ddemos=disabled
  meson install -C _build
  rm -f "$TARGET/lib/libpixman-1.so"*
  mark_built pixman "$PIXMAN_VERSION"
fi

# --- glib ---
if ! built glib "$GLIB_VERSION" "$TARGET/lib/libglib-2.0.a" glib-2.0; then
  cd "$SRCDIR"
  fetch "glib-$GLIB_VERSION.tar.xz" "$GLIB_SHA256" \
    "https://download.gnome.org/sources/glib/${GLIB_VERSION%.*}/glib-$GLIB_VERSION.tar.xz"
  rm -rf "glib-$GLIB_VERSION"
  tar xJf "glib-$GLIB_VERSION.tar.xz"
  cd "glib-$GLIB_VERSION"
  CFLAGS="$CFLAGS -Wno-incompatible-function-pointer-types" \
  meson setup _build --prefix="$TARGET" --cross-file="$SRCDIR/cross.meson" \
    --default-library=static --buildtype=release --force-fallback-for=pcre2 \
    -Dselinux=disabled -Dxattr=false -Dlibmount=disabled -Dlibelf=disabled -Dnls=disabled \
    -Dtests=false -Dsysprof=disabled -Dglib_debug=disabled -Dglib_assert=false -Dglib_checks=false
  sed -i -E "/#define HAVE_POSIX_SPAWN 1/d; /#define HAVE_PTHREAD_GETNAME_NP 1/d" ./_build/config.h
  meson install -C _build
  mark_built glib "$GLIB_VERSION"
fi

echo "=== wasm deps ready in $TARGET ==="
