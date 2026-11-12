import { createHash } from "node:crypto";
import { decryptToken, encryptToken, socialPostParts, TokenCryptoError } from "@ironnews/shared";
import type { Pool } from "../db";
import type { Logger } from "../logger";
import { pngToJpeg } from "../render/jpeg";
import { uploadObject, type StorageConfig } from "../render/storage";
import { IgApiError, buildCaption, publishCarousel, refreshLongLivedToken, scrub, type IgApiDeps } from "./instagram-api";

export interface InstagramPublishDeps {
  pool: Pool;
  log: Logger;
  storage: StorageConfig;
  tokenKey: string;
  dryRun: boolean;
  api: IgApiDeps;
  fetchImpl?: typeof fetch;
}

interface ClaimedPost {
  id: string;
  story_id: string;
  lang: "pt" | "en";
  content_version: number;
  attempts: number;
  integration_id: string | null;
}

interface Slide {
  id: string;
  position: number;
  public_url: string;
  storage_path: string;
  width: number;
  height: number;
  meta: Record<string, unknown>;
}

/** Posts que ficaram em "publishing" além disso foram interrompidos no meio (queda do processo). */
const STUCK_MINUTES = 15;
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Publica no Instagram os channel_posts pedidos pelo painel (§4.10). Roda a cada minuto.
 *
 * Segurança e idempotência:
 * - o post é "reservado" (pending → publishing) numa transação com SKIP LOCKED: dois executores
 *   nunca publicam o mesmo post;
 * - post preso em "publishing" vira "failed" com aviso para conferir no Instagram, e NÃO é repetido
 *   automaticamente: a publicação pode ter saído antes da queda, e repetir duplicaria o post;
 * - o token só existe decifrado em memória, dentro desta função.
 */
export async function publishDueInstagramPosts(deps: InstagramPublishDeps): Promise<number> {
  const { pool, log } = deps;
  await pool.query(
    `update channel_posts set status = 'failed',
            last_error = 'Publicação interrompida. Confira no Instagram se o post saiu antes de tentar de novo.'
      where channel = 'instagram' and status = 'publishing' and updated_at < now() - make_interval(mins => $1)`,
    [STUCK_MINUTES],
  );
  const { rows: posts } = await pool.query<ClaimedPost>(
    `update channel_posts cp set status = 'publishing', attempts = cp.attempts + 1
      where cp.id in (select id from channel_posts
                       where channel = 'instagram' and status = 'pending' and scheduled_for <= now()
                       order by scheduled_for limit 3 for update skip locked)
      returning cp.id, cp.story_id, cp.lang::text as lang, cp.content_version, cp.attempts, cp.integration_id`,
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
        log.info({ module: "publish", channel: "instagram", post: p.id }, "instagram dry-run");
      } else {
        await pool.query(
          `update channel_posts set status = 'published', published_at = now(), external_id = $2, external_url = $3, last_error = null
            where id = $1`,
          [p.id, result.mediaId, result.permalink],
        );
        await pool.query(
          "insert into audit_log (actor, action, entity, entity_id, diff) values (null, 'post.published', 'story', $1, $2)",
          [p.story_id, JSON.stringify({ channel: "instagram", lang: p.lang, media_id: result.mediaId })],
        );
        published++;
        log.info({ module: "publish", channel: "instagram", post: p.id, media: result.mediaId }, "instagram published");
      }
    } catch (err) {
      await handleFailure(deps, p, err);
    }
    await refreshStoryStatus(pool, p.story_id);
  }
  return published;
}

async function publishOne(deps: InstagramPublishDeps, p: ClaimedPost): Promise<"dry-run" | { mediaId: string; permalink: string | null }> {
  const { pool } = deps;
  const { rows: [integ] } = await pool.query<{ account_id: string; access_token_enc: Buffer; status: string; expires_at: Date | null }>(
    "select account_id, access_token_enc, status, expires_at from integrations where id = $1",
    [p.integration_id],
  );
  if (!integ || integ.status !== "active" || (integ.expires_at && integ.expires_at <= new Date())) {
    throw new PublishError("A conta do Instagram não está conectada ou o token venceu. Reconecte em Integrações.");
  }

  const { rows: [content] } = await pool.query<{ body: Record<string, unknown> }>(
    `select body from latest_contents where story_id = $1 and channel = 'instagram' and lang = $2 and kind = 'carousel'`,
    [p.story_id, p.lang],
  );
  if (!content) throw new PublishError("Conteúdo do Instagram não encontrado.");
  // Texto da IA (sem o convite antigo) + CTA padrão + hashtags.
  const parts = socialPostParts("instagram", p.lang, content.body);
  const caption = buildCaption(parts.text, Array.isArray(content.body.hashtags) ? content.body.hashtags.map(String) : [], parts.cta);

  // Slides: a versão renderizada mais recente de cada posição (igual ao que o painel mostra).
  const { rows: slides } = await pool.query<Slide>(
    `select distinct on (position) id, position, public_url, storage_path, width, height, meta
       from assets
      where story_id = $1 and channel = 'instagram' and lang = $2 and kind = 'carousel_slide' and status = 'ready'
        and public_url is not null
      order by position, content_version desc`,
    [p.story_id, p.lang],
  );
  if (slides.length < 2) throw new PublishError("O carrossel ainda não está pronto.");
  const imageUrls: string[] = [];
  for (const s of slides.slice(0, 10)) imageUrls.push(await ensureJpeg(deps, s));

  if (deps.dryRun) return "dry-run";

  let token: string;
  try {
    token = await decryptToken(deps.tokenKey, new Uint8Array(integ.access_token_enc), `instagram:${integ.account_id}`);
  } catch (err) {
    throw new PublishError(err instanceof TokenCryptoError ? "Não foi possível ler o token salvo (TOKEN_ENC_KEY do executor diferente da Vercel?)." : "Erro ao ler o token.");
  }
  return publishCarousel(deps.api, { igUserId: integ.account_id, token, imageUrls, caption });
}

