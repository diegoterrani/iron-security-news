import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { USER_AGENT } from "../ingest/http";

/**
 * GET de uma URL informada por um editor, com proteção contra SSRF.
 *
 * Por que não o fetch global: o fetch resolve o DNS por conta própria, e checar o IP antes (lookup) e
 * conectar depois abre a janela de DNS rebinding. Aqui o `lookup` do próprio socket valida cada IP no
 * momento da conexão, e cada redirecionamento é revalidado do zero.
 */

export class FetchRejected extends Error {
  /** `permanent`: não adianta tentar de novo (URL inválida, IP bloqueado, 404…). */
  constructor(message: string, readonly permanent = true) {
    super(message);
  }
}

// Duas listas: o BlockList casa IPv4 com regras IPv6 de IPv4 mapeado (::ffff:0:0/96), o que bloquearia tudo.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
// IPv4: "this network", privadas, CGNAT, loopback, link-local (inclui metadata 169.254.169.254),
// IETF/TEST-NETs, benchmark, multicast e reservadas.
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED_V4.addSubnet(net, prefix, "ipv4");
// IPv6: não especificado, loopback, IPv4 mapeado, NAT64, documentação, 6to4, ULA, link-local, multicast.
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED_V6.addSubnet(net, prefix, "ipv6");

export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  return family === 4 ? BLOCKED_V4.check(ip, "ipv4") : BLOCKED_V6.check(ip, "ipv6");
}

/** Valida a URL antes de qualquer rede: só https, porta 443, sem credenciais, host com ponto e sem IP privado. */
export function assertPublicHttpsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchRejected("link inválido");
  }
  if (u.protocol !== "https:") throw new FetchRejected("só links https são aceitos");
  if (u.username || u.password) throw new FetchRejected("link com usuário/senha não é aceito");
  if (u.port && u.port !== "443") throw new FetchRejected("só a porta padrão (443) é aceita");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new FetchRejected("endereço interno não é aceito");
  } else if (!host.includes(".") || /\.(local|localhost|internal|lan|home|corp)$/i.test(host) || /^localhost$/i.test(host)) {
    throw new FetchRejected("endereço interno não é aceito");
  }
  return u;
}

/** `lookup` do socket: resolve todos os IPs e recusa se QUALQUER um for interno. */
export function guardedLookup(
  resolve: typeof dnsLookup = dnsLookup,
): (hostname: string, options: object, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => void {
  return (hostname, options, cb) => {
    resolve(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err, "", 0);
      const list = addresses as LookupAddress[];
      if (list.length === 0) return cb(new FetchRejected("host sem endereço"), "", 0);
      const bad = list.find((a) => isBlockedIp(a.address));
      if (bad) return cb(new FetchRejected("o link aponta para um endereço interno"), "", 0);
      if ((options as { all?: boolean }).all) return cb(null, list);
      return cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

export interface SafeResponse {
  url: string;
  contentType: string;
  body: string;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Para testes: substitui a requisição de rede. */
  requestImpl?: (u: URL, signal: AbortSignal) => Promise<IncomingMessage>;
}

function defaultRequest(u: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(u, {
      method: "GET",
      lookup: guardedLookup() as never,
      signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
        "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
    });
    req.on("response", resolve);
    req.on("error", reject);
    req.end();
  });
}

async function readCapped(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      res.destroy();
      throw new FetchRejected(`página grande demais (mais de ${Math.round(maxBytes / 1_048_576)} MB)`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Baixa uma página HTML/texto pública. Erros com `permanent = false` (rede, 5xx, 429) podem ser tentados de novo. */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const { timeoutMs = 20_000, maxBytes = 3 * 1_048_576, maxRedirects = 5 } = opts;
  const doRequest = opts.requestImpl ?? defaultRequest;
  const signal = AbortSignal.timeout(timeoutMs);
  let current = assertPublicHttpsUrl(raw);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res: IncomingMessage;
    try {
      res = await doRequest(current, signal);
    } catch (err) {
      if (err instanceof FetchRejected) throw err;
      const msg = signal.aborted ? "tempo esgotado ao abrir o link" : `falha de rede ao abrir o link (${(err as Error).message})`;
      throw new FetchRejected(msg.slice(0, 200), false);
    }
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = assertPublicHttpsUrl(new URL(res.headers.location, current).toString());
      continue;
    }
    if (status === 429 || status >= 500) {
      res.resume();
      throw new FetchRejected(`o site respondeu ${status}`, false);
    }
    if (status !== 200) {
      res.resume();
      throw new FetchRejected(`o site respondeu ${status}${status === 401 || status === 403 ? " (página fechada ou bloqueia robôs; cole o texto)" : ""}`);
    }
    const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
    if (!/^(text\/html|application\/xhtml\+xml|text\/plain)/.test(contentType)) {
      res.resume();
      throw new FetchRejected(`o link não é uma página de texto (${contentType.split(";")[0] || "sem tipo"}); cole o texto`);
    }
    const buf = await readCapped(res, maxBytes);
    const charset = /charset=([\w-]+)/.exec(contentType)?.[1] ?? "utf-8";
    let body: string;
    try {
      body = new TextDecoder(charset).decode(buf);
    } catch {
      body = new TextDecoder("utf-8").decode(buf);
    }
    return { url: current.toString(), contentType, body };
  }
  throw new FetchRejected("redirecionamentos demais");
}
