"use client";
import { createBrowserClient } from "@supabase/ssr";

/** Cliente no navegador (só a tela de MFA usa: cadastro e verificação do TOTP). */
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