/** Converte o slide para JPEG uma vez e guarda a URL em assets.meta (as próximas publicações reaproveitam). */
async function ensureJpeg(deps: InstagramPublishDeps, s: Slide): Promise<string> {
  const cached = s.meta?.jpeg_url;
  if (typeof cached === "string" && cached.startsWith(deps.storage.supabaseUrl)) return cached;
  // Só baixa do nosso próprio Storage (evita SSRF por URL adulterada no banco).
  if (!s.public_url.startsWith(`${deps.storage.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/`)) {
    throw new PublishError("URL de criativo fora do Storage do projeto.");
  }
  const res = await (deps.fetchImpl ?? fetch)(s.public_url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new PublishError(`Não foi possível baixar o slide ${s.position} (${res.status}).`);
  const png = Buffer.from(await res.arrayBuffer());
  const jpg = pngToJpeg(png, { width: s.width, height: s.height });
  const hash = createHash("sha256").update(jpg).digest("hex").slice(0, 10);
  const path = s.storage_path.replace(/\.png$/i, "") + `-${hash}.jpg`;
  const url = await uploadObject(deps.storage, path, jpg, "image/jpeg");
  await deps.pool.query("update assets set meta = meta || jsonb_build_object('jpeg_url', $2::text, 'jpeg_path', $3::text) where id = $1", [s.id, url, path]);
  return url;
}

class PublishError extends Error {}

async function handleFailure(deps: InstagramPublishDeps, p: ClaimedPost, err: unknown) {
  const { pool, log } = deps;
  if (err instanceof IgApiError && err.rateLimited && p.attempts < MAX_RATE_LIMIT_RETRIES) {
    await pool.query(
      "update channel_posts set status = 'pending', scheduled_for = now() + interval '15 minutes', last_error = $2 where id = $1",
      [p.id, `Limite do Instagram atingido; nova tentativa em 15 min. (${err.message})`],
    );
    log.warn({ module: "publish", channel: "instagram", post: p.id, code: err.code }, "instagram rate limited");
    return;
  }
  if (err instanceof IgApiError && err.needsReauth && p.integration_id) {
    await pool.query("update integrations set status = 'needs_reauth' where id = $1", [p.integration_id]);
  }
  const message = err instanceof IgApiError
    ? (err.needsReauth ? "O Instagram recusou o token. Reconecte a conta em Integrações." : `Instagram: ${err.message}`)
    : err instanceof PublishError ? err.message : `Erro inesperado: ${scrub((err as Error)?.message ?? String(err))}`;
  await pool.query("update channel_posts set status = 'failed', last_error = $2 where id = $1", [p.id, message.slice(0, 500)]);
  log.error({ module: "publish", channel: "instagram", post: p.id, err: message }, "instagram publish failed");
}

/** Mesma regra do blog (RN-PUB05): PUBLISHED quando nada está pendente; PARTIAL se algo falhou. */
async function refreshStoryStatus(pool: Pool, storyId: string) {
  await pool.query(
    `update stories s set status = case
        when exists (select 1 from channel_posts where story_id = s.id and status in ('pending', 'publishing')) then 'PUBLISHING'::story_status
        when exists (select 1 from channel_posts where story_id = s.id and status = 'failed') then 'PARTIAL'::story_status
        else 'PUBLISHED'::story_status end
      where s.id = $1 and s.status in ('PUBLISHING', 'PUBLISHED', 'PARTIAL')`,
    [storyId],
  );
}

/**
 * Renova tokens que vencem em até 10 dias (o longo dura 60). Roda 1x por dia.
 * Sem renovação, a conta para de publicar em silêncio no dia 60.
 */
export async function refreshInstagramTokens(deps: Pick<InstagramPublishDeps, "pool" | "log" | "tokenKey" | "fetchImpl">): Promise<number> {
  const { pool, log } = deps;
  const { rows } = await pool.query<{ id: string; account_id: string; access_token_enc: Buffer }>(
    `select id, account_id, access_token_enc from integrations
      where channel = 'instagram' and status = 'active' and expires_at is not null
        and expires_at > now() and expires_at < now() + interval '10 days' and updated_at < now() - interval '24 hours'`,
  );
  let n = 0;
  for (const r of rows) {
    const ctx = `instagram:${r.account_id}`;
    try {
      const current = await decryptToken(deps.tokenKey, new Uint8Array(r.access_token_enc), ctx);
      const fresh = await refreshLongLivedToken({ fetchImpl: deps.fetchImpl }, current);
      const sealed = Buffer.from(await encryptToken(deps.tokenKey, fresh.token, ctx));
      await pool.query(
        "update integrations set access_token_enc = $2, expires_at = now() + make_interval(secs => $3) where id = $1",
        [r.id, sealed, fresh.expiresIn],
      );
      await pool.query(
        "insert into audit_log (actor, action, entity, entity_id) values (null, 'integration.refresh', 'integration', $1)",
        [r.id],
      );
      n++;
    } catch (err) {
      if (err instanceof IgApiError && err.needsReauth) {
        await pool.query("update integrations set status = 'needs_reauth' where id = $1", [r.id]);
      }
      log.error({ module: "integrations", channel: "instagram", integration: r.id, err: scrub((err as Error).message) }, "token refresh failed");
    }
  }
  if (n) log.info({ module: "integrations", channel: "instagram", refreshed: n }, "instagram tokens refreshed");
  return n;
}
