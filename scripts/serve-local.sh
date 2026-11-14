# Sourced by gate.sh and run-tcg-isa.sh.
#
#   start_serve <root> <port>
#
# Starts <root>/serve.mjs over plain HTTP on <port> in the background, sets
# SRV to its pid (node itself, so killing SRV stops the server) and waits up
# to 30 s for it to answer. Returns 1 if it never does.
start_serve() {
  ( cd "$1" && PORT=$2 HTTPS=0 exec node serve.mjs >/dev/null 2>&1 ) &
  SRV=$!
  local _
  for _ in $(seq 300); do
    curl -sf "http://127.0.0.1:$2/" >/dev/null 2>&1 && return 0
    kill -0 "$SRV" 2>/dev/null || return 1
    sleep 0.1
  done
  return 1
}
