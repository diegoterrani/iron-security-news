/**
 * Autenticação máquina-a-máquina da API do agente (servidor MCP do OpenClaw → /api/agent/v1/*).
 * Funções puras (sem I/O), testáveis. Mesmo contrato do Iron Academy, para o mesmo MCP falar com os dois:
 *   Authorization: Bearer <AGENT_ADMIN_TOKEN>
 *   X-Agent-Timestamp: <unix ms>
 *   X-Agent-Signature: hex(HMAC-SHA256(AGENT_HMAC_SECRET, `${ts}.${METHOD}.${path}.${body}`))
 *   X-WA-Sender: número do WhatsApp de quem falou com o agente
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Compara hashes de tamanho fixo para não vazar o tamanho do segredo.
  const ha = createHash("sha256").update(ab).digest();
  const hb = createHash("sha256").update(bb).digest();
  return timingSafeEqual(ha, hb) && ab.length === bb.length;
}

/** Token Bearer válido? Tokens curtos (< 32) são recusados por segurança. */
export function bearerMatches(authorization: string | null, token: string | undefined): boolean {
  if (!token || token.length < 32 || !authorization?.startsWith("Bearer ")) return false;
  const presented = authorization.slice("Bearer ".length).trim();
  return presented.length > 0 && safeEqual(presented, token);
}

export function signRequest(secret: string, ts: string, method: string, path: string, body: string): string {
  return createHmac("sha256", secret).update(`${ts}.${method.toUpperCase()}.${path}.${body}`).digest("hex");
}

export function verifySignature(opts: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  method: string;
  path: string;
  body: string;
  now?: number;
}): boolean {
  const { secret, timestamp, signature, method, path, body } = opts;
  if (!secret || secret.length < 32 || !timestamp || !signature) return false;
  if (!/^\d{10,16}$/.test(timestamp)) return false;
  const now = opts.now ?? Date.now();
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_MS) return false;
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  return safeEqual(signRequest(secret, timestamp, method, path, body), signature);
}

/** Número de WhatsApp em E.164 sem "+" (só dígitos). */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/@.*$/, "").replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/** AGENT_ADMINS = "5511999999999=<profiles.id>,..." — número do admin → perfil em nome de quem o agente age. */
export function parseAdminMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const [phone, userId] = entry.split("=").map((s) => s?.trim());
    const p = normalizePhone(phone);
    if (p && userId && /^[0-9a-f-]{36}$/i.test(userId)) map.set(p, userId.toLowerCase());
  }
  return map;
}

/** JSON canônico (chaves ordenadas) para amarrar a confirmação aos argumentos exatos. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Hash do código de confirmação, salgado com o id do pedido. */
export function confirmCodeHash(confirmationId: string, code: string): string {
  return sha256Hex(`${confirmationId}:${code}`);
}
