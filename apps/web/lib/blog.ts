import { createClient } from "@supabase/supabase-js";
import type { Lang, Severity } from "@ironnews/shared";
import { supabaseEnv } from "./supabase/env";

/** Cache das páginas do blog: o executor invalida as tags ao publicar; sem isso, expira em 5 min. */
const REVALIDATE_SECONDS = 300;

/**
 * Cliente público (chave publicável, sem sessão). O RLS só deixa ler stories PUBLISHED/PARTIAL e o
 * artigo do blog delas (view public_articles).
 */
function publicClient(tags: string[]) {
  const { url, key } = supabaseEnv();
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, next: { tags: ["articles", ...tags], revalidate: REVALIDATE_SECONDS } }),
    },
  });
}

export interface ArticleSummary {
  id: string;
  lang: Lang;
  slug: string;
  title: string;
  tldr: string;
  category: string;
  severity: Severity;
  cve_ids: string[];
  tags: string[];
  published_at: string;
}

export interface Article extends ArticleSummary {
  markdown: string;
  meta_description: string;
}

type Row = {
  id: string; lang: Lang; slug: string | null; title: string | null; category: string; severity: Severity;
  cve_ids: string[]; tags: string[]; published_at: string; body: Record<string, unknown>;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

function toArticle(r: Row): Article {
  return {
    id: r.id, lang: r.lang, slug: r.slug ?? "", title: r.title ?? "", category: r.category, severity: r.severity,
    cve_ids: r.cve_ids ?? [], tags: r.tags ?? [], published_at: r.published_at,
    tldr: str(r.body?.tldr), markdown: str(r.body?.markdown), meta_description: str(r.body?.meta_description),
  };
}

const COLUMNS = "id, lang, slug, title, category, severity, cve_ids, tags, published_at, body";

export async function listArticles(lang: Lang, limit = 20): Promise<ArticleSummary[]> {
  const { data, error } = await publicClient([]).from("public_articles").select(COLUMNS)
    .eq("lang", lang).not("slug", "is", null).order("published_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data as Row[]).map(toArticle);
}

export async function getArticle(lang: Lang, slug: string): Promise<Article | null> {
  const { data, error } = await publicClient([`article:${slug}`]).from("public_articles").select(COLUMNS)
    .eq("lang", lang).eq("slug", slug).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toArticle(data as Row) : null;
}

/** Slug da mesma story no outro idioma (hreflang e seletor PT/EN). */
export async function getAlternates(id: string): Promise<Partial<Record<Lang, string>>> {
  const { data } = await publicClient([]).from("public_articles").select("lang, slug").eq("id", id);
  return Object.fromEntries((data ?? []).filter((r) => r.slug).map((r) => [r.lang, r.slug])) as Partial<Record<Lang, string>>;
}

export async function listAllForSitemap(): Promise<{ lang: Lang; slug: string; published_at: string }[]> {
  const { data } = await publicClient([]).from("public_articles").select("lang, slug, published_at")
    .not("slug", "is", null).order("published_at", { ascending: false }).limit(1000);
  return (data ?? []) as { lang: Lang; slug: string; published_at: string }[];
}

export const fmtDate = (iso: string, lang: Lang) =>
  new Date(iso).toLocaleDateString(lang === "pt" ? "pt-BR" : "en-US", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "long", year: "numeric" });
