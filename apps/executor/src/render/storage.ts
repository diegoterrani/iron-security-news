/** Upload para o Supabase Storage (bucket público `media`, leitura aberta; escrita só com a chave de serviço). */
export interface StorageConfig {
  supabaseUrl: string;
  serviceKey: string;
  bucket?: string;
  fetchImpl?: typeof fetch;
}

export function publicUrl(cfg: StorageConfig, objectPath: string): string {
  return `${cfg.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${cfg.bucket ?? "media"}/${objectPath}`;
}

export async function uploadObject(cfg: StorageConfig, objectPath: string, data: Buffer, contentType: string): Promise<string> {
  if (!/^[a-z0-9/_.-]+$/i.test(objectPath) || objectPath.includes("..")) throw new Error(`caminho inválido: ${objectPath}`);
  const url = `${cfg.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/${cfg.bucket ?? "media"}/${objectPath}`;
  const res = await (cfg.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      apikey: cfg.serviceKey,
      authorization: `Bearer ${cfg.serviceKey}`,
      "content-type": contentType,
      "x-upsert": "true",
      // O nome do arquivo leva o hash do conteúdo (RN-RND03): pode ficar em cache para sempre.
      "cache-control": "max-age=31536000, immutable",
    },
    body: new Uint8Array(data),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Storage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return publicUrl(cfg, objectPath);
}
