#!/usr/bin/env bash
# Chamado pelo GitHub Actions via SSH como usuário `ironnews`.
# A chave de deploy tem command="…/deploy.sh" forçado: o SHA chega em $SSH_ORIGINAL_COMMAND.
set -euo pipefail

SHA="${SSH_ORIGINAL_COMMAND:-${1:-}}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "uso: deploy.sh <git-sha-40>" >&2; exit 1; }

APP=/opt/ironnews/app
COMPOSE=(docker compose -f "$APP/infra/vps/docker-compose.yml" --env-file /etc/ironnews/compose.env)
LOCK=/opt/ironnews/deploy.lock

exec 9>"$LOCK"
flock -n 9 || { echo "outro deploy em andamento" >&2; exit 1; }

cd "$APP"
git fetch --quiet --depth 1 origin "$SHA"
git checkout --quiet --force "$SHA"

export IMAGE_TAG="$SHA"
# Imagem já presente (construída pelo pipeline.sh na própria VPS): não depende do GHCR.
IMG=$("${COMPOSE[@]}" config --images executor)
docker image inspect "$IMG" >/dev/null 2>&1 || "${COMPOSE[@]}" pull executor
"${COMPOSE[@]}" up -d executor

# Workers: wrangler roda aqui porque o token Cloudflare só existe na VPS.
# Sem token em deploy.env, pula os Workers em vez de falhar o deploy do executor.
if grep -qE '^CLOUDFLARE_API_TOKEN=.+' /etc/ironnews/deploy.env 2>/dev/null; then
  "${COMPOSE[@]}" --profile deploy build deploy
  "${COMPOSE[@]}" --profile deploy run --rm deploy
else
  echo "aviso: CLOUDFLARE_API_TOKEN ausente em /etc/ironnews/deploy.env; Workers não publicados" >&2
fi

# Smoke test: espera o healthcheck do container ficar healthy (até 2 min).
for _ in $(seq 1 24); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q executor)" 2>/dev/null || echo unknown)
  [[ "$status" == "healthy" ]] && { echo "$SHA" > /opt/ironnews/DEPLOYED_SHA; echo "deploy ok: $SHA"; exit 0; }
  sleep 5
done
echo "executor não ficou healthy (status=$status)" >&2
"${COMPOSE[@]}" logs --tail 50 executor >&2
exit 1
