/**
 * Assinatura HMAC-SHA256 com timestamp, usada entre executor <-> og-render e executor <-> Vercel.
 * Mensagem assinada: `${timestamp}.${body}`. Usa WebCrypto (Node 22, Workers e Edge).
 */
const enc = new TextEncoder();

export const MAX_SKEW_SECONDS = 300;

// Tipo derivado da própria API para funcionar com libs DOM, Node e Workers.
type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function hmacKey(secret: string): Promise<HmacKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message)));
}

/** Comparação em tempo constante de duas strings hex de mesmo tamanho. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signRequest(secret: string, body: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const timestamp = String(nowSeconds);
  return { timestamp, signature: await hmacHex(secret, `${timestamp}.${body}`) };
}

export async function verifyRequest(
  secret: string,
  body: string,
  timestamp: string | null,
  signature: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!secret || !timestamp || !signature || !/^\d{9,11}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = await hmacHex(secret, `${timestamp}.${body}`);
  return timingSafeEqualHex(expected, signature.toLowerCase());
}
