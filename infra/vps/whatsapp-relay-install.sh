#!/usr/bin/env bash
# Instala (ou atualiza) o envio ao grupo do WhatsApp na VPS. Idempotente; rodar como root:
#   infra/vps/whatsapp-relay-install.sh 1203...@g.us [conta-openclaw]
# Copia o script para /usr/local/sbin (root): o timer roda como root e não pode executar arquivo do
# checkout, que pertence ao usuário ironnews.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "rode como root" >&2; exit 1; }

JID="${1:?informe o ID do grupo (…@g.us)}"
ACCOUNT="${2:-admin}"
[[ "$JID" =~ ^[0-9-]+@g\.us$ ]] || { echo "ID de grupo inválido: $JID" >&2; exit 2; }
[[ "$ACCOUNT" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "conta inválida: $ACCOUNT" >&2; exit 2; }
command -v jq >/dev/null || { echo "instale o jq" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
install -o root -g root -m 755 "$HERE/whatsapp-relay.sh" /usr/local/sbin/ironnews-whatsapp-relay

install -o root -g root -m 600 /dev/null /etc/ironnews/whatsapp-relay.env.tmp
printf 'WA_GROUP_JID=%s\nWA_ACCOUNT=%s\n' "$JID" "$ACCOUNT" > /etc/ironnews/whatsapp-relay.env.tmp
mv /etc/ironnews/whatsapp-relay.env.tmp /etc/ironnews/whatsapp-relay.env

cat > /etc/systemd/system/ironnews-whatsapp-relay.service <<'EOF'
[Unit]
Description=Iron Cyber News: envia ao grupo do WhatsApp as stories pedidas no painel
After=docker.service openclaw-gateway.service
Requires=docker.service

[Service]
Type=oneshot
EnvironmentFile=/etc/ironnews/whatsapp-relay.env
ExecStart=/usr/local/sbin/ironnews-whatsapp-relay
TimeoutStartSec=300
EOF

cat > /etc/systemd/system/ironnews-whatsapp-relay.timer <<'EOF'
[Unit]
Description=Iron Cyber News: fila do grupo do WhatsApp a cada 30 s

[Timer]
OnBootSec=1min
OnUnitActiveSec=30s
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now ironnews-whatsapp-relay.timer
systemctl list-timers ironnews-whatsapp-relay.timer --no-pager
