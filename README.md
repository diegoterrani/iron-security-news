# IRON CYBER NEWS

Plataforma interna da Iron Security que coleta notícias de cibersegurança, gera conteúdo PT-BR + EN com IA
(Claude Haiku 5.5), passa por revisão humana e publica no blog, Instagram, Facebook, LinkedIn e YouTube Shorts.

Arquitetura completa: [docs/ARQUITETURA-IRON-CYBER-NEWS.md](docs/ARQUITETURA-IRON-CYBER-NEWS.md)

## Estado atual — Fase 0 (fundação)
| Parte | Onde roda | Estado |
|---|---|---|
| `apps/web` — blog `/pt` `/en`, `/admin` (placeholder), `/api/health`, `/api/internal/revalidate` (HMAC) | Vercel | esqueleto |
| `apps/executor` — config validada, Postgres, `/health` interno, heartbeat, cron, fila pgmq, shutdown gracioso | VPS (Docker) | esqueleto |
| `workers/edge-hooks` — webhooks HeyGen e Meta com verificação de assinatura | Cloudflare | funcional |
| `workers/og-render` — HMAC + contrato; render ainda retorna 501 | Cloudflare | esqueleto |
| `supabase/` — schema, índices, RLS, filas, seed com 21 fontes | Supabase | validado em Postgres 16 + pgvector |
| `infra/vps`, `.github/workflows` — compose, deploy.sh, bootstrap.sh, CI/CD | VPS / GitHub | pronto, não executado |

## Desenvolvimento local
```bash
corepack enable            # usa o pnpm fixado em package.json
pnpm install
pnpm test                  # testes de shared, executor e edge-hooks
pnpm typecheck
pnpm --filter @ironnews/web dev        # http://localhost:3000
supabase start && supabase db reset    # banco local (requer Supabase CLI + Docker)
```
> Recomendação: clone o repositório fora do OneDrive (ex.: `C:\dev\ironnews`). O `node_modules` tem dezenas de
> milhares de arquivos e a sincronização do OneDrive deixa a instalação lenta e instável.

## Deploy sem GitHub Actions (`infra/vps/pipeline.sh`)
Contorno para quando o GitHub Actions estiver indisponível. Roda na VPS, como root, e faz o mesmo que
`ci.yml` + `deploy.yml`: CI em container → imagem do executor + Trivy → migrations pendentes (dry-run) →
**confirmação** → migrations + `deploy.sh` (executor e Workers). Nada muda em produção antes da confirmação.
O frontend continua com deploy automático pela Vercel.

```bash
/opt/ironnews/app/infra/vps/pipeline.sh                       # implanta origin/main
/opt/ironnews/app/infra/vps/pipeline.sh <sha> --skip-migrations   # rollback
```
Requer `/etc/ironnews/migrate.env` (root, 600) com `SUPABASE_DB_URL` (pooler em modo sessão, porta 5432).
Só aceita commits que estão na `main`.

## Estrutura
```
apps/web          Next.js 15 (Vercel)
apps/executor     Node 22 (VPS)
workers/*         Cloudflare Workers
packages/shared   tipos, schemas Zod, HMAC
supabase/         migrations + seed
infra/vps         docker-compose, deploy.sh, bootstrap.sh
docs/             documento de arquitetura
```
