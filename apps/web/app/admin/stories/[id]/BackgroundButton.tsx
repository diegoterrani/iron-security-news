"use client";
import { useActionState } from "react";
import { ImagePlus } from "lucide-react";
import { requestBackground, type ActionState } from "./actions";

/**
 * Botão "Gerar imagem de fundo com IA". Os criativos saem com fundo liso; a imagem (LLM + FLUX) só é
 * gerada quando o editor pede aqui. Papel, MFA, estado da story e teto diário são checados na RPC.
 */
export function BackgroundButton({ storyId, hasBackground }: { storyId: string; hasBackground: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(requestBackground, {});
  const label = hasBackground ? "Gerar outra imagem de fundo" : "Gerar imagem de fundo com IA";
  return (
    <form action={action} className="creative-group">
      <input type="hidden" name="story_id" value={storyId} />
      <p className="section-hint">
        {hasBackground
          ? "Os criativos usam uma imagem gerada por IA. Gerar outra substitui a atual."
          : "Os criativos estão com fundo liso. A imagem por IA só é gerada se você pedir."}
      </p>
      <button type="submit" className="button" disabled={pending || state.ok === true}>
        <ImagePlus className="icon" size={16} aria-hidden="true" /> {pending ? "Pedindo…" : label}
      </button>
      {state.message && <p className={state.ok ? "form__ok" : "form__error"} role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  );
}
