export const USER_AGENT = "IronCyberNews/1.0 (+https://news.iron-security.com)";
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} em ${new URL(url).host}`);
  }
}

export interface HttpResponse {
  status: number;
  body: string;
  etag: string | null;
  lastModified: string | null;
}

/**
 * GET com fetch condicional (ETag / If-Modified-Since), timeout e teto de tamanho.
 * 304 volta com body vazio; outros status ≥ 400 viram HttpError.
 */
export async function httpGet(
  url: string,
  opts: { etag?: string | null; lastModified?: string | null; headers?: Record<string, string>; fetchImpl?: typeof fetch } = {},
): Promise<HttpResponse> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "*/*", ...opts.headers };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;

  const res = await (opts.fetchImpl ?? fetch)(url, { headers, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const meta = { etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
  if (res.status === 304) return { status: 304, body: "", ...meta };
  if (res.status >= 400) throw new HttpError(res.status, url);

  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) throw new Error(`resposta grande demais (${len} bytes)`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error(`resposta grande demais (${buf.byteLength} bytes)`);
  return { status: res.status, body: new TextDecoder("utf-8").decode(buf), ...meta };
}
