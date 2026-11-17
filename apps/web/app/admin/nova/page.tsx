import type { Metadata } from "next";
import Link from "next/link";
import { getViewer, listManualRequests, type ManualRequestRow } from "@/lib/admin/data";
import { STATUS_LABEL, fmtDateTime } from "@/lib/admin/labels";
import { ManualForm } from "./ManualForm";

export const metadata: Metadata = { title: "Nova notícia" };
export const dynamic = "force-dynamic";

const REQUEST_LABEL: Record<ManualRequestRow["status"], string> = {
  pending: "Na fila", processing: "Lendo e classificando", done: "Story criada", failed: "Falhou",
};

function what(r: ManualRequestRow): string {
  if (r.kind === "url" && r.input_url) {
    try {
      const u = new URL(r.input_url);
      return `${u.hostname.replace(/^www\./, "")}${u.pathname.length > 1 ? u.pathname.slice(0, 60) : ""}`;
    } catch {
      return r.input_url.slice(0, 80);
    }
  }
  return `Texto colado${r.source_name ? ` · ${r.source_name}` : ""}`;
}

export default async function NewStoryPage() {
  const [viewer, requests] = await Promise.all([getViewer(), listManualRequests().catch(() => [])]);
  const canSubmit = viewer?.role === "admin" || viewer?.role === "editor";
  return (
    <>
      <header className="admin-header">
        <div>
          <h1 className="admin-header__title">Nova notícia</h1>
          <p className="admin-header__subtitle">Cole um link ou um texto: o agente escreve o artigo PT/EN, os posts e os criativos no padrão das demais e manda para a revisão</p>
        </div>
      </header>
      <main id="content" className="admin-main admin-main--narrow">
        <section className="panel" aria-labelledby="nova-form">
          <h2 id="nova-form" className="section-title">Enviar pauta</h2>
          <p className="section-hint">
            Mesmo redator, mesmo Fact Guard e mesmos derivados da seleção diária. Nada é publicado sem aprovação na fila de revisão.
            Limite: 5 pedidos em andamento e 30 por dia.
          </p>
          {canSubmit ? <ManualForm /> : <p className="form__error" role="alert">É preciso ser editor ou admin para enviar pautas.</p>}
        </section>

        <section className="panel" aria-labelledby="nova-lista">
          <h2 id="nova-lista" className="section-title">Últimos pedidos</h2>
          {requests.length === 0 ? (
            <p className="section-hint">Nenhum pedido ainda.</p>
          ) : (
            <ul className="source-list">
              {requests.map((r) => (
                <li key={r.id}>
                  {r.story_id ? <Link href={`/admin/stories/${r.story_id}`}>{what(r)}</Link> : <span>{what(r)}</span>}
                  <span className="story-card__meta">
                    {" · "}{r.stories ? STATUS_LABEL[r.stories.status] : REQUEST_LABEL[r.status]}
                    {" · "}{fmtDateTime(r.created_at)}
                    {r.error ? ` · ${r.error}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
