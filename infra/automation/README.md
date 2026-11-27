# Automação: vídeo no perfil do LinkedIn

Permite que o agendamento diário do **Plantão Cyber 18h** (que roda na nuvem, sem navegador e sem MFA) agende o
episódio do dia no **perfil** do LinkedIn pela mesma fila da tela **Campanhas** (`campaign_posts`). O executor
publica na hora marcada com o token já conectado em Integrações, como qualquer campanha.

## Escopo (de propósito, mínimo)

- Só **vídeo MP4**, só **LinkedIn**, só **perfil** (`target = member`). Página da empresa, Instagram, PDF e
  imagem continuam só pelo painel.
- Horário entre agora e **7 dias**. Vídeo até **500 MB**, `video/mp4`.
- Arquivos em `media/campanhas/auto/<uuid>/video.mp4`, caminho gerado pelo servidor.
- A mesma `dedupe_key` nunca agenda duas vezes (reenvio devolve `duplicate: true`).
- Se esses segredos vazarem, o pior caso é alguém agendar um vídeo no perfil. Para cortar na hora:
  `AUTOMATION_API_ENABLED=false` na Vercel e redeploy, ou trocar o `AUTOMATION_TOKEN`.

## Rotas

| Rota | Faz |
|---|---|
| `POST /api/automation/v1/uploads` | Corpo `{}`. Devolve `{ path, signed_url }`: URL de upload assinada do Storage (2 h, sem sobrescrever). |
| `POST /api/automation/v1/linkedin-video` | Corpo `{ campaign, caption, media_path, scheduled_for, dedupe_key, first_comment? }`. Chama a RPC `automation_linkedin_video_create`. |

Cabeçalhos (mesmo contrato da API do agente, com segredos próprios):

```
Authorization: Bearer <AUTOMATION_TOKEN>
X-Automation-Timestamp: <unix ms>            # janela de 5 min
X-Automation-Signature: hex(HMAC-SHA256(AUTOMATION_HMAC_SECRET, `${ts}.POST.${path}.${body}`))
```

Limite: 10 chamadas por minuto. Cada chamada entra em `agent_audit_log` (`automation.upload` e
`automation.linkedin_video`, sem a legenda) e o agendamento em `audit_log` com `via = automation`.

## Configuração (Vercel, projeto do News, ambiente Production)

| Variável | Valor |
|---|---|
| `AUTOMATION_API_ENABLED` | `true` |
| `AUTOMATION_TOKEN` | `openssl rand -hex 32` (diferente do `AGENT_ADMIN_TOKEN`) |
| `AUTOMATION_HMAC_SECRET` | `openssl rand -hex 32` (diferente do `AGENT_HMAC_SECRET` e do token) |
| `AUTOMATION_ACTOR` | `profiles.id` do admin em nome de quem a automação agenda |

A rota recusa a configuração (503) se faltar algo, se token e segredo forem iguais ou se repetirem os do agente.
O admin é conferido no banco a cada chamada: tirar o papel `admin` corta a automação.

O cliente (quem agenda) recebe só `AUTOMATION_TOKEN`, `AUTOMATION_HMAC_SECRET` e, se precisar,
`NEWS_AUTOMATION_URL` (padrão `https://news.iron-security.com`). A rede dele precisa alcançar o site do News e o
host do Supabase do projeto (a URL assinada aponta para lá).

## Cliente

`agendar-linkedin-video.mjs` (Node 22, sem dependências):

```bash
node infra/automation/agendar-linkedin-video.mjs \
  --video plantao-cyber-2026-11-28-16x9.mp4 \
  --legenda legenda-linkedin.txt \
  --quando 2026-11-28T18:00:00-03:00 \
  --chave plantao-2026-11-28-linkedin
# → {"id":"…","status":"pending","scheduled_for":"…","duplicate":false}
```

Acompanhar e cancelar: tela **Campanhas** do painel.

## Implantar e desfazer

1. Merge (depende do PR das Campanhas, migration `20261126000002`).
2. `bash /opt/ironnews/app/infra/vps/pipeline.sh` como root na VPS (aplica `20261127000001_campaign_automation.sql`).
3. Variáveis acima na Vercel e redeploy.

Desfazer: `AUTOMATION_API_ENABLED=false` + redeploy. Posts já agendados ficam na tela Campanhas e podem ser
cancelados lá. A migration só acrescenta uma coluna opcional, um índice e uma função; não altera dados.
