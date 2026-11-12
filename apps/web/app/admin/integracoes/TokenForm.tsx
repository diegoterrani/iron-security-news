"use client";
import { useActionState } from "react";
import { KeyRound } from "lucide-react";
import { saveInstagramToken, type ActionState } from "./actions";

/** Campo para colar o token do painel da Meta. type=password: não fica visível nem no autocompletar. */
export function TokenForm({ reconnect }: { reconnect: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveInstagramToken, {});
  return (
    <form action={action} className="form" autoComplete="off">
      <label className="form__label" htmlFor="ig-token">{reconnect ? "Trocar o token" : "Colar token do painel da Meta"}</label>
      <p className="section-hint">
        Em developers.facebook.com → seu app → Instagram API → <strong>Generate access tokens</strong> → Generate token. O token começa com IGAA ou EAA. Se começar com EAA, informe também o ID da conta (o número abaixo do @).
      </p>
      <div className="form--inline">
        <input id="ig-token" name="token" type="password" className="input" required minLength={30} maxLength={1024}
          autoComplete="off" spellCheck={false} placeholder="IGAA… ou EAA…" />
        <label className="sr-only" htmlFor="ig-user-id">ID da conta do Instagram</label>
        <input id="ig-user-id" name="ig_user_id" className="input mono" inputMode="numeric" pattern="[0-9]{5,30}"
          autoComplete="off" placeholder="ID da conta (só para EAA)" />
        <button type="submit" className="button button--primary" disabled={pending}>
          <KeyRound className="icon" size={16} aria-hidden="true" /> {pending ? "Conferindo…" : "Salvar token"}
        </button>
      </div>
      {state.message && <p className={state.ok ? "form__ok" : "form__error"} role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  );
}
