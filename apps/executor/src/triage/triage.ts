import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { TRIAGE_PROMPT_VERSION, TRIAGE_SYSTEM, TriageSchema, type Triage } from "@ironnews/shared";
import type { Pool } from "../db";
import { truncate } from "../ingest/normalize";

/** Item pronto para triagem (título/resumo/trecho já limpos na coleta). */
export interface TriageItem {
  id: string;
  source_name: string;
  title: string;
  summary: string | null;
  content_excerpt: string | null;
  published_at: Date | null;
}

const EXCERPT_FOR_LLM = 1200; // §9.1

const attr = (s: string) => s.replace(/["<>&]/g, " ").trim();

/** Conteúdo externo só dentro de <source> (§9.2). `</source>` já foi removido do texto na coleta. */
export function sourceBlock(it: TriageItem): string {
  const lines = [
    `<source id="${it.id}" name="${attr(it.source_name)}">`,
    `Título: ${it.title}`,
    it.published_at ? `Publicado em: ${it.published_at.toISOString().slice(0, 10)}` : "",
    it.summary ? `Resumo: ${it.summary}` : "",
    it.content_excerpt && it.content_excerpt !== it.summary ? `Trecho: ${truncate(it.content_excerpt, EXCERPT_FOR_LLM)}` : "",
    "</source>",
  ];
  return lines.filter(Boolean).join("\n");
}

export function triageParams(model: string, it: TriageItem): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 2000,
    system: [{ type: "text", text: TRIAGE_SYSTEM, cache_control: { type: "ephemeral" } }],
    // Classificação: esforço baixo basta e reduz tokens de raciocínio.
    output_config: { effort: "low", format: zodOutputFormat(TriageSchema) },
    messages: [{ role: "user", content: sourceBlock(it) }],
  };
}

/** Corta excessos inofensivos (texto longo, listas grandes) antes de validar, para não descartar por detalhe. */
export function coerceTriage(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const t = { ...(raw as Record<string, unknown>) };
  const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : v);
  const list = (v: unknown, n: number, len: number) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, n).map((x: string) => x.slice(0, len)) : v;
  t.one_line = cut(t.one_line, 200);
  t.discard_reason = cut(t.discard_reason, 120);
  if (typeof t.relevance === "number") t.relevance = Math.min(1, Math.max(0, t.relevance));
  const e = t.entities;
  if (e && typeof e === "object") {
    const en = { ...(e as Record<string, unknown>) };
    en.cves = Array.isArray(en.cves)
      ? [...new Set(en.cves.filter((c): c is string => typeof c === "string").map((c) => c.toUpperCase()))]
          .filter((c) => /^CVE-\d{4}-\d{4,7}$/.test(c)).slice(0, 20)
      : en.cves;
    en.vendors = list(en.vendors, 10, 60);
    en.threat_actors = list(en.threat_actors, 5, 60);
    en.victims = list(en.victims, 10, 80);
    en.countries = Array.isArray(en.countries)
      ? en.countries.filter((c): c is string => typeof c === "string" && /^[A-Za-z]{2}$/.test(c)).map((c) => c.toUpperCase()).slice(0, 10)
      : en.countries;
    t.entities = en;
  }
  return t;
}

export type TriageOutcome = { ok: true; triage: Triage } | { ok: false; reason: string };

/** Interpreta a resposta do modelo (RN-TRI02: saída inválida ⇒ item descartado com motivo). */
export function parseTriageMessage(msg: Pick<Anthropic.Message, "content" | "stop_reason">): TriageOutcome {
  if (msg.stop_reason === "refusal") return { ok: false, reason: "modelo recusou classificar" };
  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) return { ok: false, reason: `sem saída (${msg.stop_reason ?? "?"})` };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: `JSON inválido (${msg.stop_reason ?? "?"})` };
  }
  const parsed = TriageSchema.safeParse(coerceTriage(json));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `schema inválido: ${first?.path.join(".")} ${first?.message}`.slice(0, 200) };
  }
  return { ok: true, triage: parsed.data };
}

/**
 * Grava o resultado no item e atualiza o cluster: relevância máxima, categoria do item mais
 * relevante, flags (só `true`), CVEs citadas, e o top_score (RN-TRI05).
 */
export async function applyTriage(pool: Pool, itemId: string, outcome: TriageOutcome, model: string): Promise<void> {
  if (!outcome.ok) {
    await pool.query(
      "update raw_items set status = 'discarded', discard_reason = $2 where id = $1 and status = 'new'",
      [itemId, `triagem: ${outcome.reason}`.slice(0, 300)],
    );
    return;
  }
  const t = outcome.triage;
  const stored = { ...t, model, prompt_version: TRIAGE_PROMPT_VERSION };
  if (!t.is_relevant) {
    await pool.query(
      `update raw_items set status = 'discarded', triage = $2::jsonb, category = $3, severity = $4,
              relevance = $5, discard_reason = $6 where id = $1`,
      [itemId, JSON.stringify(stored), t.category, t.severity, t.relevance, t.discard_reason ?? "não relevante"],
    );
    return;
  }
  const { rows } = await pool.query<{ cluster_id: string | null }>(
    `update raw_items set status = 'triaged', triage = $2::jsonb, category = $3, severity = $4,
            relevance = $5, discard_reason = null,
            cve_ids = array(select distinct unnest(cve_ids || $6::text[]) order by 1)
      where id = $1 returning cluster_id`,
    [itemId, JSON.stringify(stored), t.category, t.severity, t.relevance, t.entities.cves],
  );
  const clusterId = rows[0]?.cluster_id;
  if (!clusterId) return;
  const flags = Object.fromEntries(Object.entries(t.flags).filter(([, v]) => v));
  await pool.query(
    `update clusters c
        set category = case when $2 >= c.relevance_max or c.category is null then $3 else c.category end,
            relevance_max = greatest(c.relevance_max, $2),
            flags = c.flags || $4::jsonb,
            cve_ids = array(select distinct unnest(c.cve_ids || $5::text[]) order by 1)
      where c.id = $1`,
    [clusterId, t.relevance, t.category, JSON.stringify(flags), t.entities.cves],
  );
  await pool.query("update clusters c set top_score = cluster_score(c) where c.id = $1", [clusterId]);
}
