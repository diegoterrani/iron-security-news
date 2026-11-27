import { decryptToken, TokenCryptoError } from "@ironnews/shared";
import type { Pool } from "../db";
import type { Logger } from "../logger";
import { pngToJpeg } from "../render/jpeg";
import { publicUrl, uploadObject, type StorageConfig } from "../render/storage";
import { IgApiError, publishCarousel, publishReel, scrub as igScrub, type IgApiDeps } from "./instagram-api";
import { tokenContext, type LinkedinTarget } from "./linkedin";
import {
  AUTHOR_RE, LiApiError, campaignCommentary, createComment, createMediaPost, scrub as liScrub,
  uploadDocument, uploadImage, uploadVideo, type LiApiDeps,
} from "./linkedin-api";

/**
 * Campanhas (/admin/campanhas): publica na hora marcada as peças que o admin subiu para o Storage
 * (Reels e carrossel no Instagram; vídeo, PDF e imagem no LinkedIn, no perfil ou na página).
 *
 * Mesmas garantias dos posts das stories:
 * - reserva pending → publishing com SKIP LOCKED (dois executores nunca publicam o mesmo post);
 * - post preso em "publishing" vira "failed" com aviso e NÃO é repetido sozinho (evita post duplicado);
 * - o token só existe decifrado em memória, dentro de publishOne;
 * - os arquivos são lidos só do nosso Storage, por caminho validado (nada de URL vinda do banco).
 */
export interface CampaignPublishDeps {
  pool: Pool;
  log: Logger;
  storage: StorageConfig;
  tokenKey: string;
  dryRun: boolean;
  ig: IgApiDeps;
  li: LiApiDeps;
  fetchImpl?: typeof fetch;
}

export interface CampaignPost {
  id: string;
  channel: "instagram" | "linkedin";
  target: "default" | LinkedinTarget;
  format: "reel" | "carousel" | "video" | "document" | "image";
  caption: string;
  first_comment: string | null;
  doc_title: string | null;
  media: string[];
  attempts: number;
  integration_id: string | null;
}

interface Published {
  externalId: string;
  url: string | null;
  /** Aviso que não impede a publicação (ex.: o 1º comentário falhou). */
  warning?: string;
}

/** Vídeo pode levar até ~10 min entre upload e processamento; acima disso o post é dado como interrompido. */
const STUCK_MINUTES = 30;
const MAX_RATE_LIMIT_RETRIES = 3;
export const MEDIA_PATH_RE = /^campanhas\/(?:auto\/)?[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,100}\.(mp4|jpg|jpeg|png|pdf)$/;
const MAX_DOWNLOAD = 500 * 1024 * 1024;
const NETWORK: Record<CampaignPost["channel"], string> = { instagram: "Instagram", linkedin: "LinkedIn" };

export async function publishDueCampaignPosts(deps: CampaignPublishDeps): Promise<number> {
  const { pool, log } = deps;
  await pool.query(
    `update campaign_posts set status = 'failed',
            last_error = 'Publicação interrompida. Confira na rede se o post saiu antes de tentar de novo.'
      where status = 'publishing' and updated_at < now() - make_interval(mins => $1)`,
    [STUCK_MINUTES],
  );
  // Um por vez: vídeo é pesado e a fila anda a cada minuto.
  const { rows: posts } = await pool.query<CampaignPost>(
    `update campaign_posts cp set status = 'publishing', attempts = cp.attempts + 1
      where cp.id in (select id from campaign_posts
                       where status = 'pending' and scheduled_for <= now()
                       order by scheduled_for limit 1 for update skip locked)
      returning cp.id, cp.channel::text as channel, cp.target, cp.format, cp.caption, cp.first_comment, cp.doc_title,
                cp.media, cp.attempts, cp.integration_id`,
  );
  let published = 0;
  for (const p of posts) {
    const ctx = { module: "publish", channel: p.channel, target: p.target, format: p.format, campaignPost: p.id };
    try {
      const result = await publishOne(deps, p);
      if (result === "dry-run") {
        await pool.query(
          "update campaign_posts set status = 'skipped', last_error = 'Modo de teste (PUBLISH_DRY_RUN=1): nada foi publicado.' where id = $1",
          [p.id],
        );
        log.info(ctx, "campaign dry-run");
        continue;
      }
      await pool.query(
        `update campaign_posts set status = 'published', published_at = now(), external_id = $2, external_url = $3, last_error = $4
          where id = $1`,
        [p.id, result.externalId, result.url, result.warning ?? null],
      );
      await pool.query(
        "insert into audit_log (actor, action, entity, entity_id, diff) values (null, 'campaign.published', 'campaign_post', $1, $2)",
        [p.id, JSON.stringify({ channel: p.channel, target: p.target, format: p.format, external_id: result.externalId })],
      );
      published++;
      log.info({ ...ctx, external: result.externalId, warning: result.warning }, "campaign published");
    } catch (err) {
      await handleFailure(deps, p, err);
    }
  }
  return published;
}

