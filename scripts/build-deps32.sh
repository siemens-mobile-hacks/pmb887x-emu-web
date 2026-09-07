#!/bin/bash
# Build the emscripten/wasm64 dependency stack (zlib, libffi headers, pixman,
# glib) used to compile qemu-pmb887x to WebAssembly.
#
# Mirrors qemu's tests/docker/dockerfiles/emsdk-wasm64-cross.docker.
# Result: $WASM_DEPS/target/{include,lib} + emsdk installed under
# $WASM_DEPS/emsdk. Safe to re-run; finished artifacts are skipped.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$WEB_DIR/versions.env"

DEPS_ROOT="${WASM_DEPS:-$WEB_DIR/build/deps32}"
TARGET="$DEPS_ROOT/target"
SRCDIR="$DEPS_ROOT/src"
mkdir -p "$TARGET" "$SRCDIR"

export PATH="$HOME/.local/bin:$PATH"

# --- emsdk ---
if [ ! -x "$DEPS_ROOT/emsdk/emsdk" ]; then
  git clone --depth 1 --branch "$EMSDK_VERSION" \
    https://github.com/emscripten-core/emsdk.git "$DEPS_ROOT/emsdk"
  (cd "$DEPS_ROOT/emsdk" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")
fi
source "$DEPS_ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1

export CPATH="$TARGET/include"
export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"
export CFLAGS="-O2 -pthread -DWASM_BIGINT "
export CXXFLAGS="$CFLAGS"
export LDFLAGS=" -sWASM_BIGINT -sASYNCIFY=1 -L$TARGET/lib"

cat > "$SRCDIR/cross.meson" <<EOF
[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'

[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
pkgconfig = ['pkg-config', '--static']

[built-in options]
c_args = ['-O2', '-pthread', '-Wno-incompatible-function-pointer-types']
cpp_args = ['-O2', '-pthread', '-Wno-incompatible-function-pointer-types']
objc_args = ['-O2', '-pthread', '-Wno-incompatible-function-pointer-types']
c_link_args = ['', '-sWASM_BIGINT', '-sASYNCIFY=1', '-L$TARGET/lib']
cpp_link_args = ['', '-sWASM_BIGINT', '-sASYNCIFY=1', '-L$TARGET/lib']
EOF

# --- zlib ---
if [ ! -f "$TARGET/lib/libz.a" ]; then
  cd "$SRCDIR"
  curl -Ls "https://zlib.net/zlib-$ZLIB_VERSION.tar.xz" | tar xJ
  cd "zlib-$ZLIB_VERSION"
  emconfigure ./configure --prefix="$TARGET" --static
  emmake make install
fi

# --- libffi (headers only: qemu's wasm/TCI build links none of its code) ---
if [ ! -f "$TARGET/include/ffi.h" ]; then
  cd "$SRCDIR"
  rm -rf libffi
  git clone -q https://github.com/libffi/libffi
  cd libffi && git checkout -q "$LIBFFI_VERSION"
  autoreconf -fiv >/dev/null 2>&1
  emconfigure ./configure --host=wasm32-unknown-emscripten \
    --prefix="$TARGET" --enable-static --disable-shared --disable-dependency-tracking \
    --disable-builddir --disable-multi-os-directory --disable-raw-api --disable-docs
  emmake make install SUBDIRS='include'
fi

# --- libresolv stub (glib's res_query probe) ---
if [ ! -f "$TARGET/lib/libresolv.a" ]; then
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
fi

# --- pixman ---
if [ ! -f "$TARGET/lib/libpixman-1.a" ]; then
  cd "$SRCDIR"
  rm -rf pixman
  git clone -q https://gitlab.freedesktop.org/pixman/pixman
  cd pixman && git checkout -q "pixman-$PIXMAN_VERSION"
  meson setup _build --prefix="$TARGET" --cross-file="$SRCDIR/cross.meson" \
    --default-library=static --buildtype=release -Dtests=disabled -Ddemos=disabled
  meson install -C _build
  rm -f "$TARGET/lib/libpixman-1.so"*
fi

# --- glib ---
if [ ! -f "$TARGET/lib/libglib-2.0.a" ]; then
  cd "$SRCDIR"
  curl -Lks "https://download.gnome.org/sources/glib/${GLIB_VERSION%.*}/glib-$GLIB_VERSION.tar.xz" | tar xJ
  cd "glib-$GLIB_VERSION"
  CFLAGS="$CFLAGS -Wno-incompatible-function-pointer-types" \
  meson setup _build --prefix="$TARGET" --cross-file="$SRCDIR/cross.meson" \
    --default-library=static --buildtype=release --force-fallback-for=pcre2 \
    -Dselinux=disabled -Dxattr=false -Dlibmount=disabled -Dnls=disabled \
    -Dtests=false -Dsysprof=disabled -Dglib_debug=disabled -Dglib_assert=false -Dglib_checks=false
  sed -i -E "/#define HAVE_POSIX_SPAWN 1/d; /#define HAVE_PTHREAD_GETNAME_NP 1/d" ./_build/config.h
  meson install -C _build
fi

echo "=== wasm deps ready in $TARGET ==="
