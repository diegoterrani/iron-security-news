/**
 * Ícones oficiais IRON (19 símbolos, traço 1.8 herdado de .ico), copiados de
 * diegoterrani/IronSecurity-WebSite-New@04d3a7c:apps/site/components/Icon.tsx.
 * Substituem o lucide-react nas páginas públicas: o design system não admite outro conjunto.
 */
export const ICON_NAMES = [
  "alert", "arrow", "chat", "chevron", "clock", "globe", "link", "search", "check", "eye",
  "layers", "lock", "mail", "menu", "radar", "shield", "spark", "target", "x",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** Ícone decorativo via <use> do sprite renderizado uma vez no layout público. */
export function Icon({ name, className = "ico" }: { name: IconName; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  );
}

/** Sprite com os símbolos usados no site. Renderizado uma vez em app/[lang]/layout.tsx. */
export function IconSprite() {
  return (
    <svg className="sprite" aria-hidden="true" focusable="false">
      <symbol id="i-alert" viewBox="0 0 24 24">
        <path d="M10.3 3.8 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </symbol>
      <symbol id="i-arrow" viewBox="0 0 24 24">
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </symbol>
      <symbol id="i-chat" viewBox="0 0 24 24">
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.5-4.7A8 8 0 1 1 21 12Z" />
      </symbol>
      <symbol id="i-chevron" viewBox="0 0 24 24">
        <path d="m9 18 6-6-6-6" />
      </symbol>
      <symbol id="i-clock" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </symbol>
      <symbol id="i-globe" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
      </symbol>
      <symbol id="i-link" viewBox="0 0 24 24">
        <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1" />
        <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1" />
      </symbol>
      <symbol id="i-search" viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </symbol>
      <symbol id="i-check" viewBox="0 0 24 24">
        <path d="m5 12 4 4L19 6" />
      </symbol>
      <symbol id="i-eye" viewBox="0 0 24 24">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </symbol>
      <symbol id="i-layers" viewBox="0 0 24 24">
        <path d="m12 2 9 5-9 5-9-5 9-5Z" />
        <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
      </symbol>
      <symbol id="i-lock" viewBox="0 0 24 24">
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </symbol>
      <symbol id="i-mail" viewBox="0 0 24 24">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </symbol>
      <symbol id="i-menu" viewBox="0 0 24 24">
        <path d="M4 7h16M4 12h16M4 17h16" />
      </symbol>
      <symbol id="i-radar" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <path d="M12 12 19 5M12 3v2M3 12h2" />
      </symbol>
      <symbol id="i-shield" viewBox="0 0 24 24">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        <path d="m9 12 2 2 4-4" />
      </symbol>
      <symbol id="i-spark" viewBox="0 0 24 24">
        <path d="m12 3-1.2 4.8L6 9l4.8 1.2L12 15l1.2-4.8L18 9l-4.8-1.2L12 3Z" />
        <path d="m5 15-.6 2.4L2 18l2.4.6L5 21l.6-2.4L8 18l-2.4-.6L5 15Z" />
      </symbol>
      <symbol id="i-target" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4" />
        <path d="M12 3v3M21 12h-3" />
      </symbol>
      <symbol id="i-x" viewBox="0 0 24 24">
        <path d="m6 6 12 12M18 6 6 18" />
      </symbol>
    </svg>
  );
}
