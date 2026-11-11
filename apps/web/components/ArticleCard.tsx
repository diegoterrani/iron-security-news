import Image from "next/image";
import Link from "next/link";
import type { Lang } from "@ironnews/shared";
import mark from "@/public/brand/iron-mark.png";
import { Icon } from "@/components/Icon";
import { SeverityBadge } from "@/components/SeverityBadge";
import { fmtDate, type ArticleSummary } from "@/lib/blog";
import { dict } from "@/lib/i18n";

/**
 * Célula da grade de notícias (padrão FeatureGrid do design system: hairlines, raio 0, sem sombra,
 * hover só troca o fundo para --deep-2). O link fica no título e cobre a célula inteira.
 */
export function ArticleCard({ a, lang, priority = false }: { a: ArticleSummary; lang: Lang; priority?: boolean }) {
  const t = dict[lang];
  const category = t.coverage.categories[a.category as keyof typeof t.coverage.categories] ?? a.category;
  return (
    <article className="news-card">
      <div className="news-card__media">
        {a.cover_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- imagem do Storage (já otimizada, nome com hash)
          <img src={a.cover_url} alt="" width={1200} height={630} loading={priority ? "eager" : "lazy"} decoding="async" />
        ) : (
          <div className="news-card__placeholder" aria-hidden="true">
            <Image src={mark} alt="" height={48} />
          </div>
        )}
      </div>
      <div className="news-card__body">
        <div className="meta-row">
          <SeverityBadge severity={a.severity} label={t.severity.labels[a.severity]} />
          <span className="product-tag">{category}</span>
        </div>
        <h3 className="news-card__title">
          <Link href={`/${lang}/${a.slug}`} className="news-card__link">{a.title}</Link>
        </h3>
        <p className="news-card__tldr">{a.tldr}</p>
        <div className="news-card__foot">
          <time dateTime={a.published_at}>{fmtDate(a.published_at, lang)}</time>
          <span className="text-link" aria-hidden="true">
            {t.feed.readMore} <Icon name="arrow" />
          </span>
        </div>
      </div>
    </article>
  );
}
