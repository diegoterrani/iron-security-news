import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import {
  CalendarClock, CheckCheck, Coins, Inbox, KeyRound, Plug, Rss, Users, Video, Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { inter } from "@/lib/fonts";
import { Brand } from "@/components/Brand";
import { getViewer } from "@/lib/admin/data";
import "../iron.css";

export const metadata: Metadata = {
  title: { default: "Admin · IRON CYBER NEWS", template: "%s · Admin · IRON CYBER NEWS" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#050607", colorScheme: "dark" };

type NavItem = { label: string; icon: LucideIcon; href?: string };

const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: "Revisão",
    items: [
      { label: "Fila de revisão", icon: Inbox, href: "/admin" },
      { label: "Agendadas", icon: CalendarClock },
      { label: "Publicadas", icon: CheckCheck },
    ],
  },
  {
    title: "Pipeline",
    items: [
      { label: "Fontes", icon: Rss },
      { label: "Execuções", icon: Workflow },
      { label: "Custos de IA", icon: Coins },
    ],
  },
  {
    title: "Configuração",
    items: [
      { label: "Avatares HeyGen", icon: Video },
      { label: "Integrações", icon: Plug },
      { label: "Usuários", icon: Users },
      { label: "Segurança", icon: KeyRound },
    ],
  },
];

const ROLE_LABEL = { admin: "Admin", editor: "Editor", viewer: "Leitor" } as const;

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer().catch(() => null);
  return (
    <html lang="pt-BR" className={inter.variable}>
      <body>
        <a className="skip-link" href="#content">Pular para o conteúdo</a>
        <div className="shell">
          <aside className="sidebar" aria-label="Navegação do painel">
            <div className="sidebar__brand">
              <Brand href="/admin" byline="Painel editorial" />
            </div>
            {NAV.map((group) => (
              <nav key={group.title} className="nav-group" aria-label={group.title}>
                <p className="nav-group__title">{group.title}</p>
                <ul>
                  {group.items.map(({ label, icon: Icon, href }) => (
                    <li key={label}>
                      {href ? (
                        <a className="nav-item" href={href}>
                          <Icon className="icon" size={16} aria-hidden="true" />
                          {label}
                        </a>
                      ) : (
                        <span className="nav-item" aria-disabled="true">
                          <Icon className="icon" size={16} aria-hidden="true" />
                          {label}
                          <span className="nav-item__tag">Em breve</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
            {viewer && (
              <div className="sidebar__user">
                <span>{viewer.email}{viewer.role ? ` · ${ROLE_LABEL[viewer.role]}` : ""}</span>
                <form action="/admin/logout" method="post">
                  <button type="submit" className="button">Sair</button>
                </form>
              </div>
            )}
          </aside>
          <div>{children}</div>
        </div>
      </body>
    </html>
  );
}
