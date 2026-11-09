/** Rotas do painel acessíveis sem sessão. */
export const PUBLIC_ADMIN_PATHS = ["/admin/login", "/admin/auth/callback"];

export type GuardInput = { path: string; loggedIn: boolean; aal: "aal1" | "aal2" | null };

/**
 * Para onde mandar o usuário (§7.1): sem sessão → login; sessão sem segundo fator (aal2) → MFA,
 * inclusive no primeiro acesso, quando ainda não há fator cadastrado (MFA é obrigatório);
 * com aal2, login e MFA levam à fila. `null` = segue para a página pedida.
 */
export function adminRedirect({ path, loggedIn, aal }: GuardInput): string | null {
  const isPublic = PUBLIC_ADMIN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  if (!loggedIn) return isPublic ? null : "/admin/login";
  if (aal !== "aal2") return path === "/admin/mfa" || path === "/admin/logout" || isPublic ? null : "/admin/mfa";
  if (path === "/admin/login" || path === "/admin/mfa") return "/admin";
  return null;
}
