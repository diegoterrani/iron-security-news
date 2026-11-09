# Imagem efêmera que publica os Cloudflare Workers a partir da VPS.
# O CLOUDFLARE_API_TOKEN só existe em /etc/ironnews/deploy.env (montado via env_file).
FROM node:22-alpine
RUN corepack enable
WORKDIR /repo
RUN chown node:node /repo
# Tudo como `node`: o wrangler precisa escrever em workers/*/.wrangler durante o deploy.
USER node
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile --filter "{./workers/*}..."
# Por padrão publica os dois Workers; para staging: WRANGLER_ENV=staging
CMD ["sh", "-c", "set -e; ENVARG=${WRANGLER_ENV:+--env $WRANGLER_ENV}; pnpm --filter @ironnews/edge-hooks exec wrangler deploy $ENVARG; pnpm --filter @ironnews/og-render exec wrangler deploy $ENVARG"]
