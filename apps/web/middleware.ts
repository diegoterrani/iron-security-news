import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { adminRedirect } from "./lib/admin-guard";

/** Renova a sessão do Supabase e protege /admin (login + MFA obrigatório). */
export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return new NextResponse("Painel indisponível: configuração ausente", { status: 503 });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) req.cookies.set(name, value);
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of list) res.cookies.set(name, value, options);
      },
    },
  });

  // getUser() valida o token no servidor do Supabase (não confia só no cookie).
  const { data: { user } } = await supabase.auth.getUser();
  let aal: "aal1" | "aal2" | null = null;
  if (user) {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    aal = (data?.currentLevel as "aal1" | "aal2" | null) ?? null;
  }
  const to = adminRedirect({ path: req.nextUrl.pathname, loggedIn: Boolean(user), aal });
  if (to) {
    const r = NextResponse.redirect(new URL(to, req.url));
    for (const c of res.cookies.getAll()) r.cookies.set(c);
    return r;
  }
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

export const config = { matcher: ["/admin/:path*"] };
