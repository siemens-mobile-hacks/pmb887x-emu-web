# The submodules are the pins: the commit the superproject's HEAD records
# for a submodule (its gitlink) is the revision a release builds. Sourced by
# the build scripts; expects WEB_DIR, the repository root.

# the commit HEAD's gitlink pins <path> at
submodule_pin() {
  git -C "$WEB_DIR" ls-tree HEAD "$1" | awk '$2 == "commit" { print $3 }'
}

# checks <path> out at its gitlink the first time; a checkout that exists is
# left as it is
submodule_init() {
  [ -e "$WEB_DIR/$1/.git" ] || git -C "$WEB_DIR" submodule update --init "$1"
}

# while developing: one line when <path> is not at its gitlink, the normal
# state between a commit in the submodule and the bump of its gitlink
submodule_warn_off_pin() {
  local head pin
  head="$(git -C "$WEB_DIR/$1" rev-parse HEAD)"
  pin="$(submodule_pin "$1")"
  [ "$head" = "$pin" ] ||
    echo "$(basename "$0"): warning: $1/ is at ${head:0:10}, its gitlink at ${pin:0:10}; building the checkout" >&2
}

# for a release: <path> must be exactly its gitlink, with nothing changed
submodule_require_pin() {
  local head pin
  submodule_init "$1"
  head="$(git -C "$WEB_DIR/$1" rev-parse HEAD)"
  pin="$(submodule_pin "$1")"
  if [ "$head" != "$pin" ]; then
    echo "$(basename "$0"): $1/ is at ${head:0:10}, but its gitlink pins ${pin:0:10};" \
         "commit the gitlink bump, or check the pin out with: git submodule update $1" >&2
    exit 1
  fi
  # explicit: status.showUntrackedFiles=no would hide a new source file
  if [ -n "$(git -C "$WEB_DIR/$1" status --porcelain --untracked-files=normal)" ]; then
    echo "$(basename "$0"): $1/ has local changes or untracked files (git -C $1 status); a release builds its gitlink only" >&2
    exit 1
  fi
}
