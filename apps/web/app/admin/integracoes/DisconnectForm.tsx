"use client";
import { useActionState } from "react";
import { Unplug } from "lucide-react";
import { disconnectIntegration, type ActionState } from "./actions";

export function DisconnectForm({ channel, lang, account }: { channel: string; lang: string; account: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(disconnectIntegration, {});
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(`Desconectar @${account}? Nada mais será publicado nesta conta até conectar de novo.`)) e.preventDefault(); }}>
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="lang" value={lang} />
      <button type="submit" className="button button--danger" disabled={pending}>
        <Unplug className="icon" size={16} aria-hidden="true" /> {pending ? "Desconectando…" : "Desconectar"}
      </button>
      {state.message && <p className={state.ok ? "form__ok" : "form__error"} role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  );
}
