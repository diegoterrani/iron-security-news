# Build a partir da RAIZ do monorepo:  docker build -f apps/executor/Dockerfile .
# TODO(produção): fixar as imagens base por digest (node:22-alpine@sha256:…).
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @ironnews/executor build \
 && pnpm --filter @ironnews/executor deploy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/executor/dist ./dist
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]
