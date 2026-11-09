#!/usr/bin/env bash
# Pipeline local na VPS: contorno para quando o GitHub Actions estiver indisponível.
# Faz o mesmo que .github/workflows/ci.yml + deploy.yml, na ordem:
#   1) código   2) CI   3) imagem + Trivy   4) migrations (dry-run) + confirmação   5) migrations + deploy.sh
# Nada muda em produção antes da confirmação do passo 4.
#
# Uso (root na VPS):
#   pipeline.sh [ref] [--yes] [--skip-migrations] [--skip-scan]
#     ref                 commit/branch da main a implantar (padrão: origin/main)
#     --yes               não pergunta (uso não interativo)
#     --skip-migrations   não roda migrations (obrigatório em rollback para SHA anterior a uma migration)
#     --skip-scan         pula o Trivy (só em emergência)
# Rollback: pipeline.sh <sha-anterior> --skip-migrations
set -euo pipefail

REPO_URL=https://github.com/diegoterrani/iron-security-news.git
WORK=/var/lib/ironnews-pipeline
SRC=$WORK/src
APP=/opt/ironnews/app
MIGRATE_ENV=/etc/ironnews/migrate.env   # SUPABASE_DB_URL=postgresql://postgres.<ref>:<senha>@<pooler>:5432/postgres?sslmode=require
COMPOSE_ENV=/etc/ironnews/compose.env

NODE_IMG=node:22-alpine
SUPABASE_CLI=supabase@2.122.0
TRIVY_IMG=aquasec/trivy:0.76.1
GITLEAKS_IMG=zricethezav/gitleaks:v8.30.1

step()    { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()     { echo "erro: $*" >&2; exit 1; }
usage()   { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; }
confirm() {
  ((YES)) && return 0
  [[ -t 0 ]] || die "sem terminal para confirmar; use --yes"
  local r; read -rp "$1 [s/N] " r; [[ "$r" =~ ^[sS]$ ]]
}

REF=origin/main; YES=0; SKIP_MIG=0; SKIP_SCAN=0
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    --skip-migrations) SKIP_MIG=1 ;;
    --skip-scan) SKIP_SCAN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "opção desconhecida: $a" ;;
    *) REF=$a ;;
  esac
done

[[ $EUID -eq 0 ]] || die "rode como root"
install -d -m 700 "$WORK"
exec 8>"$WORK/pipeline.lock"
flock -n 8 || die "outro pipeline em andamento"

# ---------------------------------------------------------------------------
step "1/5 código"
[[ -d "$SRC/.git" ]] || git clone -q "$REPO_URL" "$SRC"
git -C "$SRC" fetch -q --prune origin
SHA=$(git -C "$SRC" rev-parse --verify "$REF^{commit}")
# Mesma regra do ambiente `production` no GitHub: só commits da main vão para produção.
git -C "$SRC" merge-base --is-ancestor "$SHA" origin/main || die "$SHA não está na main"
git -C "$SRC" checkout -q --force "$SHA"
git -C "$SRC" clean -qfdx
DEPLOYED=$(cat /opt/ironnews/DEPLOYED_SHA 2>/dev/null || echo "?")
echo "alvo:        $SHA  $(git -C "$SRC" log -1 --format=%s "$SHA")"
echo "em produção: $DEPLOYED"

# ---------------------------------------------------------------------------
step "2/5 CI: typecheck, testes, build, audit, gitleaks"
docker run --rm -v "$SRC":/repo -v ironnews-pnpm-store:/pnpm-store -w /repo \
  -e CI=1 -e TURBO_TELEMETRY_DISABLED=1 -e npm_config_store_dir=/pnpm-store \
  "$NODE_IMG" sh -ec '
    corepack enable >/dev/null 2>&1
    pnpm install --frozen-lockfile --reporter=silent
    pnpm turbo run typecheck test build --output-logs=errors-only
    pnpm audit --prod --audit-level high'
docker run --rm -v "$SRC":/repo:ro "$GITLEAKS_IMG" detect --source /repo --no-banner --redact

# ---------------------------------------------------------------------------
step "3/5 imagem do executor"
GHCR_OWNER=$(sed -n 's/^GHCR_OWNER=//p' "$COMPOSE_ENV")
[[ -n "$GHCR_OWNER" ]] || die "GHCR_OWNER ausente em $COMPOSE_ENV"
IMG="ghcr.io/$GHCR_OWNER/ironnews-executor:$SHA"
docker build -q -f "$SRC/apps/executor/Dockerfile" --build-arg GIT_SHA="$SHA" -t "$IMG" "$SRC"
if ((SKIP_SCAN)); then
  echo "Trivy pulado (--skip-scan)"
else
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v ironnews-trivy-cache:/root/.cache \
    "$TRIVY_IMG" image --quiet --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 "$IMG"
fi

# ---------------------------------------------------------------------------
step "4/5 migrations pendentes"
supa() {
  docker run --rm -v "$SRC":/repo -v ironnews-npm-cache:/root/.npm -w /repo --env-file "$MIGRATE_ENV" \
    -e npm_config_update_notifier=false "$NODE_IMG" \
    sh -c "npx --yes $SUPABASE_CLI db push --db-url \"\$SUPABASE_DB_URL\" $*"
}
PENDING=0
if ((SKIP_MIG)); then
  echo "puladas (--skip-migrations)"
else
  [[ -r "$MIGRATE_ENV" ]] || die "$MIGRATE_ENV ausente"
  out=$(supa --dry-run 2>&1) || { echo "$out"; die "dry-run das migrations falhou"; }
  echo "$out"
  grep -qi "up to date" <<<"$out" || PENDING=1
fi

echo
echo "Resumo: implantar $SHA (executor + Workers)$( ((PENDING)) && echo ' e APLICAR as migrations acima no Supabase de produção')."
confirm "Confirmar?" || die "cancelado; nada foi alterado em produção"

# ---------------------------------------------------------------------------
step "5/5 deploy"
if ((PENDING)); then
  supa --yes
fi
# Atualiza o checkout de deploy para que o deploy.sh executado seja o da versão alvo.
su -s /bin/bash ironnews -c "git -C '$APP' fetch -q origin && git -C '$APP' checkout -q --force '$SHA'"
su -s /bin/bash ironnews -c "'$APP/infra/vps/deploy.sh' '$SHA'"

echo
echo "ok: $SHA em produção. Rollback: $0 $DEPLOYED --skip-migrations"
