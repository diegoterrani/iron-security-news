import { z } from "zod";
import { verifyRequest } from "@ironnews/shared";

export interface Env {
  RENDER_SECRET: string;
}

const RenderRequest = z.object({
  template: z.enum(["cover", "carousel", "card-linkedin", "thumb-short"]),
  lang: z.enum(["pt", "en"]),
  slide: z.number().int().min(1).max(7).optional(),
  data: z.record(z.unknown()),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Fase 0: autenticação (HMAC) e validação do contrato. A renderização (Satori + resvg-wasm
 * com os templates de packages/templates) entra na Fase 1, quando o kit da marca estiver disponível.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/health") return json({ status: "ok", service: "og-render" });
    if (req.method !== "POST" || pathname !== "/render") return json({ error: "not found" }, 404);

    const raw = await req.text();
    if (raw.length > 32 * 1024) return json({ error: "payload too large" }, 413);
    const valid = await verifyRequest(env.RENDER_SECRET, raw, req.headers.get("x-timestamp"), req.headers.get("x-signature"));
    if (!valid) return json({ error: "unauthorized" }, 401);

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "bad json" }, 400);
    }
    const parsed = RenderRequest.safeParse(body);
    if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues.length }, 422);

    return json({ error: "not implemented", template: parsed.data.template }, 501);
  },
} satisfies ExportedHandler<Env>;
