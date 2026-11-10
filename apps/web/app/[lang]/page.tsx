import { notFound } from "next/navigation";
import { CATEGORIES, SEVERITIES } from "@ironnews/shared";
import { Database, Languages, Radar, Radio, ShieldCheck, UserCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { dict, isLang } from "@/lib/i18n";
import { SeverityBadge } from "@/components/SeverityBadge";
import { fmtDate, listArticles, type ArticleSummary } from "@/lib/blog";

/** Fontes cadastradas em supabase/seed.sql. */
const CURATED_SOURCES = 21;

/** ISR: o executor invalida a tag "articles" ao publicar; sem isso, a página se renova em 5 min. */
export const revalidate = 300;

type Metric = { tone: string; icon: LucideIcon; label: string; value: string; hint: string };

export default async function Home({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  let articles: ArticleSummary[] = [];
  try {
    articles = await listArticles(lang);
  } catch {
    // Banco indisponível no build/render: mostra o estado vazio em vez de quebrar a home.
  }

  const metrics: Metric[] = [
    { tone: "cyan", icon: Radar, label: t.metrics.sources.label, value: String(CURATED_SOURCES), hint: t.metrics.sources.hint },
    { tone: "accepted", icon: Languages, label: t.metrics.languages.label, value: t.metrics.languages.value, hint: t.metrics.languages.hint },
    { tone: "low", icon: UserCheck, label: t.metrics.review.label, value: t.metrics.review.value, hint: t.metrics.review.hint },
    { tone: "medium", icon: Database, label: t.metrics.data.label, value: "NVD · KEV · EPSS", hint: t.metrics.data.hint },
  ];

  return (
    <main id="content" className="page">
      <section className="page-head" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">
            <Radio className="icon" size={14} aria-hidden="true" />
            {t.hero.eyebrow}
          </p>
          <h1 id="page-title" className="page-title">{t.hero.title}</h1>
          <p className="page-subtitle">{t.hero.subtitle}</p>
        </div>
      </section>

      <section className="grid-metrics" aria-label={t.hero.eyebrow}>
        {metrics.map(({ tone, icon: Icon, label, value, hint }) => (
          <article key={label} className={`metric-card metric-card--${tone}`}>
            <div className="metric-card__top">
              <span className="metric-card__label">{label}</span>
              <Icon className="icon metric-card__icon" size={18} aria-hidden="true" />
            </div>
            <div>
              <div className="metric-card__value">{value}</div>
              <div className="metric-card__hint">{hint}</div>
            </div>
          </article>
        ))}
      </section>

      <div className="grid-main">
        <section id="latest" className="panel panel--feed" aria-labelledby="latest-title">
          <div className="section-head">
            <h2 id="latest-title" className="section-title">{t.feed.title}</h2>
            <span className="section-hint">{t.feed.hint}</span>
          </div>
          {articles.length === 0 ? (
            <div className="empty">
              <span className="empty__icon" aria-hidden="true">
                <ShieldCheck className="icon" size={22} />
              </span>
              <p className="empty__title">{t.feed.emptyTitle}</p>
              <p className="empty__text">{t.feed.emptyText}</p>
            </div>
          ) : (
            <ul className="article-list">
              {articles.map((a) => (
                <li key={a.id} className="article-item">
                  <div className="article-item__meta">
                    <SeverityBadge severity={a.severity} label={t.severity.labels[a.severity]} />
                    <span className="article-item__kicker">{t.coverage.categories[a.category as keyof typeof t.coverage.categories] ?? a.category}</span>
                    <time dateTime={a.published_at}>{fmtDate(a.published_at, lang)}</time>
                  </div>
                  <h3 className="article-item__title"><Link href={`/${lang}/${a.slug}`}>{a.title}</Link></h3>
                  <p className="article-item__tldr">{a.tldr}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="stack">
          <section className="panel" aria-labelledby="severity-title">
            <h2 id="severity-title" className="section-title section-head">{t.severity.title}</h2>
            <ul className="severity-list">
              {SEVERITIES.map((s) => (
                <li key={s} className="severity-list__item">
                  <span><SeverityBadge severity={s} label={t.severity.labels[s]} /></span>
                  <span>{t.severity.descriptions[s]}</span>
                </li>
              ))}
            </ul>
          </section>

          <section id="coverage" className="panel" aria-labelledby="coverage-title">
            <h2 id="coverage-title" className="section-title section-head">{t.coverage.title}</h2>
            <ul className="chips">
              {CATEGORIES.filter((c) => c !== "other").map((c) => (
                <li key={c} className="chip">{t.coverage.categories[c]}</li>
              ))}
            </ul>
          </section>

          <section id="method" className="panel" aria-labelledby="method-title">
            <h2 id="method-title" className="section-title section-head">{t.method.title}</h2>
            <ol className="steps">
              {t.method.steps.map((step) => (
                <li key={step.title} className="steps__item">
                  <span>
                    <strong>{step.title}</strong>
                    {step.text}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </main>
  );
}