class PublishError extends Error {}

async function publishOne(deps: CampaignPublishDeps, p: CampaignPost): Promise<"dry-run" | Published> {
  const { pool } = deps;
  const { rows: [integ] } = await pool.query<{
    channel: string; target: string; account_id: string; access_token_enc: Buffer; status: string; expires_at: Date | null; meta: Record<string, unknown>;
  }>(
    "select channel::text as channel, target, account_id, access_token_enc, status, expires_at, meta from integrations where id = $1",
    [p.integration_id],
  );
  if (!integ || integ.channel !== p.channel || integ.target !== p.target || integ.status !== "active" || (integ.expires_at && integ.expires_at <= new Date())) {
    throw new PublishError(`A conta do ${NETWORK[p.channel]} não está conectada ou o token venceu. Reconecte em Integrações.`);
  }
  if (!Array.isArray(p.media) || p.media.length === 0 || !p.media.every((m) => MEDIA_PATH_RE.test(m))) {
    throw new PublishError("Arquivo da campanha com caminho inválido.");
  }

  if (p.channel === "instagram") {
    // O Instagram baixa a mídia por URL pública; carrossel só aceita JPEG (PNG é convertido uma vez).
    const urls = p.format === "carousel"
      ? await Promise.all(p.media.map((path) => ensureJpeg(deps, p.id, path)))
      : p.media.map((path) => publicUrl(deps.storage, path));
    if (deps.dryRun) return "dry-run";
    const token = await openToken(deps, integ.access_token_enc, `instagram:${integ.account_id}`);
    const api: IgApiDeps = { ...deps.ig, host: integ.meta?.api_host === "facebook" ? "facebook" : "instagram" };
    const caption = p.caption.trim().slice(0, 2200);
    const r = p.format === "reel"
      ? await publishReel(api, { igUserId: integ.account_id, token, videoUrl: urls[0]!, caption })
      : await publishCarousel(api, { igUserId: integ.account_id, token, imageUrls: urls, caption });
    return { externalId: r.mediaId, url: r.permalink };
  }

  // LinkedIn: os bytes sobem pela API (não por URL).
  if (!AUTHOR_RE.test(integ.account_id)) throw new PublishError("Conta do LinkedIn com identificador inválido. Reconecte em Integrações.");
  const commentary = campaignCommentary(p.caption);
  const path = p.media[0]!;
  const bytes = await download(deps, path);
  if (deps.dryRun) return "dry-run";
  const token = await openToken(deps, integ.access_token_enc, tokenContext(p.target as LinkedinTarget, integ.account_id));
  let mediaUrn: string;
  if (p.format === "video") mediaUrn = await uploadVideo(deps.li, token, integ.account_id, bytes);
  else if (p.format === "document") mediaUrn = await uploadDocument(deps.li, token, integ.account_id, bytes);
  else mediaUrn = await uploadImage(deps.li, token, integ.account_id, bytes, /\.png$/i.test(path) ? "image/png" : "image/jpeg");

  const post = await createMediaPost(deps.li, {
    author: integ.account_id, token, commentary,
    media: { id: mediaUrn, title: p.doc_title ?? undefined, altText: p.format === "image" ? p.doc_title ?? undefined : undefined },
  });
  let warning: string | undefined;
  if (p.first_comment) {
    try {
      await createComment(deps.li, token, { actor: integ.account_id, postUrn: post.postUrn, text: p.first_comment });
    } catch (err) {
      // O post já saiu: não pode virar "failed" (tentar de novo duplicaria). Fica o aviso para comentar à mão.
      warning = `Post publicado, mas o 1º comentário falhou (${err instanceof LiApiError ? err.message : "erro inesperado"}). Comente à mão.`;
    }
  }
  return { externalId: post.postUrn, url: post.url, warning };
}

