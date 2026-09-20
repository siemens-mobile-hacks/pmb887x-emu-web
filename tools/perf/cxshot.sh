#!/bin/bash
# boot CX70 with $1 binary, screendump at intervals to /tmp/cxshot-$2-*.ppm
QEMU="$1"; TAG="$2"; SECS="${3:-120}"
export BOARD=siemens-cx70 MONITOR=unix:/tmp/cxmon-$2.sock SERIAL=/tmp/cxser-$2.log DISPLAY_MODE=none RW=0
rm -f /tmp/cxmon-$2.sock
setsid nohup scripts/run-native.sh fullflashes/CX70_FW56_clean.bin -plugin file=/workspace/tests/insncount.so,count=/tmp/cxins-$2.txt > /tmp/cxout-$2.log 2>&1 &
for i in $(seq 1 $((SECS * 10))); do [ -S /tmp/cxmon-$2.sock ] && break; sleep 0.1; done
sleep 5
for t in 15 30 45 60 90 120; do
  [ $t -gt $SECS ] && break
  while [ $SECONDS -lt $t ]; do sleep 1; done
  echo "screendump /tmp/cxshot-$2-$t.ppm" | socat - unix-connect:/tmp/cxmon-$2.sock >/dev/null 2>&1 || \
    echo "screendump /tmp/cxshot-$2-$t.ppm" | nc -U /tmp/cxmon-$2.sock >/dev/null 2>&1
  sleep 1
done
echo "info registers" | socat - unix-connect:/tmp/cxmon-$2.sock 2>/dev/null | grep -m1 R15 || true
tail -c 300 /tmp/cxser-$2.log | tr -d '\0' | tail -3
kill -TERM -$(ps -o pgid= -C qemu-system-arm | tr -d ' ') 2>/dev/null
