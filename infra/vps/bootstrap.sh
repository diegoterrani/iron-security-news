#!/usr/bin/env bash
# Provisionamento idempotente do IRON CYBER NEWS na VPS (rodar como root).
# NÃO altera SSH, nginx nem outros sistemas da VPS. Docker já existe na VPS.
#   uso: bootstrap.sh <git-repo-url> [<deploy-public-key>]
set -euo pipefail

REPO_URL="${1:?informe a URL do repositório git}"
DEPLOY_PUBKEY="${2:-}"

# 1) Usuário de serviço sem senha e sem sudo
if ! id ironnews >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /opt/ironnews --shell /bin/bash ironnews
  passwd -l ironnews >/dev/null
fi
# Grupo docker é equivalente a root no host: mitigado pela chave restrita a deploy.sh (passo 3).
usermod -aG docker ironnews
chown ironnews:ironnews /opt/ironnews
chmod 750 /opt/ironnews

# 2) Diretório de secrets (root escreve, ironnews lê)
install -d -o root -g ironnews -m 750 /etc/ironnews
for f in executor.env executor-staging.env deploy.env compose.env; do
  [[ -e /etc/ironnews/$f ]] || install -o root -g ironnews -m 640 /dev/null /etc/ironnews/$f
done

# 3) Chave de deploy do GitHub Actions, restrita ao script de deploy
if [[ -n "$DEPLOY_PUBKEY" ]]; then
  install -d -o ironnews -g ironnews -m 700 /opt/ironnews/.ssh
  echo "command=\"/opt/ironnews/app/infra/vps/deploy.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $DEPLOY_PUBKEY" \
    > /opt/ironnews/.ssh/authorized_keys
  chown ironnews:ironnews /opt/ironnews/.ssh/authorized_keys
  chmod 600 /opt/ironnews/.ssh/authorized_keys
fi

# 4) Código
if [[ ! -d /opt/ironnews/app/.git ]]; then
  sudo -u ironnews git clone --depth 1 "$REPO_URL" /opt/ironnews/app
fi

echo "OK. Próximos passos:"
echo " - preencher /etc/ironnews/*.env (ver docs §10.2); compose.env precisa de GHCR_OWNER=<org>"
echo " - sudo -u ironnews docker login ghcr.io (token read:packages)"
echo " - primeiro deploy: sudo -u ironnews /opt/ironnews/app/infra/vps/deploy.sh <sha>"
