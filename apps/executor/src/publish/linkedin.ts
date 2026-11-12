import { decryptToken, encryptToken, TokenCryptoError } from "@ironnews/shared";
import type { Pool } from "../db";
import type { Logger } from "../logger";
import type { StorageConfig } from "../render/storage";
import { refreshStoryStatus } from "./instagram";
import { AUTHOR_RE, LiApiError, buildCommentary, createPost, refreshAccessToken, scrub, uploadImage, type LiApiDeps } from "./linkedin-api";

export type LinkedinTarget = "member" | "organization";

export interface LinkedinPublishDeps {
  pool: Pool;
  log: Logger;
  storage: StorageConfig;
  tokenKey: string;
  dryRun: boolean;
  api: LiApiDeps;
  fetchImpl?: typeof fetch;
}

interface ClaimedPost {
  id: string;
  story_id: string;
  lang: "pt" | "en";
  target: LinkedinTarget;
  attempts: number;
  integration_id: string | null;
}

/** Mesmo contexto (AAD) que o painel usa ao cifrar (apps/web/lib/integrations/linkedin.ts → tokenContext). */
export const tokenContext = (target: LinkedinTarget, accountId: string, kind: "access" | "refresh" = "access") =>
  `linkedin${kind === "refresh" ? "-refresh" : ""}:${target}:${accountId}`;

const STUCK_MINUTES = 15;
const MAX_RATE_LIMIT_RETRIES = 3;
const WHERE: Record<LinkedinTarget, string> = { member: "no perfil", organization: "na página" };

/**
 * Publica no LinkedIn os channel_posts pedidos pelo painel (perfil e/ou página). Roda a cada minuto.
 * Mesmas garantias do Instagram: reserva com SKIP LOCKED (nunca dois executores no mesmo post),
 * post preso em "publishing" vira "failed" sem repetir sozinho (evita post duplicado) e o token só
 * existe decifrado em memória, dentro desta função.
 */
export async function publishDueLinkedinPosts(deps: LinkedinPublishDeps): Promise<number> {
  const { pool, log } = deps;
  await pool.query(
    `update channel_posts set status = 'failed',
            last_error = 'Publicação interrompida. Confira no LinkedIn se o post saiu antes de tentar de novo.'
      where channel = 'linkedin' and status = 'publishing' and updated_at < now() - make_interval(mins => $1)`,
    [STUCK_MINUTES],
  );
  const { rows: posts } = await pool.query<ClaimedPost>(
    `update channel_posts cp set status = 'publishing', attempts = cp.attempts + 1
      where cp.id in (select id from channel_posts
                       where channel = 'linkedin' and status = 'pending' and scheduled_for <= now()
                       order by scheduled_for limit 3 for update skip locked)
      returning cp.id, cp.story_id, cp.lang::text as lang, cp.target, cp.attempts, cp.integration_id`,
  );
  let published = 0;
  for (const p of posts) {
    try {
      const result = await publishOne(deps, p);
      if (result === "dry-run") {
        await pool.query(
          "update channel_posts set status = 'skipped', last_error = 'Modo de teste (PUBLISH_DRY_RUN=1): nada foi publicado.' where id = $1",
          [p.id],
        );
        log.info({ module: "publish", channel: "linkedin", target: p.target, post: p.id }, "linkedin dry-run");
      } else {
        await pool.query(
          `update channel_posts set status = 'published', published_at = now(), external_id = $2, external_url = $3, last_error = null
            where id = $1`,
          [p.id, result.postUrn, result.url],
        );
        await pool.query(
          "insert into audit_log (actor, action, entity, entity_id, diff) values (null, 'post.published', 'story', $1, $2)",
          [p.story_id, JSON.stringify({ channel: "linkedin", target: p.target, lang: p.lang, post_urn: result.postUrn })],
        );
        published++;
        log.info({ module: "publish", channel: "linkedin", target: p.target, post: p.id, urn: result.postUrn }, "linkedin published");
      }
    } catch (err) {
      await handleFailure(deps, p, err);
    }
    await refreshStoryStatus(pool, p.story_id);
  }
  return published;
}

