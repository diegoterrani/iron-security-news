import { describe, expect, it } from "vitest";
import { hmacHex } from "@ironnews/shared";
import { parseMetaSignedRequest, verifyHeygen } from "../src/verify";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

describe("verifyHeygen", () => {
  it("valida HMAC do corpo", async () => {
    const body = JSON.stringify({ event_type: "avatar_video.success" });
    const sig = await hmacHex("whsec", body);
    expect(await verifyHeygen("whsec", body, sig)).toBe(true);
    expect(await verifyHeygen("whsec", body + " ", sig)).toBe(false);
    expect(await verifyHeygen("whsec", body, null)).toBe(false);
  });
});

describe("parseMetaSignedRequest", () => {
  it("aceita assinatura válida e rejeita adulterada", async () => {
    const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "42" })));
    const sigB64 = b64url(hexToBytes(await hmacHex("appsecret", payloadB64)));
    expect((await parseMetaSignedRequest("appsecret", `${sigB64}.${payloadB64}`))?.user_id).toBe("42");
    expect(await parseMetaSignedRequest("wrong", `${sigB64}.${payloadB64}`)).toBeNull();
    expect(await parseMetaSignedRequest("appsecret", `${sigB64}.${payloadB64}x`)).toBeNull();
    expect(await parseMetaSignedRequest("appsecret", "garbage")).toBeNull();
  });
});
