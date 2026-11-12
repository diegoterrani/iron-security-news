/**
 * Cliente mínimo da API REST do LinkedIn (§8.5): subir uma imagem e criar o post, no perfil
 * (urn:li:person:…) ou na página (urn:li:organization:…). Também renova o token pelo refresh token.
 *
 * O token vai só no header Authorization, nunca na URL; mensagens de erro passam por `scrub`.
 */
export interface LiApiDeps {
  /** LinkedIn-Version (YYYYMM). Cada versão vale cerca de 1 ano: atualizar por variável de ambiente. */
  apiVersion: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class LiApiError extends Error {
  constructor(message: string, public readonly httpStatus: number, public readonly retryAfterSec: number | null = null) {
    super(message);
    this.name = "LiApiError";
  }
  /** 401 = token inválido, expirado ou revogado → reconectar. */
  get needsReauth() {
    return this.httpStatus === 401;
  }
  /** 429 = limite diário/por minuto do LinkedIn: tentar de novo mais tarde. */
  get rateLimited() {
    return this.httpStatus === 429;
  }
}

const API = "https://api.linkedin.com/rest";
const TIMEOUT_MS = 20_000;

/** Remove qualquer coisa parecida com token antes de gravar/logar (tokens do LinkedIn começam com AQ). */
export function scrub(msg: string): string {
  return msg.replace(/\bAQ[A-Za-z0-9_-]{20,}/g, "AQ***").replace(/access_token=[^&\s"]+/gi, "access_token=***").slice(0, 300);
}

const headers = (deps: LiApiDeps, token: string, json = true): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "LinkedIn-Version": deps.apiVersion,
  "X-Restli-Protocol-Version": "2.0.0",
  ...(json ? { "Content-Type": "application/json" } : {}),
});

async function send(deps: LiApiDeps, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new LiApiError(`rede: ${scrub((err as Error).message)}`, 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    const retry = Number(res.headers.get("retry-after"));
    throw new LiApiError(scrub(body.message || `HTTP ${res.status}`), res.status, Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  return res;
}

/** URN aceito como autor/dono: pessoa ou página. Evita mandar lixo do banco para a API. */
export const AUTHOR_RE = /^urn:li:(person:[A-Za-z0-9_-]{3,60}|organization:\d{1,20})$/;

/**
 * Sobe a imagem: initializeUpload → PUT dos bytes na uploadUrl → espera ficar AVAILABLE.
 * A uploadUrl vem da API; só enviamos o token se ela for HTTPS de um domínio do LinkedIn.
 */
export async function uploadImage(deps: LiApiDeps, token: string, owner: string, bytes: Buffer, contentType: string): Promise<string> {
  const init = await send(deps, `${API}/images?action=initializeUpload`, {
    method: "POST",
    headers: headers(deps, token),
    body: JSON.stringify({ initializeUploadRequest: { owner } }),
  });
  const value = ((await init.json()) as { value?: { uploadUrl?: string; image?: string } }).value ?? {};
  const image = String(value.image ?? "");
  let upload: URL;
  try {
    upload = new URL(String(value.uploadUrl ?? ""));
  } catch {
    throw new LiApiError("resposta sem uploadUrl", 200);
  }
  if (!/^urn:li:image:[A-Za-z0-9_-]+$/.test(image)) throw new LiApiError("resposta sem URN da imagem", 200);
  if (upload.protocol !== "https:" || !(upload.hostname === "linkedin.com" || upload.hostname.endsWith(".linkedin.com"))) {
    throw new LiApiError("uploadUrl fora do LinkedIn", 200);
  }
  await send(deps, upload.toString(), {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body: new Uint8Array(bytes),
  });

  // O processamento é assíncrono; o post com imagem ainda "PROCESSING" pode falhar. Espera até ~30 s.
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < 15; i++) {
    const r = await send(deps, `${API}/images/${encodeURIComponent(image)}`, { method: "GET", headers: headers(deps, token, false) });
    const status = String(((await r.json()) as { status?: string }).status ?? "");
    if (status === "AVAILABLE") return image;
    if (status === "PROCESSING_FAILED") throw new LiApiError("o LinkedIn não conseguiu processar a imagem", 200);
    await sleep(2000);
  }
  throw new LiApiError("o LinkedIn não terminou de processar a imagem a tempo", 200);
}

export interface PostInput {
  author: string;
  token: string;
  commentary: string;
  imageUrn: string;
  altText: string;
  title: string;
}

/** Cria o post público com a imagem. Devolve o URN do post e o link para abri-lo. */
export async function createPost(deps: LiApiDeps, input: PostInput): Promise<{ postUrn: string; url: string }> {
  const res = await send(deps, `${API}/posts`, {
    method: "POST",
    headers: headers(deps, input.token),
    body: JSON.stringify({
      author: input.author,
      commentary: input.commentary,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: input.imageUrn, title: input.title.slice(0, 200), altText: input.altText.slice(0, 300) } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });
  const postUrn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id") ?? "";
  if (!/^urn:li:(share|ugcPost):\d+$/.test(postUrn)) throw new LiApiError("post criado sem URN na resposta", res.status);
  return { postUrn, url: `https://www.linkedin.com/feed/update/${postUrn}/` };
}

/**
 * Texto do post no formato "little text" do LinkedIn: os caracteres reservados precisam de escape,
 * senão o LinkedIn corta o texto no primeiro deles. Hashtags viram o template oficial {hashtag|\#|Tag}.
 * Limite da API: 3.000 caracteres.
 */
const RESERVED = /[\\|{}@[\]()<>#*_~]/g;
export const escapeLittleText = (s: string) => s.replace(RESERVED, (c) => `\\${c}`);

/** Texto + CTA padrão + hashtags. Se passar do limite, encurta só o texto: CTA e hashtags ficam inteiros. */
export function buildCommentary(text: string, hashtags: string[], cta = ""): string {
  // Só letras e números dentro do template (o "_" é reservado no little text).
  const tags = [...new Set(hashtags.map((h) => h.replace(/^#/, "").replace(/_/g, "")).filter((h) => /^[\p{L}\p{N}]+$/u.test(h)))].slice(0, 5);
  const tagLine = [cta.trim() ? escapeLittleText(cta.trim()) : "", tags.map((t) => `{hashtag|\\#|${t}}`).join(" ")].filter(Boolean).join("\n\n");
  const max = 3000;
  const reserved = tagLine ? tagLine.length + 2 : 0;
  let body = escapeLittleText(text.trim());
  if (body.length + reserved > max) {
    // corta no texto original (não no meio de um escape) e escapa de novo
    let raw = text.trim();
    while (escapeLittleText(raw).length + reserved + 1 > max) raw = raw.slice(0, -50);
    body = `${escapeLittleText(raw.trimEnd())}…`;
  }
  return tagLine ? `${body}\n\n${tagLine}` : body;
}

/** Renova o access token com o refresh token (só apps com refresh habilitado, como a Community Management API). */
export async function refreshAccessToken(
  deps: Pick<LiApiDeps, "fetchImpl">, client: { id: string; secret: string }, refreshToken: string,
): Promise<{ token: string; expiresIn: number; refreshToken: string | null; refreshExpiresIn: number | null }> {
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.id, client_secret: client.secret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LiApiError(`rede: ${scrub((err as Error).message)}`, 0);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // 400 invalid_grant = refresh token vencido/revogado: trata como "reconectar".
    throw new LiApiError(scrub(String(json.error_description ?? json.error ?? `HTTP ${res.status}`)), res.status === 400 ? 401 : res.status);
  }
  const token = typeof json.access_token === "string" ? json.access_token : "";
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 0;
  if (!token || expiresIn <= 0) throw new LiApiError("resposta de renovação inválida", res.status);
  return {
    token,
    expiresIn,
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
    refreshExpiresIn: typeof json.refresh_token_expires_in === "number" ? json.refresh_token_expires_in : null,
  };
}
