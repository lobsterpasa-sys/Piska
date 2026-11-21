#!/usr/bin/env bash
# Установка узла Hub Boost на чистый сервер Ubuntu/Debian (запуск от root).
#   HUB_URL=https://hub.example.com NODE_NAME=fra.hub.example.com HUB_SECRET=… ./install.sh
# Ставит: Hysteria 2 (бинарник собирается из исходников Go) и UDP-ретранслятор Hub (Node.js).
set -euo pipefail
: "${HUB_URL:?Укажите HUB_URL — адрес сервера Hub}"
: "${NODE_NAME:?Укажите NODE_NAME — имя узла (домен или любое имя для сертификата)}"
: "${HUB_SECRET:?Укажите HUB_SECRET — тот же, что на сервере Hub}"
HY_VERSION="${HY_VERSION:-v2.13.0}"
HERE="$(cd "$(dirname "$0")" && pwd)"

apt-get update -y && apt-get install -y golang-go nodejs openssl
# Сборка Hysteria из исходников (через зеркало модулей Go).
WORK="$(mktemp -d)"
export GOPATH="$WORK/go" GOFLAGS=-mod=mod GOTOOLCHAIN=auto
for m in app core extras; do
  D=$(go mod download -json "github.com/apernet/hysteria/$m/v2@$HY_VERSION" | grep '"Dir"' | cut -d'"' -f4)
  cp -r "$D" "$WORK/$m" && chmod -R u+w "$WORK/$m"
done
(cd "$WORK/app" && go build -trimpath -ldflags "-s -w" -o /usr/local/bin/hysteria .)

mkdir -p /etc/hysteria
"$HERE/make-cert.sh" "$NODE_NAME" /etc/hysteria
sed "s#https://hub.example.com#$HUB_URL#" "$HERE/config.example.yaml" > /etc/hysteria/config.yaml

cat > /etc/systemd/system/hysteria.service <<UNIT
[Unit]
Description=Hub Boost — Hysteria 2
After=network-online.target
[Service]
ExecStart=/usr/local/bin/hysteria server -c /etc/hysteria/config.yaml
Restart=always
DynamicUser=yes
AmbientCapabilities=CAP_NET_BIND_SERVICE
LoadCredential=cert.pem:/etc/hysteria/cert.pem
LoadCredential=key.pem:/etc/hysteria/key.pem
[Install]
WantedBy=multi-user.target
UNIT
sed -i "s#/etc/hysteria/cert.pem#/run/credentials/hysteria.service/cert.pem#; s#/etc/hysteria/key.pem#/run/credentials/hysteria.service/key.pem#" /etc/hysteria/config.yaml

cat > /etc/systemd/system/hub-relay.service <<UNIT
[Unit]
Description=Hub Boost — UDP-ретранслятор
After=network-online.target
[Service]
Environment=RELAY_SECRET=$HUB_SECRET
Environment=RELAY_PORT=40000
ExecStart=/usr/bin/node $(cd "$HERE/../.." && pwd)/server/src/boost/relay-main.js
Restart=always
DynamicUser=yes
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now hysteria hub-relay
echo "Готово. Откройте в файрволе UDP 443 (Hysteria) и UDP 40000 (ретранслятор)."
