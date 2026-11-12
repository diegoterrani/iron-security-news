/**
 * Instagram API com login do Instagram (Business Login), §8.4.
 *
 * Por que este produto e não o login do Facebook: a conta da IRON é profissional e não precisa de
 * Página do Facebook vinculada; os escopos são só os dois necessários para ler o perfil e publicar.
 * Com o app em modo Desenvolvimento e a conta como testadora, não há App Review para a própria conta.
 *
 * Tudo aqui roda no servidor. O App Secret e os tokens nunca vão para o navegador nem para o log.
 */
export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"] as const;
export const CALLBACK_PATH = "/admin/integracoes/instagram/callback";

export interface InstagramConfig {
  appId: string;
  appSecret: string;
  graphVersion: string;
  redirectUri: string;
}

/** Lê a configuração do ambiente; `null` quando falta algo (a tela mostra o que configurar). */
export function instagramConfig(env: Record<string, string | undefined>, siteUrl: string): InstagramConfig | null {
  const appId = env.INSTAGRAM_APP_ID?.trim();
  const appSecret = env.INSTAGRAM_APP_SECRET?.trim();
  if (!appId || !appSecret || !/^\d+$/.test(appId)) return null;
  const graphVersion = /^v\d+\.\d+$/.test(env.INSTAGRAM_GRAPH_VERSION ?? "") ? env.INSTAGRAM_GRAPH_VERSION! : "v23.0";
  return { appId, appSecret, graphVersion, redirectUri: `${siteUrl.replace(/\/+$/, "")}${CALLBACK_PATH}` };
}

export function authorizeUrl(cfg: InstagramConfig, state: string): string {
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", cfg.appId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
  u.searchParams.set("state", state);
  u.searchParams.set("force_reauth", "true"); // sempre pede o login: evita conectar a conta errada aberta no navegador
  return u.toString();
}

/** Erro sem segredo: `code` é estável (vira mensagem na tela); `status` ajuda no log. */
export class InstagramError extends Error {
  constructor(public readonly code: "exchange" | "long_lived" | "profile" | "not_professional" | "scopes" | "network", public readonly status?: number) {
    super(`instagram: ${code}${status ? ` (${status})` : ""}`);
    this.name = "InstagramError";
  }
}

type FetchLike = typeof fetch;
const TIMEOUT_MS = 10_000;

async function getJson(fetchImpl: FetchLike, input: string, init: RequestInit, code: InstagramError["code"]): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new InstagramError("network");
  }
  if (!res.ok) throw new InstagramError(code, res.status);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new InstagramError(code, res.status);
  }
}

export interface ConnectedAccount {
  accountId: string; // IG professional account id (user_id), usado para publicar
  username: string;
  accountType: string;
  accessToken: string; // long-lived (60 dias)
  expiresAt: Date;
  scopes: string[];
}

/** code → token curto → token longo (60 dias) → perfil. Recusa conta pessoal ou sem permissão de publicar. */
export async function connectWithCode(cfg: InstagramConfig, code: string, fetchImpl: FetchLike = fetch, now = new Date()): Promise<ConnectedAccount> {
  // 1. code → token de curta duração
  const short = await getJson(
    fetchImpl,
    "https://api.instagram.com/oauth/access_token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        grant_type: "authorization_code",
        redirect_uri: cfg.redirectUri,
        code: code.replace(/#_$/, ""),
      }),
    },
    "exchange",
  );
  // A API já respondeu nos dois formatos: { access_token, permissions } e { data: [ { … } ] }.
  const first = (Array.isArray(short.data) ? (short.data[0] as Record<string, unknown>) : short) ?? {};
  const shortToken = typeof first.access_token === "string" ? first.access_token : "";
  if (!shortToken) throw new InstagramError("exchange");
  const granted = typeof first.permissions === "string" ? first.permissions.split(",") : Array.isArray(first.permissions) ? (first.permissions as string[]) : [];
  if (granted.length && !INSTAGRAM_SCOPES.every((s) => granted.includes(s))) throw new InstagramError("scopes");

  // 2. token curto → longo (60 dias). O segredo vai na query só nesta chamada servidor-servidor (formato exigido pela API).
  const longUrl = new URL("https://graph.instagram.com/access_token");
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", cfg.appSecret);
  longUrl.searchParams.set("access_token", shortToken);
  const long = await getJson(fetchImpl, longUrl.toString(), { method: "GET" }, "long_lived");
  const accessToken = typeof long.access_token === "string" ? long.access_token : "";
  const expiresIn = typeof long.expires_in === "number" ? long.expires_in : 0;
  if (!accessToken || expiresIn <= 0) throw new InstagramError("long_lived");

  // 3. perfil: user_id é o id da conta profissional (o `id` da resposta é por app e não serve para publicar).
  const meUrl = new URL(`https://graph.instagram.com/${cfg.graphVersion}/me`);
  meUrl.searchParams.set("fields", "user_id,username,account_type");
  const me = await getJson(fetchImpl, meUrl.toString(), { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } }, "profile");
  const accountId = String(me.user_id ?? "");
  const username = typeof me.username === "string" ? me.username : "";
  const accountType = typeof me.account_type === "string" ? me.account_type : "";
  if (!/^\d+$/.test(accountId) || !username) throw new InstagramError("profile");
  if (accountType && !["BUSINESS", "MEDIA_CREATOR"].includes(accountType)) throw new InstagramError("not_professional");

  return {
    accountId,
    username,
    accountType,
    accessToken,
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
    scopes: granted.length ? granted : [...INSTAGRAM_SCOPES],
  };
}

/** Mensagem para a tela a partir do código do erro (sem detalhes internos). */
export const CONNECT_ERROR_MESSAGE: Record<string, string> = {
  denied: "A conexão foi cancelada no Instagram.",
  state: "A conexão expirou ou não foi iniciada por você. Tente de novo.",
  config: "O app do Instagram não está configurado no servidor (INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, TOKEN_ENC_KEY, OAUTH_STATE_SECRET).",
  forbidden: "Só administradores podem conectar integrações.",
  exchange: "O Instagram recusou o código de autorização. Tente de novo.",
  long_lived: "Não foi possível obter o token de longa duração do Instagram.",
  profile: "Não foi possível ler o perfil da conta do Instagram.",
  not_professional: "A conta precisa ser profissional (Empresa ou Criador de conteúdo).",
  scopes: "Faltou autorizar a permissão de publicar. Conecte de novo e aceite todas as permissões.",
  network: "O Instagram não respondeu a tempo. Tente de novo.",
  save: "Não foi possível salvar a integração. Tente de novo.",
};
