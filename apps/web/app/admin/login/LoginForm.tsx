"use client";
import { useActionState } from "react";
import { MailCheck, Send } from "lucide-react";
import { sendMagicLink, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, { status: "idle" });
  if (state.status === "sent") {
    return (
      <div className="empty" role="status">
        <span className="empty__icon" aria-hidden="true"><MailCheck className="icon" size={22} /></span>
        <p className="empty__title">Verifique seu e-mail</p>
        <p className="empty__text">{state.message}</p>
      </div>
    );
  }
  return (
    <form action={action} className="form">
      <label className="form__label" htmlFor="email">E-mail</label>
      <input id="email" name="email" type="email" required autoComplete="email" className="input" placeholder="voce@empresa.com" />
      {state.status === "error" && <p className="form__error" role="alert">{state.message}</p>}
      <button type="submit" className="button button--primary" disabled={pending}>
        <Send className="icon" size={16} aria-hidden="true" />
        {pending ? "Enviando…" : "Enviar link de entrada"}
      </button>
    </form>
  );
}
