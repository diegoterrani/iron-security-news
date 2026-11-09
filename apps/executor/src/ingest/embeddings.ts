/**
 * Embeddings bge-m3 (1024 dims) via Cloudflare Workers AI (§8.2).
 * Opcional: sem CF_ACCOUNT_ID/CF_AI_TOKEN o agrupamento usa só CVE em comum + similaridade de título.
 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

const BATCH = 32;

export function createEmbedder(accountId?: string, token?: string, fetchImpl: typeof fetch = fetch): Embedder | null {
  if (!accountId || !token) return null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-m3`;
  return async (texts) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: texts.slice(i, i + BATCH) }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json()) as { success?: boolean; result?: { data?: number[][] }; errors?: { message: string }[] };
      if (!res.ok || !body.success || !body.result?.data) {
        throw new Error(`Workers AI: ${res.status} ${body.errors?.map((e) => e.message).join("; ") ?? ""}`.trim());
      }
      out.push(...body.result.data);
    }
    return out;
  };
}

export const toPgVector = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`;
export const fromPgVector = (s: string) => s.replace(/^\[|\]$/g, "").split(",").map(Number);

/** Média incremental do centroide (RN-ING05). */
export function updateCentroid(centroid: number[], n: number, v: number[]): number[] {
  return centroid.map((c, i) => (c * n + (v[i] ?? 0)) / (n + 1));
}
