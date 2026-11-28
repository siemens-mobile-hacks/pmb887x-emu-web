#!/bin/sh
# The container's environment (README.md) as relay.py's flags. Arguments
# given to the container are appended, so any other flag can be added.
#
# Only the WebSocket listens (--port 0: no raw TCP port for phones). State
# goes to the volume; the log goes to stdout only (docker logs).
set -eu
exec python3 /opt/gsmrelay/smsrelay/relay.py \
	--port 0 \
	--ws-port 0.0.0.0:4726 \
	--ws-origins "${GSMRELAY_ORIGINS:-${GSMRELAY_PAGE_ORIGIN:-}}" \
	--trusted-proxies "${GSMRELAY_TRUSTED_PROXIES:-0}" \
	--max-phones "${GSMRELAY_MAX_PHONES:-64}" \
	--per-ip "${GSMRELAY_PER_IP:-8}" \
	--balances /var/lib/gsmrelay/balances.json \
	--numbers /var/lib/gsmrelay/numbers.json \
	--log "" \
	"$@" </dev/null
