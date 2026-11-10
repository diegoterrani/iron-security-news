import { HTML_LANG, dict, isLang } from "@/lib/i18n";
import { listArticles } from "@/lib/blog";
import { siteUrl } from "@/lib/supabase/env";

export const revalidate = 300;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** RSS 2.0 por idioma (§4.12). */
export async function GET(_req: Request, { params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) return new Response("Not found", { status: 404 });
  const base = siteUrl();
  const articles = await listArticles(lang, 50).catch(() => []);
  const items = articles.map((a) => `
    <item>
      <title>${esc(a.title)}</title>
      <link>${base}/${lang}/${a.slug}</link>
      <guid isPermaLink="true">${base}/${lang}/${a.slug}</guid>
      <pubDate>${new Date(a.published_at).toUTCString()}</pubDate>
      <description>${esc(a.tldr)}</description>
      ${a.cve_ids.map((c) => `<category>${esc(c)}</category>`).join("")}
    </item>`).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>IRON CYBER NEWS</title>
    <link>${base}/${lang}</link>
    <atom:link href="${base}/${lang}/rss.xml" rel="self" type="application/rss+xml" />
    <description>${esc(dict[lang].meta.description)}</description>
    <language>${HTML_LANG[lang]}</language>${items}
  </channel>
</rss>`;
  return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
}
