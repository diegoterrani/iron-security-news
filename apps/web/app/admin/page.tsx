import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Inbox } from "lucide-react";
import type { StoryStatus } from "@ironnews/shared";
import { SeverityBadge } from "@/components/SeverityBadge";
import { getViewer, listStories } from "@/lib/admin/data";
import { CATEGORY_LABEL, SEVERITY_LABEL, STATUS_LABEL, fmtDateTime } from "@/lib/admin/labels";

export const metadata: Metadata = { title: { absolute: "Fila de revisão · Admin · IRON CYBER NEWS" } };
export const dynamic = "force-dynamic";

const TABS: { key: string; label: string; statuses: StoryStatus[] }[] = [
  { key: "fila", label: "Aguardando revisão", statuses: ["AWAITING_REVIEW"] },
  { key: "em-producao", label: "Em produção", statuses: ["DRAFTING"] },
  { key: "aprovadas", label: "Aprovadas", statuses: ["APPROVED", "SCHEDULED", "PUBLISHING", "PUBLISHED", "PARTIAL"] },
  { key: "rejeitadas", label: "Rejeitadas / falhas", statuses: ["REJECTED", "FAILED"] },
];

export default async function ReviewQueue({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const { aba } = await searchParams;
  const tab = TABS.find((t) => t.key === aba) ?? TABS[0]!;
  const [viewer, stories] = await Promise.all([getViewer(), listStories(tab.statuses)]);

  return (
    <>
      <header className="admin-header">
        <div>
          <h1 className="admin-header__title">Fila de revisão</h1>
          <p className="admin-header__subtitle">Aprovar, editar ou rejeitar o conteúdo gerado antes da publicação</p>
        </div>
      </header>
      <main id="content" className="admin-main">
        {viewer && !viewer.role && (
          <p className="form__error" role="alert">Seu usuário não tem papel atribuído. Peça a um admin para liberar o acesso.</p>
        )}
        <nav className="segmented" aria-label="Filtrar stories">
          {TABS.map((t) => (
            <Link key={t.key} href={`/admin?aba=${t.key}`} className="segmented__item" aria-current={t.key === tab.key ? "page" : undefined}>
              {t.label}
            </Link>
          ))}
        </nav>
        <section className="panel panel--feed" aria-label={tab.label}>
          {stories.length === 0 ? (
            <div className="empty">
              <span className="empty__icon" aria-hidden="true"><Inbox className="icon" size={22} /></span>
              <p className="empty__title">Nada aqui</p>
              <p className="empty__text">A seleção diária roda às 06:00 (Brasília); as stories aparecem nesta fila quando o conteúdo fica pronto.</p>
            </div>
          ) : (
            <ul className="story-list">
              {stories.map((s) => (
                <li key={s.id}>
                  <Link href={`/admin/stories/${s.id}`} className="story-card">
                    <div className="story-card__top">
                      <SeverityBadge severity={s.severity} label={SEVERITY_LABEL[s.severity]} />
                      <span className="chip">{CATEGORY_LABEL[s.category] ?? s.category}</span>
                      <span className="chip mono">score {Number(s.score).toFixed(1)}</span>
                      {s.fact_guard?.passed === false && (
                        <span className="chip chip--warn"><AlertTriangle className="icon" size={12} aria-hidden="true" /> Fact Guard reprovou</span>
                      )}
                      {s.fact_guard?.passed === true && (
                        <span className="chip chip--ok"><CheckCircle2 className="icon" size={12} aria-hidden="true" /> Fact Guard ok</span>
                      )}
                    </div>
                    <p className="story-card__title">{s.title ?? "(sem título ainda)"}</p>
                    <p className="story-card__meta">
                      {STATUS_LABEL[s.status]} · criada {fmtDateTime(s.created_at)}
                      {s.status === "REJECTED" && s.rejected_reason ? ` · motivo: ${s.rejected_reason}` : ""}
                      {s.status === "FAILED" && s.error ? ` · ${s.error}` : ""}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
