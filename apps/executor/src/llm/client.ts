import Anthropic from "@anthropic-ai/sdk";

/**
 * Toda a IA passa pelo OpenRouter, no endpoint compatível com a Messages API da Anthropic
 * (POST https://openrouter.ai/api/v1/messages). O SDK da Anthropic continua sendo o cliente:
 * mesmos parâmetros (system com cache_control, output_config.effort/format, streaming), só muda
 * a base e a autenticação (Authorization: Bearer <OPENROUTER_API_KEY>).
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
export const OPENROUTER_API_URL = `${OPENROUTER_BASE_URL}/v1`;

/** Cabeçalhos de atribuição opcionais do OpenRouter (aparecem no painel de uso). */
const ATTRIBUTION = { "HTTP-Referer": "https://news.iron-security.com", "X-Title": "Iron Cyber News" };

export function createLlmClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey: null,
    authToken: apiKey,
    baseURL: OPENROUTER_BASE_URL,
    maxRetries: 3,
    defaultHeaders: ATTRIBUTION,
  });
}

export function openRouterHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...ATTRIBUTION };
}

/**
 * Converte IDs no formato da Anthropic (`claude-haiku-5-5`) para o slug do OpenRouter
 * (`anthropic/claude-haiku-5.5`). Slugs que já têm provedor (`x/y`) passam direto; o sufixo
 * `:batch` sai, porque o preço de lote é aplicado à parte.
 */
export function toOpenRouterModel(model: string): string {
  const m = model.trim().replace(/:batch$/, "");
  if (m.includes("/")) return m;
  const legacy = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(m);
  if (legacy) return `anthropic/claude-${legacy[1]}-${legacy[2]}.${legacy[3]}`;
  return m.startsWith("claude-") ? `anthropic/${m}` : m;
}
