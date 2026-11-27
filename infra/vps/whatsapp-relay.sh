#!/usr/bin/env bash
# Envia ao grupo do WhatsApp as stories pedidas no painel (review_publish_whatsapp) e os textos prontos
# agendados pela automação do Plantão Cyber (automation_whatsapp_group_create; só texto, sem --media).
# Roda como root, pelo timer systemd ironnews-whatsapp-relay (instalado por whatsapp-relay-install.sh).
#
# Por que fora do container: o gateway do OpenClaw (dono da sessão do WhatsApp) só escuta em loopback
# na VPS. O executor monta capa + legenda e registra o resultado; este script só chama o gateway.
#
# Config em /etc/ironnews/whatsapp-relay.env (root 600):
#   WA_GROUP_JID=1203...@g.us   grupo de destino
#   WA_ACCOUNT=admin            conta do OpenClaw que envia
#   EXECUTOR_CONTAINER=ironnews-executor-1   (opcional)
set -euo pipefail

: "${WA_GROUP_JID:?defina WA_GROUP_JID em /etc/ironnews/whatsapp-relay.env}"
[[ "$WA_GROUP_JID" =~ ^[0-9-]+@g\.us$ ]] || { echo "WA_GROUP_JID inválido: $WA_GROUP_JID" >&2; exit 2; }
WA_ACCOUNT="${WA_ACCOUNT:-admin}"
CONTAINER="${EXECUTOR_CONTAINER:-ironnews-executor-1}"
OC_PATH=/home/openclaw/.npm-global/bin:/home/openclaw/.local/node/bin:/usr/local/bin:/usr/bin:/bin

cli() { docker exec "$CONTAINER" node dist/whatsapp-relay.js "$@"; }

# Até 5 por rodada (o teto diário fica no banco); a fila costuma ter 0 ou 1.
for _ in 1 2 3 4 5; do
  job="$(cli claim)"
  id="$(jq -r '.id // empty' <<<"$job")"
  [[ -n "$id" ]] || exit 0
  caption="$(jq -r '.caption' <<<"$job")"
  media="$(jq -r '.mediaUrl // empty' <<<"$job")"
  # Só story do blog leva imagem; texto pronto vai sem --media (o WhatsApp monta a prévia do link).
  media_args=()
  [[ -n "$media" ]] && media_args=(--media "$media")

  # runuser (e não sudo): não grava a linha de comando no auth.log. Sem segredos no argv: o token do
  # gateway vem do openclaw.json do próprio usuário openclaw.
  if out="$(runuser -u openclaw -- env HOME=/home/openclaw PATH="$OC_PATH" \
      openclaw message send --channel whatsapp --account "$WA_ACCOUNT" --target "$WA_GROUP_JID" \
      --message "$caption" "${media_args[@]}" --json 2>&1)"; then
    msg_id="$(jq -r '[.. | objects | (.messageId? // .id?) | strings] | first // empty' <<<"$out" 2>/dev/null || true)"
    cli done "$id" ${msg_id:+"$msg_id"}
    echo "enviado: $id ${msg_id:-}"
  else
    err="$(jq -r '.error.message? // empty' <<<"$out" 2>/dev/null || true)"
    cli fail "$id" "${err:-$(tail -c 400 <<<"$out")}"
    echo "falhou: $id ${err:-}" >&2
  fi
done
