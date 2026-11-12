import { describe, expect, it } from "vitest";
import { TokenCryptoError, base64ToBytes, bytesToBase64, decryptToken, encryptToken } from "../src/token-crypto";

const key = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
const other = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
const ctx = "instagram:17841400000000000";

describe("token-crypto (AES-256-GCM, §7.3)", () => {
  it("cifra e decifra com a mesma chave e o mesmo contexto", async () => {
    const sealed = await encryptToken(key, "IGAAtoken-secreto", ctx);
    expect(sealed[0]).toBe(1);
    expect(new TextDecoder().decode(sealed)).not.toContain("IGAAtoken-secreto");
    expect(await decryptToken(key, sealed, ctx)).toBe("IGAAtoken-secreto");
  });
  it("IV aleatório: o mesmo token cifra diferente a cada vez", async () => {
    const a = await encryptToken(key, "t", ctx);
    const b = await encryptToken(key, "t", ctx);
    expect(bytesToBase64(a)).not.toBe(bytesToBase64(b));
  });
  it("chave errada, contexto de outra conta ou dado adulterado não decifram", async () => {
    const sealed = await encryptToken(key, "t", ctx);
    await expect(decryptToken(other, sealed, ctx)).rejects.toBeInstanceOf(TokenCryptoError);
    await expect(decryptToken(key, sealed, "instagram:999")).rejects.toBeInstanceOf(TokenCryptoError);
    const tampered = sealed.slice();
    tampered[tampered.length - 1]! ^= 1;
    await expect(decryptToken(key, tampered, ctx)).rejects.toBeInstanceOf(TokenCryptoError);
  });
  it("recusa chave ausente, inválida ou com tamanho errado", async () => {
    await expect(encryptToken(undefined, "t", ctx)).rejects.toThrow(/ausente/);
    await expect(encryptToken("@@@", "t", ctx)).rejects.toThrow(/base64/);
    await expect(encryptToken(bytesToBase64(new Uint8Array(16)), "t", ctx)).rejects.toThrow(/32 bytes/);
  });
  it("recusa formato desconhecido e token vazio", async () => {
    await expect(decryptToken(key, new Uint8Array([2, 1, 2, 3]), ctx)).rejects.toThrow(/formato/);
    await expect(encryptToken(key, "", ctx)).rejects.toThrow(/vazio/);
  });
  it("base64 ida e volta", () => {
    const b = new Uint8Array([0, 1, 254, 255]);
    expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
  });
});
