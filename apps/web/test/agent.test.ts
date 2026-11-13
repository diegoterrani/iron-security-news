import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bearerMatches, canonicalJson, normalizePhone, parseAdminMap, verifySignature } from "../lib/agent/signature";
import { findTool, toolManifest } from "../lib/agent/tools";
import { AgentError, rpcError } from "../lib/agent/db";
import type { AgentContext } from "../lib/agent/auth";

const SECRET = "h".repeat(48);
const UUID = "0b0f4c1e-1111-4222-8333-944455556666";

describe("assinatura (mesmo contrato do servidor MCP do OpenClaw)", () => {
  // Reproduz exatamente o que packages/agent-mcp/src/api.mjs (repo do site) assina.
  const mcpSign = (ts: string, method: string, path: string, body: string) =>
    createHmac("sha256", SECRET).update(`${ts}.${method}.${path}.${body}`).digest("hex");

  it("aceita a assinatura do MCP dentro da janela", () => {
    const now = 1_800_000_000_000;
    const ts = String(now);
    const body = JSON.stringify({ args: {} });
    const signature = mcpSign(ts, "POST", "/api/agent/v1/tools/fila_revisao", body);
    expect(verifySignature({ secret: SECRET, timestamp: ts, signature, method: "POST", path: "/api/agent/v1/tools/fila_revisao", body, now })).toBe(true);
  });

  it("recusa corpo, caminho ou método trocados, janela vencida e segredo curto", () => {
    const now = 1_800_000_000_000;
    const ts = String(now);
    const sig = mcpSign(ts, "POST", "/api/agent/v1/tools/aprovar_materia", "{}");
    const base = { secret: SECRET, timestamp: ts, signature: sig, method: "POST", path: "/api/agent/v1/tools/aprovar_materia", body: "{}", now };
    expect(verifySignature(base)).toBe(true);
    expect(verifySignature({ ...base, body: '{"x":1}' })).toBe(false);
    expect(verifySignature({ ...base, path: "/api/agent/v1/tools/rejeitar_materia" })).toBe(false);
    expect(verifySignature({ ...base, method: "GET" })).toBe(false);
    expect(verifySignature({ ...base, now: now + 6 * 60 * 1000 })).toBe(false);
    expect(verifySignature({ ...base, secret: "curto" })).toBe(false);
  });

  it("Bearer exige token de 32+ caracteres e igual", () => {
    expect(bearerMatches(`Bearer ${"t".repeat(40)}`, "t".repeat(40))).toBe(true);
    expect(bearerMatches(`Bearer ${"t".repeat(40)}`, "u".repeat(40))).toBe(false);
    expect(bearerMatches("Bearer abc", "abc")).toBe(false);
    expect(bearerMatches(null, "t".repeat(40))).toBe(false);
  });

  it("normaliza telefone e lê AGENT_ADMINS", () => {
    expect(normalizePhone("+55 (11) 98444-0000")).toBe("5511984440000");
    expect(normalizePhone("5511984440000@s.whatsapp.net")).toBe("5511984440000");
    expect(normalizePhone("123")).toBeNull();
    const map = parseAdminMap(`5511984440000=${UUID}, lixo, 551199=xx`);
    expect(map.get("5511984440000")).toBe(UUID);
    expect(map.size).toBe(1);
  });

  it("JSON canônico ignora ordem das chaves", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("ferramentas do News", () => {
  it("manifesto com JSON Schema de objeto e nomes únicos", () => {
    const m = toolManifest();
    expect(m.length).toBeGreaterThanOrEqual(15);
    expect(new Set(m.map((t) => t.name)).size).toBe(m.length);
    for (const t of m) expect(t.input_schema).toMatchObject({ type: "object" });
  });

  it("o que publica, rejeita ou desliga pede confirmação; leituras não", () => {
    const confirm = new Set(toolManifest().filter((t) => t.requires_confirmation).map((t) => t.name));
    for (const n of ["aprovar_materia", "rejeitar_materia", "publicar_instagram", "publicar_linkedin", "pausar_fonte"]) expect(confirm.has(n)).toBe(true);
    for (const n of ["fila_revisao", "ver_materia", "status_publicacao", "falhas", "custos_ia", "integracoes", "editar_texto", "retomar_fonte"]) expect(confirm.has(n)).toBe(false);
  });

  it("valida entradas", () => {
    expect(findTool("aprovar_materia")!.input.safeParse({ story_id: UUID, publicar_em: "amanhã" }).success).toBe(false);
    expect(findTool("aprovar_materia")!.input.safeParse({ story_id: UUID, publicar_em: "2026-11-14T09:00:00-03:00" }).success).toBe(true);
    expect(findTool("rejeitar_materia")!.input.safeParse({ story_id: UUID, motivo: "x" }).success).toBe(false);
    expect(findTool("publicar_linkedin")!.input.safeParse({ story_id: UUID, alvo: "grupo" }).success).toBe(false);
    expect(findTool("fila_revisao")!.input.parse({})).toEqual({ limite: 10 });
  });

  it("editar_texto recusa campo que o painel não permite, antes de tocar no banco", async () => {
    const tool = findTool("editar_texto")!;
    const ctx = { db: {} as never, sender: "1", actor: UUID } as AgentContext;
    const args = tool.input.parse({ story_id: UUID, canal: "instagram", campos: { slides: "x" } });
    await expect(tool.run(args, ctx)).rejects.toThrow(/não é editável/);
    const curto = tool.input.parse({ story_id: UUID, canal: "blog", campos: { markdown: "curto" } });
    await expect(tool.run(curto, ctx)).rejects.toThrow(/curto demais/);
  });

  it("traduz erros das RPCs", () => {
    expect(rpcError("VALIDATION_ERROR: o carrossel ainda não está pronto").message).toBe("o carrossel ainda não está pronto");
    expect(rpcError("INVALID_STATE")).toBeInstanceOf(AgentError);
    expect(rpcError("FORBIDDEN").status).toBe(403);
  });
});
