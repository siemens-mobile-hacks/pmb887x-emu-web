#!/bin/bash
# Print the identity of the qemu source a build comes from: its HEAD commit,
# plus a hash of the uncommitted diff and the untracked files when the tree
# has any.
#
#   scripts/qemu-source-id.sh <qemu source dir | meson build dir>
#
# A build dir is resolved to the source it was configured from.  The wasm
# deploys write this into the dist (qemu-source.txt), and
# tools/lockstep-wasm.mjs compares it with the native reference's source:
# a reference built from other code diverges on every guest-timing change —
# or agrees with code the dist no longer has.
set -euo pipefail

DIR="${1:?usage: $0 <qemu source dir | meson build dir>}"
INFO="$DIR/meson-info/meson-info.json"
if [ -f "$INFO" ]; then
  DIR="$(sed -nE 's/.*"source": *"([^"]*)".*/\1/p' "$INFO")"
fi

HEAD="$(git -C "$DIR" rev-parse HEAD)"
# a new source file not yet added changes the build as much as an edit
UNTRACKED="$(git -C "$DIR" ls-files --others --exclude-standard)"
if git -C "$DIR" diff --quiet HEAD && [ -z "$UNTRACKED" ]; then
  echo "$HEAD"
else
  echo "$HEAD+$( {
    git -C "$DIR" diff --binary HEAD
    if [ -n "$UNTRACKED" ]; then
      git -C "$DIR" ls-files --others --exclude-standard -z | (cd "$DIR" && xargs -0 sha1sum)
    fi
  } | sha1sum | cut -c1-12)"
fi
