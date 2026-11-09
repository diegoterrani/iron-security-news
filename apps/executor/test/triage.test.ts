import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { costUsd, parsePriceTable, DEFAULT_PRICES } from "../src/llm/usage";
import { coerceTriage, parseTriageMessage, sourceBlock, triageParams } from "../src/triage/triage";
import { localClock, pickClusters, selectionMinute } from "../src/triage/selection";

const valid = {
  is_relevant: true,
  discard_reason: null,
  category: "ransomware",
  severity: "high",
  relevance: 0.82,
  flags: { zero_day: false, exploited: true, brazil: true },
  entities: { cves: ["CVE-2026-1234"], vendors: ["Acme"], threat_actors: ["LockBit"], victims: ["Hospital X"], countries: ["BR"] },
  one_line: "Ransomware atinge hospital no Brasil.",
};

const msg = (text: string | null, stop: Anthropic.Message["stop_reason"] = "end_turn") =>
  ({ content: text === null ? [] : [{ type: "text", text, citations: null }], stop_reason: stop }) as unknown as Anthropic.Message;

describe("parseTriageMessage (RN-TRI02)", () => {
  it("aceita saída válida", () => {
    const r = parseTriageMessage(msg(JSON.stringify(valid)));
    expect(r.ok && r.triage.category).toBe("ransomware");
  });
  it("normaliza excessos inofensivos em vez de descartar", () => {
    const messy = { ...valid, one_line: "x".repeat(300), relevance: 1.3,
      entities: { ...valid.entities, cves: ["cve-2026-1234", "CVE-2026-1234", "lixo"], countries: ["br", "Brasil"] } };
    const r = parseTriageMessage(msg(JSON.stringify(messy)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.triage.one_line).toHaveLength(200);
      expect(r.triage.relevance).toBe(1);
      expect(r.triage.entities.cves).toEqual(["CVE-2026-1234"]);
      expect(r.triage.entities.countries).toEqual(["BR"]);
    }
  });
  it("descarta com motivo: categoria fora do enum, JSON quebrado, recusa, sem texto", () => {
    expect(parseTriageMessage(msg(JSON.stringify({ ...valid, category: "gossip" })))).toMatchObject({ ok: false, reason: expect.stringContaining("category") });
    expect(parseTriageMessage(msg("{nope", "max_tokens"))).toMatchObject({ ok: false, reason: "JSON inválido (max_tokens)" });
    expect(parseTriageMessage(msg(null, "refusal"))).toMatchObject({ ok: false, reason: "modelo recusou classificar" });
    expect(parseTriageMessage(msg(null))).toMatchObject({ ok: false });
  });
  it("coerceTriage não quebra com lixo", () => {
    expect(coerceTriage(null)).toBeNull();
    expect(coerceTriage("x")).toBe("x");
  });
});

describe("requisição de triagem (§9.2)", () => {
  const item = { id: "11111111-1111-1111-1111-111111111111", source_name: 'Evil "News" <x>', title: "Título",
    summary: "Resumo", content_excerpt: "y".repeat(3000), published_at: new Date("2026-11-08T10:00:00Z") };
  it("conteúdo externo só dentro de <source>, atributo sem aspas, trecho limitado", () => {
    const b = sourceBlock(item);
    expect(b.startsWith('<source id="11111111-1111-1111-1111-111111111111" name="Evil  News   x">')).toBe(true);
    expect(b.endsWith("</source>")).toBe(true);
    expect(b.length).toBeLessThan(1500);
    expect(b).toContain("Publicado em: 2026-11-08");
  });
  it("system fixo com cache, esforço baixo, saída estruturada", () => {
    const p = triageParams("claude-haiku-5-5", item);
    expect(p.model).toBe("claude-haiku-5-5");
    expect(Array.isArray(p.system) && p.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(p.output_config?.effort).toBe("low");
    expect(p.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(p.messages)).toContain("<source");
  });
});

describe("custo (llm_usage)", () => {
  it("Haiku 5.5 com cache e batch", () => {
    const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 };
    expect(costUsd(DEFAULT_PRICES, "claude-haiku-5-5", u, false)).toBeCloseTo(0.1 + 0.5 + 0.01, 6);
    expect(costUsd(DEFAULT_PRICES, "claude-haiku-5-5", u, true)).toBeCloseTo(0.305, 6);
  });
  it("modelo sem preço é erro explícito; tabela por env sobrescreve", () => {
    expect(() => costUsd(DEFAULT_PRICES, "x", { input_tokens: 1, output_tokens: 1 }, false)).toThrow(/sem preço/);
    const t = parsePriceTable('{"claude-haiku-5-5":{"input":0.2,"output":1}}');
    expect(t["claude-haiku-5-5"]).toEqual({ input: 0.2, output: 1 });
    expect(t["claude-sonnet-5-5"]).toBeDefined();
    expect(() => parsePriceTable('{"m":{"input":"a"}}')).toThrow(/inválida/);
  });
});

describe("seleção (RN-STO01/02)", () => {
  it("horário = primeira publicação − lead time", () => {
    expect(selectionMinute({ publish_times: { blog: ["08:00"], instagram: ["12:00"] }, lead_time_min: 120 })).toBe(6 * 60);
    expect(selectionMinute({ publish_times: { blog: ["01:00"] }, lead_time_min: 120 })).toBe(0);
  });
  it("relógio local no fuso da marca", () => {
    expect(localClock(new Date("2026-11-09T09:30:00Z"), "America/Sao_Paulo")).toEqual({ date: "2026-11-09", minutes: 6 * 60 + 30 });
    expect(localClock(new Date("2026-11-09T01:00:00Z"), "America/Sao_Paulo").date).toBe("2026-11-08");
  });
  it("respeita min_score e evita repetir categoria quando há alternativa", () => {
    const c = [
      { id: "a", category: "ransomware", score: 90 },
      { id: "b", category: "ransomware", score: 85 },
      { id: "c", category: "vulnerability", score: 70 },
      { id: "d", category: "malware", score: 40 },
    ];
    expect(pickClusters(c, 2, 55).map((x) => x.id)).toEqual(["a", "c"]);
    expect(pickClusters(c, 3, 55).map((x) => x.id)).toEqual(["a", "c", "b"]);
    expect(pickClusters(c, 2, 95)).toEqual([]);
  });
});
