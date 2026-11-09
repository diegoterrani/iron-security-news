"use server";
import { z } from "zod";
import { siteUrl } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { status: "idle" | "sent" | "error"; message?: string };

const Email = z.string().trim().toLowerCase().email().max(254);

/**
 * Envia o link mágico. Só para usuários já cadastrados (shouldCreateUser: false), e a resposta é a mesma
 * exista ou não a conta, para não revelar quem tem acesso.
 */
export async function sendMagicLink(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = Email.safeParse(form.get("email"));
  if (!parsed.success) return { status: "error", message: "Informe um e-mail válido." };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { shouldCreateUser: false, emailRedirectTo: `${siteUrl()}/admin/auth/callback` },
  });
  if (error && error.status === 429) {
    return { status: "error", message: "Muitas tentativas. Aguarde alguns minutos e tente de novo." };
  }
  return { status: "sent", message: "Se o e-mail tiver acesso ao painel, o link de entrada chega em instantes." };
}
