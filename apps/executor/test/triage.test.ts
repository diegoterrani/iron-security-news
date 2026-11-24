import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { toOpenRouterModel } from "../src/llm/client";
import { costUsd, parsePriceTable, DEFAULT_PRICES } from "../src/llm/usage";
import { coerceTriage, parseTriageMessage, sourceBlock, triageParams } from "../src/triage/triage";
import { DEDUP_COSINE, cosine, cumulativeQuota, dueSlot, localClock, pickClusters, realtimeGate, selectionMinute, selectionSlots } from "../src/triage/selection";
import { TRIAGE_PROMPT_VERSION, TRIAGE_SYSTEM } from "@ironnews/shared";

const valid = {
  is_relevant: true,
  discard_reason: null,
  category: "ransomware",
  severity: "high",
  relevance: 0.82,
  br_impact: 1,
  flags: { zero_day: false, exploited: true, brazil: true },
  entities: { cves: ["CVE-2026-1234"], vendors: ["Acme"], threat_actors: ["LockBit"], victims: ["Hospital X"], countries: ["BR"] },
  one_line: "Ransomware atinge hospital no Brasil.",
};

const msg = (text: string | null, stop: Anthropic.Message["stop_reason"] = "end_turn") =>
  ({ content: text === null ? [] : [{ type: "text", text, citations: null }], stop_reason: stop }) as unknown as Anthropic.Message;

describe("triage@2: impacto no Brasil", () => {
  it("prompt pede br_impact com régua exigente para o mercado brasileiro", () => {
    expect(TRIAGE_PROMPT_VERSION).toBe("triage@2");
    expect(TRIAGE_SYSTEM).toMatch(/br_impact vai de 0 a 1/);
    expect(TRIAGE_SYSTEM).toMatch(/0 a 0,3 = produto de nicho/);
  });
  it("br_impact é obrigatório e fica entre 0 e 1", () => {
    const { br_impact: _omit, ...without } = valid;
    expect(parseTriageMessage(msg(JSON.stringify(without))).ok).toBe(false);
    const r = parseTriageMessage(msg(JSON.stringify({ ...valid, br_impact: 1.7 })));
    expect(r.ok && r.triage.br_impact).toBe(1);
  });
});

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
  it("custo informado pelo OpenRouter tem prioridade (já inclui cache e lote)", () => {
    const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cost: 0.0123 };
    expect(costUsd(DEFAULT_PRICES, "anthropic/claude-haiku-5.5", u, true)).toBe(0.0123);
    expect(costUsd(DEFAULT_PRICES, "modelo-desconhecido", u, false)).toBe(0.0123);
  });
  it("modelo sem preço é erro explícito; tabela por env sobrescreve", () => {
    expect(() => costUsd(DEFAULT_PRICES, "x", { input_tokens: 1, output_tokens: 1 }, false)).toThrow(/sem preço/);
    const t = parsePriceTable('{"claude-haiku-5-5":{"input":0.2,"output":1}}');
    expect(t["anthropic/claude-haiku-5.5"]).toEqual({ input: 0.2, output: 1 });
    expect(t["anthropic/claude-sonnet-5.5"]).toBeDefined();
    expect(() => parsePriceTable('{"m":{"input":"a"}}')).toThrow(/inválida/);
  });
});

