"use client";
import { useActionState } from "react";
import { Send } from "lucide-react";
import { publishLinkedin, type ActionState } from "./actions";

const WHERE = { member: "no perfil", organization: "na página" } as const;

/** Botão "Publicar no LinkedIn" (perfil ou página) com confirmação. As regras de verdade ficam na RPC (banco). */
export function PublishLinkedinButton({ storyId, target, account, retry }: {
  storyId: string; target: "member" | "organization"; account: string; retry: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(publishLinkedin, {});
  const where = WHERE[target];
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(`Publicar este post agora ${where} ${account} no LinkedIn? O post fica público imediatamente.`)) e.preventDefault(); }}>
      <input type="hidden" name="story_id" value={storyId} />
      <input type="hidden" name="target" value={target} />
      <button type="submit" className="button button--primary" disabled={pending || state.ok === true}>
        <Send className="icon" size={16} aria-hidden="true" /> {pending ? "Enviando…" : `${retry ? "Tentar de novo" : "Publicar"} ${where}`}
      </button>
      {state.message && <p className={state.ok ? "form__ok" : "form__error"} role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  );
}
