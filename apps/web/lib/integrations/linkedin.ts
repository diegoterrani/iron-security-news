/**
 * LinkedIn (§8.5): conexão OAuth 2.0 (authorization code) para dois alvos.
 *
 * - "member" (perfil de quem conecta): produtos self-serve "Sign In with LinkedIn using OpenID Connect"
 *   + "Share on LinkedIn". Escopos openid, profile, w_member_social. O token dura 60 dias e, fora de
 *   parceiros aprovados, não vem refresh token: o painel avisa para reconectar.
 * - "organization" (página da IRON): produto "Community Management API", que o LinkedIn analisa e exige
 *   um app só para ele. Escopos rw_organization_admin (descobrir as páginas que a pessoa administra) e
 *   w_organization_social (publicar). Esse produto devolve refresh token (365 dias).
 *
 * Cada alvo tem o seu app (client id/secret próprios) e o seu callback, porque o LinkedIn não deixa a
 * Community Management API conviver com outros produtos no mesmo app.
 *
 * Tudo aqui roda no servidor. O client secret e os tokens nunca vão para o navegador nem para o log.
 */
export type LinkedinTarget = "member" | "organization";

/** Segmento de URL (em português, como o resto do painel) ↔ alvo. */
export const TARGET_SLUG: Record<LinkedinTarget, string> = { member: "perfil", organization: "pagina" };
export const targetFromSlug = (slug: string | null | undefined): LinkedinTarget | null =>
  slug === "perfil" ? "member" : slug === "pagina" ? "organization" : null;

export const LINKEDIN_SCOPES: Record<LinkedinTarget, readonly string[]> = {
  member: ["openid", "profile", "w_member_social"],
  organization: ["rw_organization_admin", "w_organization_social"],
};
/** Sem este escopo o token não publica: recusar na conexão em vez de falhar na hora de publicar. */
const PUBLISH_SCOPE: Record<LinkedinTarget, string> = { member: "w_member_social", organization: "w_organization_social" };

export const callbackPath = (t: LinkedinTarget) => `/admin/integracoes/linkedin/${TARGET_SLUG[t]}/callback`;
export const cookiePath = (t: LinkedinTarget) => `/admin/integracoes/linkedin/${TARGET_SLUG[t]}`;
export const LI_STATE_COOKIE = "li_oauth_state";

export interface LinkedinConfig {
  target: LinkedinTarget;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiVersion: string; // LinkedIn-Version (YYYYMM)
  /** Só página: id numérico da página da IRON (linkedin.com/company/<id>/admin). Opcional se a pessoa administra uma página só. */
  orgId: string | null;
}

export const DEFAULT_API_VERSION = "202606";

/** Lê a configuração do alvo; `null` quando falta algo (a tela mostra o que configurar). */
export function linkedinConfig(target: LinkedinTarget, env: Record<string, string | undefined>, siteUrl: string): LinkedinConfig | null {
  const prefix = target === "member" ? "LINKEDIN" : "LINKEDIN_ORG";
  const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();
  if (!clientId || !clientSecret || !/^[A-Za-z0-9]{6,40}$/.test(clientId)) return null;
  const v = env.LINKEDIN_API_VERSION?.trim() ?? "";
  const org = env.LINKEDIN_ORG_ID?.trim() ?? "";
  return {
    target,
    clientId,
    clientSecret,
    redirectUri: `${siteUrl.replace(/\/+$/, "")}${callbackPath(target)}`,
    apiVersion: /^\d{6}$/.test(v) ? v : DEFAULT_API_VERSION,
    orgId: target === "organization" && /^\d{1,20}$/.test(org) ? org : null,
  };
}

export function authorizeUrl(cfg: LinkedinConfig, state: string): string {
  const u = new URL("https://www.linkedin.com/oauth/v2/authorization");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", LINKEDIN_SCOPES[cfg.target].join(" "));
  return u.toString();
}

/** Erro sem segredo: `code` é estável (vira mensagem na tela); `status` ajuda no log. */
export class LinkedinError extends Error {
  constructor(
    public readonly code: "exchange" | "scopes" | "profile" | "no_org" | "many_orgs" | "org_not_admin" | "network",
    public readonly status?: number,
  ) {
    super(`linkedin: ${code}${status ? ` (${status})` : ""}`);
    this.name = "LinkedinError";
  }
}

type FetchLike = typeof fetch;
const TIMEOUT_MS = 10_000;

async function getJson(fetchImpl: FetchLike, input: string, init: RequestInit, code: LinkedinError["code"]): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new LinkedinError("network");
  }
  if (!res.ok) throw new LinkedinError(code, res.status);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new LinkedinError(code, res.status);
  }
}

export interface LinkedinAccount {
  target: LinkedinTarget;
  /** URN do autor dos posts: urn:li:person:<sub> ou urn:li:organization:<id>. */
  accountId: string;
  accountName: string;
  accessToken: string;
  expiresAt: Date;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
  scopes: string[];
}

const restHeaders = (cfg: LinkedinConfig, token: string) => ({
  Authorization: `Bearer ${token}`,
  "LinkedIn-Version": cfg.apiVersion,
  "X-Restli-Protocol-Version": "2.0.0",
});

