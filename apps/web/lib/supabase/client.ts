"use client";
import { createBrowserClient } from "@supabase/ssr";

/** Cliente no navegador: tela de MFA (TOTP) e upload dos arquivos de campanha (policy do Storage: admin + MFA). */
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
