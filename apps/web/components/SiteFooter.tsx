import type { Lang } from "@ironnews/shared";
import { Info } from "lucide-react";
import { dict } from "@/lib/i18n";

export function SiteFooter({ lang }: { lang: Lang }) {
  const t = dict[lang];
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="disclaimer">
          <Info className="icon" size={16} aria-hidden="true" />
          <span>{t.footer.disclaimer}</span>
        </p>
        <div className="site-footer__meta">
          <span>© {new Date().getFullYear()} Iron Security</span>
          <span>{t.footer.rights}</span>
        </div>
      </div>
    </footer>
  );
}
