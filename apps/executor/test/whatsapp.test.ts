import { describe, expect, it } from "vitest";
import type { Pool } from "../src/db";
import { claimWhatsappJob, completeWhatsappJob, failWhatsappJob, whatsappCaption } from "../src/publish/whatsapp";

const URL = "https://news.iron-security.com/pt/falha-critica-em-firewalls";

describe("legenda do WhatsApp", () => {
  it("título em negrito, TL;DR e link, separados por linha em branco", () => {
    expect(whatsappCaption({ title: "Falha crítica em firewalls", tldr: "Fabricante corrigiu.", url: URL }))
      .toBe(`*Falha crítica em firewalls*\n\nFabricante corrigiu.\n\nLeia completo: ${URL}`);
  });

  it("tira marcadores de formatação do título, que quebrariam o negrito", () => {
    expect(whatsappCaption({ title: "Ataque *grave* a _bancos_ ~hoje~", tldr: "", url: URL }))
      .toBe(`*Ataque grave a bancos hoje*\n\nLeia completo: ${URL}`);
  });

  it("corta o TL;DR longo numa palavra, sem cortar o link", () => {
    const caption = whatsappCaption({ title: "T", tldr: "palavra ".repeat(200), url: URL });
    const tldr = caption.split("\n\n")[1]!;
    expect(tldr.length).toBeLessThanOrEqual(601);
    expect(tldr.endsWith("palavra…")).toBe(true);
    expect(caption.endsWith(`Leia completo: ${URL}`)).toBe(true);
  });
});

/** Pool falso: devolve as respostas na ordem e guarda as consultas. */
function fakePool(responses: { rows?: unknown[]; rowCount?: number }[]) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const r = responses.shift() ?? {};
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
    },
  } as unknown as Pool;
  return { pool, calls };
}

const STORY = "0eb8ff71-10c3-451a-b712-5b9ba0fb01b7";
const JOB = "a4b4e2d1-7695-4c51-89ec-ab51653172d9";

describe("fila do WhatsApp", () => {
  it("fila vazia: só marca os envios presos e devolve null", async () => {
    const { pool, calls } = fakePool([{ rowCount: 0 }, { rows: [] }]);
    expect(await claimWhatsappJob(pool)).toBeNull();
    expect(calls[0]!.sql).toMatch(/status = 'failed'[\s\S]*status = 'sending'/);
    expect(calls).toHaveLength(2);
  });

  it("monta capa e legenda do pedido", async () => {
    const { pool } = fakePool([
      { rowCount: 0 },
      { rows: [{ id: JOB, story_id: STORY, lang: "pt" }] },
      { rows: [{ title: "Falha crítica", tldr: "Resumo.", url: URL, cover: "https://cdn/cover.png" }] },
    ]);
    expect(await claimWhatsappJob(pool)).toEqual({
      id: JOB, storyId: STORY, mediaUrl: "https://cdn/cover.png",
      caption: `*Falha crítica*\n\nResumo.\n\nLeia completo: ${URL}`,
    });
  });

  it("pedido sem capa falha com o motivo e passa para o próximo", async () => {
    const { pool, calls } = fakePool([
      { rowCount: 0 },
      { rows: [{ id: JOB, story_id: STORY, lang: "pt" }] },
      { rows: [{ title: "Falha", tldr: "", url: URL, cover: null }] },
      { rowCount: 1 },
      { rows: [] },
    ]);
    expect(await claimWhatsappJob(pool)).toBeNull();
    expect(calls[3]!.params).toEqual([JOB, "sem capa"]);
  });

  it("done e fail só mudam pedidos em envio", async () => {
    const done = fakePool([{ rowCount: 1 }]);
    expect(await completeWhatsappJob(done.pool, JOB, "3EB0ABC")).toBe(true);
    expect(done.calls[0]!.sql).toMatch(/where id = \$1 and status = 'sending'/);
    const fail = fakePool([{ rowCount: 0 }]);
    expect(await failWhatsappJob(fail.pool, JOB, "  gateway\n  fora  ")).toBe(false);
    expect(fail.calls[0]!.params).toEqual([JOB, "gateway fora"]);
  });
});
