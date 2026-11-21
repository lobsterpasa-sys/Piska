#!/usr/bin/env bash
# Самоподписанный сертификат для узла и его отпечаток (pinSHA256) для настроек Hub.
#   ./make-cert.sh fra.hub.example.com [/etc/hysteria]
set -euo pipefail
NAME="${1:?Укажите имя узла, например fra.hub.example.com}"
DIR="${2:-/etc/hysteria}"
mkdir -p "$DIR"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" -subj "/CN=$NAME" -addext "subjectAltName=DNS:$NAME" 2>/dev/null
chmod 600 "$DIR/key.pem"
PIN=$(openssl x509 -in "$DIR/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)
echo "Сертификат: $DIR/cert.pem"
echo "pinSHA256:  $PIN"
echo
echo "Добавьте в BOOST_NODES этого узла:"
echo "  \"hy2\": { \"port\": 443, \"sni\": \"$NAME\", \"pinSHA256\": \"$PIN\" }"
