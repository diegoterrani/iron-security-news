import type Anthropic from "@anthropic-ai/sdk";
import { OPENROUTER_API_URL, openRouterHeaders } from "./client";

/**
 * Batch API do OpenRouter (POST/GET /api/v1/batches): ~50% do preço síncrono, conclusão em até 24 h.
 * Cada requisição usa o corpo da Messages API (`endpoint: "/v1/messages"`). Não há cancelamento:
 * lote vencido só é marcado como perdido do nosso lado.
 */
export type BatchStatus = "validating" | "in_progress" | "finalizing" | "completed" | "failed" | "expired" | "cancelled";

export interface BatchResult {
  custom_id: string;
  response?: { status_code: number; body: unknown } | null;
  error?: { code?: string | number; message?: string; type?: string } | null;
}

export interface BatchInfo {
  id: string;
  status: BatchStatus;
  results?: BatchResult[] | null;
  error?: unknown;
}

export class BatchHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface BatchClient {
  create(model: string, requests: { custom_id: string; params: Anthropic.MessageCreateParamsNonStreaming }[]): Promise<{ id: string }>;
  retrieve(id: string): Promise<BatchInfo>;
}

export function createBatchClient(apiKey: string, fetchImpl: typeof fetch = fetch): BatchClient {
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchImpl(`${OPENROUTER_API_URL}${path}`, {
      method,
      headers: openRouterHeaders(apiKey),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) throw new BatchHttpError(res.status, `OpenRouter batches ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  return {
    async create(model, requests) {
      // A ordem importa: endpoint/model/completion_window antes de `requests`, senão a API devolve 400.
      const body = {
        endpoint: "/v1/messages",
        model,
        completion_window: "24h",
        requests: requests.map((r) => {
          const { model: _m, ...rest } = r.params;
          return { custom_id: r.custom_id, body: rest };
        }),
      };
      return (await call("POST", "/batches", body)) as { id: string };
    },
    async retrieve(id) {
      return (await call("GET", `/batches/${encodeURIComponent(id)}`)) as BatchInfo;
    },
  };
}

export const BATCH_TERMINAL: ReadonlySet<BatchStatus> = new Set(["completed", "failed", "expired", "cancelled"]);