class PublishError extends Error {}

async function publishOne(deps: LinkedinPublishDeps, p: ClaimedPost): Promise<"dry-run" | { postUrn: string; url: string }> {
  const { pool } = deps;
  const { rows: [integ] } = await pool.query<{ account_id: string; access_token_enc: Buffer; status: string; expires_at: Date | null; target: string }>(
    "select account_id, access_token_enc, status, expires_at, target from integrations where id = $1 and channel = 'linkedin'",
    [p.integration_id],
  );
  if (!integ || integ.target !== p.target || integ.status !== "active" || (integ.expires_at && integ.expires_at <= new Date())) {
    throw new PublishError(`A conta do LinkedIn ${WHERE[p.target]} não está conectada ou o token venceu. Reconecte em Integrações.`);
  }
  if (!AUTHOR_RE.test(integ.account_id)) throw new PublishError("Conta do LinkedIn com identificador inválido. Reconecte em Integrações.");

  const { rows: [content] } = await pool.query<{ title: string | null; body: Record<string, unknown> }>(
    "select title, body from latest_contents where story_id = $1 and channel = 'linkedin' and lang = $2 and kind = 'post'",
    [p.story_id, p.lang],
  );
  if (!content || typeof content.body.text !== "string" || !content.body.text.trim()) throw new PublishError("Texto do LinkedIn não encontrado.");
  const { rows: [article] } = await pool.query<{ title: string | null }>(
    "select title from latest_contents where story_id = $1 and channel = 'blog' and lang = $2 and kind = 'article'",
    [p.story_id, p.lang],
  );
  const commentary = buildCommentary(content.body.text, Array.isArray(content.body.hashtags) ? content.body.hashtags.map(String) : []);
  const altText = typeof content.body.alt_text === "string" ? content.body.alt_text : (article?.title ?? "");
  const title = content.title ?? article?.title ?? "IRON Cyber News";

  // Card: a versão renderizada mais recente (igual ao que o painel mostra).
  const { rows: [card] } = await pool.query<{ public_url: string }>(
    `select public_url from assets
      where story_id = $1 and channel = 'linkedin' and lang = $2 and kind = 'card' and status = 'ready' and public_url is not null
      order by content_version desc limit 1`,
    [p.story_id, p.lang],
  );
  if (!card) throw new PublishError("O card do LinkedIn ainda não está pronto.");
  // Só baixa do nosso próprio Storage (evita SSRF por URL adulterada no banco).
  if (!card.public_url.startsWith(`${deps.storage.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/`)) {
    throw new PublishError("URL de criativo fora do Storage do projeto.");
  }
  const res = await (deps.fetchImpl ?? fetch)(card.public_url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new PublishError(`Não foi possível baixar o card (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) throw new PublishError("Card com tamanho inválido.");

  if (deps.dryRun) return "dry-run";

  let token: string;
  try {
    token = await decryptToken(deps.tokenKey, new Uint8Array(integ.access_token_enc), tokenContext(p.target, integ.account_id));
  } catch (err) {
    throw new PublishError(err instanceof TokenCryptoError ? "Não foi possível ler o token salvo (TOKEN_ENC_KEY do executor diferente da Vercel?)." : "Erro ao ler o token.");
  }
  const imageUrn = await uploadImage(deps.api, token, integ.account_id, bytes, "image/png");
  return createPost(deps.api, { author: integ.account_id, token, commentary, imageUrn, altText, title });
}

async function handleFailure(deps: LinkedinPublishDeps, p: ClaimedPost, err: unknown) {
  const { pool, log } = deps;
  if (err instanceof LiApiError && err.rateLimited && p.attempts < MAX_RATE_LIMIT_RETRIES) {
    const wait = Math.min(Math.max(err.retryAfterSec ?? 900, 60), 3600);
    await pool.query(
      "update channel_posts set status = 'pending', scheduled_for = now() + make_interval(secs => $3), last_error = $2 where id = $1",
      [p.id, `Limite do LinkedIn atingido; nova tentativa em ${Math.round(wait / 60)} min.`, wait],
    );
    log.warn({ module: "publish", channel: "linkedin", target: p.target, post: p.id }, "linkedin rate limited");
    return;
  }
  if (err instanceof LiApiError && err.needsReauth && p.integration_id) {
    await pool.query("update integrations set status = 'needs_reauth' where id = $1", [p.integration_id]);
  }
  let message: string;
  if (err instanceof LiApiError) {
    message = err.needsReauth
      ? `O LinkedIn recusou o token ${WHERE[p.target]}. Reconecte em Integrações.`
      : err.httpStatus === 403
        ? `O LinkedIn negou a permissão de publicar ${WHERE[p.target]} (${err.message}).${p.target === "organization" ? " A Community Management API já foi aprovada?" : ""}`
        : `LinkedIn: ${err.message}`;
  } else {
    message = err instanceof PublishError ? err.message : `Erro inesperado: ${scrub((err as Error)?.message ?? String(err))}`;
  }
  await pool.query("update channel_posts set status = 'failed', last_error = $2 where id = $1", [p.id, message.slice(0, 500)]);
  log.error({ module: "publish", channel: "linkedin", target: p.target, post: p.id, err: message }, "linkedin publish failed");
}

/**
 * Renova tokens do LinkedIn que vencem em até 10 dias, quando há refresh token (página, pela
 * Community Management API). O perfil normalmente não tem refresh token: o painel avisa para reconectar.
 * Precisa do client id/secret do app correspondente; sem eles, não tenta.
 */
export async function refreshLinkedinTokens(deps: {
  pool: Pool; log: Logger; tokenKey: string; fetchImpl?: typeof fetch;
  clients: Partial<Record<LinkedinTarget, { id: string; secret: string }>>;
}): Promise<number> {
  const { pool, log } = deps;
  const { rows } = await pool.query<{ id: string; target: LinkedinTarget; account_id: string; refresh_token_enc: Buffer }>(
    `select id, target, account_id, refresh_token_enc from integrations
      where channel = 'linkedin' and status = 'active' and refresh_token_enc is not null
        and expires_at is not null and expires_at > now() and expires_at < now() + interval '10 days'
        and updated_at < now() - interval '24 hours'`,
  );
  let n = 0;
  for (const r of rows) {
    const client = deps.clients[r.target];
    if (!client) continue;
    try {
      const current = await decryptToken(deps.tokenKey, new Uint8Array(r.refresh_token_enc), tokenContext(r.target, r.account_id, "refresh"));
      const fresh = await refreshAccessToken({ fetchImpl: deps.fetchImpl }, client, current);
      const sealed = Buffer.from(await encryptToken(deps.tokenKey, fresh.token, tokenContext(r.target, r.account_id)));
      const sealedRefresh = fresh.refreshToken
        ? Buffer.from(await encryptToken(deps.tokenKey, fresh.refreshToken, tokenContext(r.target, r.account_id, "refresh")))
        : null;
      await pool.query(
        `update integrations set access_token_enc = $2, expires_at = now() + make_interval(secs => $3),
                refresh_token_enc = coalesce($4, refresh_token_enc)
          where id = $1`,
        [r.id, sealed, fresh.expiresIn, sealedRefresh],
      );
      await pool.query("insert into audit_log (actor, action, entity, entity_id) values (null, 'integration.refresh', 'integration', $1)", [r.id]);
      n++;
    } catch (err) {
      if (err instanceof LiApiError && err.needsReauth) {
        await pool.query("update integrations set status = 'needs_reauth' where id = $1", [r.id]);
      }
      log.error({ module: "integrations", channel: "linkedin", integration: r.id, err: scrub((err as Error).message) }, "token refresh failed");
    }
  }
  if (n) log.info({ module: "integrations", channel: "linkedin", refreshed: n }, "linkedin tokens refreshed");
  return n;
}
