import { describe, expect, it } from "vitest";
import { extractCves, signRequest, verifyRequest } from "../src";

describe("hmac", () => {
  it("aceita assinatura válida e rejeita adulterada, segredo errado, expirada e sem timestamp", async () => {
    const now = 1_762_430_000;
    const body = JSON.stringify({ a: 1 });
    const { timestamp, signature } = await signRequest("s3cret", body, now);
    expect(await verifyRequest("s3cret", body, timestamp, signature, now)).toBe(true);
    expect(await verifyRequest("s3cret", JSON.stringify({ a: 2 }), timestamp, signature, now)).toBe(false);
    expect(await verifyRequest("other", body, timestamp, signature, now)).toBe(false);
    expect(await verifyRequest("s3cret", body, timestamp, signature, now + 301)).toBe(false);
    expect(await verifyRequest("s3cret", body, null, signature, now)).toBe(false);
  });
});

describe("extractCves", () => {
  it("deduplica e normaliza para maiúsculas", () => {
    expect(extractCves("cve-2026-1234 e CVE-2026-1234, CVE-2025-123456")).toEqual([
      "CVE-2026-1234",
      "CVE-2025-123456",
    ]);
  });
});
