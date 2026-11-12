/**
 * Cifra dos tokens OAuth guardados em `integrations.access_token_enc` (§7.3).
 *
 * - AES-256-GCM (WebCrypto: Node 22, Edge e Workers), chave de 32 bytes em base64 na variável TOKEN_ENC_KEY.
 * - A chave fica só no servidor (Vercel e VPS do executor); o banco guarda apenas o texto cifrado.
 *   Um vazamento do banco sozinho não expõe os tokens.
 * - O `context` (ex.: "instagram:17841400000000000") entra como dado autenticado (AAD): um token
 *   cifrado para uma conta não decifra se for copiado para a linha de outra conta.
 * - Formato v1: [0x01][IV de 12 bytes][texto cifrado + tag GCM de 16 bytes].
 */
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const enc = new TextEncoder();
const dec = new TextDecoder();

type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function importKey(keyB64: string | undefined): Promise<AesKey> {
  if (!keyB64) throw new TokenCryptoError("TOKEN_ENC_KEY ausente");
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(keyB64);
  } catch {
    throw new TokenCryptoError("TOKEN_ENC_KEY não é base64 válido");
  }
  if (raw.length !== 32) throw new TokenCryptoError("TOKEN_ENC_KEY precisa ter 32 bytes (gere com: openssl rand -base64 32)");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptToken(keyB64: string | undefined, plaintext: string, context: string): Promise<Uint8Array> {
  if (!plaintext) throw new TokenCryptoError("token vazio");
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(context) as BufferSource },
      key,
      enc.encode(plaintext) as BufferSource,
    ),
  );
  const out = new Uint8Array(1 + IV_BYTES + sealed.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(sealed, 1 + IV_BYTES);
  return out;
}

export async function decryptToken(keyB64: string | undefined, data: Uint8Array, context: string): Promise<string> {
  if (data.length < 1 + IV_BYTES + TAG_BYTES + 1 || data[0] !== VERSION) throw new TokenCryptoError("token cifrado em formato desconhecido");
  const key = await importKey(keyB64);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.subarray(1, 1 + IV_BYTES) as BufferSource, additionalData: enc.encode(context) as BufferSource },
      key,
      data.subarray(1 + IV_BYTES) as BufferSource,
    );
    return dec.decode(plain);
  } catch {
    // Não repassa o erro original: só diz que a autenticação falhou (chave errada, contexto errado ou dado adulterado).
    throw new TokenCryptoError("falha ao decifrar o token (chave, contexto ou dado inválido)");
  }
}
