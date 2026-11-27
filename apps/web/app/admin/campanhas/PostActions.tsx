"use client";
import { useActionState } from "react";
import { RotateCcw, X } from "lucide-react";
import { cancelCampaignPost, retryCampaignPost, type CampaignActionState } from "./actions";

/** Cancelar (agendada) ou tentar de novo (falhou/cancelada). As regras de verdade ficam nas RPCs. */
export function PostActions({ id, status }: { id: string; status: string }) {
  const [cancelState, cancel, cancelling] = useActionState<CampaignActionState, FormData>(cancelCampaignPost, {});
  const [retryState, retry, retrying] = useActionState<CampaignActionState, FormData>(retryCampaignPost, {});
  const state = cancelState.message ? cancelState : retryState;
  if (status !== "pending" && status !== "failed" && status !== "skipped") return null;
  return (
    <div className="review-actions">
      {status === "pending" ? (
        <form action={cancel} onSubmit={(e) => { if (!confirm("Cancelar esta publicação?")) e.preventDefault(); }}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="button button--danger" disabled={cancelling || cancelState.ok === true}>
            <X className="icon" size={14} aria-hidden="true" /> Cancelar
          </button>
        </form>
      ) : (
        <form action={retry} onSubmit={(e) => {
          if (!confirm(status === "failed"
            ? "Tentar de novo agora? Se o erro foi \"Publicação interrompida\", confira antes na rede se o post já saiu, para não duplicar."
            : "Publicar agora?")) e.preventDefault();
        }}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="button" disabled={retrying || retryState.ok === true}>
            <RotateCcw className="icon" size={14} aria-hidden="true" /> {status === "failed" ? "Tentar de novo" : "Publicar agora"}
          </button>
        </form>
      )}
      {state.message && <p className={state.ok ? "form__ok" : "form__error"} role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </div>
  );
}
