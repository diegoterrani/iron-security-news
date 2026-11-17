"use client";
import { useActionState, useState } from "react";
import { FileText, Link2, Sparkles } from "lucide-react";
import { requestManualStory, type ManualState } from "./actions";

/** Link OU texto. O conteúdo enviado é tratado como fonte não confiável pelo redator (mesmo prompt das demais). */
export function ManualForm() {
  const [state, action, pending] = useActionState<ManualState, FormData>(requestManualStory, {});
  const [kind, setKind] = useState<"url" | "text">("url");
  return (
    <form action={action} className="form" autoComplete="off">
      <input type="hidden" name="kind" value={kind} />
      <div className="segmented" role="tablist" aria-label="Tipo de entrada">
        <button type="button" role="tab" className="segmented__item" aria-selected={kind === "url"} aria-current={kind === "url" ? "true" : undefined} onClick={() => setKind("url")}>
          <Link2 className="icon" size={14} aria-hidden="true" /> Link da notícia
        </button>
        <button type="button" role="tab" className="segmented__item" aria-selected={kind === "text"} aria-current={kind === "text" ? "true" : undefined} onClick={() => setKind("text")}>
          <FileText className="icon" size={14} aria-hidden="true" /> Colar texto
        </button>
      </div>

      {kind === "url" ? (
        <>
          <label className="form__label" htmlFor="manual-url">Link da notícia (https)</label>
          <input id="manual-url" name="url" type="url" className="input" required maxLength={2048} inputMode="url"
            placeholder="https://www.exemplo.com/noticia" spellCheck={false} />
          <p className="section-hint">O servidor abre o link e lê a matéria. Se o site tiver paywall ou bloquear robôs, use “Colar texto”.</p>
        </>
      ) : (
        <>
          <label className="form__label" htmlFor="manual-text">Texto da notícia</label>
          <textarea id="manual-text" name="text" className="input textarea" required minLength={200} maxLength={60000} rows={12}
            placeholder="A primeira linha vira o título provisório. Cole a matéria completa: números e CVEs só entram no artigo se estiverem aqui." />
          <div className="form--inline">
            <label className="sr-only" htmlFor="manual-source-name">Nome da fonte</label>
            <input id="manual-source-name" name="source_name" className="input" maxLength={120} placeholder="Nome da fonte (ex.: Reuters) — opcional" />
            <label className="sr-only" htmlFor="manual-source-url">Link da fonte</label>
            <input id="manual-source-url" name="source_url" type="url" className="input" maxLength={2048} placeholder="Link da fonte — opcional" spellCheck={false} />
          </div>
        </>
      )}

      <div>
        <button type="submit" className="button button--primary" disabled={pending}>
          <Sparkles className="icon" size={16} aria-hidden="true" /> {pending ? "Enviando…" : "Gerar notícia"}
        </button>
      </div>
      {state.message && <p className={state.ok ? "form__ok" : "form__error"} role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  );
}
