#!/bin/sh
# LAN mode (docker-compose.lan.yml sets LAN_TLS=1): https on port 443 with a
# self-signed certificate, so browsers on other machines get a secure context
# and with it cross-origin isolation.  The certificate lives on a volume and
# is only regenerated when LAN_HOSTS changes, so browsers keep their exception.
# Run by the nginx image's entrypoint from /docker-entrypoint.d.
set -eu

conf=/etc/nginx/lan-tls/listen.conf
dir=/etc/nginx/lan-cert

if [ "${LAN_TLS:-0}" != 1 ]; then
    rm -f "$conf"
    exit 0
fi

san="DNS:localhost,IP:127.0.0.1"
for h in $(echo "${LAN_HOSTS:-}" | tr ',' ' '); do
    case $h in
        *:*) san="$san,IP:$h" ;;
        *[!0-9.]*) san="$san,DNS:$h" ;;
        *) san="$san,IP:$h" ;;
    esac
done

mkdir -p "$dir"
if [ ! -s "$dir/cert.pem" ] || [ ! -s "$dir/key.pem" ] || [ "$(cat "$dir/san" 2>/dev/null)" != "$san" ]; then
    echo "$0: generating a self-signed certificate for $san"
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj /CN=pmb887x-web \
        -addext "subjectAltName=$san" -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null
    echo "$san" > "$dir/san"
fi

cat > "$conf" <<EOF
listen 443 ssl;
ssl_certificate $dir/cert.pem;
ssl_certificate_key $dir/key.pem;
# the published port differs from 443, so redirects must not name one
absolute_redirect off;
EOF
echo "$0: https on 443, certificate $(openssl x509 -in "$dir/cert.pem" -noout -fingerprint -sha256)"
