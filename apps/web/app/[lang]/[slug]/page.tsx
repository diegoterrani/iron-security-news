import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { ArrowLeft } from "lucide-react";
import type { Lang } from "@ironnews/shared";
import { SeverityBadge } from "@/components/SeverityBadge";
import { fmtDate, getAlternates, getArticle, getCoverUrl } from "@/lib/blog";
import { HTML_LANG, dict, isLang } from "@/lib/i18n";
import { withoutTldrSection } from "@/lib/markdown";
import { siteUrl } from "@/lib/supabase/env";

/** ISR: o executor invalida "article:<slug>" ao publicar ou editar; sem isso, renova em 5 min. */
export const revalidate = 300;
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

type Params = { params: Promise<{ lang: string; slug: string }> };

async function load(lang: string, slug: string) {
  if (!isLang(lang) || !/^[a-z0-9-]{1,120}$/.test(slug)) return null;
  const article = await getArticle(lang, slug).catch(() => null);
  if (!article) return null;
  const alternates: Partial<Record<Lang, string>> = await getAlternates(article.id).catch(() => ({}));
  return { lang, article, alternates };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang, slug } = await params;
  const data = await load(lang, slug);
  if (!data) return {};
  const { article: a, alternates } = data;
  const coverUrl = await getCoverUrl(a.id, a.lang).catch(() => null);
  const images = coverUrl ? [{ url: coverUrl, width: 1200, height: 630, alt: a.title }] : undefined;
  const languages = Object.fromEntries(
    Object.entries(alternates).map(([l, s]) => [HTML_LANG[l as keyof typeof HTML_LANG], `/${l}/${s}`]),
  );
  return {
    title: a.title,
    description: a.meta_description || a.tldr.slice(0, 155),
    alternates: { canonical: `/${a.lang}/${a.slug}`, languages },
    openGraph: {
      type: "article", title: a.title, description: a.meta_description || a.tldr, url: `/${a.lang}/${a.slug}`,
      siteName: "IRON CYBER NEWS", locale: HTML_LANG[a.lang], publishedTime: a.published_at, tags: a.tags, images,
    },
    twitter: { card: "summary_large_image", title: a.title, description: a.meta_description || a.tldr, images: coverUrl ? [coverUrl] : undefined },
  };
}

/** Markdown gerado por IA e revisado: sem HTML bruto; links externos isolados. */
function Md({ text }: { text: string }) {
  return (
    <Markdown
      components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a> }}
      urlTransform={(url) => (/^(https?:|mailto:|#|\/)/i.test(url) ? url : "")}
    >
      {text}
    </Markdown>
  );
}

export default async function ArticlePage({ params }: Params) {
  const { lang, slug } = await params;
  const data = await load(lang, slug);
  if (!data) notFound();
  const { article: a, alternates } = data;
  const t = dict[data.lang];
  const url = `${siteUrl()}/${a.lang}/${a.slug}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: a.title,
    description: a.meta_description || a.tldr,
    datePublished: a.published_at,
    inLanguage: HTML_LANG[a.lang],
    mainEntityOfPage: url,
    keywords: [...a.tags, ...a.cve_ids].join(", "),
    author: { "@type": "Organization", name: "Iron Security", url: "https://www.iron-security.com" },
    publisher: { "@type": "Organization", name: "Iron Security", logo: { "@type": "ImageObject", url: `${siteUrl()}/brand/iron-mark.png` } },
  };
  const other = a.lang === "pt" ? "en" : "pt";

  return (
    <main id="content" className="page article-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <Link href={`/${a.lang}`} className="back-link"><ArrowLeft className="icon" size={14} aria-hidden="true" /> {t.feed.title}</Link>
      <article className="article">
        <header className="article__head">
          <p className="eyebrow">{t.coverage.categories[a.category as keyof typeof t.coverage.categories] ?? a.category}</p>
          <h1 className="article__title">{a.title}</h1>
          <div className="article-item__meta">
            <SeverityBadge severity={a.severity} label={t.severity.labels[a.severity]} />
            {a.cve_ids.map((c) => <span key={c} className="chip mono">{c}</span>)}
            <time dateTime={a.published_at}>{fmtDate(a.published_at, a.lang)}</time>
            {alternates[other] && (
              <Link href={`/${other}/${alternates[other]}`} hrefLang={other} lang={other} className="article__alt">
                {other === "en" ? "Read in English" : "Ler em português"}
              </Link>
            )}
          </div>
        </header>
        <p className="article__tldr"><strong>TL;DR</strong> {a.tldr}</p>
        <div className="prose article__body"><Md text={withoutTldrSection(a.markdown)} /></div>
      </article>
    </main>
  );
}
