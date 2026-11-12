/**
 * Cliente mínimo da API de publicação do Instagram (graph.instagram.com ou graph.facebook.com), §8.4.
 * Só o que a publicação de carrossel e a renovação do token precisam. O token vai no header
 * Authorization (não na URL), então não aparece em log de proxy nem em mensagem de erro.
 */
export interface IgApiDeps {
  graphVersion: string;
  /** "instagram" = token IGAA (graph.instagram.com); "facebook" = token EAA de usuário do sistema (graph.facebook.com). */
  host?: "instagram" | "facebook";
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Erro da Graph API com o código que decide o que fazer (§8.4 "Erros"). */
export class IgApiError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly httpStatus: number,
    public readonly subcode: number | null = null,
  ) {
    super(message);
    this.name = "IgApiError";
  }
  /** 190 = token inválido/expirado/revogado → reconectar. */
  get needsReauth() {
    return this.code === 190;
  }
  /** Limite de uso: tentar de novo mais tarde. */
  get rateLimited() {
    return this.code !== null && [4, 17, 32, 613].includes(this.code);
  }
}

const TIMEOUT_MS = 20_000;
const BASE = "https://graph.instagram.com";
const hostBase = (h: IgApiDeps["host"]) => (h === "facebook" ? "https://graph.facebook.com" : BASE);

/** Remove qualquer coisa parecida com token de uma mensagem antes de gravar/logar. */
export function scrub(msg: string): string {
  return msg.replace(/access_token=[^&\s"]+/gi, "access_token=***").replace(/\bIG[A-Za-z0-9_-]{20,}/g, "IG***").slice(0, 300);
}

async function call(
  deps: IgApiDeps, token: string, method: "GET" | "POST", path: string, params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  // Os endpoints de publicação (/{ig-user-id}/media, media_publish, status_code) são iguais nos dois hosts.
  const url = new URL(`${hostBase(deps.host)}/${deps.graphVersion}/${path}`);
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (method === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else init.body = new URLSearchParams(params);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(url, init);
  } catch (err) {
    throw new IgApiError(`rede: ${scrub((err as Error).message)}`, null, 0);
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* corpo vazio ou não-JSON */
  }
  const e = json.error as { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } | undefined;
  if (!res.ok || e) {
    const msg = e?.error_user_msg || e?.message || `HTTP ${res.status}`;
    throw new IgApiError(scrub(msg), typeof e?.code === "number" ? e.code : null, res.status, e?.error_subcode ?? null);
  }
  return json;
}

const idOf = (j: Record<string, unknown>, what: string): string => {
  const id = String(j.id ?? "");
  if (!/^\d+$/.test(id)) throw new IgApiError(`resposta sem id (${what})`, null, 200);
  return id;
};

export interface CarouselInput {
  igUserId: string;
  token: string;
  imageUrls: string[]; // JPEG públicos, na ordem
  caption: string;
}

/**
 * Publica um carrossel: um contêiner por imagem → contêiner CAROUSEL → espera FINISHED → media_publish.
 * Devolve o id da mídia e o permalink.
 */
export async function publishCarousel(deps: IgApiDeps, input: CarouselInput): Promise<{ mediaId: string; permalink: string | null }> {
  if (input.imageUrls.length < 2 || input.imageUrls.length > 10) throw new IgApiError("carrossel precisa de 2 a 10 imagens", null, 0);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const children: string[] = [];
  for (const image_url of input.imageUrls) {
    children.push(idOf(await call(deps, input.token, "POST", `${input.igUserId}/media`, { image_url, is_carousel_item: "true" }), "item"));
  }
  const creationId = idOf(
    await call(deps, input.token, "POST", `${input.igUserId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: input.caption }),
    "carrossel",
  );
  // O Instagram baixa e processa as imagens de forma assíncrona: esperar até ~90 s.
  let status = "";
  for (let i = 0; i < 30; i++) {
    const s = await call(deps, input.token, "GET", creationId, { fields: "status_code,status" });
    status = String(s.status_code ?? "");
    if (status === "FINISHED") break;
    if (status === "ERROR" || status === "EXPIRED") throw new IgApiError(`processamento do carrossel: ${scrub(String(s.status ?? status))}`, null, 200);
    await sleep(3000);
  }
  if (status !== "FINISHED") throw new IgApiError("o Instagram não terminou de processar o carrossel a tempo", null, 200);
  const mediaId = idOf(await call(deps, input.token, "POST", `${input.igUserId}/media_publish`, { creation_id: creationId }), "publish");
  let permalink: string | null = null;
  try {
    const m = await call(deps, input.token, "GET", mediaId, { fields: "permalink" });
    permalink = typeof m.permalink === "string" && m.permalink.startsWith("https://") ? m.permalink : null;
  } catch {
    // Já publicado: sem permalink não é falha.
  }
  return { mediaId, permalink };
}

/** Renova o token longo por mais 60 dias (precisa ter mais de 24 h e ainda estar válido). */
export async function refreshLongLivedToken(deps: Pick<IgApiDeps, "fetchImpl">, token: string): Promise<{ token: string; expiresIn: number }> {
  const url = new URL(`${BASE}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  // Este endpoint só aceita o token na query (documentação da API); a URL não é logada.
  url.searchParams.set("access_token", token);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new IgApiError(`rede: ${scrub((err as Error).message)}`, null, 0);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const e = json.error as { message?: string; code?: number } | undefined;
  if (!res.ok || e) throw new IgApiError(scrub(e?.message ?? `HTTP ${res.status}`), typeof e?.code === "number" ? e.code : null, res.status);
  const t = typeof json.access_token === "string" ? json.access_token : "";
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 0;
  if (!t || expiresIn <= 0) throw new IgApiError("resposta de renovação inválida", null, res.status);
  return { token: t, expiresIn };
}

/**
 * Legenda dentro dos limites do Instagram (2.200 caracteres, 30 hashtags): texto + CTA padrão + hashtags.
 * Se faltar espaço, encurta só o texto: o CTA e as hashtags ficam inteiros.
 */
export function buildCaption(caption: string, hashtags: string[], cta = ""): string {
  const tags = [...new Set(hashtags.filter((h) => /^#\w+$/u.test(h)))].slice(0, 30);
  const inCaption = (caption.match(/#\w+/gu) ?? []).length;
  const room = Math.max(0, 30 - inCaption);
  const tagLine = tags.slice(0, room).join(" ");
  const max = 2200;
  const tail = [cta.trim(), tagLine].filter(Boolean).join("\n\n");
  const body = caption.trim();
  if (!tail) return body.slice(0, max);
  const reserved = tail.length + 2;
  const text = body.length + reserved > max ? `${body.slice(0, Math.max(0, max - reserved - 1)).trimEnd()}…` : body;
  return text ? `${text}\n\n${tail}` : tail;
}
