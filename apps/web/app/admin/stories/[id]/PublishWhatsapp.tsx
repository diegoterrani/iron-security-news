"use client";
import { useActionState } from "react";
import { Send } from "lucide-react";
import { publishWhatsapp, type ActionState } from "./actions";

/** Botão "Enviar ao grupo do WhatsApp" com confirmação. As regras de verdade ficam na RPC (banco). */
export function PublishWhatsappButton({ storyId, retry }: { storyId: string; retry: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(publishWhatsapp, {});
  return (
    <form action={action} onSubmit={(e) => { if (!confirm("Enviar esta notícia (capa, resumo e link) ao grupo do WhatsApp agora? Todos os membros recebem na hora.")) e.preventDefault(); }}>
      <input type="hidden" name="story_id" value={storyId} />
      <button type="submit" className="button button--primary" disabled={pending || state.ok === true}>
        <Send className="icon" size={16} aria-hidden="true" /> {pending ? "Enviando…" : retry ? "Tentar de novo no WhatsApp" : "Enviar ao grupo do WhatsApp"}
      </button>
      {state.message && <p className={state.ok ? "form__ok" : "form__error"} role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  );
}
