/**
 * Verifica a chave e o modelo do OpenRouter com uma triagem de exemplo (síncrona, custa frações de centavo).
 * Uso no container:  node dist/llm-check.js
 * Confere: autenticação, saída estruturada (output_config.format), esforço e o custo devolvido em usage.cost.
 */
import { loadConfig } from "./config";
import { createLlmClient } from "./llm/client";
import { parseTriageMessage, triageParams } from "./triage/triage";

const config = loadConfig();
if (!config.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY ausente");
const client = createLlmClient(config.OPENROUTER_API_KEY);
const msg = await client.messages.create(triageParams(config.LLM_MODEL_DEFAULT, {
  id: "00000000-0000-0000-0000-000000000000",
  source_name: "Teste",
  title: "Vulnerabilidade crítica CVE-2026-12345 explorada ativamente em firewalls de borda",
  summary: "Fabricante publicou correção de emergência; CISA adicionou a falha ao catálogo KEV.",
  content_excerpt: null,
  published_at: new Date(),
}));
const outcome = parseTriageMessage(msg);
console.log(JSON.stringify({
  model: msg.model, stop_reason: msg.stop_reason, usage: msg.usage,
  ok: outcome.ok, result: outcome.ok ? { category: outcome.triage.category, relevance: outcome.triage.relevance } : outcome.reason,
}, null, 2));
process.exit(outcome.ok ? 0 : 1);
