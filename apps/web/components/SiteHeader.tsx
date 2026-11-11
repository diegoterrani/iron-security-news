import type { Lang } from "@ironnews/shared";
import { Brand } from "./Brand";
import { SiteNav } from "./site/SiteNav";
import { dict } from "@/lib/i18n";

/** Header do blog no padrão do site institucional: 84px, hairline branca, gutter do sistema. */
export function SiteHeader({ lang }: { lang: Lang }) {
  const t = dict[lang];
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Brand href={`/${lang}`} byline={t.byline} />
        <SiteNav lang={lang} labels={t.nav} />
      </div>
    </header>
  );
}
