import { signRequest } from "@ironnews/shared";
import type { Pool } from "../db";
import type { Logger } from "../logger";

export interface BlogPublishDeps {
  pool: Pool;
  log: Logger;
  siteUrl: string;
  revalidateUrl?: string;
  revalidateSecret?: string;
  fetchImpl?: typeof fetch;
}

interface DuePost {
  id: string;
  story_id: string;
  lang: "pt" | "en";
  slug: string | null;
}

/**
 * Publica no blog os channel_posts vencidos (§4.10, RN-PUB02: blog primeiro).
 * "Publicar no blog" é tornar a story visível: o site lê do banco os artigos de stories PUBLISHED.
 * Por isso não depende de PUBLISH_DRY_RUN (que vale para as redes sociais).
 */
export async function publishDueBlogPosts(deps: BlogPublishDeps): Promise<string[]> {
  const client = await deps.pool.connect();
  let published: DuePost[] = [];
  try {
    await client.query("begin");
    const { rows } = await client.query<DuePost>(
      `select cp.id, cp.story_id, cp.lang, case cp.lang when 'pt' then s.slug_pt else s.slug_en end as slug
         from channel_posts cp join stories s on s.id = cp.story_id
        where cp.channel = 'blog' and cp.status = 'pending' and cp.scheduled_for <= now()
          and s.status in ('SCHEDULED', 'PUBLISHING')
        order by cp.scheduled_for
        limit 20
        for update of cp skip locked`,
    );
    for (const p of rows) {
      if (!p.slug) {
        await client.query(
          "update channel_posts set status = 'failed', attempts = attempts + 1, last_error = 'story sem slug' where id = $1",
          [p.id],
        );
        continue;
      }
      await client.query(
        `update channel_posts set status = 'published', published_at = now(), attempts = attempts + 1,
                external_url = $2, last_error = null
          where id = $1`,
        [p.id, `${deps.siteUrl}/${p.lang}/${p.slug}`],
      );
      published.push(p);
    }
    // Story fica PUBLISHED quando todos os posts saíram; PARTIAL se algum falhou; senão PUBLISHING (RN-PUB05).
    for (const storyId of new Set(rows.map((r) => r.story_id))) {
      await client.query(
        `update stories s set
            published_at = coalesce(s.published_at, now()),
            status = case
              when not exists (select 1 from channel_posts where story_id = s.id and status in ('pending', 'publishing')) then
                case when exists (select 1 from channel_posts where story_id = s.id and status = 'failed')
                     then 'PARTIAL'::story_status else 'PUBLISHED'::story_status end
              else 'PUBLISHING'::story_status end
          where s.id = $1`,
        [storyId],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    published = [];
    throw err;
  } finally {
    client.release();
  }
  if (published.length) {
    deps.log.info({ module: "publish", channel: "blog", posts: published.map((p) => `${p.lang}/${p.slug}`) }, "blog posts published");
    await revalidate(deps, ["articles", ...published.map((p) => `article:${p.slug}`)]);
  }
  return published.map((p) => p.id);
}

/** Pede ao site para regenerar as páginas (POST assinado com HMAC). Falha só gera aviso: o cache expira sozinho. */
export async function revalidate(deps: BlogPublishDeps, tags: string[]): Promise<boolean> {
  if (!deps.revalidateUrl || !deps.revalidateSecret) {
    deps.log.warn({ module: "publish" }, "REVALIDATE_URL/SECRET ausentes; o site atualiza quando o cache expirar");
    return false;
  }
  const body = JSON.stringify({ tags: [...new Set(tags)].slice(0, 20) });
  const { timestamp, signature } = await signRequest(deps.revalidateSecret, body);
  try {
    const res = await (deps.fetchImpl ?? fetch)(deps.revalidateUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-timestamp": timestamp, "x-signature": signature },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) {
    deps.log.warn({ module: "publish", err: (err as Error).message }, "site revalidation failed");
    return false;
  }
}
