"use client";
import { useActionState } from "react";
import { Send } from "lucide-react";
import { publishInstagram, type ActionState } from "./actions";

/** Botão "Publicar no Instagram" com confirmação. As regras de verdade ficam na RPC (banco). */
export function PublishInstagramButton({ storyId, account, retry }: { storyId: string; account: string; retry: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(publishInstagram, {});
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(`Publicar este carrossel agora em @${account}? O post fica público imediatamente.`)) e.preventDefault(); }}>
      <input type="hidden" name="story_id" value={storyId} />
      <button type="submit" className="button button--primary" disabled={pending || state.ok === true}>
        <Send className="icon" size={16} aria-hidden="true" /> {pending ? "Enviando…" : retry ? "Tentar de novo no Instagram" : "Publicar no Instagram"}
      </button>
      {state.message && <p className={state.ok ? "form__ok" : "form__error"} role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  );
}
