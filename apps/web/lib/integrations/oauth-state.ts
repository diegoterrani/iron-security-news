import { hmacHex, timingSafeEqualHex } from "@ironnews/shared";

/**
 * `state` do OAuth (proteção contra CSRF no callback, RFC 6749 §10.12).
 *
 * O state vai na URL do provedor e volta no callback. Ele carrega um nonce, o usuário que iniciou a
 * conexão e a validade, assinados com OAUTH_STATE_SECRET. O nonce também fica num cookie httpOnly do
 * próprio painel: o callback só aceita quando state e cookie batem, a assinatura confere, não expirou
 * e o usuário logado é o mesmo que iniciou. Assim ninguém consegue "plantar" a conta dele no painel.
 */
export const STATE_COOKIE = "ig_oauth_state";
export const STATE_TTL_SECONDS = 600;

interface StatePayload {
  n: string; // nonce
  u: string; // user id
  e: number; // expira em (epoch s)
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function requireSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32) throw new Error("OAUTH_STATE_SECRET ausente ou curto (mínimo 32 caracteres)");
  return secret;
}

export async function createState(
  secret: string | undefined,
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ state: string; nonce: string }> {
  const key = requireSecret(secret);
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const body = b64url(JSON.stringify({ n: nonce, u: userId, e: nowSeconds + STATE_TTL_SECONDS } satisfies StatePayload));
  return { state: `${body}.${await hmacHex(key, body)}`, nonce };
}

export type StateCheck = { ok: true } | { ok: false; reason: "missing" | "signature" | "expired" | "nonce" | "user" };

export async function verifyState(
  secret: string | undefined,
  state: string | null,
  cookieNonce: string | undefined,
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<StateCheck> {
  const key = requireSecret(secret);
  if (!state || !cookieNonce) return { ok: false, reason: "missing" };
  const [body, sig, extra] = state.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, reason: "signature" };
  if (!timingSafeEqualHex(await hmacHex(key, body), sig.toLowerCase())) return { ok: false, reason: "signature" };
  let p: StatePayload;
  try {
    p = JSON.parse(fromB64url(body)) as StatePayload;
  } catch {
    return { ok: false, reason: "signature" };
  }
  if (typeof p.e !== "number" || nowSeconds > p.e) return { ok: false, reason: "expired" };
  if (p.n !== cookieNonce) return { ok: false, reason: "nonce" };
  if (p.u !== userId) return { ok: false, reason: "user" };
  return { ok: true };
}