/** code → token → autor (perfil pelo /userinfo; página pelas ACLs de administrador). */
export async function connectWithCode(cfg: LinkedinConfig, code: string, fetchImpl: FetchLike = fetch, now = new Date()): Promise<LinkedinAccount> {
  const tok = await getJson(
    fetchImpl,
    "https://www.linkedin.com/oauth/v2/accessToken",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
    },
    "exchange",
  );
  const accessToken = typeof tok.access_token === "string" ? tok.access_token : "";
  const expiresIn = typeof tok.expires_in === "number" ? tok.expires_in : 0;
  if (!accessToken || expiresIn <= 0) throw new LinkedinError("exchange");
  // O LinkedIn devolve os escopos separados por vírgula (às vezes por espaço).
  const scopes = typeof tok.scope === "string" ? tok.scope.split(/[\s,]+/).filter(Boolean) : [];
  if (scopes.length && !scopes.includes(PUBLISH_SCOPE[cfg.target])) throw new LinkedinError("scopes");
  const refreshToken = typeof tok.refresh_token === "string" && tok.refresh_token ? tok.refresh_token : null;
  const refreshIn = typeof tok.refresh_token_expires_in === "number" ? tok.refresh_token_expires_in : 0;

  const base = {
    target: cfg.target,
    accessToken,
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
    refreshToken,
    refreshExpiresAt: refreshToken && refreshIn > 0 ? new Date(now.getTime() + refreshIn * 1000) : null,
    scopes: scopes.length ? scopes : [...LINKEDIN_SCOPES[cfg.target]],
  };

  if (cfg.target === "member") {
    const me = await getJson(fetchImpl, "https://api.linkedin.com/v2/userinfo", { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } }, "profile");
    const sub = typeof me.sub === "string" ? me.sub : "";
    const name = typeof me.name === "string" ? me.name.trim() : "";
    if (!/^[A-Za-z0-9_-]{3,60}$/.test(sub) || !name) throw new LinkedinError("profile");
    return { ...base, accountId: `urn:li:person:${sub}`, accountName: name.slice(0, 100) };
  }

  // Página: só aceita uma página que a pessoa ADMINISTRA (aprovada). Com várias, exige LINKEDIN_ORG_ID.
  const acl = new URL("https://api.linkedin.com/rest/organizationAcls");
  acl.searchParams.set("q", "roleAssignee");
  acl.searchParams.set("role", "ADMINISTRATOR");
  acl.searchParams.set("state", "APPROVED");
  const acls = await getJson(fetchImpl, acl.toString(), { method: "GET", headers: restHeaders(cfg, accessToken) }, "profile");
  const orgIds = (Array.isArray(acls.elements) ? acls.elements : [])
    .map((e) => String((e as Record<string, unknown>).organization ?? ""))
    .map((urn) => /^urn:li:organization:(\d{1,20})$/.exec(urn)?.[1])
    .filter((id): id is string => Boolean(id));
  let orgId: string;
  if (cfg.orgId) {
    if (!orgIds.includes(cfg.orgId)) throw new LinkedinError("org_not_admin");
    orgId = cfg.orgId;
  } else if (orgIds.length === 1) {
    orgId = orgIds[0]!;
  } else {
    throw new LinkedinError(orgIds.length === 0 ? "no_org" : "many_orgs");
  }
  const org = await getJson(fetchImpl, `https://api.linkedin.com/rest/organizations/${orgId}`, { method: "GET", headers: restHeaders(cfg, accessToken) }, "profile");
  const name = typeof org.localizedName === "string" ? org.localizedName.trim() : "";
  if (!name) throw new LinkedinError("profile");
  return { ...base, accountId: `urn:li:organization:${orgId}`, accountName: name.slice(0, 100) };
}

/** Contexto (AAD) da cifra: amarra o token ao alvo e à conta; trocar a linha no banco não o reaproveita. */
export const tokenContext = (target: LinkedinTarget, accountId: string, kind: "access" | "refresh" = "access") =>
  `linkedin${kind === "refresh" ? "-refresh" : ""}:${target}:${accountId}`;

/** Mensagem para a tela a partir do código do erro (sem detalhes internos). */
export const LINKEDIN_ERROR_MESSAGE: Record<string, string> = {
  denied: "A conexão foi cancelada no LinkedIn.",
  state: "A conexão expirou ou não foi iniciada por você. Tente de novo.",
  config: "O app do LinkedIn não está configurado no servidor (client ID, client secret, TOKEN_ENC_KEY, OAUTH_STATE_SECRET).",
  forbidden: "Só administradores podem conectar integrações.",
  exchange: "O LinkedIn recusou o código de autorização. Tente de novo.",
  scopes: "Faltou autorizar a permissão de publicar. Conecte de novo e aceite todas as permissões.",
  profile: "Não foi possível ler a conta no LinkedIn.",
  no_org: "Sua conta não é administradora de nenhuma página no LinkedIn.",
  many_orgs: "Você administra mais de uma página. Defina LINKEDIN_ORG_ID na Vercel com o id da página da IRON.",
  org_not_admin: "Sua conta não é administradora da página definida em LINKEDIN_ORG_ID.",
  network: "O LinkedIn não respondeu a tempo. Tente de novo.",
  save: "Não foi possível salvar a integração. Tente de novo.",
};
