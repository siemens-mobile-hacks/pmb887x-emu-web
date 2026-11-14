# Sourced by gate.sh and run-tcg-isa.sh.
#
#   start_serve <root> <port>
#
# Starts <root>/serve.mjs over plain HTTP on <port> in the background, sets
# SRV to its pid (node itself, so killing SRV stops the server) and waits up
# to 30 s for it to answer. Returns 1, with SRV empty and nothing left
# running, if the port already answers, the server exits, or it never
# answers: a server that is not this one's own would outlive the caller and
# be tested in its place.
start_serve() {
  SRV=""
  if curl -sf "http://127.0.0.1:$2/" >/dev/null 2>&1; then
    echo "start_serve: port $2 already answers; not starting serve.mjs there" >&2
    return 1
  fi
  ( cd "$1" && PORT=$2 HTTPS=0 exec node serve.mjs >/dev/null 2>&1 ) &
  SRV=$!
  local _
  for _ in $(seq 300); do
    if ! kill -0 "$SRV" 2>/dev/null; then
      echo "start_serve: serve.mjs on $2 exited" >&2
      SRV=""
      return 1
    fi
    # The probe alone can be answered by a server that took the port after
    # the check above, before this one died of EADDRINUSE.
    curl -sf "http://127.0.0.1:$2/" >/dev/null 2>&1 && _listens "$SRV" "$2" && return 0
    sleep 0.1
  done
  echo "start_serve: serve.mjs is not answering on $2" >&2
  kill "$SRV" 2>/dev/null
  SRV=""
  return 1
}

# does <pid> hold the listening TCP socket on <port>?
_listens() {
  local inode fd
  for inode in $(awk -v p="$(printf ':%04X' "$2")" \
      '$4 == "0A" && substr($2, length($2) - 4) == p { print $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null); do
    for fd in /proc/"$1"/fd/*; do
      [ "$(readlink "$fd" 2>/dev/null)" = "socket:[$inode]" ] && return 0
    done
  done
  return 1
}
