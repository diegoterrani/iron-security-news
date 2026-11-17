import { cleanText, decodeEntities, parseDate, truncate } from "../ingest/normalize";

/** Texto que vai ao redator. Maior que o trecho da coleta (2.000) porque aqui há uma única fonte. */
export const MANUAL_TEXT_MAX = 12_000;
/** Abaixo disso a página quase certamente não trouxe a matéria (paywall, app em JavaScript, bloqueio). */
export const MANUAL_TEXT_MIN = 400;

export interface ExtractedArticle {
  title: string;
  description: string | null;
  siteName: string | null;
  publishedAt: Date | null;
  text: string;
}

const attrOf = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? null) : null;
};

/** Valor de <meta property|name="key" content="…"> (ordem dos atributos livre). */
export function metaContent(html: string, keys: string[]): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attrOf(tag, "property") ?? attrOf(tag, "name") ?? attrOf(tag, "itemprop"))?.toLowerCase();
    if (key && keys.includes(key)) {
      const v = attrOf(tag, "content");
      if (v && v.trim()) return decodeEntities(v).trim();
    }
  }
  return null;
}

const STRIP_BLOCKS = /<(script|style|noscript|iframe|svg|nav|header|footer|aside|form|button|figure|template)\b[\s\S]*?<\/\1>/gi;

/** Corpo da matéria: <article> mais longo, senão <main>, senão <body>; só parágrafos, títulos e listas. */
export function articleBody(html: string): string {
  const clean = html.replace(/<!--[\s\S]*?-->/g, " ").replace(STRIP_BLOCKS, " ");
  const articles = [...clean.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]!);
  const scope = articles.sort((a, b) => b.length - a.length)[0]
    ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(clean)?.[1]
    ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(clean)?.[1]
    ?? clean;
  const blocks = [...scope.matchAll(/<(p|h[1-4]|li|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => cleanText(m[2]!).replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 30 || (t.length >= 15 && /^[A-ZÀ-Ú0-9]/.test(t)));
  return blocks.length ? blocks.join("\n\n") : cleanText(scope);
}

/** Extrai título, descrição, veículo, data e texto de uma página de notícia. */
export function extractArticle(html: string, now = new Date()): ExtractedArticle {
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = metaContent(html, ["og:title", "twitter:title"]) ?? (titleTag ? cleanText(titleTag) : "");
  const published = metaContent(html, ["article:published_time", "datepublished", "date", "dc.date", "pubdate"]);
  return {
    title: truncate(cleanText(title).replace(/\s+/g, " "), 300),
    description: (() => {
      const d = metaContent(html, ["og:description", "description", "twitter:description"]);
      return d ? truncate(cleanText(d), 600) : null;
    })(),
    siteName: (() => {
      const s = metaContent(html, ["og:site_name", "application-name"]);
      return s ? truncate(cleanText(s), 120) : null;
    })(),
    publishedAt: parseDate(published, now),
    text: articleBody(html),
  };
}

/** Texto colado: 1ª linha curta vira título; o resto é o corpo. Remove o que pareça marcação. */
export function splitPastedText(raw: string): { title: string; text: string } {
  const text = cleanText(raw.replace(/\r\n?/g, "\n"));
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const titleLike = first.length <= 200 && lines.length > 1;
  return {
    title: truncate((titleLike ? first : first.split(/(?<=[.!?])\s/)[0] ?? first).replace(/^#+\s*/, ""), 200),
    text: truncate(text, MANUAL_TEXT_MAX),
  };
}

export const hostLabel = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "fonte";
  }
};
