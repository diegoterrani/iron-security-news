import { hmacHex, timingSafeEqualHex } from "@ironnews/shared";

/** HeyGen: header `signature` = hex(HMAC-SHA256(secret, rawBody)). Confirmar formato na doc da HeyGen ao integrar. */
export async function verifyHeygen(secret: string, rawBody: string, signature: string | null): Promise<boolean> {
  if (!secret || !signature) return false;
  return timingSafeEqualHex(await hmacHex(secret, rawBody), signature.trim().toLowerCase());
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export interface MetaSignedPayload {
  algorithm: string;
  user_id?: string;
  issued_at?: number;
  [k: string]: unknown;
}

/**
 * Meta `signed_request` = base64url(sig) + "." + base64url(payload),
 * sig = HMAC-SHA256(app_secret, payloadB64). Retorna o payload se válido.
 */
export async function parseMetaSignedRequest(appSecret: string, signedRequest: string): Promise<MetaSignedPayload | null> {
  if (!appSecret) return null;
  const [sigB64, payloadB64, ...rest] = signedRequest.split(".");
  if (!sigB64 || !payloadB64 || rest.length) return null;
  let sigHex: string;
  let payload: MetaSignedPayload;
  try {
    sigHex = bytesToHex(b64urlToBytes(sigB64));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))) as MetaSignedPayload;
  } catch {
    return null;
  }
  if (payload.algorithm?.toUpperCase() !== "HMAC-SHA256") return null;
  const expected = await hmacHex(appSecret, payloadB64);
  return timingSafeEqualHex(expected, sigHex) ? payload : null;
}
