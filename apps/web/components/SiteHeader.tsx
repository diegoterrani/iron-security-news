import { LANGS, type Lang } from "@ironnews/shared";
import { Brand } from "./Brand";
import { dict } from "@/lib/i18n";

export function SiteHeader({ lang }: { lang: Lang }) {
  const t = dict[lang];
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Brand href={`/${lang}`} byline={t.byline} />
        <nav className="site-nav" aria-label={lang === "pt" ? "Principal" : "Main"}>
          <a className="site-nav__link" href={`/${lang}#latest`}>{t.nav.latest}</a>
          <a className="site-nav__link" href={`/${lang}#coverage`}>{t.nav.coverage}</a>
          <a className="site-nav__link" href={`/${lang}#method`}>{t.nav.method}</a>
        </nav>
        <nav className="segmented" aria-label={t.nav.language}>
          {LANGS.map((l) => (
            <a
              key={l}
              href={`/${l}`}
              hrefLang={l}
              lang={l}
              className="segmented__item"
              aria-current={l === lang ? "true" : undefined}
            >
              {l.toUpperCase()}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
