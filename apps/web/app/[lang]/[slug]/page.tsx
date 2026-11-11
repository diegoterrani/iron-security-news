import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import type { Lang } from "@ironnews/shared";
import { Eyebrow } from "@/components/Eyebrow";
import { Icon } from "@/components/Icon";
import { SeverityBadge } from "@/components/SeverityBadge";
import { fmtDate, getAlternates, getArticle } from "@/lib/blog";
import { HTML_LANG, dict, isLang } from "@/lib/i18n";
import { withoutTldrSection } from "@/lib/markdown";
import { siteUrl } from "@/lib/supabase/env";
import { DEFAULT_OG_IMAGE, articleJsonLd, jsonLdScript } from "@/lib/structured-data";

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
  const coverUrl = a.cover_url;
  // Sem capa renderizada, cai na imagem padrão do blog (nunca compartilha sem imagem).
  const image = { url: coverUrl ?? DEFAULT_OG_IMAGE.url, width: 1200, height: 630, alt: coverUrl ? a.title : DEFAULT_OG_IMAGE.alt };
  const images = [image];
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
    twitter: { card: "summary_large_image", title: a.title, description: a.meta_description || a.tldr, images: [image.url] },
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
  const jsonLd = articleJsonLd(a, siteUrl());
  const other = a.lang === "pt" ? "en" : "pt";

  return (
    <main id="content" className="article-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <Link href={`/${a.lang}`} className="text-link back-link">
        <Icon name="arrow" className="ico ico--flip" /> {t.article.back}
      </Link>
      <article className="article">
        <header className="article__head">
          <Eyebrow>{t.coverage.categories[a.category as keyof typeof t.coverage.categories] ?? a.category}</Eyebrow>
          <h1 className="article__title">{a.title}</h1>
          <div className="meta-row">
            <SeverityBadge severity={a.severity} label={t.severity.labels[a.severity]} />
            {a.cve_ids.map((c) => <span key={c} className="scope-chip">{c}</span>)}
            <time dateTime={a.published_at}>{fmtDate(a.published_at, a.lang)}</time>
            {alternates[other] && (
              <Link href={`/${other}/${alternates[other]}`} hrefLang={other} lang={other} className="text-link article__alt">
                {t.article.readOther}
              </Link>
            )}
          </div>
        </header>
        {a.cover_url && (
          <figure className="article__cover">
            {/* Criativo `cover` do idioma da página, gerado junto com a story (o texto já está no título acima). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.cover_url} alt="" width={1200} height={630} fetchPriority="high" decoding="async" />
          </figure>
        )}
        <p className="article__tldr"><strong>{t.article.tldr}</strong> {a.tldr}</p>
        <div className="prose article__body"><Md text={withoutTldrSection(a.markdown)} /></div>
      </article>
    </main>
  );
}
