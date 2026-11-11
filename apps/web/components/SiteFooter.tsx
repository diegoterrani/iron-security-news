import type { Lang } from "@ironnews/shared";
import { Brand } from "./Brand";
import { Icon } from "./Icon";
import { dict } from "@/lib/i18n";
import { IRON_LINKS } from "@/lib/links";

/**
 * Footer no padrão do site (grade de colunas, títulos mono, hairline e linha inferior), com o aviso
 * de conteúdo gerado com IA e a identificação do controlador exigida pela LGPD.
 */
export function SiteFooter({ lang }: { lang: Lang }) {
  const t = dict[lang];
  const f = t.footer;
  return (
    <footer className="footer">
      <div className="footer__grid">
        <div className="footer__brand">
          <Brand href={`/${lang}`} byline={t.byline} />
          <p>{f.about}</p>
          <a className="footer__mail" href={`mailto:${IRON_LINKS.email}`}>
            <Icon name="mail" />
            {IRON_LINKS.email}
          </a>
        </div>
        <nav aria-labelledby="footer-iron">
          <p className="footer__title" id="footer-iron">{f.colIron}</p>
          <ul>
            <li><a href={IRON_LINKS.site}>www.iron-security.com</a></li>
            <li><a href={IRON_LINKS.domainCheck}>{t.nav.domainCheck}</a></li>
            <li><a href={IRON_LINKS.academy}>{t.nav.academy}</a></li>
          </ul>
        </nav>
        <nav aria-labelledby="footer-blog">
          <p className="footer__title" id="footer-blog">{f.colBlog}</p>
          <ul>
            <li><a href={`/${lang}#latest`}>{t.nav.latest}</a></li>
            <li><a href={`/${lang}#coverage`}>{t.nav.coverage}</a></li>
            <li><a href={`/${lang}#method`}>{t.nav.method}</a></li>
            <li><a href={`/${lang}/rss.xml`} type="application/rss+xml">{f.rss}</a></li>
          </ul>
        </nav>
        <nav aria-labelledby="footer-contact">
          <p className="footer__title" id="footer-contact">{f.colContact}</p>
          <ul>
            <li><a href={IRON_LINKS.contact}>{f.specialist}</a></li>
            <li><a href={`mailto:${IRON_LINKS.email}`}>{IRON_LINKS.email}</a></li>
          </ul>
        </nav>
      </div>
      <div className="footer__notes">
        <p><strong>IA</strong> {f.disclaimer}</p>
        <p id="privacidade"><strong>{f.privacyTitle}</strong> {f.privacy}</p>
      </div>
      <div className="footer__bottom">
        <span>© {new Date().getFullYear()} Iron Security. {f.rights}</span>
        <span>{f.location}</span>
      </div>
    </footer>
  );
}