describe("seleção (RN-STO01/02)", () => {
  it("horário = primeira publicação − lead time", () => {
    expect(selectionMinute({ publish_times: { blog: ["08:00"], instagram: ["12:00"] }, lead_time_min: 120 })).toBe(6 * 60);
    expect(selectionMinute({ publish_times: { blog: ["01:00"] }, lead_time_min: 120 })).toBe(0);
  });
  it("uma rodada por horário do blog, ordenada, ignorando horário inválido", () => {
    const slots = selectionSlots({ publish_times: { blog: ["17:00", "08:00", "25:00", "08:00"], instagram: ["12:00"] }, lead_time_min: 120 });
    expect(slots).toEqual([{ time: "08:00", minute: 6 * 60 }, { time: "17:00", minute: 15 * 60 }]);
    // Sem blog: comportamento antigo (primeiro horário de qualquer canal).
    expect(selectionSlots({ publish_times: { instagram: ["12:00", "09:00"] }, lead_time_min: 60 })).toEqual([{ time: "09:00", minute: 8 * 60 }]);
  });
  it("rodada vigente = última cujo horário já passou", () => {
    const slots = [{ time: "08:00", minute: 360 }, { time: "17:00", minute: 900 }];
    expect(dueSlot(slots, 359)).toBeNull();
    expect(dueSlot(slots, 360)?.index).toBe(0);
    expect(dueSlot(slots, 899)?.index).toBe(0);
    expect(dueSlot(slots, 1439)?.slot.time).toBe("17:00");
  });
  it("vagas acumuladas: 2/dia em 2 rodadas = 1 e depois 2; nunca passa do total", () => {
    expect([0, 1].map((i) => cumulativeQuota(2, 2, i))).toEqual([1, 2]);
    expect([0, 1].map((i) => cumulativeQuota(3, 2, i))).toEqual([2, 3]);
    expect([0, 1, 2].map((i) => cumulativeQuota(1, 3, i))).toEqual([1, 1, 1]);
    expect(cumulativeQuota(2, 2, 5)).toBe(2);
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

describe("OpenRouter: nomes de modelo", () => {
  it("converte IDs da Anthropic e mantém slugs do OpenRouter", () => {
    expect(toOpenRouterModel("claude-haiku-5-5")).toBe("anthropic/claude-haiku-5.5");
    expect(toOpenRouterModel("claude-sonnet-5-5")).toBe("anthropic/claude-sonnet-5.5");
    expect(toOpenRouterModel("anthropic/claude-haiku-5.5")).toBe("anthropic/claude-haiku-5.5");
    expect(toOpenRouterModel("anthropic/claude-haiku-5.5:batch")).toBe("anthropic/claude-haiku-5.5");
    expect(toOpenRouterModel("deepseek/deepseek-v4.1-flash")).toBe("deepseek/deepseek-v4.1-flash");
  });
});

describe("modo real-time (freios)", () => {
  const now = new Date("2026-11-18T15:00:00Z");
  const base = { createdToday: 2, maxPerDay: 8, lastCreatedAt: null, gapMin: 15, now };
  it("libera quando há folga no teto e no intervalo", () => {
    expect(realtimeGate(base)).toEqual({ ok: true });
    expect(realtimeGate({ ...base, lastCreatedAt: new Date("2026-11-18T14:44:00Z") })).toEqual({ ok: true });
  });
  it("bloqueia no teto diário", () => {
    expect(realtimeGate({ ...base, createdToday: 8 })).toEqual({ ok: false, reason: "daily_cap" });
  });
  it("bloqueia dentro do intervalo mínimo", () => {
    expect(realtimeGate({ ...base, lastCreatedAt: new Date("2026-11-18T14:50:00Z") })).toEqual({ ok: false, reason: "gap" });
  });
  it("intervalo 0 desliga o freio de intervalo", () => {
    expect(realtimeGate({ ...base, gapMin: 0, lastCreatedAt: now })).toEqual({ ok: true });
  });
});

describe("dedupe de pautas do mesmo evento", () => {
  const v = (...n: number[]) => `[${n.join(",")}]`;
  it("cosseno básico", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([], [1])).toBe(0);
  });
  it("não escolhe dois clusters do mesmo evento, mesmo na 2ª passada", () => {
    expect(DEDUP_COSINE).toBeLessThan(0.85);
    const c = [
      { id: "a", category: "zero_day", score: 90, centroid: v(1, 0, 0) },
      { id: "b", category: "zero_day", score: 85, centroid: v(0.98, 0.1, 0) },
      { id: "c", category: "malware", score: 70, centroid: v(0, 1, 0) },
    ];
    expect(pickClusters(c, 3, 55).map((x) => x.id)).toEqual(["a", "c"]);
  });
  it("sem centroide não bloqueia (comportamento anterior)", () => {
    const c = [
      { id: "a", category: "zero_day", score: 90 },
      { id: "b", category: "zero_day", score: 85 },
    ];
    expect(pickClusters(c, 2, 55).map((x) => x.id)).toEqual(["a", "b"]);
  });
});
