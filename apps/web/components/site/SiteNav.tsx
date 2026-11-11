"use client";

import { useEffect, useId, useState } from "react";
import { usePathname } from "next/navigation";
import { LANGS, type Lang } from "@ironnews/shared";
import { Icon } from "@/components/Icon";
import { IRON_LINKS } from "@/lib/links";

type Labels = {
  main: string; latest: string; coverage: string; method: string; site: string; domainCheck: string;
  academy: string; contact: string; language: string; menuOpen: string; menuClose: string;
};

/** Breakpoint do design system abaixo do qual a navegação vira menu (mesmo valor do CSS). */
const MOBILE_MAX = 980;

/**
 * Navegação do blog com o padrão do site institucional: links inline acima de 980px e, abaixo,
 * painel aberto por um botão de 44px (aria-expanded/aria-controls). Fecha com Esc, ao trocar de
 * rota, ao clicar num link e ao voltar para a largura de desktop.
 */
export function SiteNav({ lang, labels }: { lang: Lang; labels: Labels }) {
  const panelId = useId();
  const pathname = usePathname();
  // O menu guarda a rota em que foi aberto: mudou de rota, fecha sem efeito extra.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenAt(null); };
    const onResize = () => { if (window.innerWidth > MOBILE_MAX) setOpenAt(null); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const close = () => setOpenAt(null);

  return (
    <>
      <nav id={panelId} className={`site-nav${open ? " is-open" : ""}`} aria-label={labels.main}>
        <ul>
          <li><a href={`/${lang}#latest`} onClick={close}>{labels.latest}</a></li>
          <li><a href={`/${lang}#coverage`} onClick={close}>{labels.coverage}</a></li>
          <li><a href={`/${lang}#method`} onClick={close}>{labels.method}</a></li>
          <li><a href={IRON_LINKS.site} onClick={close}>{labels.site}</a></li>
          <li><a href={IRON_LINKS.domainCheck} onClick={close}>{labels.domainCheck}</a></li>
          <li><a href={IRON_LINKS.academy} onClick={close}>{labels.academy}</a></li>
        </ul>
        <div className="lang-switch" role="group" aria-label={labels.language}>
          {LANGS.map((l) => (
            <a
              key={l}
              href={`/${l}`}
              hrefLang={l}
              lang={l}
              className="lang-switch__item"
              aria-current={l === lang ? "true" : undefined}
              onClick={close}
            >
              {l.toUpperCase()}
            </a>
          ))}
        </div>
        <a className="button button-primary site-nav__cta" href={IRON_LINKS.contact} onClick={close}>
          {labels.contact}
          <Icon name="arrow" />
        </a>
      </nav>
      <button
        type="button"
        className="nav-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? labels.menuClose : labels.menuOpen}
        onClick={() => setOpenAt(open ? null : pathname)}
      >
        <Icon name="menu" className="ico ico-open" />
        <Icon name="x" className="ico ico-close" />
      </button>
    </>
  );
}
