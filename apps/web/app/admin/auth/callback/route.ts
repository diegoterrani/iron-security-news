import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Destino do link mágico (fluxo PKCE): troca o código pela sessão e segue para o MFA. */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/admin/mfa", req.url));
  }
  return NextResponse.redirect(new URL("/admin/login?erro=link", req.url));
}
