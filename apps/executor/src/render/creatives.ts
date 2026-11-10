import { createHash } from "node:crypto";
import {
  CARD_LINKEDIN, CAROUSEL, COVER, IRON_MARK_DATA_URI, THUMB_SHORT, cardLinkedin, carouselCover, carouselCta, carouselSlide, cover, thumbShort,
  type El, type Lang, type Severity, type Slide, type StoryCreative,
} from "@ironnews/templates";
import type { Pool } from "../db";
import type { Logger } from "../logger";
import { storyBackground, type BackgroundDeps } from "./background";
import { renderPng } from "./png";
import { uploadObject, type StorageConfig } from "./storage";

export interface StoryForRender {
  id: string;
  severity: Severity;
  category: string;
  cve_ids: string[];
  slug_pt: string | null;
  slug_en: string | null;
}

export interface ContentForRender {
  channel: "blog" | "instagram" | "facebook" | "linkedin" | "youtube";
  lang: Lang;
  kind: string;
  version: number;
  title: string | null;
  body: Record<string, unknown>;
}

/** Um criativo a renderizar: onde ele vai (assets) e o template já preenchido. */
export interface PlannedCreative {
  channel: "blog" | "instagram" | "linkedin" | "youtube";
  lang: Lang;
  kind: "cover" | "carousel_slide" | "card" | "thumbnail";
  position: number;
  contentVersion: number;
  size: { width: number; height: number };
  el: El;
}

const slidesOf = (body: Record<string, unknown>): Slide[] =>
  (Array.isArray(body.slides) ? body.slides : [])
    .map((s) => ({ heading: String((s as Slide)?.heading ?? "").trim(), body: String((s as Slide)?.body ?? "").trim() }))
    .filter((s) => s.heading);

/**
 * Lista de criativos de uma story (§4.7), por idioma com artigo e slug:
 * capa do blog/OG, card do LinkedIn, carrossel do Instagram (capa + slides + CTA, RN-RND02) e capa do Short.
 */
export function planCreatives(story: StoryForRender, contents: ContentForRender[], background?: string | null): PlannedCreative[] {
  const out: PlannedCreative[] = [];
  const find = (channel: string, lang: Lang) => contents.find((c) => c.channel === channel && c.lang === lang);
  for (const lang of ["pt", "en"] as const) {
    const article = find("blog", lang);
    const slug = lang === "pt" ? story.slug_pt : story.slug_en;
    if (!article?.title || !slug) continue;
    const s: StoryCreative = {
      lang, severity: story.severity, category: story.category, cves: story.cve_ids, title: article.title, slug, logo: IRON_MARK_DATA_URI,
      background: background ?? undefined,
    };
    out.push({ channel: "blog", lang, kind: "cover", position: 1, contentVersion: article.version, size: COVER, el: cover(s) });
    const li = find("linkedin", lang);
    out.push({ channel: "linkedin", lang, kind: "card", position: 1, contentVersion: li?.version ?? article.version, size: CARD_LINKEDIN, el: cardLinkedin(s) });
    const ig = find("instagram", lang);
    const slides = ig ? slidesOf(ig.body).slice(0, 6) : [];
    if (ig && slides.length) {
      const total = slides.length + 1;
      out.push({ channel: "instagram", lang, kind: "carousel_slide", position: 1, contentVersion: ig.version, size: CAROUSEL, el: carouselCover(s, slides[0]!, total) });
      slides.slice(1).forEach((sl, i) =>
        out.push({ channel: "instagram", lang, kind: "carousel_slide", position: i + 2, contentVersion: ig.version, size: CAROUSEL, el: carouselSlide(s, sl, i + 2, total) }));
      out.push({ channel: "instagram", lang, kind: "carousel_slide", position: total, contentVersion: ig.version, size: CAROUSEL, el: carouselCta(s, total) });
    }
    const yt = find("youtube", lang);
    const hook = yt ? String(yt.body.on_screen_hook ?? "").trim() : "";
    if (yt && hook) {
      out.push({ channel: "youtube", lang, kind: "thumbnail", position: 1, contentVersion: yt.version, size: THUMB_SHORT, el: thumbShort(s, hook) });
    }
  }
  return out;
}

export interface RenderDeps {
  pool: Pool;
  log: Logger;
  storage: StorageConfig;
  /** Pede ao site para regenerar páginas (tags do cache). Usado quando a story já está publicada. */
  revalidate?: (tags: string[]) => Promise<unknown>;
  /** Ilustração de fundo por IA (opcional). */
  background?: Pick<BackgroundDeps, "llm" | "workersAi">;
}

/** Renderiza, envia ao Storage e registra em `assets` todos os criativos da story. Idempotente. */
export async function renderStoryCreatives(deps: RenderDeps, storyId: string): Promise<number> {
  const { pool, log } = deps;
  const { rows: [story] } = await pool.query<StoryForRender & { status: string }>(
    "select id, status, severity::text as severity, category, cve_ids, slug_pt, slug_en from stories where id = $1",
    [storyId],
  );
  if (!story || ["DRAFTING", "REJECTED", "FAILED"].includes(story.status)) return 0;
  const { rows: contents } = await pool.query<ContentForRender>(
    "select channel::text as channel, lang::text as lang, kind, version, title, body from latest_contents where story_id = $1",
    [storyId],
  );
  const pt = contents.find((c) => c.channel === "blog" && c.lang === "pt") ?? contents.find((c) => c.channel === "blog");
  const bg = deps.background && pt?.title
    ? await storyBackground({ pool, log, storage: deps.storage, ...deps.background }, storyId,
        { title: pt.title, tldr: String(pt.body.tldr ?? ""), category: story.category })
    : null;
  const plan = planCreatives(story, contents, bg);
  let done = 0;
  for (const p of plan) {
    const png = await renderPng(p.el, p.size);
    const hash = createHash("sha256").update(png).digest("hex").slice(0, 10);
    const objectPath = `stories/${storyId}/${p.lang}/${p.channel}-${p.kind}-${p.position}-${hash}.png`;
    const url = await uploadObject(deps.storage, objectPath, png, "image/png");
    await pool.query(
      `insert into assets (story_id, channel, lang, kind, position, status, storage_path, public_url, mime, width, height, bytes,
                           provider, content_version, meta)
       values ($1, $2, $3, $4, $5, 'ready', $6, $7, 'image/png', $8, $9, $10, 'og-render', $11, '{"renderer":"executor"}'::jsonb)
       on conflict (story_id, channel, lang, kind, position, content_version) do update
         set status = 'ready', storage_path = excluded.storage_path, public_url = excluded.public_url,
             width = excluded.width, height = excluded.height, bytes = excluded.bytes, meta = excluded.meta`,
      [storyId, p.channel, p.lang, p.kind, p.position, objectPath, url, p.size.width, p.size.height, png.length, p.contentVersion],
    );
    done++;
  }
  log.info({ module: "render", storyId, creatives: done }, "creatives rendered");
  // Story já no ar: a capa entra na grade e no artigo agora, sem esperar o cache expirar.
  if (done && deps.revalidate && ["PUBLISHED", "PARTIAL", "PUBLISHING"].includes(story.status)) {
    const slugs = [story.slug_pt, story.slug_en].filter((x): x is string => Boolean(x));
    await deps.revalidate(["articles", ...slugs.map((x) => `article:${x}`)]);
  }
  return done;
}
