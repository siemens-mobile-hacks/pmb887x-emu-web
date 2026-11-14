#!/bin/bash
# The native TCI build with TCG plugins on: scripts/build-native.sh tci
# -> build/qemu-native-tci-build/qemu-system-arm
exec bash "$(dirname "${BASH_SOURCE[0]}")/build-native.sh" tci "$@"
