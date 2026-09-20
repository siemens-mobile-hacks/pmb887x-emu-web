#!/bin/bash
exec valgrind --tool=callgrind --callgrind-out-file="$CGOUT" "$QEMU_REAL" "$@"
