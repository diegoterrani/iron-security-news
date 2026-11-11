import { notFound } from "next/navigation";
import { CATEGORIES, SEVERITIES } from "@ironnews/shared";
import { dict, isLang } from "@/lib/i18n";
import { Accent } from "@/components/Accent";
import { Eyebrow } from "@/components/Eyebrow";
import { Icon, type IconName } from "@/components/Icon";
import { SeverityBadge } from "@/components/SeverityBadge";
import { ArticleCard } from "@/components/ArticleCard";
import { listArticles, type ArticleSummary } from "@/lib/blog";
import { homeJsonLd, jsonLdScript } from "@/lib/structured-data";
import { siteUrl } from "@/lib/supabase/env";

/** Fontes cadastradas em supabase/seed.sql. */
const CURATED_SOURCES = 21;

/** ISR: o executor invalida a tag "articles" ao publicar; sem isso, a página se renova em 5 min. */
export const revalidate = 300;

/** Métricas institucionais: cor neutra (acento), nunca cor de risco (risco é só para severidade). */
type Metric = { icon: IconName; label: string; value: string; hint: string };

export default async function Home({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  let articles: ArticleSummary[] = [];
  try {
    articles = await listArticles(lang);
  } catch (err) {
    // Banco indisponível no build/render: registra e mostra o estado vazio em vez de quebrar a home.
    console.error("[home] listArticles falhou:", err instanceof Error ? err.message : err);
  }

  const metrics: Metric[] = [
    { icon: "radar", label: t.metrics.sources.label, value: String(CURATED_SOURCES), hint: t.metrics.sources.hint },
    { icon: "globe", label: t.metrics.languages.label, value: t.metrics.languages.value, hint: t.metrics.languages.hint },
    { icon: "eye", label: t.metrics.review.label, value: t.metrics.review.value, hint: t.metrics.review.hint },
    { icon: "layers", label: t.metrics.data.label, value: "NVD · KEV · EPSS", hint: t.metrics.data.hint },
  ];

  return (
    <main id="content">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(homeJsonLd(siteUrl(), lang, t.meta.description)) }}
      />
      <section className="page-hero" aria-labelledby="page-title">
        <Eyebrow>{t.hero.eyebrow}</Eyebrow>
        <h1 id="page-title" className="page-hero__title"><Accent parts={t.hero.title} /></h1>
        <p className="page-hero__lead">{t.hero.subtitle}</p>
      </section>

      <section className="stat-grid" aria-label={t.hero.eyebrow}>
        {metrics.map(({ icon, label, value, hint }) => (
          <div key={label} className="stat">
            <p className="stat__label"><Icon name={icon} />{label}</p>
            <p className="stat__value">{value}</p>
            <p className="stat__hint">{hint}</p>
          </div>
        ))}
      </section>

      <section id="latest" className="section" aria-labelledby="latest-title">
        <div className="section__head section__head--row">
          <div>
            <Eyebrow>{t.feed.eyebrow}</Eyebrow>
            <h2 id="latest-title" className="h2"><Accent parts={t.feed.title} /></h2>
          </div>
          <p className="result-count">{t.feed.hint}</p>
        </div>
        {articles.length === 0 ? (
          <div className="empty">
            <Icon name="shield" className="ico empty__icon" />
            <p className="empty__title">{t.feed.emptyTitle}</p>
            <p className="empty__text">{t.feed.emptyText}</p>
          </div>
        ) : (
          <ul className="news-grid">
            {articles.map((a, i) => (
              <li key={a.id}><ArticleCard a={a} lang={lang} priority={i < 3} /></li>
            ))}
          </ul>
        )}
      </section>

      <section className="section section--soft" aria-label={t.method.eyebrow}>
        <div className="feature-grid">
          <section id="severity" className="feature" aria-labelledby="severity-title">
            <Eyebrow>{t.severity.eyebrow}</Eyebrow>
            <h2 id="severity-title" className="feature__title"><Accent parts={t.severity.title} /></h2>
            <ul className="severity-list">
              {SEVERITIES.map((s) => (
                <li key={s}>
                  <SeverityBadge severity={s} label={t.severity.labels[s]} />
                  <span>{t.severity.descriptions[s]}</span>
                </li>
              ))}
            </ul>
          </section>

          <section id="coverage" className="feature" aria-labelledby="coverage-title">
            <Eyebrow>{t.coverage.eyebrow}</Eyebrow>
            <h2 id="coverage-title" className="feature__title"><Accent parts={t.coverage.title} /></h2>
            <ul className="chips">
              {CATEGORIES.filter((c) => c !== "other").map((c) => (
                <li key={c} className="scope-chip">{t.coverage.categories[c]}</li>
              ))}
            </ul>
          </section>

          <section id="method" className="feature" aria-labelledby="method-title">
            <Eyebrow>{t.method.eyebrow}</Eyebrow>
            <h2 id="method-title" className="feature__title"><Accent parts={t.method.title} /></h2>
            <ol className="steps">
              {t.method.steps.map((step, i) => (
                <li key={step.title}>
                  <span className="steps__num" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                  <span><strong>{step.title}</strong> {step.text}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </section>
    </main>
  );
}
