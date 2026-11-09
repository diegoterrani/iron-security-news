"use client";
import { useActionState, useState } from "react";
import { Check, Pencil, Save, X } from "lucide-react";
import { approveStory, editContent, rejectStory, type ActionState } from "./actions";

function Feedback({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return <p className={state.ok ? "form__ok" : "form__error"} role={state.ok ? "status" : "alert"}>{state.message}</p>;
}

export function ReviewActions({ storyId }: { storyId: string }) {
  const [approveState, approve, approving] = useActionState<ActionState, FormData>(approveStory, {});
  const [rejectState, reject, rejecting] = useActionState<ActionState, FormData>(rejectStory, {});
  const [showReject, setShowReject] = useState(false);
  return (
    <div className="review-actions">
      <form action={approve} onSubmit={(e) => { if (!confirm("Aprovar esta story? Ela segue para a agenda de publicação.")) e.preventDefault(); }}>
        <input type="hidden" name="story_id" value={storyId} />
        <button type="submit" className="button button--primary" disabled={approving}>
          <Check className="icon" size={16} aria-hidden="true" /> {approving ? "Aprovando…" : "Aprovar"}
        </button>
      </form>
      {!showReject ? (
        <button type="button" className="button" onClick={() => setShowReject(true)}>
          <X className="icon" size={16} aria-hidden="true" /> Rejeitar
        </button>
      ) : (
        <form action={reject} className="form form--inline">
          <input type="hidden" name="story_id" value={storyId} />
          <label className="sr-only" htmlFor="reason">Motivo da rejeição</label>
          <input id="reason" name="reason" className="input" required minLength={3} maxLength={500} placeholder="Motivo (fica registrado)" />
          <button type="submit" className="button button--danger" disabled={rejecting}>{rejecting ? "Rejeitando…" : "Confirmar rejeição"}</button>
          <button type="button" className="button" onClick={() => setShowReject(false)}>Cancelar</button>
        </form>
      )}
      <Feedback state={approveState} />
      <Feedback state={rejectState} />
    </div>
  );
}

export interface EditField {
  name: string;
  label: string;
  value: string;
  rows?: number;
}

export function EditForm(props: { storyId: string; channel: string; lang: string; kind: string; title?: string | null; fields: EditField[] }) {
  const [state, action, saving] = useActionState<ActionState, FormData>(editContent, {});
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <>
        <button type="button" className="button" onClick={() => setOpen(true)}>
          <Pencil className="icon" size={16} aria-hidden="true" /> Editar
        </button>
        <Feedback state={state} />
      </>
    );
  }
  return (
    <form action={action} className="form" onSubmit={() => setTimeout(() => setOpen(false), 0)}>
      <input type="hidden" name="story_id" value={props.storyId} />
      <input type="hidden" name="channel" value={props.channel} />
      <input type="hidden" name="lang" value={props.lang} />
      <input type="hidden" name="kind" value={props.kind} />
      {props.title !== undefined && (
        <>
          <label className="form__label" htmlFor={`title-${props.channel}-${props.lang}`}>Título</label>
          <input id={`title-${props.channel}-${props.lang}`} name="title" className="input" defaultValue={props.title ?? ""} maxLength={120} />
        </>
      )}
      {props.fields.map((f) => (
        <div key={f.name}>
          <label className="form__label" htmlFor={`${f.name}-${props.channel}-${props.lang}`}>{f.label}</label>
          <textarea id={`${f.name}-${props.channel}-${props.lang}`} name={f.name} className="input textarea" rows={f.rows ?? 4} defaultValue={f.value} />
        </div>
      ))}
      <div className="review-actions">
        <button type="submit" className="button button--primary" disabled={saving}>
          <Save className="icon" size={16} aria-hidden="true" /> {saving ? "Salvando…" : "Salvar nova versão"}
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)}>Cancelar</button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