async function openToken(deps: CampaignPublishDeps, enc: Buffer, context: string): Promise<string> {
  try {
    return await decryptToken(deps.tokenKey, new Uint8Array(enc), context);
  } catch (err) {
    throw new PublishError(err instanceof TokenCryptoError ? "Não foi possível ler o token salvo (TOKEN_ENC_KEY do executor diferente da Vercel?)." : "Erro ao ler o token.");
  }
}

/** Baixa um arquivo da campanha do nosso Storage (URL montada aqui a partir do caminho validado). */
async function download(deps: CampaignPublishDeps, path: string): Promise<Buffer> {
  if (!MEDIA_PATH_RE.test(path)) throw new PublishError("Arquivo da campanha com caminho inválido.");
  const res = await (deps.fetchImpl ?? fetch)(publicUrl(deps.storage, path), { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new PublishError(`Não foi possível baixar ${path.split("/").pop()} do Storage (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_DOWNLOAD) throw new PublishError("Arquivo da campanha com tamanho inválido.");
  return bytes;
}

/** Largura e altura de um PNG (cabeçalho IHDR). */
export function pngSize(png: Buffer): { width: number; height: number } {
  const sig = "89504e470d0a1a0a";
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== sig || png.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new PublishError("Imagem PNG inválida.");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** JPEG público para o carrossel do Instagram: JPEG vai direto; PNG é convertido e salvo ao lado. */
async function ensureJpeg(deps: CampaignPublishDeps, postId: string, path: string): Promise<string> {
  if (/\.jpe?g$/i.test(path)) return publicUrl(deps.storage, path);
  const png = await download(deps, path);
  const jpg = pngToJpeg(png, pngSize(png));
  const out = path.replace(/\.png$/i, ".jpg").replace(/^campanhas\//, `campanhas/jpeg-${postId.slice(0, 8)}/`);
  return uploadObject(deps.storage, out, jpg, "image/jpeg");
}

async function handleFailure(deps: CampaignPublishDeps, p: CampaignPost, err: unknown) {
  const { pool, log } = deps;
  const network = NETWORK[p.channel];
  const rateLimited = (err instanceof IgApiError || err instanceof LiApiError) && err.rateLimited;
  if (rateLimited && p.attempts < MAX_RATE_LIMIT_RETRIES) {
    await pool.query(
      "update campaign_posts set status = 'pending', scheduled_for = now() + interval '15 minutes', last_error = $2 where id = $1",
      [p.id, `Limite do ${network} atingido; nova tentativa em 15 min.`],
    );
    log.warn({ module: "publish", channel: p.channel, campaignPost: p.id }, "campaign rate limited");
    return;
  }
  const needsReauth = (err instanceof IgApiError || err instanceof LiApiError) && err.needsReauth;
  if (needsReauth && p.integration_id) {
    await pool.query("update integrations set status = 'needs_reauth' where id = $1", [p.integration_id]);
  }
  let message: string;
  if (needsReauth) message = `O ${network} recusou o token. Reconecte a conta em Integrações.`;
  else if (err instanceof LiApiError && err.httpStatus === 403) {
    message = `O LinkedIn negou a permissão (${err.message}).${p.target === "organization" ? " A Community Management API já foi aprovada?" : ""}`;
  } else if (err instanceof IgApiError || err instanceof LiApiError) message = `${network}: ${err.message}`;
  else if (err instanceof PublishError) message = err.message;
  else {
    const raw = (err as Error)?.message ?? String(err);
    message = `Erro inesperado: ${p.channel === "instagram" ? igScrub(raw) : liScrub(raw)}`;
  }
  await pool.query("update campaign_posts set status = 'failed', last_error = $2 where id = $1", [p.id, message.slice(0, 500)]);
  log.error({ module: "publish", channel: p.channel, campaignPost: p.id, err: message }, "campaign publish failed");
}
