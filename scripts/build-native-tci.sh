#!/bin/bash
# The native TCI build with TCG plugins on: scripts/build-native.sh tci
# -> $QEMU_NATIVE_TCI_BUILD/qemu-system-arm (default
# build/qemu-native-tci-build, scripts/build-dirs.sh)
exec bash "$(dirname "${BASH_SOURCE[0]}")/build-native.sh" tci "$@"
